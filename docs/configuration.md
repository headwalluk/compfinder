# Configuration

compfinder runs with no configuration at all. It then uses only `web-fetch`, which needs no key.
Configuration adds API keys for the other providers and changes defaults.

## Where settings come from

From lowest to highest precedence:

1. built-in defaults;
2. the config file;
3. `COMPFINDER_*` environment variables;
4. command-line flags.

`compfinder config show` prints every effective setting and which of these it came from. API
keys are shown only as `set` or `unset`.

## The config file

The file is TOML, at `${XDG_CONFIG_HOME:-~/.config}/compfinder/config.toml`. To use another
file, pass `--config PATH` or set `COMPFINDER_CONFIG`. A file named that way must exist. A
missing file at the default path just means the defaults apply.

`compfinder config init` writes a commented template there, listing every setting at its
default. It creates the directory with mode `0700` and the file with mode `0600`. It never
overwrites an existing file. `compfinder config path` shows which file is in use.

The file can hold API keys, so keep it readable by you alone (`chmod 600`). If it holds a key
and other users can read it, compfinder logs a warning on every run.

- Keys are `snake_case`. Settings are grouped into tables: `[budgets]`, `[web_fetch]`, and one
  `[providers.<name>]` table per provider.
- `~` at the start of a path means your home directory. A relative path in the file is relative
  to the file's own directory. One given in a variable or flag is relative to the current
  directory.
- An unknown key, table or `COMPFINDER_` variable is reported as an error, because it's almost
  always a typo.

## Errors

compfinder checks every source before doing anything, and reports **every** problem at once,
each naming its source. Then it exits with code 3:

```
Invalid configuration:
  - /home/you/.config/compfinder/config.toml: web_fetch.max_pages must be a whole number from 1 to 20; got 50.
  - COMPFINDER_LOG_LEVEL must be one of warn, info, debug; got "verbose".
  - Unknown setting COMPFINDER_GOOGLE_PLACE_API_KEY. Check for a typo.
```

A value that's set but invalid is always an error. It's never quietly replaced by the default.
An API key that's set but empty is an error too. Remove the key to leave a provider unconfigured.

## Settings

| Setting | Default | Environment | Flag | Meaning |
|---|---|---|---|---|
| `country` | `"GB"` | `COMPFINDER_COUNTRY` | `--country` | Two-letter country code to prefer when a lookup doesn't give one |
| `log_level` | `"info"` | `COMPFINDER_LOG_LEVEL` | | `warn`, `info` or `debug`. Errors are always written. Logs go to stderr |
| `cache_dir` | `${XDG_CACHE_HOME:-~/.cache}/compfinder` | `COMPFINDER_CACHE_DIR` | `--cache-dir` | Where the logo and response caches live. Safe to delete at any time |
| `skip_settled` | `true` | | | Skip a metered provider when every field it could supply is already at confidence 100 |
| `budgets.metered_calls_per_lookup` | `5` | | `--max-metered-calls` | Most metered provider calls one lookup may make, 0 to 100. `0` means free providers only |
| `budgets.metered_calls_per_batch` | `0` | | `--max-metered-calls-total` | Most metered calls a whole batch may make. `0` means no limit |
| `timeouts.request_ms` | `10000` | | | Longest a single request may take, 1000 to 120000 ms |
| `timeouts.lookup_ms` | `30000` | | | Longest a whole lookup may take, 1000 to 600000 ms. Not less than `request_ms` |
| `web_fetch.max_pages` | `5` | | | Most pages read from a business's site per lookup, 1 to 20 |
| `web_fetch.honour_robots` | `true` | | | Honour the site's `robots.txt` |
| `web_fetch.unreadable_text_chars` | `200` | | | A page with less visible text than this and no structured data is reported as unreadable |
| `discover.directory_hosts` | directories, social networks and property portals | | | Hosts never taken as a business's own website. See the template for the full list |
| `net.allow_private_addresses` | `false` | | `--allow-private-addresses` | Let requests reach private, loopback and link-local addresses. For testing only |
| `priority.<field>` | see below | | | Provider order for a field |

### Priority

`priority.name`, `priority.website`, `priority.address`, `priority.phone`, `priority.email`,
`priority.logo`, `priority.place_id` and `priority.socials` each take a list of providers.
Priority decides which value is shown when sources disagree and nothing else settles it, and
which providers are called first under a budget. It never changes a confidence score. The
providers you list come first, in your order, and the rest follow in the default order. A
provider that can't supply the field is an error.

| Field | Default order |
|---|---|
| `name` | web-fetch, google-places-api |
| `website` | web-fetch, google-places-api, brave-search-api |
| `address` | google-places-api, web-fetch |
| `phone` | web-fetch, google-places-api |
| `email` | web-fetch |
| `logo` | web-fetch |
| `place_id` | google-places-api |
| `socials` | web-fetch |

## Providers

Each provider has its own table. A provider that needs a key is configured once the key is set,
in the file or in its environment variable (the variable wins). `enabled = false` switches a
provider off without removing its key.

| Provider | Key setting | Environment | Metered |
|---|---|---|---|
| `web-fetch` | none needed | | no |
| `google-places-api` | `providers.google-places-api.api_key` | `COMPFINDER_GOOGLE_PLACES_API_KEY` | yes |
| `brave-search-api` | `providers.brave-search-api.api_key` | `COMPFINDER_BRAVE_SEARCH_API_KEY` | yes |

Every provider also has `providers.<name>.enabled`, which defaults to `true`.

```toml
[providers.google-places-api]
api_key = "…"

[providers.brave-search-api]
enabled = false
```

`compfinder providers list` shows each provider as `configured`, `not-configured` (with what to
set) or `disabled`.

## Other environment variables

| Variable | Meaning |
|---|---|
| `COMPFINDER_CONFIG` | The config file to read, in place of the default path |
| `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` | Standard base directories for the config file and the cache |
| `NO_COLOR` | Set to anything to turn off colour in text output |
