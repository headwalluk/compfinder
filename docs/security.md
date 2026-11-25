# Security and good behaviour

This page is for people running compfinder: what it does on the network, what it refuses to
do, and how it treats what it reads.

## Being a good web citizen

When `web-fetch` reads a business's site, it:

- sends an honest User-Agent naming the tool, its version and this project's URL
  (`compfinder/<version> (+https://github.com/headwalluk/compfinder)`), and nothing about you;
- reads `robots.txt` first and honours it. A `robots.txt` that answers 404 (or another 4xx)
  allows everything. One that answers 401, 403, 429 or 5xx means the whole site is treated as
  disallowed, and the lookup reports `web-fetch` as `blocked`, following RFC 9309. A `robots.txt`
  that redirects is followed, to another host if need be (an old domain sending everything to a
  new one), up to five redirects, each checked against the refused addresses below. Every
  redirect a page takes is checked too, against the `robots.txt` of the origin it lands on,
  before it's followed: a hop to a disallowed path, or to an origin whose `robots.txt` can't be
  read, isn't followed. Rules are matched without regular expressions, and a group keeps at most
  1,000 rules of up to 512 characters each, so no `robots.txt` can make matching slow.
  `web_fetch.honour_robots = false` turns this off, at your own responsibility;
- reads only a few pages per lookup (`web_fetch.max_pages`, default 5): the page given, then
  contact, home, branches and about pages on the same host (not other subdomains). It never crawls. The only way it leaves
  the site is when the page given redirects to another domain: that domain is then read as the
  business's site (with its own `robots.txt`), and a warning says so. Later pages must stay on
  it;
- makes one request at a time within a lookup, with a timeout per request
  (`timeouts.request_ms`) and per lookup (`timeouts.lookup_ms`). A batch with `--concurrency`
  above 1 runs several lookups at once, and lookups don't wait for each other, even on the same
  site: keep concurrency low for a list of branches on one site;
- stops at bot protection. A 401, 403 or 429, a CDN's protected 503, or a challenge page
  (Cloudflare's "Just a moment…", Imperva, DataDome) is reported as `blocked`. There's no retry
  and no workaround.

`COMPFINDER_LOG_LEVEL=debug` logs every request to stderr, whatever the output format: method,
URL, status, size and time taken.

## Refused addresses

So that compfinder can't be used to reach into the network it runs on (SSRF), it refuses:

- any URL that isn't `http` or `https`, or uses a port other than 80 or 443;
- any host that resolves to a private, loopback, link-local, shared (CGNAT), documentation,
  multicast or reserved address, IPv4 or IPv6. That includes IPv4 addresses inside IPv4-mapped,
  NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) IPv6 addresses, however the address is written.
  The deprecated IPv4-compatible form (`::/96`) and NAT64's local-use prefix (`64:ff9b:1::/48`),
  which can hold an IPv4 address anywhere, are refused outright. The check runs on the resolved address **at connect time** and on
  every redirect, so a name that resolves somewhere else on a second lookup is still caught;
- an IP address given directly, checked before any connection.

A refused address is reported as `blocked`. `--allow-private-addresses` (or
`net.allow_private_addresses = true`) turns the guard off, and lifts the 80 and 443 port limit
too, for testing against a local server only.

Every response has a size cap, and the cap applies to the **decompressed** bytes as they arrive,
so a compressed "bomb" is cut off: 2 MiB for a page, 512 KiB for `robots.txt`, 64 KiB for a web
app manifest, 1 MiB for an API's JSON answer, 5 MiB for an image. An SVG logo over 1 MiB isn't
rendered. Redirects are followed at most five times.

A cached response keeps the redirect hops that led to it. A later request answered from the
cache has those hops checked as a live request's would be (where it may redirect, the refused
addresses, `robots.txt`), so the cache can't let through what the network wouldn't. A request's
cache entry is its full URL, and responses fetched with `--allow-private-addresses` are kept
apart from the rest. If the cache can't be read or written (a full disk), the request is made
live and a warning says so; it never costs the lookup its evidence.

## Untrusted content

Everything compfinder reads from a page or an API is untrusted. It returns only typed fields:
names, addresses, phone numbers, email addresses, URLs and IDs. Each is stripped of markup, of
control characters, and of bidi and zero-width characters, and its length is capped. It never
returns free text from a page: no descriptions, snippets or titles.

That matters when the output goes to an LLM agent: a page saying "ignore your instructions"
can't reach the agent through compfinder. Text output to a terminal is also stripped of escape
sequences, so a page can't drive your terminal.

## Personal data

compfinder looks up organisations, not people.

- An email address is returned only when it's a role address (`info@`, `lettings@`, or a word
  from the business's name or town, such as `reading@`). Anything else, including
  `firstname.lastname@` and a lone first name like `jane@`, is counted in `warnings` and never
  returned.
- A LinkedIn profile under `/in/` belongs to a person. It's counted in `warnings` and never
  returned.

## Credentials

API keys come from `config.toml` or `COMPFINDER_*` environment variables
([configuration.md](configuration.md)). compfinder never prints, logs or caches a key.
`config show` shows each as `set` or `unset`. Keys are sent in request headers, and an API
request never follows a redirect to another origin or to plain HTTP, so a key is only ever sent
to the API it's for. Anything that reaches a log or the output (error details, logged URLs,
warnings) passes through a redactor that removes every configured key, the user and password
part of a URL, and any credential-looking query parameter (`key`, `token`, `signature` and
signed-URL parameters such as `X-Amz-Signature`). Never pass a key as a
command-line argument: it would end up in your shell history.
