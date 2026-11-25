import { BUSINESS_STATUSES, type AddressValue, type Evidence, type SourceRecord } from '../../lookup/types.js';
import { ProviderError } from '../../lookup/errors.js';
import { countryRules } from '../../normalise/country/index.js';
import { mapsCid } from '../../normalise/maps.js';
import { normalisePhone } from '../../normalise/phone.js';
import { decodeEscapes, sanitiseText } from '../../normalise/text.js';
import { compactWords, isSameSite, isSiteRoot, nameFromDomain, normaliseUrl } from '../../normalise/url.js';
import { HttpError } from '../../net/http-client.js';
import { compareQueryName } from '../../normalise/name.js';
import { apiRequest } from '../api-errors.js';
import type { Knowledge, Provider, ProviderContext, Readiness } from '../contract.js';
import { PROVIDER_DECLARATIONS } from '../declarations.js';

const API_NAME = 'Google Places API';
const API_BASE = 'https://places.googleapis.com/v1';
const KEY_HEADER = 'x-goog-api-key';
const FIELD_MASK_HEADER = 'x-goog-fieldmask';
/** The fields read from a place; the mask decides Google's billing tier (docs/providers.md). */
const PLACE_FIELDS = [
  'id', 'displayName', 'formattedAddress', 'addressComponents', 'location',
  'nationalPhoneNumber', 'internationalPhoneNumber', 'websiteUri', 'googleMapsUri', 'businessStatus',
];
/** At most this many off-site websites of Google's places are checked per lookup, and each answer is kept this long. */
const MAX_WEBSITE_CHECKS = 2;
const WEBSITE_CHECK_TTL_SECONDS = 60 * 60;
/** Candidates asked for per text search. */
const SEARCH_PAGE_SIZE = 5;
/** The IDs-only field mask, for the credentials check. */
const CHECK_FIELD_MASK = 'places.id';
const CHECK_QUERY = 'London';
const ORIGIN = 'google-business-profile';
const OPERATIONAL = 'OPERATIONAL';

/** The parts of a Places API (New) place compfinder reads. */
interface Place {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: Array<{ longText?: string; shortText?: string; types?: string[] }>;
  location?: { latitude?: number; longitude?: number };
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  businessStatus?: string;
}

/** The long text of the first address component with a type. */
function component(place: Place, type: string, short = false): string | null {
  const found = place.addressComponents?.find((entry) => entry.types?.includes(type));
  const text = short ? found?.shortText : found?.longText;
  return text === undefined ? null : sanitiseText(text, 'addressLine') || null;
}

/** A place's address, from its components (UK towns are postal_town). */
export function placeAddress(place: Place, countryCode: string): AddressValue | null {
  const street = [component(place, 'street_number'), component(place, 'route')].filter((part) => part !== null).join(' ');
  const lines = [component(place, 'subpremise'), component(place, 'premise'), street === '' ? null : street].filter((line): line is string => line !== null);
  const rawPostcode = component(place, 'postal_code');
  const country = component(place, 'country', true);
  const rules = countryRules(country ?? countryCode);
  const address: AddressValue = {
    lines,
    town: component(place, 'postal_town') ?? component(place, 'locality'),
    county: component(place, 'administrative_area_level_2'),
    postcode: rawPostcode === null ? null : rules.normalisePostcode(rawPostcode) ?? rawPostcode,
    country_code: country !== null && /^[A-Z]{2}$/.test(country) ? country : countryCode,
    formatted: place.formattedAddress === undefined ? null : sanitiseText(place.formattedAddress, 'identifier'),
    lat: typeof place.location?.latitude === 'number' ? place.location.latitude : null,
    lon: typeof place.location?.longitude === 'number' ? place.location.longitude : null,
  };
  return address.lines.length === 0 && address.postcode === null && address.formatted === null ? null : address;
}

/** One place as a location record. */
export function placeRecord(place: Place, countryCode: string, detail: string): SourceRecord | null {
  const placeId = typeof place.id === 'string' && /^[A-Za-z0-9_-]{10,300}$/.test(place.id) ? place.id : null;
  let record: SourceRecord | null = null;
  if (placeId !== null) {
    const reference = { recordId: placeId, detail };
    const evidence: Evidence[] = [{ field: 'place_id', value: placeId, quality: 'structured', reference }];
    const name = place.displayName?.text === undefined ? '' : sanitiseText(place.displayName.text, 'name');
    if (name !== '') {
      evidence.push({ field: 'name', value: name, quality: 'structured', reference });
    }
    const phone = normalisePhone(place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? '', countryCode);
    if (phone !== null) {
      evidence.push({ field: 'phone', value: phone, quality: 'structured', reference });
    }
    const address = placeAddress(place, countryCode);
    if (address !== null) {
      evidence.push({ field: 'address', value: address, quality: 'structured', reference });
    }
    const website = place.websiteUri === undefined ? null : normaliseUrl(sanitiseText(place.websiteUri, 'url'));
    if (website !== null) {
      evidence.push({ field: 'website', value: website, quality: 'structured', reference: { ...reference, url: website.url } });
    }
    const cid = place.googleMapsUri === undefined ? null : mapsCid(place.googleMapsUri);
    const status = BUSINESS_STATUSES.find((known) => known === place.businessStatus?.toLowerCase());
    record = {
      source: 'google-places-api', origin: ORIGIN, subject: placeId, scope: 'location', role: 'unknown', evidence,
      ...(cid === null ? {} : { mapsCids: [cid] }), ...(status === undefined ? {} : { businessStatus: status }),
    };
  }
  return record;
}

/** A URL path's last segment longer than this isn't a usable place hint. */
const MAX_PATH_HINT_CHARS = 60;

/** What Google is asked: the text, and when the name came from the domain, the site its places must be on. */
export interface SearchPlan {
  text: string;
  /** Set when no name was known: only places whose website is on this site are kept. */
  siteDomain: string | null;
}

/** The last segment of a URL's path, as words (/bookshops/reading -> "reading"); null for a site root or a non-word segment. */
export function pathHint(url: string): string | null {
  const segment = new URL(url).pathname.split('/').filter((part) => part !== '').pop() ?? '';
  const words = decodeEscapes(segment).replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_+]+/g, ' ').trim();
  return /\p{L}/u.test(words) && words.length <= MAX_PATH_HINT_CHARS ? words : null;
}

/**
 * What to search for (docs/providers.md). The query's own keys come first, so a lead another provider followed (one
 * branch's page) can't narrow a town-wide query to that branch: its postcode or address with the best name known; else
 * its phone; else a location another provider found; else a phone a page showed; else a hint from the URL's path.
 * With no name known, the domain stands in for one, and the path comes before a page's phone (which may be a call-
 * tracking number). A search on a domain-derived name, a name alone, or (for a home page) a found name that spells the
 * domain, keeps only places on the query's site.
 */
export function searchPlan(knowledge: Knowledge): SearchPlan | null {
  const { query, fields } = knowledge;
  const queryLocation = query.postcode ?? query.address;
  const queryPhone = query.phone?.display ?? null;
  const knownName = query.name ?? fields.name ?? null;
  const isNameFromDomain = knownName === null && query.website !== null;
  const domainName = query.website === null ? null : nameFromDomain(query.website.domain);
  const name = knownName ?? domainName;
  // On a home page, a found name that only spells the domain ("PureGym" on puregym.com) finds namesakes as the domain would.
  const isDomainSpelling = query.name === null && query.website !== null && isSiteRoot(query.website.url)
    && name !== null && domainName !== null && compactWords(name) === compactWords(domainName);
  const location = queryLocation ?? fields.address?.postcode ?? fields.address?.town ?? null;
  const foundPhone = fields.phone?.display ?? null;
  const hint = query.website === null ? null : pathHint(query.website.url);
  let text: string | null = null;
  let isSiteOnly = isNameFromDomain || isDomainSpelling;
  if (queryLocation === null && queryPhone !== null) {
    text = queryPhone;
  } else if (name !== null && location !== null) {
    text = `${name}, ${location}`;
  } else if (foundPhone !== null && !isNameFromDomain) {
    text = foundPhone;
  } else if (name !== null && hint !== null) {
    text = `${name}, ${hint}`;
  } else if (foundPhone !== null) {
    text = foundPhone;
  } else if (name !== null && query.website !== null) {
    // A name alone (a chain's home page with no location) finds its places anywhere: keep those on its own site.
    text = name;
    isSiteOnly = true;
  }
  return text === null ? null : { text, siteDomain: isSiteOnly ? query.website?.domain ?? null : null };
}

/** The text a search would send, or null when there's nothing to search with. */
export function searchText(knowledge: Knowledge): string | null {
  return searchPlan(knowledge)?.text ?? null;
}

/** The API key, which the engine only gives a configured provider. */
function apiKey(context: ProviderContext): string {
  if (context.settings.apiKey === null) {
    throw new ProviderError('auth_failed', 'no API key', 'no_api_key');
  }
  return context.settings.apiKey;
}

/**
 * Checks the websites of places named like the query but on another site (docs/providers.md): one that redirects to the
 * query's site is given that address, and one whose host doesn't answer at all is dropped as dead. At most a few are tried.
 */
async function resolveOffSiteWebsites(records: SourceRecord[], knowledge: Knowledge, context: ProviderContext): Promise<SourceRecord[]> {
  const { query } = knowledge;
  const querySite = query.website?.domain ?? null;
  const queryName = query.name ?? knowledge.fields.name ?? null;
  let tried = 0;
  const resolved: SourceRecord[] = [];
  for (const record of records) {
    const website = record.evidence.find((item) => item.field === 'website');
    const name = record.evidence.find((item) => item.field === 'name');
    const isOffSiteNamesake = querySite !== null && queryName !== null && website?.field === 'website' && name?.field === 'name'
      && !isSameSite(website.value.domain, querySite) && compareQueryName(queryName, name.value) !== 'incompatible';
    if (!isOffSiteNamesake || tried >= MAX_WEBSITE_CHECKS) {
      resolved.push(record);
      continue;
    }
    tried += 1;
    let landed: string | null = null;
    let isDead = false;
    try {
      // Stopped at the first hop onto the query's site, so that page isn't fetched here.
      await context.webHttp.request({
        url: website.value.url, kind: 'html', cacheTtlSeconds: WEBSITE_CHECK_TTL_SECONDS,
        canFollowRedirect: (unusedFrom, to) => {
          landed = isSameSite(to.hostname, querySite) ? to.href : null;
          return landed === null;
        },
      });
    } catch (error) {
      if (!(error instanceof HttpError)) {
        throw error;
      }
      isDead = error.failure === 'network';
      if (landed === null) {
        context.logger.warn(`Couldn't check Google's website for ${name.value}: ${error.message}`);
      }
    }
    const landedWebsite = landed === null ? null : normaliseUrl(landed);
    if (landedWebsite !== null) {
      resolved.push({ ...record, evidence: record.evidence.map((item) => (item === website
        ? { ...item, value: landedWebsite, reference: { ...item.reference, detail: `${item.reference.detail}: ${website.value.url}, which redirects to ${landedWebsite.url}` } }
        : item)) });
    } else if (isDead) {
      context.warn(`Google's website for ${name.value} (${website.value.url}) doesn't answer, so it's left out.`);
      resolved.push({ ...record, evidence: record.evidence.filter((item) => item !== website) });
    } else {
      resolved.push(record);
    }
  }
  return resolved;
}

/** Builds the Google Places provider: Place Details for a known place ID, else one Text Search (docs/providers.md). */
export function createGooglePlacesProvider(): Provider {
  return {
    declaration: PROVIDER_DECLARATIONS['google-places-api'],
    readiness(knowledge: Knowledge): Readiness {
      return knowledge.query.placeId !== null || searchText(knowledge) !== null
        ? { state: 'ready' }
        : { state: 'waiting', reason: 'no place ID, and no name with a location (or a phone) to search with' };
    },
    maxCalls: () => 1,
    async run(knowledge: Knowledge, context: ProviderContext): Promise<SourceRecord[]> {
      const key = apiKey(context);
      const countryCode = knowledge.query.country;
      let places: Place[];
      let detail: string;
      let siteDomain: string | null = null;
      if (knowledge.query.placeId !== null) {
        detail = 'Google Places Place Details';
        const place = await apiRequest(() => context.http.request({
          url: `${API_BASE}/places/${encodeURIComponent(knowledge.query.placeId ?? '')}`,
          kind: 'json',
          headers: { [KEY_HEADER]: key, [FIELD_MASK_HEADER]: PLACE_FIELDS.join(',') },
        }), API_NAME) as Place;
        places = [place];
      } else {
        const plan = searchPlan(knowledge);
        siteDomain = plan?.siteDomain ?? null;
        detail = siteDomain === null ? 'Google Places Text Search' : `Google Places Text Search for ${siteDomain}`;
        const response = await apiRequest(() => context.http.request({
          url: `${API_BASE}/places:searchText`,
          kind: 'json',
          method: 'POST',
          headers: { [KEY_HEADER]: key, [FIELD_MASK_HEADER]: PLACE_FIELDS.map((field) => `places.${field}`).join(',') },
          json: { textQuery: plan?.text, regionCode: countryCode.toLowerCase(), pageSize: SEARCH_PAGE_SIZE },
        }), API_NAME) as { places?: Place[] };
        places = Array.isArray(response.places) ? response.places : [];
      }
      const found = places.flatMap((place) => {
        const record = placeRecord(place, countryCode, detail);
        return record === null ? [] : [{ place, record }];
      });
      const resolved = await resolveOffSiteWebsites(found.map((entry) => entry.record), knowledge, context);
      const records: SourceRecord[] = [];
      for (const [index, record] of resolved.entries()) {
        const place = found[index]?.place;
        // A search on the domain's name finds namesakes too: keep only places whose website is on that site.
        const website = record.evidence.find((item) => item.field === 'website');
        const isKept = siteDomain === null || (website?.field === 'website' && isSameSite(website.value.domain, siteDomain));
        if (isKept) {
          records.push(record);
        }
        if (isKept && place?.businessStatus !== undefined && place.businessStatus !== OPERATIONAL) {
          const name = place.displayName?.text === undefined ? record.subject : sanitiseText(place.displayName.text, 'name');
          context.warn(`Google lists ${name} as ${place.businessStatus.toLowerCase().replace(/_/g, ' ')}.`);
        }
      }
      return records;
    },
    async check(context: ProviderContext): Promise<void> {
      await apiRequest(() => context.http.request({
        url: `${API_BASE}/places:searchText`,
        kind: 'json',
        method: 'POST',
        headers: { [KEY_HEADER]: apiKey(context), [FIELD_MASK_HEADER]: CHECK_FIELD_MASK },
        json: { textQuery: CHECK_QUERY, pageSize: 1 },
      }), API_NAME);
    },
  };
}
