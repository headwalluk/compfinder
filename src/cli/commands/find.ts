import { runLookup, planLookup, type LookupRequest } from '../../lookup/engine.js';
import { FIELD_NAMES, isFieldName, type FieldName } from '../../lookup/fields.js';
import { normaliseQuery, type QueryInput } from '../../lookup/query.js';
import { buildResult } from '../../lookup/result.js';
import { ERROR_CODES, outputError } from '../../messages/error-codes.js';
import { isProviderName, PROVIDER_NAMES, type ProviderName } from '../../providers/declarations.js';
import { builtInProviders } from '../../providers/registry.js';
import { stringFlag, booleanFlag, type ParsedArgs } from '../args.js';
import type { Command, CommandResult } from '../command.js';
import { ExitCode } from '../exit-codes.js';
import { csvHeader, csvRow, UTF8_BOM } from '../output/csv.js';
import { renderLookupText, renderPlanText } from '../output/text.js';

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
    + '[--output=text|json|csv]',
  maxArguments: 1,
  flags: [
    'url', 'address', 'postcode', 'phone', 'place-id', 'country', 'fields', 'providers', 'exclude',
    'max-metered-calls', 'dry-run', 'explain', 'cache-dir', 'no-cache', 'no-download', 'allow-private-addresses',
  ],
  outputs: ['text', 'json', 'csv'],
  async run({ args, config, output, logger, colour }): Promise<CommandResult> {
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
  },
};
