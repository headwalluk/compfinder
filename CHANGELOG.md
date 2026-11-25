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
- Places with different place IDs are never merged into one, and a record joins only the place it
  shares its strongest key with, so listings that share a building or a switchboard stay apart
  and a tie's fields always describe one place.
- Google searches by the query's phone when it has no postcode or address, and, when no name is
  known (a blocked site, a URL-only row), by the domain's name, keeping only places on that site.
- `identity.chain`: a chain's home page that matches several of its places is the chain, with
  the brand's fields and no one place's address or phone. `identity.co-listed`: listings that
  share one address and phone are one place, not a tie.
- A home page with no location searches Google on the site's name, kept to the site; with no
  name known, the URL's path comes before a page's phone. An unread branch page isn't
  contradicted by an alias URL for it.
- An unread branch page (blocked, timed out or unreadable) is an alias of another URL when one's
  last path segment has all its words in the other's. A place with no website takes the brand of
  a found site that shares its name, so a co-listed place shows the listing that site supports.
  A phrase repeated straight after itself in a name is collapsed.
- A `country` (in a query or the config) must be a real ISO 3166-1 code; `UK` is read as `GB`,
  with a warning.
- "One building" means the same postcode and building number, so branches sharing a US ZIP code
  tie; same-named listings in one building are co-listed. An alias URL (an old scheme, a longer
  slug) never contradicts a branch page, and when the query's site redirects to another domain,
  places on that domain count as on the query's site.
- `robots.txt` redirects are followed to another host. A branch named only by its place takes the
  brand's name. Brave gets `country=ALL` for countries it doesn't support. A home page whose only
  match is a branch's Google listing is `identity.chain`, and a chain's website is the home page.
- An area page that lists several branches ties the branches it links to that Google found. An
  Organization read from another page of the site, when an inner page was asked for, is the head
  office, and a head office's address or phone no longer steers Google's search for a branch.
- Listings with the same name and website page, in one postcode sector and with no differing
  phone, are co-listed. A tied listing whose website is on another site drops out when the
  business's own site agrees with the others.
- A home page's title that spells the domain gives the site's name, so a chain with no name in
  its markup gets its brand name. The chain warning reads right when one place matched.
- A street address (building number and street, abbreviations evened out) links a site's record
  to Google's when one has no postcode. A record with nothing about a place joins its site's
  other records. When one phone fits several listings, the record joins the one it shares the
  street with, and a home page's own marked-up place ranks first. So single-site businesses with
  duplicate Google listings are no longer read as chains.
- Google's website for a namesake is checked: one that redirects to the query's site counts as on
  it, and one whose host doesn't answer is left out rather than contradicting the query.
- `identity.head-office-only`: a branch asked about with only the head office's details is capped at
  30, with a warning. An Organization on the page asked about is the head office when the query's
  name has a place it isn't in.
- A branch page that redirects to another page on the site is reported as gone, and the site's
  loose numbers and postcodes aren't taken as the branch's.
- Every failed provider has a `cause` code (`dns`, `tls_certificate`, `http_404`, …) beside its
  `detail`, so a dead website can be told apart from nothing found.
- `identity.business_status` (and a `business_status` CSV column, and one per candidate): Google's
  trading status for the place, so a permanently closed business can be rejected without reading
  warnings.
- Google's website checks are plain page fetches: no longer metered or counted in its calls, so a
  dry run's "at most" holds. An old URL that redirects to the home page isn't a gone branch page,
  so a small site's own details are kept. A branch named "Crosby Branch" takes the brand's name.
- A connection reset part-way through a compressed response no longer ends the process: it's that
  provider's failure (`cause` `connection_reset`), and a batch carries on. A redirect's unread
  body is closed rather than left open.
- A site's brand name is the one that spells its domain, so a template's leftover Organization
  name no longer names the business; blocks that are only a name aren't places.
- An alias of a branch page can't add a place word (`south`, `upper`, …): Kensington isn't South
  Kensington. A listing with an alias of the branch page beats the head office's home page.
- A query's town that a listing's name leaves out isn't a name mismatch, and an address without a
  postcode agrees with the same street given with one.
- A site's record isn't joined to a place on another website by sharing a postcode or street, so
  a rival in the same building no longer takes the site's own details down with it. On a home
  page, the site's own details that match no place show as conflicts with the leader's.
- A query's town found only in Google's formatted address isn't a name mismatch either.
- Adding the branch's name to a branch page no longer lowers the answer: Google is searched with
  the name and the URL's path before a phone the page showed, which may be a call-tracking number.
- Branch slugs that differ only in their hyphens (`remax-` and `re-max-`) are the same page, and
  a branch page that redirects to its renamed page is read as that page instead of being gone.
- When two names contradict each other with equal backing, the one the query agrees with wins.
- `identity.site-brand-only` (capped at 40): an inner page that gives only the site's own brand,
  as a franchise network's agent page does, no longer passes the network's name as the agent's.
- A schema.org region that is only a country code and a hyphen (`GB-`) is dropped, and a UK
  nation's code (`ENG`, `GB-SCT`) is written as its name.
- An old branch URL that redirects to an alias of itself is a rename too, so Google's listing on
  the page it lands on confirms it.
- A lookup by name and town reaches `identity.independent-agreement` when a search's first result
  is exactly the branch page Google's listing gives. It never breaks a tie between places.
- An Organization that repeats a site's only LocalBusiness (the same phone or postcode) is that
  business, not a chain's head office.
- A double-encoded name (`&amp;amp;`) is decoded fully.
- A query's town found only in a street's name ("7 Blackburn Rd, Accrington") no longer excuses a
  listing's different name, and a name with a place qualifier before the query's place ("South
  Kensington" for "Kensington") is another place.
- In text output, a conflicting phone and each source's phone are shown with their own display.
- From an outside code review:
  - `robots.txt` rules are matched without regular expressions and capped in number and length,
    so a hostile `robots.txt` can't stall the process. Every redirect hop is checked against
    the `robots.txt` of the origin it lands on before it's followed.
  - An API request (one carrying its key in a header) never follows a redirect to another
    origin or to plain HTTP.
  - The address guard reads an IPv6 address's groups, so an embedded IPv4 address is found
    however it's written; 6to4 is checked, and IPv4-compatible and local-use NAT64 addresses are
    refused.
  - A cached response is checked against the current request's redirect and address policy.
    Cache entries are keyed by the full URL, and kept apart for `--allow-private-addresses`.
  - A cache or logo-storage failure (a full disk) is a warning, never a lost lookup. A batch
    line that fails unexpectedly is that line's `lookup.internal_error`, and the batch carries on.
  - Log lines and warnings are redacted centrally, URL userinfo and signed-URL parameters
    included.
  - Batch output waits for stdout to drain, and a closed pipe (`| head`) stops the batch.
  - A dry-run batch's total is capped by `--max-metered-calls-total`, and `--dry-run` with
    `--output=csv` is a usage error.
  - A provider's `calls` include its checks of other sites (Google's website checks); the new
    `metered_calls` counts only the paid calls.
  - The test suite passes on Node 22 as well as 24.
- An address's `formatted` line is always filled: Google's normalised form, or the parts joined.
- Names compare equal regardless of word order, connecting words and plain plurals. Departments
  and parent companies in schema.org markup aren't read as the business.
- A Google Maps `?cid=` link in a site's schema (`hasMap` or `sameAs`) links the site to Google's
  listing for the same place, so they agree even when their phone or address differs.

