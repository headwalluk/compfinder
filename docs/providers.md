# Providers

This page is for people running compfinder: what each provider does, what it needs, and what
it costs. `compfinder providers list` shows which are configured.

| Provider | Needs | Metered |
|---|---|---|
| `web-fetch` | nothing | no |
| `google-places-api` | `COMPFINDER_GOOGLE_PLACES_API_KEY` | yes |
| `brave-search-api` | `COMPFINDER_BRAVE_SEARCH_API_KEY` | yes |

## How providers run

Providers run in stages, so a later one can use what an earlier one found:

1. **discover**: Brave Search finds the business's website, when none was given;
2. **site**: `web-fetch` reads it;
3. **place**: Google Places matches the business by name and location, or by place ID.

A provider waiting for something a later stage finds gets one more chance at the end. For
example, with no search provider, Google may supply the website, and `web-fetch` then reads it.
Within a stage, free providers run before metered ones. A metered provider is skipped when every field it could
supply is already at confidence 100 (`skip_settled`), or when the lookup's metered-call budget
is used up (`budgets.metered_calls_per_lookup`).

`compfinder find --dry-run` shows the plan for a query (which providers would run, in what
order, and the most metered calls they could make) without making any call.

## web-fetch

Reads the business's own pages. It needs no key, and it's free.

**What it reads**, starting from the URL given (or the website another provider found):

- `robots.txt`, and honours it ([security.md](security.md));
- the page itself, then up to `web_fetch.max_pages - 1` more pages on the same host (four, by
  default). The link scores (highest first)
  are: the page's canonical URL (40), contact pages (30), the home page (25), branch or office
  listings (20), about pages (10). Ties are broken by URL. It stops early once it finds a
  LocalBusiness matching the query's postcode or phone.

**What it extracts:**

| From | Gives |
|---|---|
| schema.org `Organization`, `LocalBusiness` and their subtypes, in JSON-LD (including `@graph`) and microdata | name, address (with `geo`), phone, email, website, logo, `sameAs` social profiles, and a Google Maps `?cid=` link in `hasMap` or `sameAs`. These are structured evidence |
| Open Graph and Twitter tags | the site's name from `og:site_name` (loose evidence), and `og:image` and `twitter:image` as social images |
| The page title | for a home page asked about, with no `og:site_name`, the part of the title that spells the domain (`… \| PureGym` on `puregym.com`), as the site's name (loose evidence). It isn't taken for an inner page, where a name steers Google's search |
| `<link rel="icon">`, `apple-touch-icon`, and the web app manifest when the site has no schema.org logo | icons |
| `tel:` and `mailto:` links, social links | phone, role email and social profiles. These are loose evidence |
| The page text | a postcode, when the page has exactly one |

"The same host" means the start page's own host, with or without `www.`: links to other
subdomains (`staging.example.com`) aren't followed. Relative links resolve against the page's
`<base href>` when it has one.

Organisations written inline under `department`, `parentOrganization`, `subOrganization`,
`member` or `memberOf` are other organisations (a Sales department, a parent company), and
aren't read as this business. One those properties point to by `@id` is read where it's defined.

A branch whose markup names it only by its place (a garden centre called "Oxford", every word of
the name in its own address) takes the site's brand name in front: "Notcutts Garden Centres
Oxford". A postcode written at the end of a street line isn't repeated. Cloudflare's own links
(`/cdn-cgi/`) are never read.

A LocalBusiness on an inner page is a **branch**. An Organization's own address, on a site that
also lists branches, is the **head office**, and so is one read from another page when an inner
page was asked for (a publisher's address on the site's articles). The same business repeated on
every page counts once. A head office's address and phone are never used to search Google for a
branch.

An inner page with no location of its own (no markup, and no phone or postcode, or those of
several places) is a **listing page**: an area page that links each nearby branch. web-fetch
reports the pages on the site that it links to, and a branch whose page is one of them isn't
contradicted by the query's URL (see `docs/confidence.md`).

**Sites with no location markup** give only loose evidence: `tel:` links and a postcode in the
text. The start page's own loose details come first, so a branch page gives its own branch's
number. Only when the start page has no phone or postcode are the other pages' details merged.
Loose details holding more than two phone numbers, or more than one postcode, are a **listing**
(a footer with every branch's number, a branch directory), not one place: none of those numbers
or postcodes is taken as the business's, and a warning says how many the site lists.

**Statuses** it can report: `blocked` (bot protection, `robots.txt`, or a refused address),
`unreadable` (pages with no usable content as served, because they build their content with
JavaScript), `unreachable`, `timeout` or `bad_response`.

**Caching:** pages and the web app manifest are kept for an hour, and `robots.txt` for a day,
in the response cache (`<cache_dir>/responses/web-fetch/`). Responses that refused the request
(401, 403, 429) or failed on the server (5xx) aren't cached. `--no-cache` bypasses the cache.

**Settings:** `web_fetch.max_pages`, `web_fetch.honour_robots`, `web_fetch.unreadable_text_chars`
([configuration.md](configuration.md)).

## google-places-api

Google Places API (New). It needs a Google Cloud API key with the Places API (New) enabled, in
`COMPFINDER_GOOGLE_PLACES_API_KEY` or `providers.google-places-api.api_key`. Every call is
metered by Google.

- **With a place ID** (`--place-id`): one Place Details call.
- **Otherwise**: one Text Search call. What it searches for, in order:
  1. the best name known with the query's own postcode or address;
  2. the query's phone, when it has a phone but no postcode or address;
  3. the best name with a postcode or town another provider found;
  4. a phone a page showed;
  5. the best name with a hint from the URL's path (`/bookshops/reading` gives `reading`);
  6. for a home page with a name but no location or phone (a chain's home page), the name alone.

  The query's own values come first, so a branch page another provider happened to find can't
  narrow a town-wide query to that one branch. When no name is known at all (the site is blocked,
  or has no name in its markup), the domain stands in for the name (`waterstones.com` gives
  `waterstones`), and the URL's path comes before a phone the page showed, which may be a
  call-tracking number Google doesn't know. A search on a domain-derived name, on a name alone,
  or, for a home page, on a found name that only spells the domain (`PureGym` on `puregym.com`),
  **keeps only places whose website is on the query's site**, so a namesake elsewhere is
  never taken. With nothing to search for, it waits for an earlier stage, and is
  skipped if nothing turns up. It asks for at most 5 candidates, and sends the lookup's
  country as `regionCode`, which favours places there without excluding others.
- **Fields read** (the field mask decides Google's billing tier): `id`, `displayName`,
  `formattedAddress`, `addressComponents`, `location`, `nationalPhoneNumber`,
  `internationalPhoneNumber`, `websiteUri`, `googleMapsUri`, `businessStatus`. Phone and website
  already put the request in Google's top tier for Text Search, so `googleMapsUri` adds no cost.
- **Maps listing cid**: the `cid` in a place's `googleMapsUri` is compared with any `?cid=` Maps
  link in the site's schema. A match links the two as the same place, even when their phone
  numbers and addresses differ (see [confidence.md](confidence.md)). The cid itself is never an
  output value, and compfinder never converts a cid into a place ID.
- The key is sent in the `X-Goog-Api-Key` header, never in a URL.
- A place Google lists as closed (temporarily or permanently) is named in `warnings`.
- Google's responses aren't cached. Google's terms restrict caching most Places content.
- `providers check` makes one Text Search asking only for place IDs, Google's lowest tier.

Failures: a rejected or invalid key is `auth_failed`, a quota or rate limit is
`quota_exceeded`, a Google outage is `unreachable`, and anything unparseable is `bad_response`.

## brave-search-api

Finds a business's website when none was given. It needs a name to search for, and searches for
it with the best location known, in the lookup's country. It makes one metered call, and runs
only while no website is known.

- **The website** is the first result whose host isn't a directory, social network or property
  portal (`discover.directory_hosts`). A search result counts as the site it points at, so it
  never confirms that site: confirmation has to come from somewhere independent, such as
  Google's listing.
- It reads Brave's web results only. The key goes in the `X-Subscription-Token` header.
- The lookup's country is sent as Brave's `country`. Brave accepts only some countries (Ireland
  isn't one); any other is sent as `ALL`, and the location in the search text does the work.
- Its responses aren't cached until Brave's terms on storing results have been checked.
- `providers check` makes one small search, which costs one query.

## Logos

After the providers run, compfinder downloads the best logo candidate: a schema.org logo first,
then large icons (192 px or more, or `apple-touch-icon`), then social images and favicons, which
rank equally, and within each rank the widest first ([confidence.md](confidence.md)). It identifies the image by its
bytes, not by the server's Content-Type or the URL's extension. It accepts PNG, JPEG, GIF, WebP,
ICO and SVG, and reads the pixel size from the image's header. An SVG is rendered to PNG,
scaled so its longest side is at most 1200 px, with no external resources and no system fonts.

If a candidate turns out not to be a usable image, the next is tried: each URL once, three at
most. The file is stored in the logo cache at `<cache_dir>/logos/<domain>/<kind>-<hash>.<ext>`.
The cache is long-lived and safe to delete. `--no-download` reports the logo's URL without
downloading it.
