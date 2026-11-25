import type { ProviderSettings } from '../config.js';
import type { CallMeter } from '../lookup/budget.js';
import type { FieldName } from '../lookup/fields.js';
import type { FieldValues, Query, SourceRecord } from '../lookup/types.js';
import type { Logger } from '../logger.js';
import type { HttpClient } from '../net/http-client.js';
import type { ProviderDeclaration } from './declarations.js';

/** What the engine knows when a provider is about to run: the query and the best value of each field so far. */
export interface Knowledge {
  query: Query;
  fields: { [Field in Exclude<FieldName, 'socials'>]?: FieldValues[Field] };
  /** Fields already at confidence 100. */
  settled: ReadonlySet<FieldName>;
}

export type Readiness =
  | { state: 'ready' }
  | { state: 'waiting'; reason: string }
  | { state: 'never'; reason: string };

export interface ProviderContext {
  /** This provider's own settings, never the whole config. */
  settings: ProviderSettings;
  /** Every call goes through meter.record(), which debits the budget for metered calls. */
  meter: CallMeter;
  /** The guarded HTTP client; every network request goes through it, and it records each call on the meter. */
  http: HttpClient;
  /** For ordinary web pages a metered provider fetches (a website's redirect): never metered, nor in its calls. */
  webHttp: HttpClient;
  /** Adds a warning to the lookup's result. */
  warn(message: string): void;
  /** Aborts at the lookup's deadline. */
  signal: AbortSignal;
  logger: Logger;
}

/** A built-in provider. It returns evidence, never answers; matching is the scorer's job. */
export interface Provider {
  declaration: ProviderDeclaration;
  /** Whether it can run on what's known so far. */
  readiness(knowledge: Knowledge): Readiness;
  /** The most metered calls a run on this knowledge could make; used for budgets and --dry-run. */
  maxCalls(knowledge: Knowledge): number;
  /** Runs the lookup. Throws ProviderError for a classified failure. */
  run(knowledge: Knowledge, context: ProviderContext): Promise<SourceRecord[]>;
  /** One cheap live call proving the credentials work (providers check). Absent when there are none to check. */
  check?(context: ProviderContext): Promise<void>;
}
