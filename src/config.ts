import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parse as parseToml, TomlDate, TomlError } from 'smol-toml';
import { FIELD_NAMES, type FieldName } from './lookup/fields.js';
import {
  DEFAULT_FIELD_PRIORITY,
  PROVIDER_DECLARATIONS,
  PROVIDER_NAMES,
  isProviderName,
  type ProviderName,
} from './providers/declarations.js';

export const LOG_LEVELS = ['warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Where an effective setting came from, lowest precedence first. */
export const SETTING_SOURCES = ['default', 'file', 'env', 'flag'] as const;
export type SettingSource = (typeof SETTING_SOURCES)[number];

const DEFAULT_COUNTRY = 'GB';
const DEFAULT_LOG_LEVEL: LogLevel = 'info';
const DEFAULT_METERED_CALLS_PER_LOOKUP = 5;
const MAX_METERED_CALLS_PER_LOOKUP = 100;
const DEFAULT_METERED_CALLS_PER_BATCH = 0;
const MAX_METERED_CALLS_PER_BATCH = 1_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 30_000;
const MIN_LOOKUP_TIMEOUT_MS = 1_000;
const MAX_LOOKUP_TIMEOUT_MS = 600_000;
const DEFAULT_WEB_FETCH_MAX_PAGES = 5;
const MAX_WEB_FETCH_MAX_PAGES = 20;
const DEFAULT_UNREADABLE_TEXT_CHARS = 200;
const MAX_UNREADABLE_TEXT_CHARS = 10_000;

/** Permission bits for group and other; a config file holding keys should have none of them. */
const GROUP_OTHER_PERMISSION_MASK = 0o077;

const APP_DIRECTORY_NAME = 'compfinder';
const CONFIG_FILE_NAME = 'config.toml';
const ENV_PREFIX = 'COMPFINDER_';
const CONFIG_PATH_VARIABLE = 'COMPFINDER_CONFIG';
const CONFIG_PATH_FLAG = 'config';

const COUNTRY_CODE_PATTERN = /^[A-Za-z]{2}$/;
const HOSTNAME_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const BOOLEAN_TRUE_WORDS = new Set(['true', '1', 'yes']);
const BOOLEAN_FALSE_WORDS = new Set(['false', '0', 'no']);

/** Hosts whose pages are directory listings, not a business's own site. */
export const DEFAULT_DIRECTORY_HOSTS: readonly string[] = [
  'yell.com', 'thomsonlocal.com', 'scoot.co.uk', 'cylex-uk.co.uk', 'checkatrade.com', 'trustpilot.com',
  'yelp.com', 'yelp.co.uk', 'tripadvisor.com', 'tripadvisor.co.uk',
  'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'youtube.com', 'tiktok.com',
  'rightmove.co.uk', 'zoopla.co.uk', 'onthemarket.com',
  'find-and-update.company-information.service.gov.uk', 'opencorporates.com', 'endole.co.uk',
  'wikipedia.org', 'google.com', 'bing.com',
];

/** Command-line flags that are settings; each maps to one setting key. */
export const SETTING_FLAGS = [
  'config', 'country', 'cache-dir', 'max-metered-calls', 'max-metered-calls-total', 'allow-private-addresses',
] as const;
export type SettingFlag = (typeof SETTING_FLAGS)[number];

/** Setting flags given on the command line: a value, or true for a flag without one. */
export type ConfigOverrides = Partial<Record<SettingFlag, string | true>>;

type SettingKind = 'integer' | 'boolean' | 'choice' | 'country' | 'path' | 'hostList' | 'providerList' | 'secret';
type SettingValue = string | number | boolean | readonly string[];

/** One setting: its TOML key, how it is parsed, and the env variable and flag that override it. */
export interface SettingSpec {
  key: string;
  kind: SettingKind;
  /** Undefined only for secrets, which are never defaulted. */
  defaultValue: SettingValue | undefined;
  env?: string;
  flag?: SettingFlag;
  minimum?: number;
  maximum?: number;
  choices?: readonly string[];
  /** For providerList settings: the field whose priority it sets. */
  field?: FieldName;
}

export interface ProviderSettings {
  enabled: boolean;
  /** Null when no key is configured. */
  apiKey: string | null;
}

/** One line of `config show`: secrets appear only as set or unset. */
export interface SettingReport {
  key: string;
  value: SettingValue | 'set' | 'unset';
  source: SettingSource;
  env: string | null;
}

export interface Config {
  configPath: string;
  configFileExists: boolean;
  country: string;
  logLevel: LogLevel;
  cacheDir: string;
  skipSettled: boolean;
  /** False when NO_COLOR is set; the renderer also checks that stdout is a terminal. */
  colour: boolean;
  budgets: { meteredCallsPerLookup: number; meteredCallsPerBatch: number };
  timeouts: { requestMs: number; lookupMs: number };
  webFetch: { maxPages: number; honourRobots: boolean; unreadableTextChars: number };
  discover: { runAll: boolean; directoryHosts: string[] };
  net: { allowPrivateAddresses: boolean };
  /** Full provider order per field: configured providers first, then the defaults. */
  priority: Record<FieldName, ProviderName[]>;
  providers: Record<ProviderName, ProviderSettings>;
  settings: SettingReport[];
  /** Problems that don't stop the run, for the caller to log once a logger exists. */
  warnings: string[];
}

/** Plain inputs to loadConfig, so tests never touch the real environment or disk. */
export interface ConfigInputs {
  variables: Record<string, string | undefined>;
  configPath: string;
  /** True when --config or COMPFINDER_CONFIG named the file, so it must exist. */
  isConfigPathExplicit: boolean;
  /** The file's text, or undefined when there is no file. */
  fileText: string | undefined;
  /** The file's permission bits, when known. */
  fileMode?: number;
  overrides: ConfigOverrides;
  workingDirectory: string;
  homeDirectory: string;
}

/** Thrown when configuration is invalid; lists every problem found. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Returns the default cache directory: $XDG_CACHE_HOME/compfinder, else ~/.cache/compfinder. */
function defaultCacheDir(variables: Record<string, string | undefined>, homeDirectory: string): string {
  const xdgCacheHome = variables.XDG_CACHE_HOME;
  const base = xdgCacheHome !== undefined && path.isAbsolute(xdgCacheHome) ? xdgCacheHome : path.join(homeDirectory, '.cache');
  return path.join(base, APP_DIRECTORY_NAME);
}

/** Builds the full list of settings, in sample-file order. */
export function settingSpecs(defaultCacheDirectory: string): SettingSpec[] {
  const specs: SettingSpec[] = [
    { key: 'country', kind: 'country', defaultValue: DEFAULT_COUNTRY, env: 'COMPFINDER_COUNTRY', flag: 'country' },
    { key: 'log_level', kind: 'choice', defaultValue: DEFAULT_LOG_LEVEL, env: 'COMPFINDER_LOG_LEVEL', choices: LOG_LEVELS },
    { key: 'cache_dir', kind: 'path', defaultValue: defaultCacheDirectory, env: 'COMPFINDER_CACHE_DIR', flag: 'cache-dir' },
    { key: 'skip_settled', kind: 'boolean', defaultValue: true },
    {
      key: 'budgets.metered_calls_per_lookup', kind: 'integer', defaultValue: DEFAULT_METERED_CALLS_PER_LOOKUP,
      flag: 'max-metered-calls', minimum: 0, maximum: MAX_METERED_CALLS_PER_LOOKUP,
    },
    {
      key: 'budgets.metered_calls_per_batch', kind: 'integer', defaultValue: DEFAULT_METERED_CALLS_PER_BATCH,
      flag: 'max-metered-calls-total', minimum: 0, maximum: MAX_METERED_CALLS_PER_BATCH,
    },
    {
      key: 'timeouts.request_ms', kind: 'integer', defaultValue: DEFAULT_REQUEST_TIMEOUT_MS,
      minimum: MIN_REQUEST_TIMEOUT_MS, maximum: MAX_REQUEST_TIMEOUT_MS,
    },
    {
      key: 'timeouts.lookup_ms', kind: 'integer', defaultValue: DEFAULT_LOOKUP_TIMEOUT_MS,
      minimum: MIN_LOOKUP_TIMEOUT_MS, maximum: MAX_LOOKUP_TIMEOUT_MS,
    },
    { key: 'web_fetch.max_pages', kind: 'integer', defaultValue: DEFAULT_WEB_FETCH_MAX_PAGES, minimum: 1, maximum: MAX_WEB_FETCH_MAX_PAGES },
    { key: 'web_fetch.honour_robots', kind: 'boolean', defaultValue: true },
    {
      key: 'web_fetch.unreadable_text_chars', kind: 'integer', defaultValue: DEFAULT_UNREADABLE_TEXT_CHARS,
      minimum: 0, maximum: MAX_UNREADABLE_TEXT_CHARS,
    },
    { key: 'discover.run_all', kind: 'boolean', defaultValue: false },
    { key: 'discover.directory_hosts', kind: 'hostList', defaultValue: DEFAULT_DIRECTORY_HOSTS },
    { key: 'net.allow_private_addresses', kind: 'boolean', defaultValue: false, flag: 'allow-private-addresses' },
  ];
  for (const field of FIELD_NAMES) {
    specs.push({ key: `priority.${field}`, kind: 'providerList', defaultValue: DEFAULT_FIELD_PRIORITY[field], field });
  }
  for (const providerName of PROVIDER_NAMES) {
    const credentialVariable = PROVIDER_DECLARATIONS[providerName].credentialVariable;
    if (credentialVariable !== null) {
      specs.push({ key: `providers.${providerName}.api_key`, kind: 'secret', defaultValue: undefined, env: credentialVariable });
    }
    specs.push({ key: `providers.${providerName}.enabled`, kind: 'boolean', defaultValue: true });
  }
  return specs;
}

/** Every COMPFINDER_ variable the tool reads. Any other prefixed name is reported as a likely typo. */
export function knownVariables(): Set<string> {
  const names = new Set<string>([CONFIG_PATH_VARIABLE]);
  for (const spec of settingSpecs('')) {
    if (spec.env !== undefined) {
      names.add(spec.env);
    }
  }
  return names;
}

/** Works out which config file to read, and whether the caller named it explicitly. */
export function resolveConfigPath(
  variables: Record<string, string | undefined>,
  overrides: ConfigOverrides,
  workingDirectory: string,
  homeDirectory: string,
): { configPath: string; isConfigPathExplicit: boolean } {
  const flagValue = overrides[CONFIG_PATH_FLAG];
  const envValue = variables[CONFIG_PATH_VARIABLE]?.trim();
  const xdgConfigHome = variables.XDG_CONFIG_HOME;
  let configPath: string;
  let isConfigPathExplicit = true;
  if (typeof flagValue === 'string' && flagValue.trim() !== '') {
    configPath = path.resolve(workingDirectory, expandHome(flagValue.trim(), homeDirectory));
  } else if (envValue !== undefined && envValue !== '') {
    configPath = path.resolve(workingDirectory, expandHome(envValue, homeDirectory));
  } else {
    const base = xdgConfigHome !== undefined && path.isAbsolute(xdgConfigHome) ? xdgConfigHome : path.join(homeDirectory, '.config');
    configPath = path.join(base, APP_DIRECTORY_NAME, CONFIG_FILE_NAME);
    isConfigPathExplicit = false;
  }
  return { configPath, isConfigPathExplicit };
}

/** Replaces a leading ~ with the home directory. */
function expandHome(value: string, homeDirectory: string): string {
  let expanded = value;
  if (value === '~') {
    expanded = homeDirectory;
  } else if (value.startsWith('~/')) {
    expanded = path.join(homeDirectory, value.slice(2));
  }
  return expanded;
}

/** True for a TOML table: an object that isn't an array or a date. */
function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof TomlDate);
}

/** Shows a found value in a problem message. */
function describeValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

type ValueOrigin = 'file' | 'env' | 'flag';

/** Parses settings from every source, collecting each problem instead of stopping at the first. */
class SettingsReader {
  readonly problems: string[] = [];
  private readonly inputs: ConfigInputs;

  constructor(inputs: ConfigInputs) {
    this.inputs = inputs;
  }

  /** Names a setting in a message: the file and key, the variable, or the flag. */
  label(spec: SettingSpec, origin: ValueOrigin): string {
    let label: string;
    if (origin === 'file') {
      label = `${this.inputs.configPath}: ${spec.key}`;
    } else if (origin === 'env') {
      label = spec.env ?? spec.key;
    } else {
      label = `--${spec.flag ?? spec.key}`;
    }
    return label;
  }

  /** Parses one raw value; records a problem and returns undefined when it's invalid. */
  parse(spec: SettingSpec, raw: unknown, origin: ValueOrigin): SettingValue | undefined {
    const label = this.label(spec, origin);
    let parsed: SettingValue | undefined;
    switch (spec.kind) {
      case 'integer':
        parsed = this.parseInteger(spec, raw, label);
        break;
      case 'boolean':
        parsed = this.parseBoolean(raw, label);
        break;
      case 'choice':
        parsed = this.parseChoice(spec, raw, label);
        break;
      case 'country':
        parsed = this.parseCountry(raw, label);
        break;
      case 'path':
        parsed = this.parsePath(raw, label, origin);
        break;
      case 'hostList':
        parsed = this.parseHostList(raw, label);
        break;
      case 'providerList':
        parsed = this.parseProviderList(spec, raw, label);
        break;
      case 'secret':
        parsed = this.parseSecret(raw, label);
        break;
      default: {
        const unhandled: never = spec.kind;
        throw new Error(`Unhandled setting kind ${String(unhandled)}`);
      }
    }
    return parsed;
  }

  private parseInteger(spec: SettingSpec, raw: unknown, label: string): number | undefined {
    const number = typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : raw;
    const minimum = spec.minimum ?? 0;
    const maximum = spec.maximum ?? Number.MAX_SAFE_INTEGER;
    let parsed: number | undefined;
    if (typeof number === 'number' && Number.isInteger(number) && number >= minimum && number <= maximum) {
      parsed = number;
    } else {
      this.problems.push(`${label} must be a whole number from ${minimum} to ${maximum}; got ${describeValue(raw)}.`);
    }
    return parsed;
  }

  private parseBoolean(raw: unknown, label: string): boolean | undefined {
    let parsed: boolean | undefined;
    if (typeof raw === 'boolean') {
      parsed = raw;
    } else if (typeof raw === 'string' && BOOLEAN_TRUE_WORDS.has(raw.trim().toLowerCase())) {
      parsed = true;
    } else if (typeof raw === 'string' && BOOLEAN_FALSE_WORDS.has(raw.trim().toLowerCase())) {
      parsed = false;
    } else {
      this.problems.push(`${label} must be true or false; got ${describeValue(raw)}.`);
    }
    return parsed;
  }

  private parseChoice(spec: SettingSpec, raw: unknown, label: string): string | undefined {
    const choices = spec.choices ?? [];
    const value = typeof raw === 'string' ? raw.trim() : raw;
    const matched = choices.find((choice) => choice === value);
    if (matched === undefined) {
      this.problems.push(`${label} must be one of ${choices.join(', ')}; got ${describeValue(raw)}.`);
    }
    return matched;
  }

  private parseCountry(raw: unknown, label: string): string | undefined {
    let parsed: string | undefined;
    if (typeof raw === 'string' && COUNTRY_CODE_PATTERN.test(raw.trim())) {
      parsed = raw.trim().toUpperCase();
    } else {
      this.problems.push(`${label} must be a two-letter country code such as GB; got ${describeValue(raw)}.`);
    }
    return parsed;
  }

  private parsePath(raw: unknown, label: string, origin: ValueOrigin): string | undefined {
    let parsed: string | undefined;
    if (typeof raw === 'string' && raw.trim() !== '') {
      const base = origin === 'file' ? path.dirname(this.inputs.configPath) : this.inputs.workingDirectory;
      parsed = path.resolve(base, expandHome(raw.trim(), this.inputs.homeDirectory));
    } else {
      this.problems.push(`${label} must be a directory path; got ${describeValue(raw)}.`);
    }
    return parsed;
  }

  private parseHostList(raw: unknown, label: string): string[] | undefined {
    const items = typeof raw === 'string' ? raw.split(',').map((item) => item.trim()).filter((item) => item !== '') : raw;
    let parsed: string[] | undefined;
    if (!Array.isArray(items)) {
      this.problems.push(`${label} must be a list of host names; got ${describeValue(raw)}.`);
    } else {
      const hosts: string[] = [];
      for (const item of items) {
        const host = typeof item === 'string' ? item.trim().toLowerCase() : '';
        if (HOSTNAME_PATTERN.test(host)) {
          hosts.push(host);
        } else {
          this.problems.push(`${label} must contain only host names such as yell.com; got ${describeValue(item)}.`);
        }
      }
      parsed = hosts;
    }
    return parsed;
  }

  private parseProviderList(spec: SettingSpec, raw: unknown, label: string): string[] | undefined {
    let parsed: string[] | undefined;
    if (!Array.isArray(raw)) {
      this.problems.push(`${label} must be a list of provider names; got ${describeValue(raw)}.`);
    } else {
      const providers: string[] = [];
      for (const item of raw) {
        const name = typeof item === 'string' ? item : describeValue(item);
        if (!isProviderName(name)) {
          this.problems.push(`${label} must list provider names (${PROVIDER_NAMES.join(', ')}); got ${describeValue(item)}.`);
        } else if (providers.includes(name)) {
          this.problems.push(`${label} lists ${name} more than once.`);
        } else if (spec.field !== undefined && !PROVIDER_DECLARATIONS[name].supplies.includes(spec.field)) {
          this.problems.push(`${label} lists ${name}, which can't supply ${spec.field}.`);
        } else {
          providers.push(name);
        }
      }
      parsed = providers;
    }
    return parsed;
  }

  private parseSecret(raw: unknown, label: string): string | undefined {
    let parsed: string | undefined;
    if (typeof raw === 'string' && raw.trim() !== '') {
      parsed = raw.trim();
    } else if (typeof raw === 'string') {
      this.problems.push(`${label} is set but empty. Remove it to leave the provider unconfigured, or set a key.`);
    } else {
      this.problems.push(`${label} must be a string.`);
    }
    return parsed;
  }
}

/** Parses the config file text; a syntax error becomes one problem with its line and column. */
function parseConfigFile(inputs: ConfigInputs, problems: string[]): Record<string, unknown> {
  let table: Record<string, unknown> = {};
  if (inputs.fileText !== undefined) {
    try {
      table = parseToml(inputs.fileText);
    } catch (error) {
      if (!(error instanceof TomlError)) {
        throw error;
      }
      const firstLine = error.message.split('\n')[0] ?? error.message;
      problems.push(`${inputs.configPath}:${error.line}:${error.column}: ${firstLine}.`);
    }
  }
  return table;
}

/** Flattens the parsed file to dotted keys, reporting keys and tables the tool doesn't know. */
function flattenFileSettings(
  table: Record<string, unknown>,
  specs: SettingSpec[],
  configPath: string,
  problems: string[],
): Map<string, unknown> {
  const knownKeys = new Set(specs.map((spec) => spec.key));
  const knownTables = new Set<string>();
  for (const key of knownKeys) {
    const parts = key.split('.');
    for (let length = 1; length < parts.length; length += 1) {
      knownTables.add(parts.slice(0, length).join('.'));
    }
  }
  const values = new Map<string, unknown>();
  const pending: Array<{ prefix: string; entries: Record<string, unknown> }> = [{ prefix: '', entries: table }];
  while (pending.length > 0) {
    const next = pending.shift();
    if (next === undefined) {
      break;
    }
    for (const [name, value] of Object.entries(next.entries)) {
      const key = next.prefix === '' ? name : `${next.prefix}.${name}`;
      if (knownKeys.has(key)) {
        values.set(key, value);
      } else if (knownTables.has(key) && isTable(value)) {
        pending.push({ prefix: key, entries: value });
      } else if (next.prefix === 'providers') {
        problems.push(`${configPath}: [providers.${name}] is not a provider. Providers are ${PROVIDER_NAMES.join(', ')}.`);
      } else {
        problems.push(`${configPath}: unknown key ${key}. Check for a typo.`);
      }
    }
  }
  return values;
}

/** Turns a flag value into the raw form its setting parses: a bare boolean flag means true. */
function flagRawValue(spec: SettingSpec, value: string | true): unknown {
  let raw: unknown = value;
  if (value === true && spec.kind !== 'boolean') {
    raw = '';
  }
  return raw;
}

/** Validates and normalises every source into a Config. Throws ConfigError listing every problem. */
export function loadConfig(inputs: ConfigInputs): Config {
  const { variables, overrides } = inputs;
  const reader = new SettingsReader(inputs);
  const warnings: string[] = [];
  const specs = settingSpecs(defaultCacheDir(variables, inputs.homeDirectory));

  if (inputs.fileText === undefined && inputs.isConfigPathExplicit) {
    reader.problems.push(`Config file ${inputs.configPath} does not exist.`);
  }
  const known = knownVariables();
  for (const name of Object.keys(variables)) {
    if (name.startsWith(ENV_PREFIX) && !known.has(name)) {
      reader.problems.push(`Unknown setting ${name}. Check for a typo.`);
    }
  }

  const fileValues = flattenFileSettings(parseConfigFile(inputs, reader.problems), specs, inputs.configPath, reader.problems);
  const resolved = new Map<string, { value: SettingValue | undefined; source: SettingSource }>();
  for (const spec of specs) {
    let value = spec.defaultValue;
    let source: SettingSource = 'default';
    const candidates: Array<{ origin: ValueOrigin; raw: unknown }> = [];
    if (fileValues.has(spec.key)) {
      candidates.push({ origin: 'file', raw: fileValues.get(spec.key) });
    }
    const envValue = spec.env === undefined ? undefined : variables[spec.env];
    if (envValue !== undefined) {
      candidates.push({ origin: 'env', raw: envValue });
    }
    const flagValue = spec.flag === undefined ? undefined : overrides[spec.flag];
    if (spec.flag !== undefined && flagValue !== undefined) {
      candidates.push({ origin: 'flag', raw: flagRawValue(spec, flagValue) });
    }
    for (const candidate of candidates) {
      const parsed = reader.parse(spec, candidate.raw, candidate.origin);
      if (parsed !== undefined) {
        value = parsed;
        source = candidate.origin;
      }
    }
    resolved.set(spec.key, { value, source });
  }

  const valueOf = (key: string): SettingValue | undefined => resolved.get(key)?.value;
  const integer = (key: string): number => Number(valueOf(key));
  const flag = (key: string): boolean => valueOf(key) === true;
  const text = (key: string): string => String(valueOf(key));
  const list = (key: string): string[] => {
    const value = valueOf(key);
    return Array.isArray(value) ? [...(value as readonly string[])] : [];
  };

  const priority = {} as Record<FieldName, ProviderName[]>;
  for (const field of FIELD_NAMES) {
    const chosen = list(`priority.${field}`).filter(isProviderName);
    const rest = DEFAULT_FIELD_PRIORITY[field].filter((name) => !chosen.includes(name));
    priority[field] = [...chosen, ...rest];
  }

  const providers = {} as Record<ProviderName, ProviderSettings>;
  let hasFileSecret = false;
  for (const providerName of PROVIDER_NAMES) {
    const apiKey = resolved.get(`providers.${providerName}.api_key`);
    if (apiKey?.source === 'file') {
      hasFileSecret = true;
    }
    providers[providerName] = {
      enabled: flag(`providers.${providerName}.enabled`),
      apiKey: typeof apiKey?.value === 'string' ? apiKey.value : null,
    };
  }

  const config: Config = {
    configPath: inputs.configPath,
    configFileExists: inputs.fileText !== undefined,
    country: text('country'),
    logLevel: LOG_LEVELS.find((level) => level === valueOf('log_level')) ?? DEFAULT_LOG_LEVEL,
    cacheDir: text('cache_dir'),
    skipSettled: flag('skip_settled'),
    colour: variables.NO_COLOR === undefined || variables.NO_COLOR === '',
    budgets: {
      meteredCallsPerLookup: integer('budgets.metered_calls_per_lookup'),
      meteredCallsPerBatch: integer('budgets.metered_calls_per_batch'),
    },
    timeouts: { requestMs: integer('timeouts.request_ms'), lookupMs: integer('timeouts.lookup_ms') },
    webFetch: {
      maxPages: integer('web_fetch.max_pages'),
      honourRobots: flag('web_fetch.honour_robots'),
      unreadableTextChars: integer('web_fetch.unreadable_text_chars'),
    },
    discover: { runAll: flag('discover.run_all'), directoryHosts: list('discover.directory_hosts') },
    net: { allowPrivateAddresses: flag('net.allow_private_addresses') },
    priority,
    providers,
    settings: specs.map((spec) => {
      const entry = resolved.get(spec.key);
      const value: SettingValue | undefined = entry?.value;
      let shown: SettingReport['value'];
      if (spec.kind === 'secret') {
        shown = value === undefined ? 'unset' : 'set';
      } else {
        shown = value ?? '';
      }
      return { key: spec.key, value: shown, source: entry?.source ?? 'default', env: spec.env ?? null };
    }),
    warnings,
  };

  if (config.timeouts.requestMs > config.timeouts.lookupMs) {
    reader.problems.push(
      `timeouts.request_ms (${config.timeouts.requestMs}) must not be longer than timeouts.lookup_ms (${config.timeouts.lookupMs}).`,
    );
  }
  if (hasFileSecret && inputs.fileMode !== undefined && (inputs.fileMode & GROUP_OTHER_PERMISSION_MASK) !== 0) {
    warnings.push(`${inputs.configPath} holds an API key but other users can read it. Run: chmod 600 ${inputs.configPath}`);
  }
  if (reader.problems.length > 0) {
    throw new ConfigError(reader.problems);
  }
  return config;
}

/** Reads the real environment and config file, then loads the Config. The only process.env read. */
export function loadConfigFromEnvironment(overrides: ConfigOverrides): Config {
  const variables = { ...process.env };
  const workingDirectory = process.cwd();
  const homeDirectory = variables.HOME ?? homedir();
  const { configPath, isConfigPathExplicit } = resolveConfigPath(variables, overrides, workingDirectory, homeDirectory);
  let fileText: string | undefined;
  let fileMode: number | undefined;
  try {
    fileText = readFileSync(configPath, 'utf8');
    fileMode = statSync(configPath).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    fileText = undefined; // No config file; defaults apply.
  }
  return loadConfig({ variables, configPath, isConfigPathExplicit, fileText, fileMode, overrides, workingDirectory, homeDirectory });
}

/** Names the settings source in problems when settings were passed in code rather than read from a file. */
export const IN_CODE_CONFIG_LABEL = '(settings passed in code)';

/** Loads the Config from settings passed in code: TOML text and COMPFINDER_* variables, never the environment or a file. */
export function loadConfigFromValues(values: { toml?: string; variables?: Record<string, string | undefined> }): Config {
  return loadConfig({
    variables: values.variables ?? {},
    configPath: IN_CODE_CONFIG_LABEL,
    isConfigPathExplicit: false,
    fileText: values.toml,
    overrides: {},
    workingDirectory: process.cwd(),
    homeDirectory: homedir(),
  });
}
