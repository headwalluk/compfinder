import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { Knowledge, Provider, ProviderContext } from '../providers/contract.js';
import { PROVIDER_DECLARATIONS, PROVIDER_NAMES, PROVIDER_STAGES, type ProviderName } from '../providers/declarations.js';
import { scoreLookup, type ScoreResult } from '../scoring/index.js';
import { CallBudget, CallMeter } from './budget.js';
import { BudgetExhaustedError, ProviderError, type ProviderRunStatus } from './errors.js';
import { FIELD_NAMES, type FieldName } from './fields.js';
import { queryRecord } from './query.js';
import type { Query, SourceRecord } from './types.js';

/** How one provider fared in one lookup. */
export interface ProviderReport {
  name: ProviderName;
  status: ProviderRunStatus;
  /** Why it was skipped or not configured. */
  reason: string | null;
  /** What went wrong, for a failure. Never holds a credential. */
  detail: string | null;
  calls: number;
  metered: boolean;
}

export interface LookupRequest {
  query: Query;
  /** The provider implementations available; declared providers without one are skipped. */
  providers: readonly Provider[];
  config: Config;
  /** Fields asked for (--fields); every field when absent. */
  fields?: readonly FieldName[];
  /** --providers: use only these. */
  only?: readonly ProviderName[];
  /** --exclude: use all but these. */
  exclude?: readonly ProviderName[];
  /** Shared across a batch (--max-metered-calls-total). */
  batchBudget?: CallBudget;
  logger: Logger;
  signal?: AbortSignal;
}

export interface LookupOutcome {
  query: Query;
  records: SourceRecord[];
  reports: ProviderReport[];
  score: ScoreResult;
  warnings: string[];
}

/** Builds the knowledge handed to the next provider from a provisional score. */
function knowledgeFrom(query: Query, score: ScoreResult): Knowledge {
  const fields: Knowledge['fields'] = {};
  const settled = new Set<FieldName>();
  for (const field of FIELD_NAMES) {
    const result = score.fields[field];
    if (field !== 'socials' && result.value !== null && result.confidence > 0) {
      Object.assign(fields, { [field]: result.value });
    }
    if (result.confidence === 100) {
      settled.add(field);
    }
  }
  return { query, fields, settled };
}

/** Orders providers: by stage, free before metered, then best priority for the requested fields, then by name order. */
function runOrder(config: Config, requested: ReadonlySet<FieldName>): ProviderName[] {
  const bestRank = (name: ProviderName): number => Math.min(
    ...PROVIDER_DECLARATIONS[name].supplies.filter((field) => requested.has(field)).map((field) => {
      const position = config.priority[field].indexOf(name);
      return position === -1 ? PROVIDER_NAMES.length : position;
    }),
    PROVIDER_NAMES.length,
  );
  return [...PROVIDER_NAMES].sort((first, second) => (
    PROVIDER_STAGES.indexOf(PROVIDER_DECLARATIONS[first].stage) - PROVIDER_STAGES.indexOf(PROVIDER_DECLARATIONS[second].stage)
    || Number(PROVIDER_DECLARATIONS[first].metered) - Number(PROVIDER_DECLARATIONS[second].metered)
    || bestRank(first) - bestRank(second)
    || PROVIDER_NAMES.indexOf(first) - PROVIDER_NAMES.indexOf(second)
  ));
}

/** Reports a provider that can't run whatever is found: excluded, disabled, unconfigured, unwanted or unavailable. */
function staticSkip(name: ProviderName, request: LookupRequest, requested: ReadonlySet<FieldName>, available: ReadonlySet<ProviderName>): ProviderReport | null {
  const declaration = PROVIDER_DECLARATIONS[name];
  const settings = request.config.providers[name];
  const skip = (status: ProviderRunStatus, reason: string): ProviderReport => (
    { name, status, reason, detail: null, calls: 0, metered: declaration.metered }
  );
  let report: ProviderReport | null = null;
  if ((request.only !== undefined && !request.only.includes(name)) || request.exclude?.includes(name) === true) {
    report = skip('skipped', 'excluded');
  } else if (!settings.enabled) {
    report = skip('skipped', 'disabled in config');
  } else if (declaration.credentialVariable !== null && settings.apiKey === null) {
    report = skip('not_configured', `set ${declaration.credentialVariable}`);
  } else if (!declaration.supplies.some((field) => requested.has(field))) {
    report = skip('skipped', 'fields not requested');
  } else if (!available.has(name)) {
    report = skip('skipped', 'not available in this version');
  }
  return report;
}

/** Runs the providers in stage order, with one late pass, and scores what they find. */
export async function runLookup(request: LookupRequest): Promise<LookupOutcome> {
  const { query, config, logger } = request;
  const requested = new Set<FieldName>(request.fields ?? FIELD_NAMES);
  const implementations = new Map(request.providers.map((provider) => [provider.declaration.name, provider]));
  const budgets = [new CallBudget(config.budgets.meteredCallsPerLookup), ...(request.batchBudget === undefined ? [] : [request.batchBudget])];
  const deadline = AbortSignal.timeout(config.timeouts.lookupMs);
  const signal = request.signal === undefined ? deadline : AbortSignal.any([deadline, request.signal]);
  const anchor = queryRecord(query);
  const records: SourceRecord[] = [];
  const reports = new Map<ProviderName, ProviderReport>();
  const waiting = new Map<ProviderName, string>();
  let score = scoreLookup(records, query, anchor, config.priority);
  let knowledge = knowledgeFrom(query, score);

  const order = runOrder(config, requested);
  for (const name of order) {
    const report = staticSkip(name, request, requested, new Set(implementations.keys()));
    if (report !== null) {
      reports.set(name, report);
    }
  }

  /** Runs one provider if it's ready and worth calling, and records its report. */
  const attempt = async (provider: Provider, isLatePass: boolean): Promise<void> => {
    const { name, metered, supplies } = provider.declaration;
    const skip = (status: ProviderRunStatus, reason: string): void => {
      reports.set(name, { name, status, reason, detail: null, calls: 0, metered });
    };
    const readiness = provider.readiness(knowledge);
    const meter = new CallMeter(metered, budgets);
    const wanted = supplies.filter((field) => requested.has(field));
    if (readiness.state === 'never') {
      skip('skipped', readiness.reason);
    } else if (readiness.state === 'waiting' && isLatePass) {
      skip('skipped', readiness.reason);
    } else if (readiness.state === 'waiting') {
      waiting.set(name, readiness.reason);
    } else if (metered && config.skipSettled && wanted.every((field) => knowledge.settled.has(field))) {
      skip('skipped', 'fields already settled');
    } else if (meter.remaining() < 1) {
      skip('skipped', 'over budget');
    } else {
      waiting.delete(name);
      const context: ProviderContext = { settings: config.providers[name], meter, signal, logger: logger.child(name) };
      let status: ProviderRunStatus = 'ok';
      let detail: string | null = null;
      try {
        records.push(...await provider.run(knowledge, context));
      } catch (error) {
        if (error instanceof ProviderError) {
          logger.warn(`${name} failed: ${error.status}`, { detail: error.detail });
          status = error.status;
          detail = error.detail;
        } else if (error instanceof BudgetExhaustedError) {
          logger.info(`${name} stopped at the metered call budget`);
          status = meter.calls > 0 ? 'ok' : 'skipped';
          detail = 'stopped at the metered call budget';
        } else if (signal.aborted) {
          logger.warn(`${name} ran out of time`, { error });
          status = 'timeout';
          detail = 'the lookup timed out';
        } else {
          logger.error(`${name} failed unexpectedly`, { error });
          status = 'internal_error';
          detail = error instanceof Error ? error.message : String(error);
        }
      }
      reports.set(name, { name, status, reason: status === 'skipped' ? 'over budget' : null, detail, calls: meter.calls, metered });
      score = scoreLookup(records, query, anchor, config.priority);
      knowledge = knowledgeFrom(query, score);
    }
  };

  for (const name of order) {
    const provider = implementations.get(name);
    if (provider !== undefined && !reports.has(name)) {
      await attempt(provider, false);
    }
  }
  for (const name of order) {
    const provider = implementations.get(name);
    if (provider !== undefined && waiting.has(name)) {
      await attempt(provider, true);
    }
  }

  return {
    query,
    records,
    reports: PROVIDER_NAMES.map((name) => reports.get(name)).filter((report) => report !== undefined),
    score,
    warnings: [...score.warnings],
  };
}
