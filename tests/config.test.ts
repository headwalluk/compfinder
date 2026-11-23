import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parse as parseToml } from 'smol-toml';
import {
  ConfigError,
  knownVariables,
  loadConfig,
  resolveConfigPath,
  settingSpecs,
  type Config,
  type ConfigInputs,
} from '../src/config.js';

const HOME_DIRECTORY = '/home/tester';
const WORKING_DIRECTORY = '/work';
const DEFAULT_CONFIG_PATH = '/home/tester/.config/compfinder/config.toml';
const SAMPLE_TEXT = readFileSync(new URL('../config.sample.toml', import.meta.url), 'utf8');
const TEST_API_KEY = 'test-key-not-real';
const WORLD_READABLE_MODE = 0o644;

/** Builds loadConfig inputs with no file, no variables and no flags, changed by the given fields. */
function inputs(changes: Partial<ConfigInputs> = {}): ConfigInputs {
  return {
    variables: {},
    configPath: DEFAULT_CONFIG_PATH,
    isConfigPathExplicit: false,
    fileText: undefined,
    overrides: {},
    workingDirectory: WORKING_DIRECTORY,
    homeDirectory: HOME_DIRECTORY,
    ...changes,
  };
}

/** Runs loadConfig and returns the problems it reports, or an empty list when it loads. */
function problemsFor(changes: Partial<ConfigInputs>): string[] {
  let problems: string[] = [];
  try {
    loadConfig(inputs(changes));
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    problems = error.problems;
  }
  return problems;
}

/** Turns the sample's commented-out settings into live TOML, with a stand-in for API keys. */
function uncommentSample(sampleText: string): string {
  const lines: string[] = [];
  let isInArray = false;
  for (const line of sampleText.split('\n')) {
    if (isInArray) {
      lines.push(line.replace(/^# ?/, ''));
      isInArray = line.trim() !== '# ]';
    } else if (/^# [a-z_]+ = /.test(line)) {
      const setting = line.slice(2).replace(/^api_key = ""$/, `api_key = "${TEST_API_KEY}"`);
      lines.push(setting);
      isInArray = setting.endsWith('[');
    } else {
      lines.push(line);
    }
  }
  return lines.join('\n');
}

/** Lists every leaf key in a parsed TOML document, dotted. */
function leafKeys(table: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [name, value] of Object.entries(table)) {
    const key = prefix === '' ? name : `${prefix}.${name}`;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      keys.push(...leafKeys(value as Record<string, unknown>, key));
    } else {
      keys.push(key);
    }
  }
  return keys;
}

describe('loadConfig', () => {
  test('a minimal config, with no file and no variables, loads with the defaults', () => {
    const config: Config = loadConfig(inputs());
    assert.equal(config.country, 'GB');
    assert.equal(config.logLevel, 'info');
    assert.equal(config.cacheDir, '/home/tester/.cache/compfinder');
    assert.equal(config.configFileExists, false);
    assert.equal(config.budgets.meteredCallsPerLookup, 5);
    assert.equal(config.providers['web-fetch'].enabled, true);
    assert.equal(config.providers['google-places-api'].apiKey, null);
    assert.deepEqual(config.priority.address, ['google-places-api', 'web-fetch', 'searchapi-io', 'apollo-io']);
    assert.deepEqual(config.warnings, []);
  });

  test('every problem is reported at once, from the file, the environment and the flags', () => {
    const problems = problemsFor({
      fileText: 'country = "GBR"\n[web_fetch]\nmax_pages = 50\nhonour_robots = "yes please"\n',
      variables: { COMPFINDER_LOG_LEVEL: 'verbose' },
      overrides: { 'max-metered-calls': 'lots' },
    });
    assert.equal(problems.length, 5);
    assert.match(problems.join('\n'), /country must be a two-letter country code such as GB; got "GBR"/);
    assert.match(problems.join('\n'), /web_fetch\.max_pages must be a whole number from 1 to 20; got 50/);
    assert.match(problems.join('\n'), /web_fetch\.honour_robots must be true or false/);
    assert.match(problems.join('\n'), /COMPFINDER_LOG_LEVEL must be one of warn, info, debug; got "verbose"/);
    assert.match(problems.join('\n'), /--max-metered-calls must be a whole number from 0 to 100; got "lots"/);
  });

  test('a TOML syntax error is one problem with its line and column, reported alongside the rest', () => {
    const problems = problemsFor({
      fileText: 'country = "GB"\nlog_level = \n',
      variables: { COMPFINDER_COUNTRY: 'nowhere' },
    });
    assert.equal(problems.length, 2);
    assert.match(problems[0] ?? '', /^\/home\/tester\/\.config\/compfinder\/config\.toml:2:\d+: /);
    assert.match(problems[1] ?? '', /COMPFINDER_COUNTRY must be a two-letter country code/);
  });

  test('a missing file is fine at the default path, but a problem when it was named explicitly', () => {
    assert.deepEqual(problemsFor({}), []);
    const problems = problemsFor({ configPath: '/elsewhere/config.toml', isConfigPathExplicit: true });
    assert.deepEqual(problems, ['Config file /elsewhere/config.toml does not exist.']);
  });

  test('precedence, lowest first, is default, file, environment, flag', () => {
    const fileText = 'country = "fr"\n';
    const fromFile = loadConfig(inputs({ fileText }));
    const fromEnvironment = loadConfig(inputs({ fileText, variables: { COMPFINDER_COUNTRY: 'de' } }));
    const fromFlag = loadConfig(inputs({ fileText, variables: { COMPFINDER_COUNTRY: 'de' }, overrides: { country: 'es' } }));
    const sourceOf = (config: Config): string | undefined => config.settings.find((setting) => setting.key === 'country')?.source;
    assert.equal(fromFile.country, 'FR');
    assert.equal(sourceOf(fromFile), 'file');
    assert.equal(fromEnvironment.country, 'DE');
    assert.equal(sourceOf(fromEnvironment), 'env');
    assert.equal(fromFlag.country, 'ES');
    assert.equal(sourceOf(fromFlag), 'flag');
  });

  test('unknown keys, unknown provider tables and unknown prefixed variables are reported as likely typos', () => {
    const problems = problemsFor({
      fileText: 'colour = true\n[web_fetch]\nmax_page = 3\n[providers.gogle-places-api]\napi_key = "x"\n',
      variables: { COMPFINDER_GOOGLE_PLACE_API_KEY: 'x', UNRELATED_VARIABLE: 'fine' },
    });
    assert.equal(problems.length, 4);
    assert.match(problems.join('\n'), /Unknown setting COMPFINDER_GOOGLE_PLACE_API_KEY\. Check for a typo\./);
    assert.match(problems.join('\n'), /unknown key colour\. Check for a typo\./);
    assert.match(problems.join('\n'), /unknown key web_fetch\.max_page\. Check for a typo\./);
    assert.match(problems.join('\n'), /\[providers\.gogle-places-api\] is not a provider/);
  });

  test('an API key configures its provider, and is reported only as set', () => {
    const config = loadConfig(inputs({ variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: TEST_API_KEY } }));
    assert.equal(config.providers['google-places-api'].apiKey, TEST_API_KEY);
    const report = config.settings.find((setting) => setting.key === 'providers.google-places-api.api_key');
    assert.deepEqual(report, { key: 'providers.google-places-api.api_key', value: 'set', source: 'env', env: 'COMPFINDER_GOOGLE_PLACES_API_KEY' });
    assert.doesNotMatch(JSON.stringify(config.settings), new RegExp(TEST_API_KEY));
  });

  test('an API key that is set but empty is a problem, not a silent fallback', () => {
    const problems = problemsFor({
      variables: { COMPFINDER_APOLLO_API_KEY: '' },
      fileText: '[providers.searchapi-io]\napi_key = "  "\n',
    });
    assert.equal(problems.length, 2);
    assert.match(problems.join('\n'), /COMPFINDER_APOLLO_API_KEY is set but empty/);
    assert.match(problems.join('\n'), /providers\.searchapi-io\.api_key is set but empty/);
  });

  test('a priority list puts the chosen providers first, and rejects providers that cannot supply the field', () => {
    const config = loadConfig(inputs({ fileText: '[priority]\naddress = ["web-fetch"]\n' }));
    assert.deepEqual(config.priority.address, ['web-fetch', 'google-places-api', 'searchapi-io', 'apollo-io']);
    const problems = problemsFor({ fileText: '[priority]\nlogo = ["apollo-io", "web-fetch", "web-fetch", "nobody"]\n' });
    assert.equal(problems.length, 3);
    assert.match(problems.join('\n'), /lists apollo-io, which can't supply logo/);
    assert.match(problems.join('\n'), /lists web-fetch more than once/);
    assert.match(problems.join('\n'), /must list provider names .*; got "nobody"/);
  });

  test('a request timeout longer than the lookup timeout is a problem', () => {
    const problems = problemsFor({ fileText: '[timeouts]\nrequest_ms = 20000\nlookup_ms = 10000\n' });
    assert.deepEqual(problems, ['timeouts.request_ms (20000) must not be longer than timeouts.lookup_ms (10000).']);
  });

  test('a config file holding an API key that others can read gives a warning, not a failure', () => {
    const config = loadConfig(inputs({
      fileText: `[providers.apollo-io]\napi_key = "${TEST_API_KEY}"\n`,
      fileMode: WORLD_READABLE_MODE,
    }));
    assert.equal(config.warnings.length, 1);
    assert.match(config.warnings[0] ?? '', /chmod 600/);
  });

  test('NO_COLOR turns colour off', () => {
    assert.equal(loadConfig(inputs()).colour, true);
    assert.equal(loadConfig(inputs({ variables: { NO_COLOR: '1' } })).colour, false);
  });

  test('paths expand ~, and resolve relative to the config file or the working directory', () => {
    assert.equal(loadConfig(inputs({ fileText: 'cache_dir = "~/cache"\n' })).cacheDir, '/home/tester/cache');
    assert.equal(loadConfig(inputs({ fileText: 'cache_dir = "cache"\n' })).cacheDir, '/home/tester/.config/compfinder/cache');
    assert.equal(loadConfig(inputs({ overrides: { 'cache-dir': 'cache' } })).cacheDir, '/work/cache');
  });

  test('the config path comes from the flag, then COMPFINDER_CONFIG, then XDG_CONFIG_HOME, then ~/.config', () => {
    const resolve = (variables: Record<string, string>, flag?: string): string => resolveConfigPath(
      variables, flag === undefined ? {} : { config: flag }, WORKING_DIRECTORY, HOME_DIRECTORY,
    ).configPath;
    assert.equal(resolve({}), DEFAULT_CONFIG_PATH);
    assert.equal(resolve({ XDG_CONFIG_HOME: '/xdg' }), '/xdg/compfinder/config.toml');
    assert.equal(resolve({ XDG_CONFIG_HOME: '/xdg', COMPFINDER_CONFIG: '~/my.toml' }), '/home/tester/my.toml');
    assert.equal(resolve({ COMPFINDER_CONFIG: '/env.toml' }, 'flag.toml'), '/work/flag.toml');
  });
});

describe('config.sample.toml', () => {
  test('every setting the reader accepts is in the sample, and every sample setting is accepted', () => {
    const sampleKeys = leafKeys(parseToml(uncommentSample(SAMPLE_TEXT))).sort();
    const readerKeys = settingSpecs('').map((spec) => spec.key).sort();
    assert.deepEqual(sampleKeys, readerKeys);
  });

  test('the sample\'s values are the defaults', () => {
    const config = loadConfig(inputs({ fileText: uncommentSample(SAMPLE_TEXT) }));
    const defaults = loadConfig(inputs());
    for (const setting of config.settings) {
      assert.equal(setting.source, 'file', `${setting.key} should come from the sample`);
      if (!setting.key.endsWith('.api_key')) {
        const defaultSetting = defaults.settings.find((candidate) => candidate.key === setting.key);
        assert.deepEqual(setting.value, defaultSetting?.value, `${setting.key} in the sample should be its default`);
      }
    }
  });

  test('every environment variable the tool reads is named in the sample', () => {
    const named = new Set(SAMPLE_TEXT.match(/COMPFINDER_[A-Z_]+/g) ?? []);
    assert.deepEqual([...named].sort(), [...knownVariables()].sort());
  });
});
