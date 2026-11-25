import type { Config } from '../config.js';
import { CallBudget } from '../lookup/budget.js';
import { planLookup, runLookup, type LookupRequest } from '../lookup/engine.js';
import type { FieldName } from '../lookup/fields.js';
import { normaliseQuery, readQueryInput, type QueryInput } from '../lookup/query.js';
import { buildResult } from '../lookup/result.js';
import type { Logger } from '../logger.js';
import { outputError, type ErrorCode, type OutputError } from '../messages/error-codes.js';
import type { ProviderName } from '../providers/declarations.js';
import { builtInProviders } from '../providers/registry.js';
import type { OutputFormat } from './command.js';
import { csvHeader, csvRow, UTF8_BOM } from './output/csv.js';
import { renderLookupText, renderPlanText } from './output/text.js';

/** Keys a batch line may have besides the query's. */
const LINE_KEYS = ['id'] as const;
/** Upper bound on --concurrency: lookups in flight at once. */
export const MAX_CONCURRENCY = 16;

export interface BatchOptions {
  config: Config;
  logger: Logger;
  output: OutputFormat;
  colour: boolean;
  isExplain: boolean;
  isDryRun: boolean;
  isCacheBypassed: boolean;
  isDownloadSkipped: boolean;
  fields?: FieldName[];
  only?: ProviderName[];
  exclude?: ProviderName[];
  concurrency: number;
  /** Writes one finished lookup's output to stdout. */
  write(text: string): Promise<void>;
}

export interface BatchSummary {
  lines: number;
  errors: number;
  meteredCalls: number;
}

/** What one line produced: a finished lookup, a dry-run plan, or an error. */
type LineOutcome =
  | { kind: 'result'; id: string | null; result: ReturnType<typeof buildResult> }
  | { kind: 'plan'; id: string | null; plan: ReturnType<typeof planLookup> }
  | { kind: 'error'; id: string | null; error: OutputError; problems: string[] };

/** Reads a batch line into query input, or the error it is. */
function parseLine(line: string): { id: string | null; input: QueryInput | null; error: ErrorCode | null; problems: string[] } {
  let parsed: unknown;
  let error: ErrorCode | null = null;
  const problems: string[] = [];
  try {
    parsed = JSON.parse(line);
  } catch (parseError) {
    if (!(parseError instanceof SyntaxError)) {
      throw parseError;
    }
    error = 'input.bad_json';
    problems.push(parseError.message);
  }
  const record = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  const rawId = record?.id;
  const id = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : null;
  let input: QueryInput | null = null;
  if (error === null && record === null) {
    error = 'input.bad_value';
    problems.push('Each line must be a JSON object.');
  } else if (record !== null) {
    const read = readQueryInput(record, LINE_KEYS);
    problems.push(...read.problems);
    input = read.input;
    error = problems.length > 0 ? 'input.bad_value' : null;
  }
  return { id, input, error, problems };
}

/** Formats one line's outcome for the chosen output. */
function format(outcome: LineOutcome, options: BatchOptions, lineNumber: number): string {
  const heading = `[${outcome.id ?? `line ${lineNumber}`}]`;
  let text: string;
  if (options.output === 'csv') {
    text = outcome.kind === 'result' ? csvRow(outcome.result, outcome.id) : csvRow(null, outcome.id, outcome.kind === 'error' ? outcome.error.code : null);
  } else if (options.output === 'json') {
    const body = outcome.kind === 'result'
      ? { id: outcome.id, ok: outcome.result.error === null, ...outcome.result }
      : outcome.kind === 'plan'
        ? { id: outcome.id, ok: true, dry_run: true, providers: outcome.plan.providers, max_metered_calls: outcome.plan.maxMeteredCalls }
        : { id: outcome.id, ok: false, error: outcome.error, problems: outcome.problems };
    text = `${JSON.stringify(body)}\n`;
  } else if (outcome.kind === 'result') {
    text = `${renderLookupText(outcome.result, options.colour, heading)}\n\n`;
  } else if (outcome.kind === 'plan') {
    text = `${heading}\n${renderPlanText(outcome.plan.providers, outcome.plan.maxMeteredCalls)}\n\n`;
  } else {
    text = `${heading}\n  ${outcome.error.message} ${outcome.problems.join(' ')}\n\n`;
  }
  return text;
}

/** Runs one batch line to its outcome; an unexpected failure is that line's error, never the batch's. */
async function runLineSafely(line: string, options: BatchOptions, batchBudget: CallBudget): Promise<LineOutcome> {
  let outcome: LineOutcome;
  try {
    outcome = await runLine(line, options, batchBudget);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.logger.error('A batch line failed unexpectedly', { error });
    outcome = { kind: 'error', id: parseLine(line).id, error: outputError('lookup.internal_error', detail), problems: [detail] };
  }
  return outcome;
}

/** Runs one batch line to its outcome. */
async function runLine(line: string, options: BatchOptions, batchBudget: CallBudget): Promise<LineOutcome> {
  const parsed = parseLine(line);
  let outcome: LineOutcome;
  if (parsed.error !== null || parsed.input === null) {
    outcome = { kind: 'error', id: parsed.id, error: outputError(parsed.error ?? 'input.bad_value', parsed.problems.join(' ')), problems: parsed.problems };
  } else {
    const { query, problems } = normaliseQuery(parsed.input, options.config.country);
    if (problems.length > 0) {
      const code = problems.some((problem) => problem.startsWith('Give at least one')) ? 'input.no_query' : 'input.bad_value';
      outcome = { kind: 'error', id: parsed.id, error: outputError(code, problems.join(' ')), problems };
    } else {
      const request: LookupRequest = {
        query,
        providers: builtInProviders(options.config),
        config: options.config,
        logger: options.logger,
        batchBudget,
        isCacheBypassed: options.isCacheBypassed,
        isDownloadSkipped: options.isDownloadSkipped,
        ...(options.fields === undefined ? {} : { fields: options.fields }),
        ...(options.only === undefined ? {} : { only: options.only }),
        ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      };
      outcome = options.isDryRun
        ? { kind: 'plan', id: parsed.id, plan: planLookup(request) }
        : { kind: 'result', id: parsed.id, result: buildResult(await runLookup(request), { isExplain: options.isExplain }) };
    }
  }
  return outcome;
}

/** Runs every line, up to `concurrency` at once, writing each result as soon as all earlier ones are written. */
export async function runBatch(lines: AsyncIterable<string>, options: BatchOptions): Promise<BatchSummary> {
  const limit = options.config.budgets.meteredCallsPerBatch;
  const batchBudget = new CallBudget(limit === 0 ? null : limit);
  const pending = new Map<number, Promise<LineOutcome>>();
  const summary: BatchSummary = { lines: 0, errors: 0, meteredCalls: 0 };
  let nextToWrite = 0;

  /** Waits for the next line in order, writes it, and counts it. */
  const flushNext = async (): Promise<void> => {
    const outcome = await pending.get(nextToWrite);
    pending.delete(nextToWrite);
    if (outcome !== undefined) {
      await options.write(format(outcome, options, nextToWrite + 1));
      summary.errors += outcome.kind === 'error' || (outcome.kind === 'result' && outcome.result.error !== null) ? 1 : 0;
      summary.meteredCalls += outcome.kind === 'plan' ? outcome.plan.maxMeteredCalls : 0;
    }
    nextToWrite += 1;
  };

  if (options.output === 'csv') {
    await options.write(`${UTF8_BOM}${csvHeader()}`);
  }
  for await (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    pending.set(summary.lines, runLineSafely(line, options, batchBudget));
    summary.lines += 1;
    while (pending.size >= options.concurrency) {
      await flushNext();
    }
  }
  while (pending.size > 0) {
    await flushNext();
  }
  // A dry run's per-line plans don't share the batch's budget, so their sum is capped by it here.
  summary.meteredCalls = options.isDryRun ? Math.min(summary.meteredCalls, limit === 0 ? Infinity : limit) : batchBudget.spent();
  return summary;
}
