# compfinder

Repository: public

House style: the headwall-node-ts skill.

## What it is

A deterministic, read-only command-line tool. Given a few facts about a business (a name, a
web address, a postcode), it returns the business's website, address, phone, email, logo, socials
and Google place ID. Every value comes with its sources and a confidence score. Evidence
comes from built-in providers: `web-fetch` (no key needed), `google-places-api`, `searchapi-io`,
`brave-search-api` and `apollo-io`. The tool makes no LLM calls. It's published as
`@headwall/compfinder` under the MIT licence, and the command is `compfinder`.

## Documentation

- `docs/` holds the long-lived documentation, and is what code comments cite
- `dev-notes/` is untracked working material (requirements, design notes, decisions, tracker).
  Never cite it from a tracked file

## Commands

- `npm run check`: typecheck, lint and tests. This must pass before work is called done
- `npm run compfinder -- <command>`: runs the CLI from source through `tsx`
- `./bin/compfinder <command>`: runs the built CLI (`npm run build` first). This is how a
  development build is tried by hand; it isn't `npm link`ed. A released version may also be
  installed globally (`npm install -g @headwall/compfinder`), and both read the same
  `~/.config/compfinder/config.toml`

## CLI shape

Every invocation starts with a command (`find`, `providers`, `config`, `version`, `help`). A
bare business name is a usage error. Output is chosen with `--output=text|json|csv` (default
`text`) in place of the house `--json` default. `json` prints the `{ ok, exitCode, ...data }`
envelope. `csv` is for `find` only. Batch lookups (`find --input`) stream one line, row or
block per lookup. See `docs/cli.md` and `docs/output.md`.

## Configuration

`${XDG_CONFIG_HOME:-~/.config}/compfinder/config.toml`, one TOML table per provider, with
`COMPFINDER_*` environment variables as overrides. There's no `.env` file. `config.sample.toml`
is the documented template for every setting and its env override, and `compfinder config init`
writes it out.

## Runtime dependencies

- `htmlparser2`, `domhandler` and `domutils`: HTML parsing and tree traversal
- `@resvg/resvg-js`: SVG to PNG for logos. It ships a native binary through per-platform
  optional dependencies, and has no install script
- `libphonenumber-js`: phone numbers to E.164
- `smol-toml`: parsing `config.toml`

## Jobs

None. This is a CLI with no schedulers, so no PM2 instance gating applies.

## Exceptions to house style

None.
