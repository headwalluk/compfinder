# Using compfinder from an AI agent

This page is for an AI agent (or whoever writes its instructions) using compfinder to check
and fill in business records: a list of sales leads, a CRM export, a spreadsheet of branches.
It covers how to prepare the input, how to run a batch without wasting paid calls, and how to
decide what to do with each result. The full contracts are in [output.md](output.md) (the
result's shape), [confidence.md](confidence.md) (what the scores mean) and [cli.md](cli.md)
(every option). Code that embeds compfinder as a library should read [library.md](library.md).

compfinder is deterministic and makes no LLM calls. It gathers evidence, scores how well the
sources agree, and returns everything it found, even when the score is low. The judgement about
what to do with a record is yours.

## Before the first batch

```sh
compfinder providers list     # which providers are configured; no network calls
compfinder providers check    # one cheap live call per configured provider, to prove the keys
```

There are three providers:

| Provider | What it adds | Cost |
|---|---|---|
| `web-fetch` | Reads the business's own site: name, address, phone, email, logo, socials | Free |
| `google-places-api` | Google's listing: place ID, Google's address and phone, and a second, independent source | One metered call per lookup |
| `brave-search-api` | Finds the website when the record has none | One metered call, only when no website is known |

Without Google, nothing can confirm what a site says about itself, so most scores stop at 60.
Without Brave, a record with no website relies on Google to supply one.

## Preparing the input

Each lookup is one line of JSON (JSONL). Every value is a string:

```json
{"id": "row-17", "name": "Example Estates Reading", "url": "https://example.com/branches/reading/", "postcode": "RG1 1AA"}
{"id": "row-18", "name": "Example Estates", "address": "12 High Street, Wokingham", "phone": "0118 496 0123"}
{"id": "row-19", "name": "Example Plumbing Ltd", "postcode": "SW1A 1AA"}
```

| Key | Put here | Leave it out when |
|---|---|---|
| `id` | Your row's key, copied back to the result so you can join them. A string or a number | Never: always set it |
| `name` | The business or branch name, as the record has it. Typos are tolerated | Missing |
| `url` | The business's **own** website, ideally the branch's own page | It's a Facebook page, a Google Maps link, a directory listing (Yell, Checkatrade, Rightmove, Zoopla…), or any site that isn't the business's own. compfinder would read that page as if it were the business's site |
| `postcode` | The postcode, when it's in its own column | It's inside `address`: compfinder finds it there |
| `address` | The address as one line of text | Missing |
| `phone` | The phone number as written: `0118 496 0123` or `+44 118 496 0123` | Missing |
| `place_id` | A Google place ID (`ChIJ…`), if the record somehow has one | Anything else, including a Maps link |
| `country` | Two letters, when the row isn't in the configured country (usually `GB`) | The row is in the default country |

Rules worth following:

- **Drop empty and unreadable values** rather than sending placeholders like `"N/A"`, `"TBC"`
  or `"-"`. Empty strings are ignored, but a `url`, `postcode`, `phone`, `place_id` or `country`
  that can't be read makes the **whole line** an `input.bad_value` error, with a problem saying
  which value. Check those five before sending: a postcode must be valid for the row's country,
  a phone number must be a real number for it, and a URL must be a web address.
- **Send only these keys.** Any other key makes the line an `input.bad_value` error, and so
  does a number where a string belongs (except `id`). `null` counts as absent.
- **One business per line.** If a row really holds two businesses, split it.
- **Give the most specific thing you have.** A branch's own page, a postcode or a phone number
  pins down one place. A chain's home page with no location returns the head office.

The minimum is a name with a location (postcode, address or phone), or a URL, or a phone number,
or a place ID. A name alone needs Brave to find the website.

## Running a batch

Cost it first. A dry run makes no calls and reports the most metered calls each line could make:

```sh
compfinder find --input=leads.jsonl --dry-run --output=json > plan.jsonl
```

The summary on stderr gives the total. Then run it with a ceiling on the whole batch:

```sh
compfinder find --input=leads.jsonl --output=json --no-download \
  --concurrency=4 --max-metered-calls-total=500 > results.jsonl 2> run.log
```

- **stdout** gets exactly one JSON line per input line, in input order. Match results back to
  rows by `id`.
- **stderr** gets logs and a closing summary: `Batch: N lines, E with errors, M metered calls.`
- **Exit code**: a batch exits 0 when it ran, even if some lines had errors. Per-line problems
  are in each line's `ok` and `error`. Exit 2 means the command itself was wrong (a bad option,
  an unreadable input file), and exit 3 means the configuration is invalid.
- **`--no-download`** skips saving logo images to disk. The logo's URL is still returned.
  Leave it off only if you want the image files.
- **`--concurrency`** (1 to 16) is the number of lookups in flight. Each lookup reads its site
  one page at a time, but separate lookups don't wait for each other, even on the same site. For
  a list where many rows share one website (a chain's branches), keep it at 1 or 2, so the site
  sees a few requests at a time rather than a burst. For rows on different sites, 4 is a
  reasonable start.
- **The budget**: once `--max-metered-calls-total` is spent, Google and Brave are skipped with
  reason `over budget` and `web-fetch` carries on. Re-run those lines later rather than
  treating them as not found.
- **Re-running is cheap for sites**: pages are cached for an hour, so a re-run within the hour
  costs no fetches. Google and Brave answers aren't cached, so a re-run costs those calls again.

`--input=-` reads the JSONL from stdin.

## Reading a result

Each output line is the JSON result described in [output.md](output.md), with `id` and `ok` at
the front. The parts that matter for a decision:

| Path | What it tells you |
|---|---|
| `ok`, `error.code` | Whether the lookup ran. `ok: false` is a broken line or a total failure, not "not found" |
| `identity.confidence` | 0 to 100: how sure compfinder is that the evidence is about the business in your row |
| `identity.rules` | Why: the rule IDs behind that number (below) |
| `identity.candidates` | When several places tied, all of them |
| `fields.<field>.value` | The best value for each of `name`, `website`, `address`, `phone`, `email`, `logo`, `place_id`, `socials` |
| `fields.<field>.confidence` | How well the sources agree on that value. Never higher than the identity |
| `fields.<field>.sources` | Which providers gave it. `query` means your own input |
| `fields.<field>.conflicts` | The values that lost, with their sources: an old phone number, a moved address |
| `warnings` | Sentences written for you to read: a business Google lists as closed, a name that doesn't match, a head office returned for a chain |
| `providers[].status` | What each provider did: `ok`, `skipped` (with `reason`), or a failure such as `blocked` |

Match on codes and rule IDs, never on the wording of messages, reasons or warnings. Those can
change; the codes are versioned.

### What the scores mean

The numbers are agreement between independent sources, not a probability and not a measure of
how good a lead is. The ones you'll see most:

| Score | Typically means | A sensible default |
|---|---|---|
| 100 | Two independent sources agree (the site and Google), or a source confirms something you supplied | Use it |
| 60 | One source, from structured data. Usually the site alone, which nothing else has confirmed | Usable. Check it if it matters |
| 40 | One source from loose page content, or a name mismatch (below) | Read the reasons before using it |
| 30 | A branch was asked for, but the value only came from the head office | Treat it as the head office's, not the branch's |
| 20 | Only your own input; nothing confirmed it | Unverified |
| 0 | Nothing found | Not found, or not findable from what you gave |

Some fields are usually lower by nature: Google never gives emails, so an email from the site is
60 at best, and socials usually come from the site alone too.

### The identity rules to act on

| Rule in `identity.rules` | What happened | What to do |
|---|---|---|
| `identity.input-confirmed` | A place ID, phone, postcode or branch page from your row was confirmed | Trust the identity |
| `identity.independent-agreement` | The site and Google describe the same place | Trust the identity |
| `identity.single-structured` | Only one source (usually the site) | Fine for most uses; Google would confirm it |
| `identity.name-mismatch` | The website you gave is confirmed, but the name isn't, even allowing for typos. Capped at 40 | Often a trading name, a rebrand or a parent company. Compare your name with `fields.name.value` and decide |
| `identity.tie` | Several places match equally, for example two branches when you gave no location | Look at `identity.candidates`, then re-run with a postcode, phone or branch URL |
| `identity.head-office` | You gave a chain's home page and no location | The result is the head office. For a branch, give its page or postcode |
| `identity.none` | Nothing matched, or everything found contradicted your row | Check the input. A wrong URL or a stale phone is the usual cause |

## Branches of one business

For a list of branches that share one website:

- Give each branch's **own page** as `url` when you have it
  (`https://example.com/branches/reading/`). That's the strongest key there is.
- Otherwise give the chain's site with the branch's **postcode** or **phone**. compfinder reads
  the site's branch listings and picks the matching branch.
- Give the **branch's name** as the row has it ("Example Estates Reading"). The chain's name alone
  matches every branch equally.
- A home page with no location returns the **head office**, with the `identity.head-office`
  rule and a warning. If you meant a branch, that row needs more location data.
- A value that only the head office supplies is capped at 30 for a branch query, so you can tell
  the head office's switchboard from a branch's own number.

## When a line fails

| What you see | Cause | What to do |
|---|---|---|
| `error.code: input.bad_json` | The line isn't valid JSON | Fix the line |
| `error.code: input.bad_value` | An unknown key, a non-string value, or a value that can't be read (a URL that isn't one, a phone number that isn't valid) | `problems` lists each one |
| `error.code: input.no_query` | Nothing to look up | The row has no usable name, URL, phone or place ID |
| `error.code: lookup.no_provider` | No configured provider can work from this row, for example a name with no location and no Brave key | Add data to the row, or configure the missing provider |
| `error.code: lookup.all_failed` | Every provider that ran failed | Look at `providers[].status` and `detail` |
| `web-fetch` status `blocked` | The site refused automated requests (Cloudflare and similar) | Nothing to fix here. Google may still give a result |
| `web-fetch` status `unreadable` | The site builds its pages with JavaScript, so there's nothing to read | As above |
| `skipped`, reason `over budget` | The batch's metered budget ran out | Re-run those lines with a new budget |
| `auth_failed`, `quota_exceeded` | A key was rejected, or a provider's quota was used up | Stop and report it: every later line will hit it too |

## What compfinder won't do

- **Guess.** A value nothing supports isn't returned, and an unconfirmed one is scored low.
- **Return people's details.** Email addresses that look personal (`jane.smith@…`) and
  people's social profiles (LinkedIn `/in/` pages) are seen and withheld. A warning counts them.
  Role addresses such as `info@`, `hello@` and `sales@` are returned.
- **Get past bot protection** or log in anywhere. It identifies itself, follows `robots.txt`,
  and reads at most a few pages per site.
- **Fetch private or local addresses.** A URL that resolves to one is refused. See
  [security.md](security.md).
