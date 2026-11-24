# Command line

```
compfinder <command> [options]
```

Every invocation starts with a command. Anything else, such as a business name on its own, is
an unknown command and exits 2. `compfinder` with nothing after it prints the help and exits 0.

## Commands

| Command | Does |
|---|---|
| `compfinder find ["Name"] [options]` | Looks up a business (below) |
| `compfinder providers check [provider]` | Proves each configured provider's credentials with one cheap live call, and reports `ok` or a failure status (`auth_failed`, `quota_exceeded`, …). Exits 1 when any check fails. Never prints a key |
| `compfinder providers list` | Lists the built-in providers, and whether each is `configured`, `not-configured` (with what to set) or `disabled`. Makes no network calls |
| `compfinder config init` | Writes a commented config file to the config path. Refuses, with exit 4, if the file already exists. It never overwrites |
| `compfinder config path` | Shows which config file is used, and whether it exists |
| `compfinder config show` | Shows every effective setting and where it came from (`default`, `file`, `env`, `flag`). API keys show only as `set` or `unset`. Accepts the setting flags below, to preview their effect |
| `compfinder version` | Prints the version |
| `compfinder help` | Lists the commands. `compfinder <command> --help` shows one command's usage |

## find

```
compfinder find "Example Estates" --url https://example.com/branches/reading/
compfinder find "Example Estates Reading" --postcode "rg1 1aa" --output=json
compfinder find --url example.com --output=csv > example.csv
```

Give at least one of a name or the options below. A URL or a name plus a place works best.

| Option | Means |
|---|---|
| `"Name"` | The business or branch name, as known (one argument: quote it) |
| `--url=URL` | Its website, ideally the branch's own page. `https://` is added when missing |
| `--address=TEXT`, `--postcode=CODE` | Where it is, as known. A postcode inside the address is found |
| `--phone=NUMBER` | Its phone number, as known |
| `--place-id=ID` | A Google place ID, as known |
| `--country=CC` | The country to assume (also a setting) |
| `--fields=a,b` | Only look for these fields, skipping providers that can't supply them |
| `--providers=a,b` / `--exclude=a,b` | Use only these providers, or all but these |
| `--max-metered-calls=N` | Spend at most N metered calls on this lookup (also a setting) |
| `--dry-run` | Show which providers would run, in what order, and the most metered calls. No calls are made |
| `--explain` | Include every piece of evidence behind each field (text or JSON output) |
| `--no-download` | Report logo URLs without downloading them |
| `--no-cache` | Don't reuse cached responses or logos. A downloaded logo is still stored, because its path is part of the result |
| `--cache-dir=DIR` | Where the response and logo caches live (also a setting) |
| `--output=text\|json\|csv` | `csv` writes a header row and one row per lookup, UTF-8 with a byte-order mark, for spreadsheets |

A lookup that finds nothing still exits 0. The exit code describes the run, not the
confidence. See [output.md](output.md) for the result.

### Batch: find --input

```
compfinder find --input=records.jsonl --output=json > results.jsonl
compfinder find --input=records.jsonl --output=csv > results.csv
cat records.jsonl | compfinder find --input=- --dry-run --output=json
```

Each line of the input is one JSON object, the query for one lookup:

```json
{"id": "crm-1042", "name": "Example Estates", "url": "https://example.com/branches/reading/"}
{"id": "crm-1043", "name": "Example Estates Wokingham", "postcode": "RG40 1AA"}
```

Its keys are `id` (copied back to the result), `name`, `url`, `address`, `postcode`, `phone`,
`place_id` and `country`. The values are strings, and the id may also be a number. Blank lines
are skipped. With `--input`, give no name or query options on the command line. The other
options (`--fields`, `--providers`, `--no-download`, …) apply to every line.

| Option | Means |
|---|---|
| `--input=FILE` | Read queries from FILE, or from stdin with `-` |
| `--concurrency=N` | Run up to N lookups at once, 1 to 16 (default 1). Results are still written in input order |
| `--max-metered-calls-total=N` | Spend at most N metered calls on the whole batch (also a setting). Once they're spent, metered providers are skipped as `over budget` and free ones carry on |
| `--dry-run` | Plan every line without making a call, then report the most metered calls the batch could make, for estimating a bill |

Results stream out as each lookup finishes: one JSON line, one CSV row (after a single header
row), or one text block headed by `[id]` (or `[line N]` when the line has no id). A line that can't be looked up gets an error
in place of a result ([output.md](output.md)), and the batch carries on. A batch exits 0 once it has run, whatever its lines held. It exits 2 when an option is wrong or
the input file can't be read. A summary (lines, lines with errors, metered calls) goes to stderr at
`info`.

## Options for every command

| Option | Means |
|---|---|
| `--output=text\|json` | `text` (the default) is for people. `json` prints one line of JSON for scripts and agents. `find` also takes `csv` |
| `--config=PATH` | Read this config file in place of `~/.config/compfinder/config.toml` |
| `--help` | Show the command's usage |

There's no `--json` flag. Use `--output=json`.

## Setting flags

These override the matching setting for one run (see [configuration.md](configuration.md)):

| Flag | Setting |
|---|---|
| `--country=CODE` | `country` |
| `--cache-dir=DIR` | `cache_dir` |
| `--max-metered-calls=N` | `budgets.metered_calls_per_lookup` |
| `--max-metered-calls-total=N` | `budgets.metered_calls_per_batch` |
| `--allow-private-addresses` | `net.allow_private_addresses` |

## Output

stdout carries only the result. Logs, warnings and errors go to stderr, so JSON output can always
be piped.

With `--output=json`, every command prints exactly one line (except `find --input`, which prints
one line per lookup, described in [output.md](output.md#batch-lines)):

```json
{"ok":true,"exitCode":0, ...}
```

`ok` is `true` when `exitCode` is 0. The rest of the object is the command's data. A failed
command still prints its JSON line, with an `error` and, where there are several, `problems`:

```json
{"ok":false,"exitCode":3,"error":"Invalid configuration","problems":["…","…"]}
```

Text output is for people, and may change in any release. Scripts and agents should use
`--output=json`.

## Exit codes

| Code | Name | Means |
|---|---|---|
| 0 | success | The command ran. For a lookup, finding nothing is still success |
| 1 | failure | The command ran and failed. For a lookup, every provider that was tried failed (`lookup.all_failed`) |
| 2 | usage | Unknown command, unknown or invalid option, or an unexpected argument |
| 3 | invalidConfig | Configuration problems, every one listed. Or no provider can serve the request (`lookup.no_provider`) |
| 4 | refused | The command refused to act, for example `config init` when the file already exists |
| 5 | notReady | Not used yet |
