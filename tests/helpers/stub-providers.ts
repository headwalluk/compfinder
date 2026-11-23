import { createLogger } from '../../src/logger.js';
import type { Knowledge, Provider, ProviderContext, Readiness } from '../../src/providers/contract.js';
import { PROVIDER_DECLARATIONS, type ProviderName } from '../../src/providers/declarations.js';
import type { SourceRecord } from '../../src/lookup/types.js';

/** A logger for tests: warnings and errors only, all to stderr. */
export const quietLogger = createLogger({ level: 'warn', tag: 'test', stderrOnly: true });

export interface StubOptions {
  /** Records to return, or a function of the knowledge it was given. */
  records?: SourceRecord[] | ((knowledge: Knowledge) => SourceRecord[]);
  readiness?: (knowledge: Knowledge) => Readiness;
  /** Calls the stub makes per run (each through the meter). */
  calls?: number;
  /** Thrown instead of returning records. */
  error?: Error;
}

/** A provider with a real declaration and scripted behaviour; logs each run in `runs`. */
export function stubProvider(name: ProviderName, options: StubOptions = {}): Provider & { runs: Knowledge[] } {
  const runs: Knowledge[] = [];
  return {
    declaration: PROVIDER_DECLARATIONS[name],
    runs,
    readiness: options.readiness ?? ((): Readiness => ({ state: 'ready' })),
    maxCalls: () => options.calls ?? 1,
    async run(knowledge: Knowledge, context: ProviderContext): Promise<SourceRecord[]> {
      runs.push(knowledge);
      for (let call = 0; call < (options.calls ?? 1); call += 1) {
        context.meter.record();
      }
      if (options.error !== undefined) {
        throw options.error;
      }
      const records = options.records ?? [];
      return typeof records === 'function' ? records(knowledge) : records;
    },
  };
}

/** web-fetch's readiness: it needs a website. */
export function needsWebsite(knowledge: Knowledge): Readiness {
  return knowledge.fields.website === undefined ? { state: 'waiting', reason: 'no website known' } : { state: 'ready' };
}

/** A search provider's readiness: only when no website is known yet. */
export function onlyWithoutWebsite(knowledge: Knowledge): Readiness {
  return knowledge.fields.website === undefined ? { state: 'ready' } : { state: 'never', reason: 'website already known' };
}
