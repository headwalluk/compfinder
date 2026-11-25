import { runLookup, planLookup, type LookupRequest } from '../../lookup/engine.js';
import { FIELD_NAMES, isFieldName, type FieldName } from '../../lookup/fields.js';
import { normaliseQuery, type QueryInput } from '../../lookup/query.js';
import { buildResult } from '../../lookup/result.js';
import { ERROR_CODES, outputError } from '../../messages/error-codes.js';
import { isProviderName, PROVIDER_NAMES, type ProviderName } from '../../providers/declarations.js';
import { builtInProviders } from '../../providers/registry.js';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { MAX_CONCURRENCY, runBatch } from '../batch.js';
import { stringFlag, booleanFlag, type ParsedArgs } from '../args.js';
import type { Command, CommandResult } from '../command.js';
import { ExitCode } from '../exit-codes.js';
import { csvHeader, csvRow, UTF8_BOM } from '../output/csv.js';
import { renderLookupText, renderPlanText } from '../output/text.js';

/** File errors that mean the batch input can't be read: a usage problem, not a crash. */
const UNREADABLE_INPUT_CODES: ReadonlySet<string> = new Set(['ENOENT', 'EISDIR', 'EACCES', 'EPERM']);

/** Flags that become the query, mapped to its keys. */
const QUERY_FLAGS: ReadonlyArray<[string, keyof QueryInput]> = [
  ['url', 'url'], ['address', 'address'], ['postcode', 'postcode'], ['phone', 'phone'], ['place-id', 'place_id'],
];

/** Splits a comma-separated flag into trimmed, non-empty items. */
function listFlag(args: ParsedArgs, name: string): string[] | undefined {
  const value = stringFlag(args, name);
  return value === undefined ? undefined : value.split(',').map((item) => item.trim()).filter((item) => item !== '');
}

/** Reads --fields, --providers and --exclude, listing every problem. */
function selectionFlags(args: ParsedArgs): { fields?: FieldName[]; only?: ProviderName[]; exclude?: ProviderName[]; problems: string[] } {
  const problems: string[] = [];
  const fields = listFlag(args, 'fields');
  const only = listFlag(args, 'providers');
  const exclude = listFlag(args, 'exclude');
  for (const field of fields ?? []) {
    if (!isFieldName(field)) {
      problems.push(`--fields: "${field}" isn't a field. Fields are ${FIELD_NAMES.join(', ')}.`);
    }
  }
  for (const name of [...(only ?? []), ...(exclude ?? [])]) {
    if (!isProviderName(name)) {
      problems.push(`"${name}" isn't a provider. Providers are ${PROVIDER_NAMES.join(', ')}.`);
    }
  }
  if (only !== undefined && exclude !== undefined) {
    problems.push('Use --providers or --exclude, not both.');
  }
  return {
    ...(fields === undefined ? {} : { fields: fields.filter(isFieldName) }),
    ...(only === undefined ? {} : { only: only.filter(isProviderName) }),
    ...(exclude === undefined ? {} : { exclude: exclude.filter(isProviderName) }),
    problems,
  };
}

export const findCommand: Command = {
  path: ['find'],
  summary: 'Look up a business: its website, address, phone, email, logo, socials and place ID, with confidence.',
  usage: 'compfinder find ["Business name"] [--url=URL] [--address=TEXT] [--postcode=CODE] [--phone=NUMBER] [--place-id=ID] '
    + '[--country=CC] [--fields=a,b] [--providers=a,b | --exclude=a,b] [--max-metered-calls=N] [--dry-run] [--explain] '
    + '[--no-download] [--no-cache] [--cache-dir=DIR] '
    + '| compfinder find --input=FILE|- [--concurrency=N] [--max-metered-calls-total=N] [options] '
    + '[--output=text|json|csv]',
  maxArguments: 1,
  flags: [
    'url', 'address', 'postcode', 'phone', 'place-id', 'country', 'fields', 'providers', 'exclude',
    'max-metered-calls', 'max-metered-calls-total', 'dry-run', 'explain', 'cache-dir', 'no-cache', 'no-download',
    'allow-private-addresses', 'input', 'concurrency',
  ],
  outputs: ['text', 'json', 'csv'],
  async run(context): Promise<CommandResult> {
    const inputPath = stringFlag(context.args, 'input');
    return inputPath === undefined ? findOne(context) : findBatch(context, inputPath);
  },
};

/** Opens a batch input as lines: a file, or stdin for "-". */
function inputLines(inputPath: string): AsyncIterable<string> {
  const stream = inputPath === '-' ? process.stdin : createReadStream(inputPath, { encoding: 'utf8' });
  return createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
}

/** --dry-run plans calls; a CSV row has no columns for a plan. */
const DRY_RUN_CSV_PROBLEM = '--dry-run needs --output=text or json; CSV has no columns for a plan.';

/** find --input: one lookup per JSONL line, streamed in order (docs/cli.md). */
async function findBatch({ args, config, output, logger, colour, write }: Parameters<Command['run']>[0], inputPath: string): Promise<CommandResult> {
  const selection = selectionFlags(args);
  const problems = [...selection.problems];
  const concurrencyText = stringFlag(args, 'concurrency') ?? '1';
  const concurrency = Number(concurrencyText);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    problems.push(`--concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}; got "${concurrencyText}".`);
  }
  if (args.words[1] !== undefined || QUERY_FLAGS.some(([flag]) => stringFlag(args, flag) !== undefined)) {
    problems.push('With --input, each line is the query: give no name or query options on the command line.');
  }
  if (booleanFlag(args, 'explain') && output === 'csv') {
    problems.push('--explain needs --output=text or json; CSV carries only the chosen values.');
  }
  if (booleanFlag(args, 'dry-run') && output === 'csv') {
    problems.push(DRY_RUN_CSV_PROBLEM);
  }
  let result: CommandResult;
  if (problems.length > 0) {
    result = { exitCode: ExitCode.usage, data: { error: outputError('input.bad_value', problems.join(' ')), problems }, text: problems.join('\n') };
  } else {
    try {
      const summary = await runBatch(inputLines(inputPath), {
        config, logger, output, colour, write, concurrency,
        isExplain: booleanFlag(args, 'explain'),
        isDryRun: booleanFlag(args, 'dry-run'),
        isCacheBypassed: booleanFlag(args, 'no-cache'),
        isDownloadSkipped: booleanFlag(args, 'no-download'),
        ...(selection.fields === undefined ? {} : { fields: selection.fields }),
        ...(selection.only === undefined ? {} : { only: selection.only }),
        ...(selection.exclude === undefined ? {} : { exclude: selection.exclude }),
      });
      const calls = booleanFlag(args, 'dry-run') ? `at most ${summary.meteredCalls}` : String(summary.meteredCalls);
      logger.info(`Batch: ${summary.lines} lines, ${summary.errors} with errors, ${calls} metered calls.`);
      result = { exitCode: ExitCode.success, data: { ...summary }, text: '', isStreamed: true };
    } catch (error) {
      if (!UNREADABLE_INPUT_CODES.has((error as NodeJS.ErrnoException).code ?? '')) {
        throw error;
      }
      const problem = `Can't read the input file ${inputPath}: ${(error as Error).message}`;
      result = { exitCode: ExitCode.usage, data: { error: outputError('input.bad_value', problem), problems: [problem] }, text: problem };
    }
  }
  return result;
}

/** find with a query on the command line: one lookup. */
async function findOne({ args, config, output, logger, colour }: Parameters<Command['run']>[0]): Promise<CommandResult> {
  const input: QueryInput = { name: args.words[1] };
  for (const [flag, key] of QUERY_FLAGS) {
    const value = stringFlag(args, flag);
    if (value !== undefined) {
      input[key] = value;
    }
  }
  const { query, problems } = normaliseQuery(input, config.country);
  const selection = selectionFlags(args);
  const allProblems = [...problems, ...selection.problems];
  const isExplain = booleanFlag(args, 'explain');
  if (isExplain && output === 'csv') {
    allProblems.push('--explain needs --output=text or json; CSV carries only the chosen values.');
  }
  if (booleanFlag(args, 'dry-run') && output === 'csv') {
    allProblems.push(DRY_RUN_CSV_PROBLEM);
  }
  let result: CommandResult;

  if (allProblems.length > 0) {
    const code = problems.some((problem) => problem.startsWith('Give at least one')) ? 'input.no_query' : 'input.bad_value';
    result = { exitCode: ExitCode.usage, data: { error: outputError(code, allProblems.join(' ')), problems: allProblems }, text: allProblems.join('\n') };
  } else {
    const request: LookupRequest = {
      query,
      providers: builtInProviders(config),
      config,
      logger,
      isCacheBypassed: booleanFlag(args, 'no-cache'),
      isDownloadSkipped: booleanFlag(args, 'no-download'),
      ...(selection.fields === undefined ? {} : { fields: selection.fields }),
      ...(selection.only === undefined ? {} : { only: selection.only }),
      ...(selection.exclude === undefined ? {} : { exclude: selection.exclude }),
    };
    if (booleanFlag(args, 'dry-run')) {
      const plan = planLookup(request);
      result = {
        exitCode: ExitCode.success,
        data: { dry_run: true, providers: plan.providers, max_metered_calls: plan.maxMeteredCalls },
        text: renderPlanText(plan.providers, plan.maxMeteredCalls),
      };
    } else {
      const lookup = buildResult(await runLookup(request), { isExplain });
      const exitCode = lookup.error === null ? ExitCode.success : ERROR_CODES[lookup.error.code].exitCode;
      let text: string;
      if (output === 'csv') {
        text = `${UTF8_BOM}${csvHeader()}${csvRow(lookup, null)}`;
      } else {
        text = renderLookupText(lookup, colour);
      }
      result = { exitCode, data: { ...lookup }, text };
    }
  }
  return result;
}
