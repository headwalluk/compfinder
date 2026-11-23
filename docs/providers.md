# Providers

This page is for people running compfinder: what each provider does, what it needs, and what
it costs. `compfinder providers list` shows which are configured.

| Provider | Needs | Metered | Status in this version |
|---|---|---|---|
| `web-fetch` | nothing | no | available |
| `google-places-api` | `COMPFINDER_GOOGLE_PLACES_API_KEY` | yes | declared, arriving soon |
| `searchapi-io` | `COMPFINDER_SEARCHAPI_IO_API_KEY` | yes | declared, arriving soon |
| `brave-search-api` | `COMPFINDER_BRAVE_SEARCH_API_KEY` | yes | declared, arriving soon |
| `apollo-io` | `COMPFINDER_APOLLO_API_KEY` | yes | declared, arriving soon |

A declared provider that isn't available yet shows as `skipped: not available in this
version` in a lookup's `providers` list.

## How providers run

Providers run in stages, so a later one can use what an earlier one found:

1. **discover**: search providers find the business's website, when none was given;
2. **site**: `web-fetch` reads it;
3. **place**: Google Places matches the business by name and location, or by place ID;
4. **enrich**: Apollo adds organisation details by domain.

A provider waiting for something a later stage finds gets one more chance at the end. For
example, with no search provider, Google may supply the website, and `web-fetch` then reads it.
Free providers run before metered ones. A metered provider is skipped when every field it could
supply is already at confidence 100 (`skip_settled`), or when the lookup's metered-call budget
is used up (`budgets.metered_calls_per_lookup`).

`compfinder find --dry-run` shows the plan for a query (which providers would run, in what
order, and the most metered calls they could make) without making any call.

## web-fetch

Reads the business's own pages. It needs no key, and it's free.

**What it reads**, starting from the URL given (or the website another provider found):

- `robots.txt`, and honours it ([security.md](security.md));
- the page itself, then up to four more pages on the same site. The link scores (highest first)
  are: the page's canonical URL (40), contact pages (30), the home page (25), branch or office
  listings (20), about pages (10). Ties are broken by URL. It stops early once it finds a
  LocalBusiness matching the query's postcode or phone.

**What it extracts:**

| From | Gives |
|---|---|
| schema.org `Organization`, `LocalBusiness` and their subtypes, in JSON-LD (including `@graph`) and microdata | name, address (with `geo`), phone, email, website, logo, `sameAs` social profiles. These are structured evidence |
| Open Graph and Twitter tags | `og:site_name`, `og:image` and `twitter:image` as social images |
| `<link rel="icon">`, `apple-touch-icon` and the web app manifest | icons |
| `tel:` and `mailto:` links, social links | phone, role email and social profiles. These are loose evidence |
| The page text | a postcode, when the page has exactly one |

A LocalBusiness on an inner page is a **branch**. An Organization's own address, on a site that
also lists branches, is the **head office**. The same business repeated on every page counts
once.

**Statuses** it can report: `blocked` (bot protection, `robots.txt`, or a refused address),
`unreadable` (pages with no usable content as served, because they build their content with
JavaScript), `unreachable`, `timeout` or `bad_response`.

**Settings:** `web_fetch.max_pages`, `web_fetch.honour_robots`, `web_fetch.unreadable_text_chars`
([configuration.md](configuration.md)).
