import type { AddressValue, Evidence, SourceRecord } from '../../lookup/types.js';
import { ProviderError } from '../../lookup/errors.js';
import { countryRules } from '../../normalise/country/index.js';
import { normalisePhone } from '../../normalise/phone.js';
import { parseSocialProfile } from '../../normalise/social.js';
import { sanitiseText } from '../../normalise/text.js';
import { normaliseUrl } from '../../normalise/url.js';
import { apiRequest } from '../api-errors.js';
import type { Knowledge, Provider, ProviderContext, Readiness } from '../contract.js';
import { PROVIDER_DECLARATIONS } from '../declarations.js';

const API_NAME = 'Apollo.io';
/** The only Apollo endpoint compfinder calls: organisation enrichment. It never calls a people endpoint. */
export const APOLLO_ENRICH_URL = 'https://api.apollo.io/api/v1/organizations/enrich';
const APOLLO_HEALTH_URL = 'https://api.apollo.io/v1/auth/health';
const KEY_HEADER = 'x-api-key';
const ORIGIN = 'apollo';
const DETAIL = 'Apollo.io organisation enrichment';

/** The organisation fields compfinder reads: an explicit allow-list, so people data in a response is never touched. */
interface ApolloOrganisation {
  id?: string;
  name?: string;
  website_url?: string;
  primary_domain?: string;
  sanitized_phone?: string;
  phone?: string;
  street_address?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  linkedin_url?: string;
  facebook_url?: string;
  twitter_url?: string;
}

/** Reads one string field from the organisation, sanitised; null when absent. */
function text(organisation: ApolloOrganisation, field: keyof ApolloOrganisation): string | null {
  const value = organisation[field];
  const cleaned = typeof value === 'string' ? sanitiseText(value, 'addressLine') : '';
  return cleaned === '' ? null : cleaned;
}

/** Apollo's address for the organisation: always its head office, never a branch. */
function headOfficeAddress(organisation: ApolloOrganisation, countryCode: string): AddressValue | null {
  const street = text(organisation, 'street_address');
  const rawPostcode = text(organisation, 'postal_code');
  const postcode = rawPostcode === null ? null : countryRules(countryCode).normalisePostcode(rawPostcode) ?? rawPostcode;
  return street === null && postcode === null ? null : {
    lines: street === null ? [] : [street],
    town: text(organisation, 'city'),
    county: text(organisation, 'state'),
    postcode,
    country_code: countryCode,
    formatted: null,
    lat: null,
    lon: null,
  };
}

/** The organisation as one brand record, with the role head-office. */
export function organisationRecord(organisation: ApolloOrganisation, countryCode: string): SourceRecord | null {
  const reference = { recordId: text(organisation, 'id') ?? undefined, detail: DETAIL };
  const evidence: Evidence[] = [];
  const name = organisation.name === undefined ? '' : sanitiseText(organisation.name, 'name');
  if (name !== '') {
    evidence.push({ field: 'name', value: name, quality: 'structured', reference });
  }
  const rawWebsite = text(organisation, 'website_url') ?? text(organisation, 'primary_domain');
  const website = rawWebsite === null ? null : normaliseUrl(rawWebsite);
  if (website !== null) {
    evidence.push({ field: 'website', value: website, quality: 'structured', reference: { ...reference, url: website.url } });
  }
  const phone = normalisePhone(text(organisation, 'sanitized_phone') ?? text(organisation, 'phone') ?? '', countryCode);
  if (phone !== null) {
    evidence.push({ field: 'phone', value: phone, quality: 'structured', reference });
  }
  const address = headOfficeAddress(organisation, countryCode);
  if (address !== null) {
    evidence.push({ field: 'address', value: address, quality: 'structured', reference });
  }
  for (const field of ['linkedin_url', 'facebook_url', 'twitter_url'] as const) {
    const url = text(organisation, field);
    const social = url === null ? null : parseSocialProfile(url);
    if (social?.kind === 'profile') {
      evidence.push({ field: 'socials', value: social.value, quality: 'structured', reference });
    }
  }
  return evidence.length === 0 ? null : {
    source: 'apollo-io', origin: ORIGIN, subject: reference.recordId ?? name, scope: 'brand', role: 'head-office', evidence,
  };
}

/** The API key; the engine only runs a configured provider. */
function apiKey(context: ProviderContext): string {
  if (context.settings.apiKey === null) {
    throw new ProviderError('auth_failed', 'no API key');
  }
  return context.settings.apiKey;
}

/** Builds the Apollo.io provider: organisation enrichment by domain, organisations only (docs/providers.md). */
export function createApolloProvider(): Provider {
  return {
    declaration: PROVIDER_DECLARATIONS['apollo-io'],
    readiness(knowledge: Knowledge): Readiness {
      return knowledge.query.website !== null || knowledge.fields.website !== undefined
        ? { state: 'ready' }
        : { state: 'waiting', reason: 'no website domain known' };
    },
    maxCalls: () => 1,
    async run(knowledge: Knowledge, context: ProviderContext): Promise<SourceRecord[]> {
      const domain = (knowledge.query.website ?? knowledge.fields.website)?.domain ?? '';
      const response = await apiRequest(() => context.http.request({
        url: `${APOLLO_ENRICH_URL}?${new URLSearchParams({ domain }).toString()}`,
        kind: 'json',
        headers: { [KEY_HEADER]: apiKey(context) },
      }), API_NAME) as { organization?: ApolloOrganisation | null };
      const organisation = response.organization;
      const record = organisation === undefined || organisation === null ? null : organisationRecord(organisation, knowledge.query.country);
      return record === null ? [] : [record];
    },
    async check(context: ProviderContext): Promise<void> {
      await apiRequest(() => context.http.request({ url: APOLLO_HEALTH_URL, kind: 'json', headers: { [KEY_HEADER]: apiKey(context) } }), API_NAME);
    },
  };
}
