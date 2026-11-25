import { configuredSecrets, type Config } from '../config.js';
import type { Logger } from '../logger.js';
import { createHttpClient } from '../net/http-client.js';
import { redact } from '../net/redact.js';
import { LIVE_TRANSPORT, type Transport } from '../net/transport.js';
import { userAgent } from '../net/user-agent.js';
import type { Knowledge, Provider, ProviderContext } from '../providers/contract.js';
import { PROVIDER_DECLARATIONS, PROVIDER_NAMES, PROVIDER_STAGES, type ProviderName } from '../providers/declarations.js';
import { NO_CACHE, providerCache } from '../cache/store.js';
import { rankLogoItems } from '../scoring/fields.js';
import { scoreLookup, type ScoreResult } from '../scoring/index.js';
import { MAX_CONFIDENCE } from '../scoring/rules.js';
import { SYSTEM_CLOCK, type Clock } from './clock.js';
import { settleLogo } from './logo.js';
import { CallBudget, CallMeter } from './budget.js';
import { BudgetExhaustedError, ProviderError, type FailureCause, type ProviderRunStatus } from './errors.js';
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
  /** Why it failed, as a short stable code (docs/output.md: providers); null unless it failed. */
  cause: FailureCause | null;
  /** Every request it made over the network, each redirect hop included: its API's, and any to other sites. */
  calls: number;
  /** Requests answered from the cache, which cost nothing. */
  cached_calls: number;
  /** The calls that cost money: its API's own, never its checks of other sites. */
  metered_calls: number;
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
  /** The network; tests pass a fixture transport. */
  transport?: Transport;
  /** --no-cache: neither read nor write the response cache, and don't reuse cached logos. */
  isCacheBypassed?: boolean;
  /** --no-download: report logo URLs without downloading them. */
  isDownloadSkipped?: boolean;
  clock?: Clock;
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
    // A head office's address or phone, on a branch query, would steer the next search to the head office.
    if (field !== 'socials' && result.value !== null && result.confidence > 0 && !result.rules.includes('field.head-office')) {
      Object.assign(fields, { [field]: result.value });
    }
    if (result.confidence === MAX_CONFIDENCE) {
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
    { name, status, reason, detail: null, cause: null, calls: 0, cached_calls: 0, metered_calls: 0, metered: declaration.metered }
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
  const warnings: string[] = [];
  const secrets = configuredSecrets(config);
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
      reports.set(name, { name, status, reason, detail: null, cause: null, calls: 0, cached_calls: 0, metered_calls: 0, metered });
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
      const http = createHttpClient({
        transport: request.transport ?? LIVE_TRANSPORT,
        userAgent: userAgent(),
        requestTimeoutMs: config.timeouts.requestMs,
        allowPrivateAddresses: config.net.allowPrivateAddresses,
        meter,
        signal,
        logger: logger.child(name),
        secrets,
        cache: request.isCacheBypassed === true ? NO_CACHE : providerCache(name, {
          directory: config.cacheDir, clock: request.clock ?? SYSTEM_CLOCK, logger, warn: (message) => warnings.push(message),
        }),
      });
      const webMeter = new CallMeter(false, budgets);
      const webHttp = createHttpClient({
        transport: request.transport ?? LIVE_TRANSPORT,
        userAgent: userAgent(),
        requestTimeoutMs: config.timeouts.requestMs,
        allowPrivateAddresses: config.net.allowPrivateAddresses,
        meter: webMeter,
        signal,
        logger: logger.child(name),
        secrets,
        cache: request.isCacheBypassed === true ? NO_CACHE : providerCache('web-fetch', {
          directory: config.cacheDir, clock: request.clock ?? SYSTEM_CLOCK, logger, warn: (message) => warnings.push(message),
        }),
      });
      const context: ProviderContext = {
        settings: config.providers[name],
        meter,
        http,
        webHttp,
        warn: (message) => warnings.push(redact(message, secrets)),
        signal,
        logger: logger.child(name),
      };
      let status: ProviderRunStatus = 'ok';
      let detail: string | null = null;
      let cause: FailureCause | null = null;
      try {
        records.push(...await provider.run(knowledge, context));
      } catch (error) {
        if (error instanceof ProviderError) {
          detail = redact(error.detail, secrets);
          logger.warn(`${name} failed: ${error.status}`, { detail });
          status = error.status;
          cause = error.failureCause;
        } else if (error instanceof BudgetExhaustedError) {
          logger.info(`${name} stopped at the metered call budget`);
          status = meter.calls > 0 ? 'ok' : 'skipped';
          detail = 'stopped at the metered call budget';
        } else if (signal.aborted) {
          logger.warn(`${name} ran out of time`, { error });
          status = 'timeout';
          detail = 'the lookup timed out';
          cause = 'timeout';
        } else {
          detail = redact(error instanceof Error ? error.message : String(error), secrets);
          logger.error(`${name} failed unexpectedly`, { detail, stack: error instanceof Error ? redact(error.stack ?? '', secrets) : null });
          status = 'internal_error';
          cause = 'internal';
        }
      }
      reports.set(name, { name, status, reason: status === 'skipped' ? 'over budget' : null, detail, cause,
        calls: meter.calls + webMeter.calls, cached_calls: meter.cachedCalls + webMeter.cachedCalls, metered_calls: metered ? meter.calls : 0, metered,
      });
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

  const logoCandidates = rankLogoItems(score.fields.logo.evidence.map((entry) => entry.item));
  const logoSource = logoCandidates[0]?.record.source;
  if (requested.has('logo') && request.isDownloadSkipped !== true && logoSource !== undefined && logoSource !== 'query') {
    const meter = new CallMeter(false, budgets);
    const http = createHttpClient({
      transport: request.transport ?? LIVE_TRANSPORT,
      userAgent: userAgent(),
      requestTimeoutMs: config.timeouts.requestMs,
      allowPrivateAddresses: config.net.allowPrivateAddresses,
      meter,
      signal,
      logger: logger.child('logo'),
      secrets,
    });
    await settleLogo(logoCandidates, {
      http, cacheDir: config.cacheDir, isCacheBypassed: request.isCacheBypassed === true, logger: logger.child('logo'), secrets,
      warn: (message) => warnings.push(redact(message, secrets)),
    });
    const report = reports.get(logoSource);
    if (report !== undefined) {
      report.calls += meter.calls;
    }
    score = scoreLookup(records, query, anchor, config.priority);
  }

  return {
    query,
    records,
    reports: PROVIDER_NAMES.map((name) => reports.get(name)).filter((report) => report !== undefined),
    score,
    warnings: [...(request.query.notes ?? []), ...score.warnings, ...warnings],
  };
}

/** One provider's line in a --dry-run plan. */
export interface PlannedProvider {
  name: ProviderName;
  stage: string;
  status: 'would_run' | 'skipped' | 'not_configured';
  reason: string | null;
  metered: boolean;
  /** The most metered calls it could make; 0 when it wouldn't run or isn't metered. */
  maxCalls: number;
}

const HYPOTHETICAL_URL = 'https://hypothetical.invalid/';

/** Pretends a provider found everything it can supply, so later providers' readiness can be judged. */
function assumeFound(knowledge: Knowledge, supplies: readonly FieldName[]): Knowledge {
  const fields: Knowledge['fields'] = { ...knowledge.fields };
  if (supplies.includes('website') && fields.website === undefined) {
    fields.website = { url: HYPOTHETICAL_URL, domain: 'hypothetical.invalid' };
  }
  if (supplies.includes('name') && fields.name === undefined) {
    fields.name = 'hypothetical';
  }
  if (supplies.includes('place_id') && fields.place_id === undefined) {
    fields.place_id = 'hypothetical';
  }
  if (supplies.includes('address') && fields.address === undefined) {
    fields.address = { lines: [], town: 'hypothetical', county: null, postcode: 'hypothetical', country_code: null, formatted: null, lat: null, lon: null };
  }
  if (supplies.includes('phone') && fields.phone === undefined) {
    fields.phone = { e164: '+440000000000', display: 'hypothetical' };
  }
  return { ...knowledge, fields };
}

/** Plans a lookup without making any call: which providers would run, in order, and the most metered calls (--dry-run). */
export function planLookup(request: LookupRequest): { providers: PlannedProvider[]; maxMeteredCalls: number } {
  const { query, config } = request;
  const requested = new Set<FieldName>(request.fields ?? FIELD_NAMES);
  const implementations = new Map(request.providers.map((provider) => [provider.declaration.name, provider]));
  const available = new Set(implementations.keys());
  const order = runOrder(config, requested);
  const planned = new Map<ProviderName, PlannedProvider>();
  const waiting = new Set<ProviderName>();
  let remaining = config.budgets.meteredCallsPerLookup;
  let knowledge: Knowledge = { query, fields: query.website === null ? {} : { website: query.website }, settled: new Set() };

  const plan = (name: ProviderName, isLatePass: boolean): void => {
    const declaration = PROVIDER_DECLARATIONS[name];
    const provider = implementations.get(name);
    const skipped = staticSkip(name, request, requested, available);
    const line = (status: PlannedProvider['status'], reason: string | null, maxCalls = 0): PlannedProvider => (
      { name, stage: declaration.stage, status, reason, metered: declaration.metered, maxCalls }
    );
    const readiness = provider?.readiness(knowledge);
    if (skipped !== null) {
      planned.set(name, line(skipped.status === 'not_configured' ? 'not_configured' : 'skipped', skipped.reason));
    } else if (provider === undefined || readiness === undefined) {
      planned.set(name, line('skipped', 'not available in this version'));
    } else if (readiness.state === 'never' || (readiness.state === 'waiting' && isLatePass)) {
      planned.set(name, line('skipped', readiness.reason));
    } else if (readiness.state === 'waiting') {
      waiting.add(name);
    } else {
      const calls = declaration.metered ? Math.min(provider.maxCalls(knowledge), remaining) : 0;
      if (declaration.metered && calls < 1) {
        planned.set(name, line('skipped', 'over budget'));
      } else {
        remaining -= calls;
        planned.set(name, line('would_run', null, calls));
        knowledge = assumeFound(knowledge, declaration.supplies);
      }
      waiting.delete(name);
    }
  };
  for (const name of order) {
    plan(name, false);
  }
  for (const name of order.filter((candidate) => waiting.has(candidate))) {
    plan(name, true);
  }
  // In run order, so the plan reads top to bottom as the lookup would run.
  const providers = order.map((name) => planned.get(name)).filter((entry) => entry !== undefined);
  return { providers, maxMeteredCalls: providers.reduce((total, entry) => total + entry.maxCalls, 0) };
}

/** One provider's result from `providers check`. */
export interface CheckReport {
  name: ProviderName;
  status: 'ok' | 'skipped' | 'not_configured' | ProviderRunStatus;
  detail: string | null;
}

/** Proves each configured provider's credentials with one cheap live call. Never prints a key (redacted). */
export async function checkProviders(request: Pick<LookupRequest, 'providers' | 'config' | 'logger' | 'transport' | 'only'>): Promise<CheckReport[]> {
  const { config, logger } = request;
  const implementations = new Map(request.providers.map((provider) => [provider.declaration.name, provider]));
  const secrets = configuredSecrets(config);
  const reports: CheckReport[] = [];
  for (const name of PROVIDER_NAMES.filter((candidate) => request.only === undefined || request.only.includes(candidate))) {
    const declaration = PROVIDER_DECLARATIONS[name];
    const settings = config.providers[name];
    const provider = implementations.get(name);
    let report: CheckReport;
    if (!settings.enabled) {
      report = { name, status: 'skipped', detail: 'disabled in config' };
    } else if (declaration.credentialVariable !== null && settings.apiKey === null) {
      report = { name, status: 'not_configured', detail: `set ${declaration.credentialVariable}` };
    } else if (provider === undefined) {
      report = { name, status: 'skipped', detail: 'not available in this version' };
    } else if (provider.check === undefined) {
      report = { name, status: 'ok', detail: 'needs no credentials' };
    } else {
      const meter = new CallMeter(declaration.metered, []);
      const signal = AbortSignal.timeout(config.timeouts.requestMs);
      const http = createHttpClient({
        transport: request.transport ?? LIVE_TRANSPORT, userAgent: userAgent(), requestTimeoutMs: config.timeouts.requestMs,
        allowPrivateAddresses: config.net.allowPrivateAddresses, meter, signal, logger: logger.child(name), secrets,
      });
      const context: ProviderContext = { settings, meter, http, webHttp: http, warn: () => undefined, signal, logger: logger.child(name) };
      try {
        await provider.check(context);
        report = { name, status: 'ok', detail: null };
      } catch (error) {
        if (!(error instanceof ProviderError)) {
          throw error;
        }
        report = { name, status: error.status, detail: redact(error.detail, secrets) };
        logger.warn(`${name} check failed: ${error.status}`, { detail: report.detail });
      }
    }
    reports.push(report);
  }
  return reports;
}
