import type { Evidence, SourceRecord } from '../../lookup/types.js';
import { ProviderError } from '../../lookup/errors.js';
import { sanitiseText } from '../../normalise/text.js';
import { normaliseUrl } from '../../normalise/url.js';
import type { Knowledge, ProviderContext, Readiness } from '../contract.js';
import type { ProviderName } from '../declarations.js';

const SITE_ORIGIN_PREFIX = 'site:';

/** The website-discovery result a search provider found. */
export interface SearchHit {
  url: string;
  title: string | null;
}

/** Search providers' behaviour from config. */
export interface SearchOptions {
  directoryHosts: readonly string[];
}

/** A search provider runs only while no website is known, and needs a name to search for. */
export function searchReadiness(knowledge: Knowledge): Readiness {
  const isWebsiteKnown = knowledge.query.website !== null || knowledge.fields.website !== undefined;
  let readiness: Readiness;
  if (isWebsiteKnown) {
    readiness = { state: 'never', reason: 'website already known' };
  } else if (knowledge.query.name === null && knowledge.fields.name === undefined) {
    readiness = { state: 'never', reason: 'no name to search for' };
  } else {
    readiness = { state: 'ready' };
  }
  return readiness;
}

/** The search text: the business name plus the best location known. */
export function searchQuery(knowledge: Knowledge): string {
  const name = knowledge.query.name ?? knowledge.fields.name ?? '';
  const location = knowledge.query.postcode ?? knowledge.fields.address?.postcode ?? knowledge.fields.address?.town ?? knowledge.query.address ?? '';
  return [name, location].filter((part) => part !== '').join(' ');
}

/** True when a host is a directory, social network or portal (config discover.directory_hosts), never a business's own site. */
export function isDirectoryHost(host: string, directoryHosts: readonly string[]): boolean {
  return directoryHosts.some((directory) => host === directory || host.endsWith(`.${directory}`));
}

/** The first organic result on a business's own site, skipping directories; null when there's none. */
export function firstOwnSite(hits: readonly SearchHit[], directoryHosts: readonly string[]): SearchHit | null {
  return hits.find((hit) => {
    const website = normaliseUrl(hit.url);
    return website !== null && !isDirectoryHost(website.domain, directoryHosts);
  }) ?? null;
}

/** A discovered website as a record. Its origin is that site, so it never counts as confirming the site itself. */
export function websiteRecord(provider: ProviderName, hit: SearchHit, detail: string): SourceRecord | null {
  const website = normaliseUrl(sanitiseText(hit.url, 'url'));
  const evidence: Evidence[] = website === null ? [] : [{ field: 'website', value: website, quality: 'loose', reference: { url: website.url, detail } }];
  return website === null ? null : {
    source: provider, origin: `${SITE_ORIGIN_PREFIX}${website.domain}`, subject: website.url, scope: 'brand', role: 'unknown', evidence,
  };
}

/** The provider's API key; the engine only runs a configured provider. */
export function searchApiKey(context: ProviderContext): string {
  if (context.settings.apiKey === null) {
    throw new ProviderError('auth_failed', 'no API key');
  }
  return context.settings.apiKey;
}

/** The country code a search API expects for the lookup's country (Google uses "uk" for GB). */
export function googleCountry(countryCode: string): string {
  return countryCode.toUpperCase() === 'GB' ? 'uk' : countryCode.toLowerCase();
}
