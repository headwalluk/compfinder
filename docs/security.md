# Security and good behaviour

This page is for people running compfinder: what it does on the network, what it refuses to
do, and how it treats what it reads.

## Being a good web citizen

When `web-fetch` reads a business's site, it:

- sends an honest User-Agent naming the tool, its version and this project's URL
  (`compfinder/<version> (+https://github.com/headwalluk/compfinder)`), and nothing about you;
- reads `robots.txt` first and honours it. A `robots.txt` that answers 4xx allows everything,
  and one that answers 5xx means the whole site is treated as disallowed, as RFC 9309 says.
  `web_fetch.honour_robots = false` turns this off, at your own responsibility;
- reads only a few pages per lookup (`web_fetch.max_pages`, default 5): the page given, then
  same-site contact, home, branches and about pages. It never follows links off the site, and
  never crawls;
- makes one request at a time, with a timeout per request (`timeouts.request_ms`) and per lookup
  (`timeouts.lookup_ms`);
- stops at bot protection. A 401, 403 or 429, a CDN's protected 503, or a challenge page
  (Cloudflare's "Just a moment…", Imperva, DataDome) is reported as `blocked`. There's no retry
  and no workaround.

`--output=text` with `COMPFINDER_LOG_LEVEL=debug` logs every request: method, URL, status, size
and time taken.

## Refused addresses

So that compfinder can't be used to reach into the network it runs on (SSRF), it refuses:

- any URL that isn't `http` or `https`, or uses a port other than 80 or 443;
- any host that resolves to a private, loopback, link-local, shared (CGNAT), documentation,
  multicast or reserved address, IPv4 or IPv6. That includes IPv4 addresses inside IPv4-mapped
  and NAT64 IPv6 addresses. The check runs on the resolved address **at connect time** and on
  every redirect, so a name that resolves somewhere else on a second lookup is still caught;
- an IP address given directly, checked before any connection.

A refused address is reported as `blocked`. `--allow-private-addresses` (or
`net.allow_private_addresses = true`) turns the guard off, for testing against a local server
only.

Every response has a size cap, and the cap applies to the **decompressed** bytes as they arrive,
so a compressed "bomb" is cut off: 2 MiB for a page, 512 KiB for `robots.txt`, 64 KiB for a web
app manifest, 5 MiB for an image. Redirects are followed at most five times.

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
`config show` shows each as `set` or `unset`. Keys are sent in request headers, and anything
that reaches a log or the output (error details, logged URLs) passes through a redactor that
removes every configured key and any credential-looking query parameter. Never pass a key as a
command-line argument: it would end up in your shell history.
