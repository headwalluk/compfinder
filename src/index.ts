/**
 * The library entry point: everything the CLI does, callable from code. Usage and examples are in
 * docs/library.md. Nothing outside this module's exports is a public contract.
 */
import { loadConfigFromEnvironment, loadConfigFromValues, type Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { CallBudget } from './lookup/budget.js';
import { checkProviders, planLookup, runLookup, type CheckReport, type LookupRequest, type PlannedProvider } from './lookup/engine.js';
import type { FieldName } from './lookup/fields.js';
import { normaliseQuery, readQueryInput, type QueryInput } from './lookup/query.js';
import { buildResult, type LookupResult } from './lookup/result.js';
import { outputError, type ErrorCode, type OutputError } from './messages/error-codes.js';
import type { ProviderName } from './providers/declarations.js';
import { builtInProviders } from './providers/registry.js';

export { ConfigError, type Config } from './config.js';
export type { Logger } from './logger.js';
export { CallBudget } from './lookup/budget.js';
export type { CheckReport, PlannedProvider, ProviderReport } from './lookup/engine.js';
export { FIELD_NAMES, type FieldName } from './lookup/fields.js';
export { QUERY_INPUT_KEYS, type QueryInput } from './lookup/query.js';
export { SCHEMA_VERSION, type LookupResult, type OutputCandidate, type OutputEvidence, type OutputField } from './lookup/result.js';
export type { ErrorCode, OutputError } from './messages/error-codes.js';
export { PROVIDER_NAMES, type ProviderName } from './providers/declarations.js';

const LOGGER_TAG = 'compfinder';

/** Where a finder's settings come from. */
export interface FinderOptions {
  /** Settings in the config.toml format. Ignored when fromEnvironment is true. */
  toml?: string;
  /** COMPFINDER_* settings by variable name, applied over toml. Ignored when fromEnvironment is true. */
  variables?: Record<string, string | undefined>;
  /** Read the CLI's config file and COMPFINDER_* environment variables instead, exactly as the command does. */
  fromEnvironment?: boolean;
  /** Receives the library's log lines; by default, warnings and errors go to stderr. */
  logger?: Logger;
}

/** Options for one lookup, matching the find command's flags. */
export interface FindOptions {
  /** Fields to find; every field when absent (--fields). */
  fields?: readonly FieldName[];
  /** Use only these providers (--providers). */
  providers?: readonly ProviderName[];
  /** Use all providers but these (--exclude). */
  exclude?: readonly ProviderName[];
  /** Include every piece of evidence in each field (--explain). */
  explain?: boolean;
  /** Neither read nor write the response cache (--no-cache). */
  noCache?: boolean;
  /** Report logo URLs without downloading them (--no-download). */
  noDownload?: boolean;
  /** Shared across lookups to cap their metered calls together (--max-metered-calls-total). */
  budget?: CallBudget;
  /** Cancels the lookup; providers still running are reported as timed out. */
  signal?: AbortSignal;
}

/** What a dry run would do: each provider's plan and the most metered calls it could make. */
export interface LookupPlan {
  providers: PlannedProvider[];
  maxMeteredCalls: number;
}

/** Thrown by find and plan when the query itself is unusable; lists every problem. */
export class QueryError extends Error {
  readonly code: ErrorCode;
  readonly problems: string[];
  readonly error: OutputError;

  constructor(code: ErrorCode, problems: string[]) {
    super(problems.join(' '));
    this.name = 'QueryError';
    this.code = code;
    this.problems = problems;
    this.error = outputError(code, problems.join(' '));
  }
}

/** A configured lookup engine. Safe to share across concurrent lookups. */
export interface Finder {
  /** The validated settings in use. Holds API keys: don't log or return it. */
  readonly config: Config;
  /** Looks one business up. Provider failures are in the result, not thrown. */
  find(query: QueryInput, options?: FindOptions): Promise<LookupResult>;
  /** Plans a lookup without making any call, for costing. */
  plan(query: QueryInput, options?: FindOptions): LookupPlan;
  /** Proves each configured provider's key with one cheap live call. */
  checkProviders(only?: readonly ProviderName[]): Promise<CheckReport[]>;
}

/** Creates a finder. Throws ConfigError listing every problem when the settings are invalid. */
export function createFinder(options: FinderOptions = {}): Finder {
  const config = options.fromEnvironment === true
    ? loadConfigFromEnvironment({})
    : loadConfigFromValues({ ...(options.toml === undefined ? {} : { toml: options.toml }), ...(options.variables === undefined ? {} : { variables: options.variables }) });
  const logger = options.logger ?? createLogger({ level: config.logLevel, tag: LOGGER_TAG, stderrOnly: true });
  for (const warning of config.warnings) {
    logger.warn(warning);
  }
  const providers = builtInProviders(config);

  const request = (rawInput: QueryInput, findOptions: FindOptions): LookupRequest => {
    // Callers may pass parsed JSON, so the input's shape is checked before it's normalised.
    const read = readQueryInput(rawInput);
    if (read.input === null || read.problems.length > 0) {
      throw new QueryError('input.bad_value', read.problems);
    }
    const { query, problems } = normaliseQuery(read.input, config.country);
    if (problems.length > 0) {
      throw new QueryError(problems.some((problem) => problem.startsWith('Give at least one')) ? 'input.no_query' : 'input.bad_value', problems);
    }
    return {
      query, providers, config, logger,
      isCacheBypassed: findOptions.noCache === true,
      isDownloadSkipped: findOptions.noDownload === true,
      ...(findOptions.fields === undefined ? {} : { fields: findOptions.fields }),
      ...(findOptions.providers === undefined ? {} : { only: findOptions.providers }),
      ...(findOptions.exclude === undefined ? {} : { exclude: findOptions.exclude }),
      ...(findOptions.budget === undefined ? {} : { batchBudget: findOptions.budget }),
      ...(findOptions.signal === undefined ? {} : { signal: findOptions.signal }),
    };
  };

  return {
    config,
    find: async (query, findOptions = {}) => buildResult(await runLookup(request(query, findOptions)), { isExplain: findOptions.explain === true }),
    plan: (query, findOptions = {}) => planLookup(request(query, findOptions)),
    checkProviders: (only) => checkProviders({ providers, config, logger, ...(only === undefined ? {} : { only }) }),
  };
}

/** Creates a budget of metered calls to share across lookups; null for no limit. */
export function createBudget(maxMeteredCalls: number | null): CallBudget {
  return new CallBudget(maxMeteredCalls);
}
