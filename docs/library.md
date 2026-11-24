# Using compfinder as a library

Everything the `compfinder` command does can be called from your own Node code: a lead-cleaning
script, a queue worker, or an HTTP API. The library returns the same result object that
`compfinder find --output=json` prints, so [output.md](output.md) and
[confidence.md](confidence.md) describe it field by field.

compfinder is ESM only and needs Node 22 or later.

```sh
npm install @headwall/compfinder
```

## A first lookup

```ts
import { createFinder } from '@headwall/compfinder';

const finder = createFinder({
  variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY },
});

const result = await finder.find({ name: 'Example Estates', postcode: 'RG1 1AA' });

console.log(result.identity.confidence);   // 0 to 100: how sure it is this is the right business
console.log(result.fields.phone.value);    // '+441184960000', or null
console.log(result.fields.phone.confidence);
console.log(result.fields.phone.sources);  // ['web-fetch', 'google-places-api']
```

`createFinder` validates the settings once. Keep the finder and reuse it: it holds no state
between lookups, and concurrent `find` calls on one finder are safe.

## Settings

A finder takes its settings in one of two ways.

**In code (the default).** Pass `toml`, in the same format as `config.toml`, or `variables`
keyed by the `COMPFINDER_*` names, or both (`variables` wins where they overlap). Every
setting, its TOML key and its variable name are listed in [configuration.md](configuration.md).
Settings passed in code never read the environment or `~/.config/compfinder/config.toml`, so
your application stays in charge of its own configuration:

```ts
const finder = createFinder({
  toml: `
    country = "GB"
    cache_dir = "/var/cache/my-api/compfinder"

    [budgets]
    metered_calls_per_lookup = 3

    [providers.apollo-io]
    enabled = false
  `,
  variables: {
    COMPFINDER_GOOGLE_PLACES_API_KEY: config.googlePlacesApiKey,
    COMPFINDER_BRAVE_SEARCH_API_KEY: config.braveSearchApiKey,
  },
});
```

A variable that is `undefined` is ignored, so you can pass optional keys straight through.

**Like the command.** `createFinder({ fromEnvironment: true })` reads the config file and the
`COMPFINDER_*` environment variables exactly as `compfinder` does, which suits a script running
on a machine that already has the CLI set up.

Invalid settings throw a `ConfigError` whose `problems` array lists every problem at once, so
fail at start-up rather than on the first request:

```ts
import { ConfigError, createFinder } from '@headwall/compfinder';

try {
  finder = createFinder({ variables });
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.problems.join('\n'));
  }
  throw error;
}
```

## Lookup options

`find(query, options)` takes the query keys a batch line takes (`name`, `url`, `address`,
`postcode`, `phone`, `place_id`, `country`; all strings, listed in `QUERY_INPUT_KEYS`) and these
options, each matching a
`find` flag:

| Option | Flag | What it does |
|---|---|---|
| `fields` | `--fields` | Only find these fields, e.g. `['phone', 'address']`. Providers that can't add one are skipped, which saves metered calls |
| `providers` | `--providers` | Use only these providers |
| `exclude` | `--exclude` | Use every provider but these |
| `explain` | `--explain` | Include every piece of evidence in each field, agreeing or not |
| `noCache` | `--no-cache` | Neither read nor write the response cache |
| `noDownload` | `--no-download` | Report logo URLs without downloading the images |
| `budget` | `--max-metered-calls-total` | A shared budget, from `createBudget(n)`, capping metered calls across many lookups |
| `signal` | | An `AbortSignal`. Providers still running when it fires are reported with status `timeout` |

`finder.plan(query, options)` works out which providers would run and the most metered calls
the lookup could make, without calling anything (`--dry-run`). `finder.checkProviders()` makes
one cheap call per configured provider to prove its key (`compfinder providers check`).

## Errors

There are two kinds, and they are handled differently.

- **The query can't be used** (nothing to look up, a malformed URL or phone number, an unknown
  key, a value that isn't a string): `find` and `plan` throw a `QueryError`. The query is checked
  at run time, so a parsed JSON request body can be passed straight in. Its `code` is `input.no_query` or `input.bad_value`, `problems`
  lists every problem, and `error` is the same `{ code, message, detail }` object the CLI
  prints.
- **The lookup ran but providers failed** (a rejected key, a quota, a site that blocks bots):
  nothing is thrown. Each provider's `status` is in `result.providers`, and when no provider
  succeeded, `result.error` is set, with code `lookup.all_failed` or `lookup.no_provider`.

```ts
import { QueryError } from '@headwall/compfinder';

try {
  const result = await finder.find(query);
  if (result.error !== null) {
    console.warn(result.error.message, result.providers.map((provider) => `${provider.name}: ${provider.status}`));
  }
} catch (error) {
  if (!(error instanceof QueryError)) {
    throw error;
  }
  console.warn('Bad row:', error.problems);
}
```

## Example: cleaning a spreadsheet of leads

A list of leads usually has a name and some of a website, a postcode or a phone number, often
out of date or misspelt. This runs four lookups at a time, caps the whole job at 500 metered
calls, and sorts each lead by what it found. The sorting is where your own judgement (or an
LLM's, per row) comes in: the numbers say how well the sources agree, not whether a lead is
worth calling.

```ts
import { createBudget, createFinder, QueryError, type LookupResult } from '@headwall/compfinder';

interface Lead { id: string; name?: string; website?: string; postcode?: string; phone?: string }

const finder = createFinder({ variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY } });
const budget = createBudget(500);
const CONCURRENCY = 4;
const SURE = 100;
const WORTH_CHECKING = 40;

/** Looks one lead up; a row the query can't use comes back as null. */
async function lookUp(lead: Lead): Promise<LookupResult | null> {
  let result: LookupResult | null = null;
  try {
    result = await finder.find(
      { name: lead.name, url: lead.website, postcode: lead.postcode, phone: lead.phone },
      { budget, noDownload: true },
    );
  } catch (error) {
    if (!(error instanceof QueryError)) {
      throw error;
    }
    console.warn(`Lead ${lead.id}: ${error.problems.join(' ')}`);
  }
  return result;
}

/** Runs every lead, a few at a time, keeping results in the leads' order. */
async function lookUpAll(leads: Lead[]): Promise<Array<LookupResult | null>> {
  const results: Array<LookupResult | null> = new Array(leads.length).fill(null);
  let next = 0;
  const worker = async (): Promise<void> => {
    let lead = leads[next];
    while (lead !== undefined) {
      const index = next;
      next += 1;
      results[index] = await lookUp(lead);
      lead = leads[next];
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

const results = await lookUpAll(leads);
for (const [index, lead] of leads.entries()) {
  const result = results[index] ?? null;
  if (result === null || result.identity.confidence === 0) {
    console.log(`${lead.id}: not found`);
  } else if (result.identity.confidence >= SURE && result.warnings.length === 0) {
    console.log(`${lead.id}: confirmed`, result.fields.website.value, result.fields.phone.value);
  } else if (result.identity.confidence >= WORTH_CHECKING) {
    console.log(`${lead.id}: found, needs a look`, result.identity.reasons, result.warnings);
  } else {
    console.log(`${lead.id}: weak or ambiguous`, result.identity.candidates.map((candidate) => candidate.name));
  }
}
console.log(`${budget.spent()} metered calls used`);
```

Things worth reading in each result when deciding what to do with a lead:

- **`identity.rules`** says why the score is what it is. `identity.name-mismatch` means the site
  you gave was confirmed but the lead's name wasn't: often a trading name or a rebrand, and the
  data is still there to check. `identity.tie` means several branches matched equally, and
  `identity.candidates` lists them.
- **`fields.<name>.conflicts`** holds the values that lost, with their sources. An old phone
  number in your spreadsheet shows up here, against the one the sources agree on.
- **`warnings`** are written for a person (or an LLM) to read: a business Google lists as
  closed, a head office returned for a chain, a name that doesn't match.
- Ask for `explain: true` when an agent needs to justify its decision: every field then
  carries each piece of evidence, its source and where it was found.

## Example: an HTTP API

A small JSON endpoint with Fastify (its bundled logger switched off). The finder is created once
at start-up, where a bad setting stops the server; a bad query is a 400, and a lookup where
providers failed is still a 200, because the result says what happened.

```ts
import Fastify from 'fastify';
import { createFinder, QueryError, type QueryInput } from '@headwall/compfinder';

const finder = createFinder({
  toml: '[budgets]\nmetered_calls_per_lookup = 3\n',
  variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: process.env.GOOGLE_PLACES_API_KEY },
});
const LOOKUP_TIMEOUT_MS = 20_000;

const app = Fastify({ logger: false });

app.post<{ Body: QueryInput }>('/lookups', async (request, reply) => {
  let response: unknown;
  try {
    response = await finder.find(request.body, { noDownload: true, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  } catch (error) {
    if (!(error instanceof QueryError)) {
      throw error;
    }
    reply.code(400);
    response = { error: error.error, problems: error.problems };
  }
  return response;
});

await app.listen({ port: 3000 });
```

Points to watch in a server:

- **Pass `noDownload: true`** unless you want logo images on the server's disk. Without it,
  logos are saved under `cache_dir` and `fields.logo.value.path` is a local file path.
- **Set `cache_dir`** to somewhere the service can write. In-code settings don't look at
  `XDG_CACHE_HOME`, so the default is `~/.cache/compfinder` for the user the service runs as.
- **Keep the finder's `config` private.** It holds the API keys. The result never does:
  provider error details are redacted before they reach it.
- **Requests reach the network on your behalf.** `web-fetch` fetches whatever URL is in the
  query, so the same safeguards apply as for the CLI: private and local addresses are refused
  unless `allow_private_addresses` is on, which a public API should never turn on. See
  [security.md](security.md).

## Logging

By default the library writes warnings and errors to stderr, at the configured `log_level`.
Pass `logger` to send them somewhere else. It needs `error`, `warn`, `info`, `debug` (each taking
a message and an optional details object) and `child(tag)`, which returns a logger for one part
of the lookup. To send them to your application's own logger:

```ts
import type { Logger } from '@headwall/compfinder';

/** Sends compfinder's log lines to the application's logger, tagged by component. */
function compfinderLogger(tag = 'compfinder'): Logger {
  return {
    error: (message, details) => appLogger.error(`[${tag}] ${message}`, details),
    warn: (message, details) => appLogger.warn(`[${tag}] ${message}`, details),
    info: (message, details) => appLogger.info(`[${tag}] ${message}`, details),
    debug: (message, details) => appLogger.debug(`[${tag}] ${message}`, details),
    child: (childTag) => compfinderLogger(`${tag}:${childTag}`),
  };
}

const finder = createFinder({ variables, logger: compfinderLogger() });
```

## Types and the schema

The package ships TypeScript declarations. The main types are `Finder`, `FindOptions`,
`QueryInput`, `LookupResult` (and its parts `OutputField`, `OutputEvidence` and
`OutputCandidate`), `ProviderReport`, `LookupPlan` and `CheckReport`. `FIELD_NAMES` and
`PROVIDER_NAMES` list the fields and providers.

The JSON Schema for a result is exported too, for checking results you have stored or passed
between services:

```ts
import schema from '@headwall/compfinder/schema/result-1.0.json' with { type: 'json' };
```

`SCHEMA_VERSION` is the version of the result shape this release returns. It follows the rules
in [output.md](output.md#versioning): a change that could break a reader of the result is a
new major schema version, and a new major package version too. Only what `@headwall/compfinder`
exports is public: importing from inside `dist/` isn't supported and can change in any release.
