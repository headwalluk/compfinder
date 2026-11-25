import type { Evidence, RecordRole, SourceRecord, WebsiteValue } from '../../lookup/types.js';
import { httpStatusCause, ProviderError } from '../../lookup/errors.js';
import { comparableName, compareNames, nameTokens } from '../../normalise/name.js';
import { compactWords, isRelatedPath, isSameSite, isSiteRoot, nameFromDomain, normaliseUrl, pagePath, sharesPlaceWord, siteHost } from '../../normalise/url.js';
import { decodeBody } from '../../net/charset.js';
import { HttpError, type HttpResponse } from '../../net/http-client.js';
import { httpFailureCause } from '../api-errors.js';
import { isPathAllowed, parseRobots, type RobotsRules } from '../../net/robots.js';
import { ROBOTS_PRODUCT_TOKEN } from '../../net/user-agent.js';
import type { Knowledge, Provider, ProviderContext, Readiness } from '../contract.js';
import { PROVIDER_DECLARATIONS } from '../declarations.js';
import { parsePage, type ParsedPage } from './document.js';
import { blockEvidence, looseEvidence, manifestEvidence, metaEvidence, PAGE_FALLBACK_DETAIL, TITLE_NAME_DETAIL, type Withheld } from './evidence.js';
import { challengeName, isProtected503, isUnreadable, REFUSING_STATUSES, selectPages } from './pages.js';
import { jsonLdBlocks, microdataBlocks } from './structured.js';

export interface WebFetchOptions {
  maxPages: number;
  honourRobots: boolean;
  unreadableTextChars: number;
}

const HTML_CONTENT_TYPE = /^(text\/html|application\/xhtml\+xml)/i;
const CLIENT_ERROR_MIN = 400;
const SERVER_ERROR_MIN = 500;
const SUCCESS_MIN = 200;
const SUCCESS_MAX = 299;
const SITE_ORIGIN_PREFIX = 'site:';
/** How long web-fetch may keep responses (docs/providers.md): pages and manifests an hour, robots.txt a day. */
const PAGE_CACHE_TTL_SECONDS = 60 * 60;
/** Most distinct phone numbers, and postcodes, loose page evidence may hold and still describe one place. */
const MAX_LOOSE_PHONES = 2;
const MAX_LOOSE_POSTCODES = 1;
/** Words that name a branch as such ("Crosby Branch", "Leeds Office"), not as a business. */
const BRANCH_WORDS: ReadonlySet<string> = new Set(['branch', 'office', 'store', 'shop', 'showroom', 'centre', 'center', 'location', 'site']);
/** At most this many linked pages are kept from a listing page. */
const MAX_LISTED_PAGES = 200;
const ROBOTS_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** What reading one page produced. */
interface PageResult {
  page: ParsedPage;
  locations: Array<{ evidence: Evidence[]; isLocalBusiness: boolean; mapsCids: string[] }>;
  brand: Evidence[];
  loose: { location: Evidence[]; brand: Evidence[] };
  manifestUrl: string | null;
  isUnreadable: boolean;
}

/** Maps an HTTP client failure to the provider status it means for web-fetch. */
function failureFor(error: HttpError): ProviderError {
  const statuses: Record<HttpError['failure'], ConstructorParameters<typeof ProviderError>[0]> = {
    refused_address: 'blocked',
    refused_url: 'blocked',
    redirect_refused: 'bad_response',
    too_many_redirects: 'bad_response',
    too_large: 'bad_response',
    timeout: 'timeout',
    network: 'unreachable',
  };
  return new ProviderError(statuses[error.failure], error.message, httpFailureCause(error));
}

/** Fetches robots.txt: 4xx allows everything; 5xx disallows everything (RFC 9309), reported as blocked. */
async function loadRobots(origin: string, context: ProviderContext): Promise<RobotsRules> {
  const url = new URL('/robots.txt', origin).href;
  let response: HttpResponse;
  try {
    response = await context.http.request({
      // RFC 9309 follows robots.txt redirects, to any host: a rebranded site often sends its old domain's to the new one.
      url, kind: 'robots', cacheTtlSeconds: ROBOTS_CACHE_TTL_SECONDS, canFollowRedirect: () => true,
    });
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    throw failureFor(error);
  }
  if (response.status >= SERVER_ERROR_MIN || REFUSING_STATUSES.has(response.status)) {
    throw new ProviderError('blocked', `robots.txt unavailable (HTTP ${response.status}), so the site is treated as disallowed`, httpStatusCause(response.status));
  }
  return parseRobots(response.status >= CLIENT_ERROR_MIN ? '' : decodeBody(response.body, response.headers['content-type']));
}

/** Why robots.txt keeps compfinder from a URL, or null when it may be fetched. */
type RobotsGate = (url: URL) => Promise<string | null>;

/** A lookup's robots.txt checks, each origin's rules loaded once; an unreadable one (not the start's) refuses everything. */
async function robotsGate(startOrigin: string, isHonoured: boolean, context: ProviderContext): Promise<RobotsGate> {
  const rulesByOrigin = new Map<string, RobotsRules | null>();
  if (isHonoured) {
    rulesByOrigin.set(startOrigin, await loadRobots(startOrigin, context));
  }
  return async (url: URL): Promise<string | null> => {
    let rules = rulesByOrigin.get(url.origin);
    if (isHonoured && rules === undefined) {
      try {
        rules = await loadRobots(url.origin, context);
      } catch (error) {
        if (!(error instanceof ProviderError)) {
          throw error;
        }
        context.logger.warn(`Treating ${url.origin} as disallowed: ${error.detail}`);
        rules = null;
      }
      rulesByOrigin.set(url.origin, rules);
    }
    let refusal: string | null = null;
    if (isHonoured && (rules === null || rules === undefined)) {
      refusal = `${url.origin}'s robots.txt can't be read`;
    } else if (isHonoured && rules !== undefined && rules !== null && !isPathAllowed(rules, ROBOTS_PRODUCT_TOKEN, `${url.pathname}${url.search}`)) {
      refusal = `robots.txt disallows ${url.pathname}`;
    }
    return refusal;
  };
}

/** Fetches and parses one page. For the start page every problem is a ProviderError; for others, null. */
async function fetchPage(url: string, isStart: boolean, site: string, context: ProviderContext, robotsRefusal: RobotsGate): Promise<ParsedPage | null> {
  let page: ParsedPage | null = null;
  let problem: ProviderError | null = null;
  const refused: { reason: string | null } = { reason: null };
  try {
    const response = await context.http.request({
      url,
      kind: 'html',
      cacheTtlSeconds: PAGE_CACHE_TTL_SECONDS,
      // The start page may redirect anywhere (a business that moved domain); later pages must stay on the site. Every
      // hop must also be one its origin's robots.txt allows.
      canFollowRedirect: async (unusedFrom, to) => {
        const isOnSite = isStart || isSameSite(to.hostname, site);
        refused.reason = isOnSite ? await robotsRefusal(to) : null;
        return isOnSite && refused.reason === null;
      },
    });
    const contentType = response.headers['content-type'] ?? 'text/html';
    if (REFUSING_STATUSES.has(response.status) || isProtected503(response.status, response.headers)) {
      problem = new ProviderError('blocked', `${url} refused the request (HTTP ${response.status})`, isProtected503(response.status, response.headers) ? 'bot_protection' : httpStatusCause(response.status));
    } else if (response.status >= SERVER_ERROR_MIN) {
      problem = new ProviderError('unreachable', `${url} answered HTTP ${response.status}`, httpStatusCause(response.status));
    } else if (response.status < SUCCESS_MIN || response.status > SUCCESS_MAX) {
      problem = new ProviderError('bad_response', `${url} answered HTTP ${response.status}`, httpStatusCause(response.status));
    } else if (!HTML_CONTENT_TYPE.test(contentType)) {
      problem = new ProviderError('bad_response', `${url} is ${contentType}, not an HTML page`, 'not_html');
    } else {
      const parsed = parsePage(decodeBody(response.body, contentType), response.url);
      const challenge = challengeName(parsed);
      if (challenge === null) {
        page = parsed;
      } else {
        problem = new ProviderError('blocked', `${url} returned a ${challenge} page`, 'bot_protection');
      }
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    const reason = refused.reason;
    problem = reason === null ? failureFor(error) : new ProviderError('blocked', `${url} redirects to ${error.url}, but ${reason}`, 'robots_disallowed');
  }
  if (problem !== null && isStart) {
    throw problem;
  }
  if (problem !== null) {
    context.logger.warn(`Skipping a page: ${problem.detail}`);
  }
  return page;
}

/** The distinct phone numbers and postcodes in some loose evidence. */
function placeKeys(evidence: readonly Evidence[]): { phones: Set<string>; postcodes: Set<string> } {
  const phones = new Set<string>();
  const postcodes = new Set<string>();
  for (const item of evidence) {
    if (item.field === 'phone') {
      phones.add(item.value.e164);
    } else if (item.field === 'address' && item.value.postcode !== null) {
      postcodes.add(item.value.postcode);
    }
  }
  return { phones, postcodes };
}

/** The site's own name: one that spells the domain first, then the one with fewest words (docs/providers.md). */
function shortestBrandName(brand: readonly Evidence[], site: string): string | null {
  const names = brand.flatMap((item) => (item.field === 'name' ? [item.value] : [])).filter((name) => nameTokens(name).length > 0);
  const spells = (name: string): number => Number(spellsDomain(name, site));
  return [...names].sort((first, second) => spells(second) - spells(first)
    || nameTokens(first).length - nameTokens(second).length || first.localeCompare(second))[0] ?? null;
}

/** True for a brand name unlike the site's own when that spells its domain: a template's leftover ("SiteBuilder"). */
function isLeftoverName(item: Evidence, brandName: string | null, site: string): boolean {
  return item.field === 'name' && brandName !== null && spellsDomain(brandName, site) && compareNames(item.value, brandName) === 'incompatible';
}

/** True when a name spells the site's domain, "&" read as "and" or as nothing: "Example & Sons" on exampleandsons.com. */
function spellsDomain(name: string, site: string): boolean {
  const domain = compactWords(nameFromDomain(site));
  const spellings = [compactWords(name.replace(/&/g, ' and ')), compactWords(name)];
  return domain !== '' && spellings.includes(domain);
}

/** A branch name that is only a place ("Oxford") with the brand put in front of it (docs/providers.md). */
function withBrand(item: Evidence, brandName: string, placeWords: ReadonlySet<string>): Evidence {
  const words = item.field === 'name' ? nameTokens(item.value) : [];
  const placeOnly = words.filter((word) => !BRANCH_WORDS.has(word));
  const isOnlyPlace = placeOnly.length > 0 && placeOnly.every((word) => placeWords.has(word)) && !nameTokens(brandName).some((word) => words.includes(word));
  return isOnlyPlace && item.field === 'name' ? { ...item, value: `${brandName} ${item.value}` } : item;
}

/** The words of a record's addresses: its lines, town and county. */
function addressWords(evidence: readonly Evidence[]): Set<string> {
  const parts = evidence.flatMap((item) => (item.field === 'address' ? [...item.value.lines, item.value.town ?? '', item.value.county ?? ''] : []));
  return new Set(parts.flatMap((part) => nameTokens(part)));
}

/** True when the query's name has words in neither a record's name nor its address: a branch somewhere the record isn't. */
function namesElsewhere(queryName: string | null, evidence: readonly Evidence[]): boolean {
  const recordWords = new Set([
    ...addressWords(evidence),
    ...evidence.flatMap((item) => (item.field === 'name' ? nameTokens(item.value) : [])),
  ]);
  const hasAddress = evidence.some((item) => item.field === 'address');
  const extraWords = queryName === null ? [] : nameTokens(queryName).filter((word) => !recordWords.has(word));
  return hasAddress && extraWords.length > 0;
}

/** True when loose evidence lists several places (a branch directory, a footer of numbers) rather than one (docs/providers.md). */
function isListing(evidence: readonly Evidence[]): boolean {
  const { phones, postcodes } = placeKeys(evidence);
  return phones.size > MAX_LOOSE_PHONES || postcodes.size > MAX_LOOSE_POSTCODES;
}

/** True when a page describes no one place: no location markup, and no phone or postcode, or those of several places. */
function isListingPage(result: PageResult | undefined): boolean {
  const hasPlaceFacts = result !== undefined && result.loose.location.some((item) => item.field === 'phone' || item.field === 'address');
  return result !== undefined && result.locations.length === 0 && (!hasPlaceFacts || isListing(result.loose.location));
}

/** The paths of the pages on the site that a page links to, other than itself. */
function linkedPaths(page: ParsedPage, site: string): string[] {
  const ownPath = pagePath(page.url);
  const paths = page.links.filter((link) => URL.canParse(link.url) && siteHost(new URL(link.url).hostname) === site)
    .map((link) => pagePath(link.url)).filter((path) => path !== '' && path !== ownPath);
  return [...new Set(paths)].slice(0, MAX_LISTED_PAGES);
}

/** Loose evidence without the facts that belong to one place: what a listing still says about the business. */
function withoutPlaceFacts(evidence: readonly Evidence[]): Evidence[] {
  return evidence.filter((item) => item.field !== 'phone' && item.field !== 'address');
}

/** Extracts everything web-fetch reads from one page. */
function readPage(page: ParsedPage, countryCode: string, minimumTextChars: number, withheld: Withheld): PageResult {
  const { blocks } = jsonLdBlocks(page);
  const allBlocks = [...blocks, ...microdataBlocks(page)];
  const locations: PageResult['locations'] = [];
  const brand: Evidence[] = [];
  const businessWords: string[] = [];
  for (const block of allBlocks) {
    const evidence = blockEvidence(block, page, countryCode, withheld);
    if (evidence.location.length > 0) {
      locations.push({ evidence: evidence.location, isLocalBusiness: evidence.isLocalBusiness, mapsCids: evidence.mapsCids });
    }
    brand.push(...evidence.brand);
    for (const item of [...evidence.location, ...evidence.brand]) {
      if (item.field === 'name') {
        businessWords.push(item.value);
      } else if (item.field === 'address' && item.value.town !== null) {
        businessWords.push(item.value.town);
      }
    }
  }
  // A listing page's URL identifies none of its branches; keeping it would link them all into one place.
  if (locations.filter((location) => location.isLocalBusiness).length > 1) {
    for (const location of locations) {
      location.evidence = location.evidence.filter((item) => !(item.field === 'website' && item.reference.detail.startsWith(PAGE_FALLBACK_DETAIL)));
    }
  }
  const meta = metaEvidence(page);
  return {
    page,
    locations,
    brand: [...brand, ...meta.brand],
    loose: looseEvidence(page, countryCode, businessWords, withheld),
    manifestUrl: meta.manifestUrl,
    isUnreadable: isUnreadable(page, allBlocks.length, minimumTextChars),
  };
}

/** True when two pieces of evidence are the same field and value, so one can be dropped. */
function isDuplicate(first: Evidence, second: Evidence): boolean {
  return first.field === second.field && JSON.stringify(first.value) === JSON.stringify(second.value);
}

/** Appends evidence, skipping anything already present. */
function addUnique(target: Evidence[], additions: readonly Evidence[]): void {
  for (const addition of additions) {
    if (!target.some((existing) => isDuplicate(existing, addition))) {
      target.push(addition);
    }
  }
}

/** True when a page's location matches the query's postcode or phone, so reading more pages won't help. */
function answersQuery(result: PageResult, knowledge: Knowledge): boolean {
  const { postcode, phone } = knowledge.query;
  return result.locations.some((location) => location.isLocalBusiness && location.evidence.some((item) => (
    (item.field === 'address' && postcode !== null && item.value.postcode === postcode)
    || (item.field === 'phone' && phone !== null && item.value.e164 === phone.e164)
  )));
}

/** A location's identity for counting: its postcode, else its phone, else its name; null when it has none. */
function locationSignature(location: PageResult['locations'][number]): string | null {
  const postcode = location.evidence.find((item) => item.field === 'address')?.value;
  const phone = location.evidence.find((item) => item.field === 'phone')?.value;
  const name = location.evidence.find((item) => item.field === 'name')?.value;
  return [
    postcode !== undefined && 'postcode' in postcode ? postcode.postcode : null,
    phone !== undefined && 'e164' in phone ? phone.e164 : null,
    typeof name === 'string' ? comparableName(name) : null,
  ].find((part) => part !== null && part !== undefined) ?? null;
}

/** The different LocalBusiness entities the pages describe; the same branch repeated on every page counts once. */
function localBusinessSignatures(results: readonly PageResult[]): Set<string> {
  const signatures = new Set<string>();
  for (const result of results) {
    for (const location of result.locations.filter((entry) => entry.isLocalBusiness)) {
      signatures.add(locationSignature(location) ?? `${result.page.url}#${result.locations.indexOf(location)}`);
    }
  }
  return signatures;
}

/** A location record's role, branch, head office or unknown (docs/providers.md). */
function roleFor(result: PageResult, location: PageResult['locations'][number], localSignatures: ReadonlySet<string>, isElsewhere: boolean): RecordRole {
  const localOnPage = result.locations.filter((entry) => entry.isLocalBusiness).length;
  const isRoot = isSiteRoot(result.page.url);
  const totalLocalBusinesses = localSignatures.size;
  const signature = locationSignature(location);
  // An Organization repeating the site's only LocalBusiness (same postcode or phone) is that business, not a head office.
  const isOnlyBusiness = totalLocalBusinesses === 1 && signature !== null && localSignatures.has(signature);
  let role: RecordRole = 'unknown';
  if (!location.isLocalBusiness && ((totalLocalBusinesses > 0 && !isOnlyBusiness) || isElsewhere)) {
    role = 'head-office';
  } else if (!isRoot && localOnPage === 1) {
    role = 'branch';
  } else if (isRoot && totalLocalBusinesses > 1) {
    role = 'head-office';
  }
  return role;
}

/** Builds the web-fetch provider: reads the business's own pages (docs/providers.md). */
export function createWebFetchProvider(options: WebFetchOptions): Provider {
  const declaration = PROVIDER_DECLARATIONS['web-fetch'];
  return {
    declaration,
    readiness(knowledge: Knowledge): Readiness {
      return knowledge.query.website !== null || knowledge.fields.website !== undefined
        ? { state: 'ready' }
        : { state: 'waiting', reason: 'no website known' };
    },
    maxCalls: () => 0,
    async run(knowledge: Knowledge, context: ProviderContext): Promise<SourceRecord[]> {
      const website = (knowledge.query.website ?? knowledge.fields.website) as WebsiteValue;
      const countryCode = knowledge.query.country;
      const withheld: Withheld = { personalEmails: 0, personalProfiles: 0 };
      const startUrl = new URL(website.url);
      const robotsRefusal = await robotsGate(startUrl.origin, options.honourRobots, context);
      const startRefusal = await robotsRefusal(startUrl);
      if (startRefusal !== null) {
        throw new ProviderError('blocked', startRefusal, 'robots_disallowed');
      }

      const start = await fetchPage(website.url, true, website.domain, context, robotsRefusal) as ParsedPage;
      const site = siteHost(new URL(start.url).hostname);
      const redirectedFrom = isSameSite(site, website.domain) ? null : website.domain;
      if (redirectedFrom !== null) {
        context.warn(`${website.domain} redirected to ${site}; read ${site} as the business's site.`);
      }
      const results = [readPage(start, countryCode, options.unreadableTextChars, withheld)];
      for (const url of selectPages(start, site, options.maxPages - 1)) {
        if (!results.some((result) => answersQuery(result, knowledge)) && await robotsRefusal(new URL(url)) === null) {
          const page = await fetchPage(url, false, site, context, robotsRefusal);
          if (page !== null) {
            results.push(readPage(page, countryCode, options.unreadableTextChars, withheld));
          }
        }
      }

      // A branch page that now redirects to another inner page (the branch list) is gone: the site's loose numbers and
      // postcodes belong to other branches, so none is taken as this one's. Landing on the home page isn't a move;
      // landing on an alias, or on one place's page that keeps a word of the old one's name (putney-vale to
      // putney-branch), is a rename (docs/providers.md).
      const startPath = pagePath(start.url);
      const askedPath = pagePath(website.url);
      const isRedirected = !isSiteRoot(website.url) && !isSiteRoot(start.url) && startPath !== askedPath;
      const isAlias = isRelatedPath(startPath, askedPath);
      const isPageMoved = isRedirected && (isAlias || (!isListingPage(results[0]) && sharesPlaceWord(startPath, askedPath)));
      const isPageGone = isRedirected && !isPageMoved;
      if (isPageMoved) {
        context.warn(`${website.url} redirected to ${start.url}, which is read as the page asked about.`);
      } else if (isPageGone) {
        context.warn(`${website.url} redirected to ${start.url}: the page asked about seems to be gone, so the site's loose phone numbers and postcodes aren't taken as this business's.`);
        for (const result of results) {
          result.loose.location = withoutPlaceFacts(result.loose.location);
        }
      }
      const readable = results.filter((result) => !result.isUnreadable);
      if (readable.length === 0) {
        throw new ProviderError('unreadable', `${start.url} has no usable content as served; it probably builds its content with JavaScript`, 'unreadable');
      }
      if (readable.length < results.length) {
        context.warn(`${results.length - readable.length} page(s) on ${site} had no usable content as served.`);
      }

      const origin = `${SITE_ORIGIN_PREFIX}${site}`;
      const localSignatures = localBusinessSignatures(readable);
      const isInnerStart = !isSiteRoot(start.url);
      // The brand's name may sit in an Organization that also carries the head office's address.
      const organisationNames = readable.flatMap((result) => result.locations.filter((location) => !location.isLocalBusiness).flatMap((location) => location.evidence));
      // A LocalBusiness named as the domain is spelt ("Example & Sons") names the brand too.
      const domainNamedPlaces = readable.flatMap((result) => result.locations.flatMap((location) => location.evidence))
        .filter((item) => item.field === 'name' && spellsDomain(item.value, site));
      const brandName = shortestBrandName(readable.flatMap((result) => [
        ...result.brand.filter((item) => !isInnerStart || item.reference.detail !== TITLE_NAME_DETAIL), ...result.loose.brand, ...organisationNames, ...domainNamedPlaces,
      ]), site);
      // A name from a title steers later searches; it's taken only for a home page asked about (docs/providers.md).
      const brandOf = (result: PageResult): Evidence[] => result.brand.filter((item) => (!isInnerStart || item.reference.detail !== TITLE_NAME_DETAIL)
        && !isLeftoverName(item, brandName, site));
      const records: SourceRecord[] = [];
      for (const result of readable) {
        result.locations.forEach((location, index) => {
          const placeWords = addressWords(location.evidence);
          const evidence = brandName === null ? [...location.evidence] : location.evidence.map((item) => withBrand(item, brandName, placeWords));
          if (result.locations.length === 1) {
            // Loose facts only fill gaps: a footer's registered-office postcode must not join a branch's record.
            const structuredFields = new Set(location.evidence.map((item) => item.field));
            const fillers = isListing(result.loose.location) ? withoutPlaceFacts(result.loose.location) : result.loose.location;
            addUnique(evidence, fillers.filter((item) => !structuredFields.has(item.field)));
          }
          // A block that is only a name (a team member's office, "St Albans") says nothing about a business.
          const isNameOnly = evidence.every((item) => item.field === 'name') && location.mapsCids.length === 0;
          if (!isNameOnly) {
            records.push({
              source: 'web-fetch', origin, subject: `${result.page.url}#${index}`, scope: 'location',
              role: roleFor(result, location, localSignatures,
                isInnerStart && (result.page.url !== start.url || namesElsewhere(knowledge.query.name, location.evidence))), evidence,
              ...(location.mapsCids.length === 0 ? {} : { mapsCids: location.mapsCids }),
            });
          }
        });
      }
      const brand: Evidence[] = [];
      const listedPages = isInnerStart && isListingPage(results[0]) ? linkedPaths(start, site) : [];
      if (records.length === 0) {
        // The start page's own details come first: a branch page names its branch, while the site's other pages
        // may list every branch. Only when the start page has no place facts are the pages merged.
        const startLoose = readable[0]?.page.url === start.url ? readable[0].loose.location : [];
        const hasStartPlace = startLoose.some((item) => item.field === 'phone' || item.field === 'address');
        const loose: Evidence[] = hasStartPlace && !isListing(startLoose) ? [...startLoose] : [];
        for (const result of readable) {
          addUnique(loose, loose.length > 0 ? withoutPlaceFacts(result.loose.location) : result.loose.location);
        }
        if (isListing(loose)) {
          const { phones, postcodes } = placeKeys(loose);
          context.warn(`${site} lists ${phones.size} phone number(s) and ${postcodes.size} postcode(s) without saying which place each belongs to, so none was taken as this business's.`);
          addUnique(brand, withoutPlaceFacts(loose));
        } else if (loose.length > 0) {
          records.push({ source: 'web-fetch', origin, subject: `${start.url}#links`, scope: 'location', role: 'unknown', evidence: loose });
        }
      }

      for (const result of readable) {
        addUnique(brand, brandOf(result));
        addUnique(brand, result.loose.brand);
      }
      const siteWebsite = normaliseUrl(new URL('/', start.url).href);
      if (siteWebsite !== null) {
        addUnique(brand, [{ field: 'website', value: siteWebsite, quality: 'loose', reference: { url: start.url, detail: 'the site that was read' } }]);
      }
      const manifestUrl = readable.find((result) => result.manifestUrl !== null)?.manifestUrl ?? null;
      const hasSchemaLogo = brand.some((item) => item.field === 'logo' && item.value.source === 'schema-org');
      if (manifestUrl !== null && !hasSchemaLogo && await robotsRefusal(new URL(manifestUrl)) === null) {
        try {
          const manifest = await context.http.request({
            url: manifestUrl, kind: 'manifest', cacheTtlSeconds: PAGE_CACHE_TTL_SECONDS, canFollowRedirect: async (unusedFrom, to) => isSameSite(to.hostname, site) && await robotsRefusal(to) === null,
          });
          if (manifest.status >= SUCCESS_MIN && manifest.status <= SUCCESS_MAX) {
            addUnique(brand, manifestEvidence(decodeBody(manifest.body, manifest.headers['content-type']), manifest.url));
          }
        } catch (error) {
          if (!(error instanceof HttpError)) {
            throw error;
          }
          context.logger.warn(`Couldn't read the web app manifest: ${error.message}`);
        }
      }
      if (brand.length > 0) {
        records.push({
          source: 'web-fetch', origin, subject: `${start.url}#brand`, scope: 'brand', role: 'unknown', evidence: brand,
          ...(listedPages.length === 0 ? {} : { listedPages }), ...(isPageMoved ? { movedTo: start.url } : {}),
        });
      }
      if (withheld.personalEmails > 0) {
        context.warn(`${withheld.personalEmails} possibly personal email address(es) seen on ${site}, not returned.`);
      }
      if (withheld.personalProfiles > 0) {
        context.warn(`${withheld.personalProfiles} personal social profile(s) seen on ${site}, not returned.`);
      }
      return redirectedFrom === null ? records : records.map((record) => ({ ...record, redirectedFrom }));
    },
  };
}
