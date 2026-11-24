# Development

This page is for people working on compfinder's code.

## Setup

Node 22 or later, then:

```sh
npm install
npm run check                          # typecheck, lint and every test: the gate before calling work done
npm run compfinder -- find --url example.com   # the CLI from source, through tsx
npm run build && ./bin/compfinder ...  # the built CLI from dist/
```

House style is enforced by lint: the house plugin in `tools/eslint-plugin-house/` (no `return`
in a loop, no `return` in `forEach`, no swallowed `catch`), and project rules in
`eslint.config.js`. Only `src/net/` may import `node:http`, `node:https`, `node:net` or
`node:dns`. `Date.now()` and `new Date()` are only allowed in the logger and the lookup clock,
so output stays deterministic.

## Layout

```
src/index.ts         the library's public API (docs/library.md); nothing else is a contract
src/config.ts        the only reader of process.env and config.toml
src/cli/             commands, argument parsing, output renderers (text, csv)
src/lookup/          query normalisation, the engine, budgets, the result builder
src/scoring/         linking records into candidates, identity, field rules (docs/confidence.md)
src/normalise/       postcodes (per country), phone, URL, names, email, social profiles, untrusted text
src/net/             the guarded HTTP client, address guard, robots.txt, charset, redaction
src/providers/       declarations, the registry, and one folder per provider
schema/              the published JSON Schema for --output=json
scripts/             gen-schema-types.ts regenerates web-fetch's schema.org type list; calibrate.ts records and replays live batches
tests/               node:test suites, helpers, and fixtures (invented businesses on example.com)
```

## How a lookup flows

`find` normalises the query, then `runLookup` (`src/lookup/engine.ts`) runs providers in stage
order. After each provider, the engine re-scores everything found so far (`scoreLookup`), so the
next provider sees the best value of each field, and the engine can skip metered providers whose
fields are already settled. Providers run one at a time in a fixed order, so the same responses
always give the same output. `buildResult` turns the final score into the schema 1.0 shape.

## Providers

A provider (`src/providers/contract.ts`) has a declaration (stage, metered, the fields it
supplies, its credential variable), and `readiness`, `maxCalls` and `run` methods, plus an
optional `check` that `providers check` calls to prove a key cheaply.

- `run` returns **records**: everything it found, each with an `origin` (the independence key),
  a `scope` (`brand` or `location`) and a `role`. It never decides which record is right; that's
  the scorer's job.
- Every network call goes through `context.http`. That client applies the address guard, byte
  caps, timeouts and redirect checks, counts calls on the meter, and debits the budget for
  metered providers.
- Expected failures throw `ProviderError(status, detail)`. Anything else thrown is reported as
  `internal_error` and logged with its stack.
- Every string from outside passes through `sanitiseText` before it becomes evidence.

To add one: declare it in `src/providers/declarations.ts`, add its settings to
`src/config.ts` and `config.sample.toml`, implement it in its own folder, register it in
`src/providers/registry.ts`, and document it in `docs/providers.md`. Tests keep the
declarations, default priorities, sample config and docs in step.

## Tests

`npm test` runs everything offline, with no keys.

- **Scoring**: hand-built records (`tests/helpers/records.ts`). Every rule ID needs a test, and
  a test fails when one has none.
- **Engine**: stub providers (`tests/helpers/stub-providers.ts`).
- **Network**: a real local HTTP server on 127.0.0.1, covering redirects, compression bombs,
  timeouts and the address guard.
- **Providers**: the fixture transport (`tests/helpers/fixture-transport.ts`). It answers from
  `tests/fixtures/` by URL, and records any request with no fixture, so a test can assert that
  none was missed. Fixture sites use invented businesses on `example.com`, Ofcom drama numbers
  (`0118 496 xxxx`) and documentation IP ranges, never real data.
- **CLI**: the real CLI as a child process, with an empty temporary home. Tests whose own server
  must answer the CLI use `runCliAsync`, because a synchronous spawn would block that server.
- **Docs**: tests check that every setting, flag, exit code, error code, provider status and
  confidence rule is documented, and that every `docs/` page cited from the source exists.

## Calibration

Fixtures test the rules; calibration tests them against real businesses. `scripts/calibrate.ts`
records a batch's live HTTP exchanges and replays them later with no network calls, so a change
to scoring or extraction can be checked against real sites and real API answers for free:

```sh
npx tsx scripts/calibrate.ts record recordings/<set>/input.jsonl recordings/<set>
npx tsx scripts/calibrate.ts replay recordings/<set>/input.jsonl recordings/<set>
```

`record` bypasses the cache and makes every call for real, metered ones included. `replay`
answers each request from the recording, and lists any request that wasn't recorded (a change
that asks Google something new needs a fresh `record`). Both write one result line per input
line, with `--explain` evidence, to `recordings/<set>/results-<mode>.jsonl`.

Recordings hold third-party pages and API answers, so `recordings/` is never committed. Bodies
are stored decoded, and any API key a response echoes is redacted; request headers, which carry
the keys, aren't stored.

## Regenerating the schema.org types

`web-fetch` recognises business markup by schema.org type. The list of Organization and
LocalBusiness subtypes is committed in `src/providers/web-fetch/schema-org-types.json`, so the
build never needs the network. To refresh it:

```sh
curl -o /tmp/schemaorg.jsonld https://schema.org/version/latest/schemaorg-current-https.jsonld
npx tsx scripts/gen-schema-types.ts /tmp/schemaorg.jsonld
```
