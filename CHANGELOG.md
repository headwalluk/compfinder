# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The `compfinder` command, with `--output=text|json` and `--help` on every command.
- `compfinder providers list`: the built-in providers and whether each is configured, with no
  network calls.
- `compfinder config init`, `config path` and `config show`: write the commented config
  template, find the config file in use, and see every effective setting and where it came from.
- Configuration from `~/.config/compfinder/config.toml`, with `COMPFINDER_*` environment
  variables and command-line flags as overrides. Every problem is reported at once.
- `compfinder find`: look up a business by name, URL, address, postcode, phone or place ID, with
  `--output=text|json|csv`, `--fields`, `--providers`/`--exclude`, `--max-metered-calls`,
  `--dry-run` and `--explain`. The JSON output follows `schema/result-1.0.json`, documented in
  `docs/output.md`, and every confidence rule is in `docs/confidence.md`.
- Batch lookups: `compfinder find --input=FILE` (or `-` for stdin) reads one JSON query per line
  and streams results in input order, as JSON lines, CSV rows or text blocks, with
  `--concurrency`, a whole-batch budget (`--max-metered-calls-total`) and `--dry-run` costing.
- The `web-fetch` provider: reads a business's own pages (schema.org JSON-LD and microdata,
  Open Graph, icons, the web app manifest, `tel:`/`mailto:` and social links), honours
  `robots.txt`, stops at bot protection, and reports pages that build their content with
  JavaScript as unreadable.
- The `google-places-api` provider: Place Details for a known place ID, otherwise one Text Search
  for the best name and location known. It supplies the place ID, Google's normalised address,
  phone and website, and warns when Google lists a place as closed.
- The `brave-search-api` provider finds a business's website when none was given, skipping
  directories and portals.
- `compfinder providers check [provider]`: one cheap live call per configured provider, to prove
  its credentials work.
- Logos: the best candidate is downloaded, identified by its bytes, measured, converted to PNG
  when it's an SVG, and stored in the logo cache. A failed candidate falls back to the next
  (`--no-download` skips this).
- A response cache for web pages and `robots.txt`, so repeated lookups cost no requests
  (`--no-cache` bypasses it). Each provider's `cached_calls` shows how many requests it saved.
- Network safeguards: refuses private and reserved addresses at connect time and on every
  redirect, caps response sizes after decompression, and sends an honest User-Agent
  (`docs/security.md`).
- The name in a query forgives one typo in each word of five letters or more, so a misspelt name
  no longer rejects the business it plainly means.
- A query whose website is confirmed but whose name isn't is kept rather than dropped, under
  `identity.name-mismatch`: capped at 40, with a warning giving both names.
- A library API: `import { createFinder } from '@headwall/compfinder'`, with settings passed in
  code, `find`, `plan` and `checkProviders`, TypeScript declarations, and the result schema
  exported as `@headwall/compfinder/schema/result-1.0.json`. See `docs/library.md`.
- On sites with no location markup, a page's own phone and postcode are used first, and loose
  details that list many places (every branch's number in a footer) are treated as a listing,
  not as one business's details, with a warning.
- Places that match a query equally tie, however many sources back each one, and Google searches
  with the query's own location first: a name and a town with several branches is a tie, not
  whichever branch another provider happened to find.
- `Co`, `Company` and `& Co` are compared as legal suffixes. When every candidate is rejected,
  the reason names each one and what it contradicted.
- `web-fetch` reads only the start page's own host, honours `<base href>`, and decodes HTML
  character references in text. Tracking parameters are removed from URLs.
- `compfinder --version`. The batch summary's error count includes lookups that failed.
- A Google Maps `?cid=` link in a site's schema (`hasMap` or `sameAs`) links the site to Google's
  listing for the same place, so they agree even when their phone or address differs.

