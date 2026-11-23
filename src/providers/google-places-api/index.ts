import type { AddressValue, Evidence, SourceRecord } from '../../lookup/types.js';
import { ProviderError } from '../../lookup/errors.js';
import { countryRules } from '../../normalise/country/index.js';
import { normalisePhone } from '../../normalise/phone.js';
import { sanitiseText } from '../../normalise/text.js';
import { normaliseUrl } from '../../normalise/url.js';
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
  'nationalPhoneNumber', 'internationalPhoneNumber', 'websiteUri', 'businessStatus',
];
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
    record = { source: 'google-places-api', origin: ORIGIN, subject: placeId, scope: 'location', role: 'unknown', evidence };
  }
  return record;
}

/** The text to search for: the best name known, plus the best location (postcode, then town, then address). */
export function searchText(knowledge: Knowledge): string | null {
  const name = knowledge.query.name ?? knowledge.fields.name ?? null;
  const address = knowledge.fields.address;
  const location = knowledge.query.postcode ?? address?.postcode ?? address?.town ?? knowledge.query.address ?? null;
  const phone = knowledge.query.phone?.display ?? knowledge.fields.phone?.display ?? null;
  let text: string | null = null;
  if (name !== null && location !== null) {
    text = `${name}, ${location}`;
  } else if (phone !== null) {
    text = phone;
  }
  return text;
}

/** The API key, which the engine only gives a configured provider. */
function apiKey(context: ProviderContext): string {
  if (context.settings.apiKey === null) {
    throw new ProviderError('auth_failed', 'no API key');
  }
  return context.settings.apiKey;
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
      if (knowledge.query.placeId !== null) {
        detail = 'Google Places Place Details';
        const place = await apiRequest(() => context.http.request({
          url: `${API_BASE}/places/${encodeURIComponent(knowledge.query.placeId ?? '')}`,
          kind: 'json',
          headers: { [KEY_HEADER]: key, [FIELD_MASK_HEADER]: PLACE_FIELDS.join(',') },
        }), API_NAME) as Place;
        places = [place];
      } else {
        detail = 'Google Places Text Search';
        const response = await apiRequest(() => context.http.request({
          url: `${API_BASE}/places:searchText`,
          kind: 'json',
          method: 'POST',
          headers: { [KEY_HEADER]: key, [FIELD_MASK_HEADER]: PLACE_FIELDS.map((field) => `places.${field}`).join(',') },
          json: { textQuery: searchText(knowledge), regionCode: countryCode.toLowerCase(), pageSize: SEARCH_PAGE_SIZE },
        }), API_NAME) as { places?: Place[] };
        places = Array.isArray(response.places) ? response.places : [];
      }
      const records: SourceRecord[] = [];
      for (const place of places) {
        const record = placeRecord(place, countryCode, detail);
        if (record !== null) {
          records.push(record);
        }
        if (record !== null && place.businessStatus !== undefined && place.businessStatus !== OPERATIONAL) {
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
