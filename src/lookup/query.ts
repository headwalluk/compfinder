import { normaliseCountryCode } from '../normalise/country/codes.js';
import { countryRules } from '../normalise/country/index.js';
import { normalisePhone } from '../normalise/phone.js';
import { sanitiseText } from '../normalise/text.js';
import { normaliseUrl } from '../normalise/url.js';
import { QUERY_ORIGIN, QUERY_SOURCE, type Evidence, type Query, type SourceRecord } from './types.js';

/** The inputs to one lookup, as the caller gave them. */
export interface QueryInput {
  name?: string;
  url?: string;
  address?: string;
  postcode?: string;
  phone?: string;
  place_id?: string;
  country?: string;
}

/** The keys a query may have, in documentation order. */
export const QUERY_INPUT_KEYS = ['name', 'url', 'address', 'postcode', 'phone', 'place_id', 'country'] as const;

/** Reads untyped input (a JSON object) into query input, listing unknown keys and non-string values. */
export function readQueryInput(value: unknown, extraKeys: readonly string[] = []): { input: QueryInput | null; problems: string[] } {
  const problems: string[] = [];
  let input: QueryInput | null = null;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push('The query must be an object.');
  } else {
    const record = value as Record<string, unknown>;
    const allowed = new Set<string>([...extraKeys, ...QUERY_INPUT_KEYS]);
    for (const key of Object.keys(record).filter((candidate) => !allowed.has(candidate))) {
      problems.push(`Unknown key "${key}". Keys are ${[...allowed].join(', ')}.`);
    }
    for (const key of QUERY_INPUT_KEYS.filter((candidate) => record[candidate] !== undefined && record[candidate] !== null && typeof record[candidate] !== 'string')) {
      problems.push(`"${key}" must be a string.`);
    }
    input = Object.fromEntries(QUERY_INPUT_KEYS.filter((key) => typeof record[key] === 'string').map((key) => [key, record[key]])) as QueryInput;
  }
  return { input, problems };
}

/** Google place IDs are URL-safe base64-like tokens. */
const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{10,300}$/;
const QUERY_SUBJECT = 'query';
const QUERY_DETAIL = 'given in the query';

/** Returns trimmed text, or null when absent or blank. */
function present(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/** Normalises a lookup's inputs; lists every problem rather than stopping at the first. */
export function normaliseQuery(input: QueryInput, defaultCountry: string): { query: Query; problems: string[] } {
  const problems: string[] = [];
  const countryInput = present(input.country);
  let country = defaultCountry;
  const countryCode = countryInput === null ? null : normaliseCountryCode(countryInput);
  const notes: string[] = [];
  if (countryCode !== null) {
    country = countryCode;
    if (countryInput !== null && countryInput.trim().toUpperCase() !== countryCode) {
      notes.push(`country "${countryInput}" was read as ${countryCode}, its ISO code.`);
    }
  } else if (countryInput !== null) {
    problems.push(`country must be a two-letter country code such as GB; got "${countryInput}".`);
  }
  const rules = countryRules(country);

  const nameInput = present(input.name);
  const name = nameInput === null ? null : sanitiseText(nameInput, 'name');

  const urlInput = present(input.url);
  const website = urlInput === null ? null : normaliseUrl(urlInput);
  if (urlInput !== null && website === null) {
    problems.push(`url must be a web address such as example.com or https://example.com/branch/; got "${urlInput}".`);
  }

  const addressInput = present(input.address);
  const address = addressInput === null ? null : sanitiseText(addressInput, 'addressLine');

  const postcodeInput = present(input.postcode);
  let postcode = postcodeInput === null ? null : rules.normalisePostcode(postcodeInput);
  if (postcodeInput !== null && postcode === null) {
    problems.push(`postcode "${postcodeInput}" isn't a valid ${country} postcode.`);
  }
  if (postcode === null && postcodeInput === null && address !== null) {
    postcode = rules.findPostcodes(address)[0] ?? null;
  }

  const phoneInput = present(input.phone);
  const phone = phoneInput === null ? null : normalisePhone(phoneInput, country);
  if (phoneInput !== null && phone === null) {
    problems.push(`phone "${phoneInput}" isn't a valid ${country} phone number.`);
  }

  const placeIdInput = present(input.place_id);
  const placeId = placeIdInput !== null && PLACE_ID_PATTERN.test(placeIdInput) ? placeIdInput : null;
  if (placeIdInput !== null && placeId === null) {
    problems.push(`place_id "${placeIdInput}" doesn't look like a Google place ID.`);
  }

  const query: Query = { name, website, address, postcode, phone, placeId, country, ...(notes.length > 0 ? { notes } : {}) };
  if (problems.length === 0 && Object.values({ name, website, address, postcode, phone, placeId }).every((value) => value === null)) {
    problems.push('Give at least one of: a name, url, address, postcode, phone or place_id.');
  }
  return { query, problems };
}

/** The query as a record, so scoring can compare it with what sources found. It's never an independent source. */
export function queryRecord(query: Query): SourceRecord {
  const reference = { detail: QUERY_DETAIL };
  const evidence: Evidence[] = [];
  if (query.name !== null) {
    evidence.push({ field: 'name', value: query.name, quality: 'structured', reference });
  }
  if (query.website !== null) {
    evidence.push({ field: 'website', value: query.website, quality: 'structured', reference });
  }
  // Free text without a postcode can't be compared with a structured address; the town key covers it.
  if (query.postcode !== null) {
    const value = {
      lines: query.address === null ? [] : [query.address],
      town: null,
      county: null,
      postcode: query.postcode,
      country_code: query.country,
      formatted: null,
      lat: null,
      lon: null,
    };
    evidence.push({ field: 'address', value, quality: 'structured', reference });
  }
  if (query.phone !== null) {
    evidence.push({ field: 'phone', value: query.phone, quality: 'structured', reference });
  }
  if (query.placeId !== null) {
    evidence.push({ field: 'place_id', value: query.placeId, quality: 'structured', reference });
  }
  return { source: QUERY_SOURCE, origin: QUERY_ORIGIN, subject: QUERY_SUBJECT, scope: 'location', role: 'unknown', evidence };
}
