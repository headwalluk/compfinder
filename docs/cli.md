# Command line

```
compfinder <command> [options]
```

Every invocation starts with a command. Anything else, such as a business name on its own, is
an unknown command and exits 2.

## Commands

| Command | Does |
|---|---|
| `compfinder providers list` | Lists the built-in providers, and whether each is `configured`, `not-configured` (with what to set) or `disabled`. Makes no network calls |
| `compfinder config init` | Writes a commented config file to the config path. Refuses, with exit 4, if the file already exists. It never overwrites |
| `compfinder config path` | Shows which config file is used, and whether it exists |
| `compfinder config show` | Shows every effective setting and where it came from (`default`, `file`, `env`, `flag`). API keys show only as `set` or `unset`. Accepts the setting flags below, to preview their effect |
| `compfinder version` | Prints the version |
| `compfinder help` | Lists the commands. `compfinder <command> --help` shows one command's usage |

## Options for every command

| Option | Means |
|---|---|
| `--output=text\|json` | `text` (the default) is for people. `json` prints one line of JSON for scripts and agents |
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

With `--output=json`, every command prints exactly one line:

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
| 1 | failure | The command ran and failed. For a lookup, every provider that was tried failed |
| 2 | usage | Unknown command, unknown or invalid option, or an unexpected argument |
| 3 | invalidConfig | Configuration problems, every one listed. Or no provider can serve the request |
| 4 | refused | The command refused to act, for example `config init` when the file already exists |
| 5 | notReady | Not used yet |
