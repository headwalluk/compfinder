# Confidence

This page is for scripts, agents and people deciding which values to trust. Every confidence in
compfinder's output is an integer from 0 to 100. It comes from named rules, and every score
lists the rules that produced it in `rules`. The numbers are fixed in each release, so 100
means the same thing to every caller.

compfinder doesn't decide what's good enough. A queue that writes back only values at 100,
and sends the rest to a person, is the intended pattern.

## Sources and independence

A value is believed more when **independent** sources agree on it. Each piece of evidence has
an origin, and values from the same origin count once:

| Evidence from | Origin |
|---|---|
| Any page on the business's own site | the site |
| `google-places-api` | Google's business listing |
| A search result's URL | the site the result points at |
| Your own query | never independent |

So two pages of the same site are one source, and a search result that repeats the site's own
text confirms nothing. Google's listing counts as independent of the site, even though the
business owner may edit both.

## Identity

First, compfinder works out which real business (and which branch) the evidence is about. It
links records that share a place ID, a Google Maps listing (the `cid` in a Maps link, such as
the site's schema.org `hasMap` and Google's own link for the place), a phone number, a postcode
(with compatible names) or the same branch page, and each linked group is a **candidate**.

Linking keeps places apart that are different:

- Records with **different place IDs** are different places, and never join one candidate, even
  when they share a phone (a chain's switchboard) or a postcode (several listings in one
  building).
- Keys have a strength: a place ID or a Maps listing names one place, a phone number or a branch
  page nearly so, and a postcode or a street address only a building. A street address is the
  building number and street, compared with common words shortened and units left out, so
  `329 W 18th St, Ste 914` and `Ste 914, 329 West 18th Street` match without a postcode. A
  record without a place ID joins the place it shares its **strongest** key with. When that key
  fits several places (one switchboard for two listings), it joins the one it shares the most keys
  with (the street as well), then the one with the same name, or, with none of those (a head
  office known only by its postcode), none of them.
- A record that says nothing about where a place is (an About page's markup: a name, a website,
  an email) joins the candidate holding its site's other records, rather than standing as a
  place of its own.

Candidates are matched against your query. A branch page in your query isn't contradicted by a
different URL for what may be the same page: a longer slug, or an old URL scheme that redirects
(`/healthandfitness/york` against `/health-club/york`). Only a clearly different page contradicts
it, one where neither URL's last segment has all its words in the other's (`/shops/wokingham`
against `/shops/reading`), or where the longer one adds a word that makes it another place
(`south`, `north`, `upper`, `new` and the like: `/foxtons_kensington` isn't
`/foxtons_south_kensington`). An alias (`/offices/chiswick` against
`/offices/dexters-chiswick-estate-agents`) is neither confirmed nor contradicted, but a candidate
with an alias of your branch page ranks above one whose website is the site's home page (a
head office). When your query's
site redirects to another domain (an old brand's domain to the new one's), places on the new
domain count as on your query's site, with the same path. When your query's page is a **listing page**
(it describes no place of its own, as an area page linking each nearby branch does), a candidate
whose page it links to isn't contradicted either; the candidates are then those of its places that
a search found, and a warning says the page lists several places. A candidate the query contradicts is dropped, unless one of your query's pinning values
(place ID, phone, postcode, branch page) is confirmed. In that case the other mismatches are
treated as stale data and shown as field conflicts.

A website from your query that the sources confirm is treated more gently. If the name is the
only thing that disagrees, the candidate is kept under `identity.name-mismatch`, so a trading
name, a rebrand or a bad typo still returns data, at a score low enough to say it needs checking.

The name you type is matched forgivingly: it agrees with a source's name when all its words are in
that name (or the other way round), allowing one typo (a wrong, missing, extra or swapped letter)
in each word of five letters or more. So `Headwlal Hosting` still matches `Headwall Hosting`, and
the source's spelling wins the name field, with yours shown as a conflict. Names from two sources
are never matched with typos allowed, so `Smith Estates` and `Smyth Estates` stay apart.

All name comparisons ignore case, punctuation, word order, legal suffixes, connecting words
(`and`, `in`, `at`, `of`, `the`, `for`) and plain plurals. So `Martin & Co Estate Agents & Letting
Agents in Reading` and `Martin & Co Reading Lettings & Estate Agents` are the same name. A word of
your query's name that is in a candidate's own address (its town) can be missing from the
candidate's name: `Michael Poole Nunthorpe` matches a listing called `Michael Poole Estate Agents`
in Nunthorpe.

For a home page with no location (a whole business), the site's head office ranks first, then a
place its own markup gives an address or phone for. The site saying where it is counts as the
query saying so. Loose details, such as a postcode in a footer, don't count.

When candidates match the query equally, the best match ranks first only inside one building:
of several listings at one address (the same postcode and building number), the one named exactly
as your query beats one with extra words (a brewery over its tap room). A postcode alone isn't a
building everywhere: a US ZIP code covers a district, so two branches in one ZIP with different
building numbers still tie. Branches at different addresses tie, because there the missing piece
is where, not what. Listings in one building that share a phone, or that have the same name (a
thin duplicate listing with only a postcode), are one place: `identity.co-listed`. So are listings
with the same name and the same website page (`http` or `https`, with or without `www.`), in one
postcode sector (OX20 1PP and OX20 1PX; outside the UK, one postcode), when they give no phone
numbers that differ. Separate branches of a chain each have their own number, so they still tie.

When the business's own site has been read and agrees with some tied candidates, a candidate with
nothing from that site and a website on another site (a heritage body's page about a palace, a
directory's page about a shop) drops out of the tie, and the reasons name it. Branches of a chain
share the brand's site, so they still tie. A tie's reason says when the candidates came from a place
search, which returns only its best few matches, so the list may not be complete.

| Rule | Score | Applies when |
|---|---|---|
| `identity.input-confirmed` | 100 | A place ID, phone, postcode or page URL from your query is confirmed by structured data |
| `identity.independent-agreement` | 100 | Records from two or more independent sources describe the same place |
| `identity.single-structured` | 60 | One source only, with structured data (schema.org markup, an API field) |
| `identity.single-loose` | 40 | One source only, from loose page content (a `tel:` link, a postcode in the text) |
| `identity.none` | 0 | Nothing matches, or every candidate contradicts the query |
| `identity.tie` | ÷ n | *n* candidates match your query equally: each gets ⌊score ÷ n⌋ and all are listed in `candidates`. How many sources back a candidate never breaks a tie: two sources agreeing that a branch exists doesn't make it the branch you meant. The best-sourced candidate is listed first, and supplies the fields |
| `identity.name-mismatch` | ≤ 40 | Your query's site is confirmed but its name isn't, even allowing for typos. The business is kept rather than dropped, its identity (and so every field) is capped at 40, and a warning gives both names |
| `identity.co-listed` | — | The tied candidates are one place listed several times: they share one address and one phone (sales and lettings, say), or one name and website page in one postcode sector with no differing phone. It isn't a tie: the score isn't divided. The listing shown is the one with the most support: a website found for the business (by a search, say) whose name matches that listing's |
| `identity.chain` | — | A chain's home page with no location given matches several of its places (a tie), or only Google listings whose websites are branch pages on its site, which nothing the site says joins. The identity is the chain: the fields come from the brand's own records (name, website, logo, socials) at the brand's confidence, place fields (address, phone, place ID) are left empty, the places are listed in `candidates`, and a warning says so. `identity.confidence` is still the tie's divided score, because it measures which place, and no one place is meant |
| `identity.head-office` | — | A chain's home page with no location given: the identity is the head office, and a warning says so |
| `identity.head-office-only` | ≤ 30 | A branch was asked for (a branch page, or a name with a place in it), but every source describes only the head office: an online agent's town page that carries its London office's markup. The identity is capped at 30, the address and phone are the head office's (and capped by `field.head-office`), and a warning names where the head office is |

## Fields

For each field, values that are the same fact are grouped. Phone numbers are equal by E.164,
addresses by postcode and building number, websites by site, and names after removing case,
punctuation and legal suffixes (`Ltd`, `Limited`, `PLC`, `LLP`, `Co`, `Company`, `& Co` and similar). The
group with the most independent sources wins.

| Rule | Score | Applies when |
|---|---|---|
| `field.independent-agreement` | 100 | Two or more independent sources agree |
| `field.input-confirmed` | 100 | One source confirms the value you supplied, from structured data |
| `field.input-confirmed-loose` | 60 | One source confirms the value you supplied, from loose page content |
| `field.single-structured` | 60 | One source only, from structured data |
| `field.single-loose` | 40 | One source only, from loose page content |
| `field.input-only` | 20 | Only your query gave the value: nothing confirms it |
| `field.none` | 0 | Nothing found: `value` is `null` (`[]` for socials) |

Then, in this order:

| Rule | Effect |
|---|---|
| `field.identity-record` | For `place_id` only: a place ID from a record the identity rests on is as sure as the identity. It names that very record |
| `field.conflict` | Sources disagree: the score becomes ⌊score × winning sources ÷ all disagreeing sources⌋, and the other values are listed in `conflicts`. For example, the site and Google agree on a phone and a third, independent source gives another: ⌊100 × 2 ÷ 3⌋ = 66 |
| `field.head-office` | Capped at 30 when you asked about a branch, but the only source for an address, phone or email is a head-office record |
| `field.identity-cap` | A value about one place (name, address, phone, email, place ID, branch page) is capped at the identity's confidence |
| `field.brand-cap` | A value about the whole brand (logo, socials, the website's home page) is capped at the brand's confidence. When tied candidates are branches of one chain on one site, the brand isn't in doubt, so its logo keeps full confidence |

Disagreement with your own query doesn't lower a score, but it is listed in `conflicts` with
the source `query`. That's how stale records show up.

## Logos

A logo rarely appears in more than one source, so agreement can't score it. The score depends
on what kind of image it is:

| Rule | Ceiling | Image |
|---|---|---|
| `logo.schema-org` | 100 | The site's own schema.org `logo` |
| `logo.manifest-icon` | 60 | A large web app icon (192 px or more) or `apple-touch-icon` |
| `logo.social-image` | 40 | A social sharing image (`og:image`, `twitter:image`) |
| `logo.favicon` | 40 | A favicon |
| `logo.website-cap` | — | A logo is capped at the website's own confidence, because it's only as sure as the site it came from |

## Social profiles

Each profile is scored on its own with the field rules: a schema.org `sameAs` link is
structured, and a link in the page is loose. The `socials` field's confidence is that of its
best profile.

## Calibration

These numbers are a reasoned starting point, to be calibrated against a set of known businesses
before 1.0. A change to any number is noted in the changelog.
