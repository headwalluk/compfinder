import type { Evidence, RecordRole, SourceRecord, WebsiteValue } from '../../lookup/types.js';
import { ProviderError } from '../../lookup/errors.js';
import { comparableName } from '../../normalise/name.js';
import { isSameSite, isSiteRoot, normaliseUrl, siteHost } from '../../normalise/url.js';
import { decodeBody } from '../../net/charset.js';
import { HttpError, type HttpResponse } from '../../net/http-client.js';
import { isPathAllowed, parseRobots, type RobotsRules } from '../../net/robots.js';
import { ROBOTS_PRODUCT_TOKEN } from '../../net/user-agent.js';
import type { Knowledge, Provider, ProviderContext, Readiness } from '../contract.js';
import { PROVIDER_DECLARATIONS } from '../declarations.js';
import { parsePage, type ParsedPage } from './document.js';
import { blockEvidence, looseEvidence, manifestEvidence, metaEvidence, PAGE_FALLBACK_DETAIL, type Withheld } from './evidence.js';
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

/** What reading one page produced. */
interface PageResult {
  page: ParsedPage;
  locations: Array<{ evidence: Evidence[]; isLocalBusiness: boolean }>;
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
  return new ProviderError(statuses[error.failure], error.message);
}

/** Fetches robots.txt: 4xx allows everything; 5xx disallows everything (RFC 9309), reported as blocked. */
async function loadRobots(origin: string, context: ProviderContext): Promise<RobotsRules> {
  const url = new URL('/robots.txt', origin).href;
  let response: HttpResponse;
  try {
    response = await context.http.request({ url, kind: 'robots', canFollowRedirect: (from, to) => isSameSite(from.hostname, to.hostname) });
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    throw failureFor(error);
  }
  if (response.status >= SERVER_ERROR_MIN || REFUSING_STATUSES.has(response.status)) {
    throw new ProviderError('blocked', `robots.txt unavailable (HTTP ${response.status}), so the site is treated as disallowed`);
  }
  return parseRobots(response.status >= CLIENT_ERROR_MIN ? '' : decodeBody(response.body, response.headers['content-type']));
}

/** Fetches and parses one page. For the start page every problem is a ProviderError; for others, null. */
async function fetchPage(url: string, isStart: boolean, site: string, context: ProviderContext): Promise<ParsedPage | null> {
  let page: ParsedPage | null = null;
  let problem: ProviderError | null = null;
  try {
    const response = await context.http.request({
      url,
      kind: 'html',
      // The start page may redirect anywhere (a business that moved domain); later pages must stay on the site.
      canFollowRedirect: (from, to) => isStart || isSameSite(to.hostname, site),
    });
    const contentType = response.headers['content-type'] ?? 'text/html';
    if (REFUSING_STATUSES.has(response.status) || isProtected503(response.status, response.headers)) {
      problem = new ProviderError('blocked', `${url} refused the request (HTTP ${response.status})`);
    } else if (response.status >= SERVER_ERROR_MIN) {
      problem = new ProviderError('unreachable', `${url} answered HTTP ${response.status}`);
    } else if (response.status < SUCCESS_MIN || response.status > SUCCESS_MAX) {
      problem = new ProviderError('bad_response', `${url} answered HTTP ${response.status}`);
    } else if (!HTML_CONTENT_TYPE.test(contentType)) {
      problem = new ProviderError('bad_response', `${url} is ${contentType}, not an HTML page`);
    } else {
      const parsed = parsePage(decodeBody(response.body, contentType), response.url);
      const challenge = challengeName(parsed);
      if (challenge === null) {
        page = parsed;
      } else {
        problem = new ProviderError('blocked', `${url} returned a ${challenge} page`);
      }
    }
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    problem = failureFor(error);
  }
  if (problem !== null && isStart) {
    throw problem;
  }
  if (problem !== null) {
    context.logger.warn(`Skipping a page: ${problem.detail}`);
  }
  return page;
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
      locations.push({ evidence: evidence.location, isLocalBusiness: evidence.isLocalBusiness });
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

/** How many different LocalBusiness entities the pages describe; the same branch repeated on every page counts once. */
function distinctLocalBusinesses(results: readonly PageResult[]): number {
  const signatures = new Set<string>();
  for (const result of results) {
    for (const location of result.locations.filter((entry) => entry.isLocalBusiness)) {
      const postcode = location.evidence.find((item) => item.field === 'address')?.value;
      const phone = location.evidence.find((item) => item.field === 'phone')?.value;
      const name = location.evidence.find((item) => item.field === 'name')?.value;
      const signature = [
        postcode !== undefined && 'postcode' in postcode ? postcode.postcode : null,
        phone !== undefined && 'e164' in phone ? phone.e164 : null,
        typeof name === 'string' ? comparableName(name) : null,
      ].find((part) => part !== null && part !== undefined) ?? `${result.page.url}#${result.locations.indexOf(location)}`;
      signatures.add(signature);
    }
  }
  return signatures.size;
}

/** A location record's role: a single LocalBusiness on an inner page is a branch; a chain's home page is head office. */
function roleFor(result: PageResult, isLocalBusiness: boolean, totalLocalBusinesses: number): RecordRole {
  const localOnPage = result.locations.filter((location) => location.isLocalBusiness).length;
  const isRoot = isSiteRoot(result.page.url);
  let role: RecordRole = 'unknown';
  if (!isLocalBusiness && totalLocalBusinesses > 0) {
    // An Organization's own address is the head office only on a site that also lists branches.
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
      const robots = options.honourRobots ? await loadRobots(startUrl.origin, context) : null;
      if (robots !== null && !isPathAllowed(robots, ROBOTS_PRODUCT_TOKEN, `${startUrl.pathname}${startUrl.search}`)) {
        throw new ProviderError('blocked', `robots.txt disallows ${startUrl.pathname}`);
      }

      const start = await fetchPage(website.url, true, website.domain, context) as ParsedPage;
      const site = siteHost(new URL(start.url).hostname);
      if (!isSameSite(site, website.domain)) {
        context.warn(`${website.domain} redirected to ${site}; read ${site} as the business's site.`);
      }
      const results = [readPage(start, countryCode, options.unreadableTextChars, withheld)];
      const siteRobots = robots !== null && !isSameSite(site, website.domain) ? await loadRobots(new URL(start.url).origin, context) : robots;
      for (const url of selectPages(start, site, options.maxPages - 1)) {
        const parsedUrl = new URL(url);
        const isAllowed = siteRobots === null || isPathAllowed(siteRobots, ROBOTS_PRODUCT_TOKEN, `${parsedUrl.pathname}${parsedUrl.search}`);
        if (!results.some((result) => answersQuery(result, knowledge)) && isAllowed) {
          const page = await fetchPage(url, false, site, context);
          if (page !== null) {
            results.push(readPage(page, countryCode, options.unreadableTextChars, withheld));
          }
        }
      }

      const readable = results.filter((result) => !result.isUnreadable);
      if (readable.length === 0) {
        throw new ProviderError('unreadable', `${start.url} has no usable content as served; it probably builds its content with JavaScript`);
      }
      if (readable.length < results.length) {
        context.warn(`${results.length - readable.length} page(s) on ${site} had no usable content as served.`);
      }

      const origin = `${SITE_ORIGIN_PREFIX}${site}`;
      const totalLocalBusinesses = distinctLocalBusinesses(readable);
      const records: SourceRecord[] = [];
      for (const result of readable) {
        result.locations.forEach((location, index) => {
          const evidence = [...location.evidence];
          if (result.locations.length === 1) {
            addUnique(evidence, result.loose.location);
          }
          records.push({
            source: 'web-fetch', origin, subject: `${result.page.url}#${index}`, scope: 'location',
            role: roleFor(result, location.isLocalBusiness, totalLocalBusinesses), evidence,
          });
        });
      }
      if (records.length === 0) {
        const loose: Evidence[] = [];
        for (const result of readable) {
          addUnique(loose, result.loose.location);
        }
        if (loose.length > 0) {
          records.push({ source: 'web-fetch', origin, subject: `${start.url}#links`, scope: 'location', role: 'unknown', evidence: loose });
        }
      }

      const brand: Evidence[] = [];
      for (const result of readable) {
        addUnique(brand, result.brand);
        addUnique(brand, result.loose.brand);
      }
      const siteWebsite = normaliseUrl(new URL('/', start.url).href);
      if (siteWebsite !== null) {
        addUnique(brand, [{ field: 'website', value: siteWebsite, quality: 'loose', reference: { url: start.url, detail: 'the site that was read' } }]);
      }
      const manifestUrl = readable.find((result) => result.manifestUrl !== null)?.manifestUrl ?? null;
      const hasSchemaLogo = brand.some((item) => item.field === 'logo' && item.value.source === 'schema-org');
      if (manifestUrl !== null && !hasSchemaLogo) {
        try {
          const manifest = await context.http.request({ url: manifestUrl, kind: 'manifest', canFollowRedirect: (from, to) => isSameSite(to.hostname, site) });
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
        records.push({ source: 'web-fetch', origin, subject: `${start.url}#brand`, scope: 'brand', role: 'unknown', evidence: brand });
      }
      if (withheld.personalEmails > 0) {
        context.warn(`${withheld.personalEmails} possibly personal email address(es) seen on ${site}, not returned.`);
      }
      if (withheld.personalProfiles > 0) {
        context.warn(`${withheld.personalProfiles} personal social profile(s) seen on ${site}, not returned.`);
      }
      return records;
    },
  };
}
