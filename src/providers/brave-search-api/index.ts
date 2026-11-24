import type { SourceRecord } from '../../lookup/types.js';
import { apiRequest } from '../api-errors.js';
import type { Knowledge, Provider, ProviderContext } from '../contract.js';
import { PROVIDER_DECLARATIONS } from '../declarations.js';
import { firstOwnSite, searchApiKey, searchQuery, searchReadiness, websiteRecord, type SearchHit, type SearchOptions } from '../search/common.js';

const API_NAME = 'Brave Search API';
const SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
const KEY_HEADER = 'x-subscription-token';
const RESULTS_PER_SEARCH = 10;
const CHECK_QUERY = 'compfinder';

/** The parts of a Brave web search response compfinder reads. */
interface BraveResponse {
  web?: { results?: Array<{ url?: string; title?: string }> };
}

/** Builds the search URL. The key goes in the X-Subscription-Token header, never here. */
function searchUrl(query: string, countryCode: string, results: number): string {
  const parameters = new URLSearchParams({ q: query, country: countryCode.toUpperCase(), count: String(results) });
  return `${SEARCH_URL}?${parameters.toString()}`;
}

/** Builds the Brave Search provider: finds the business's website from web results (docs/providers.md). */
export function createBraveSearchProvider(options: SearchOptions): Provider {
  return {
    declaration: PROVIDER_DECLARATIONS['brave-search-api'],
    readiness: (knowledge) => searchReadiness(knowledge),
    maxCalls: () => 1,
    async run(knowledge: Knowledge, context: ProviderContext): Promise<SourceRecord[]> {
      const response = await apiRequest(() => context.http.request({
        url: searchUrl(searchQuery(knowledge), knowledge.query.country, RESULTS_PER_SEARCH),
        kind: 'json',
        headers: { [KEY_HEADER]: searchApiKey(context) },
      }), API_NAME) as BraveResponse;
      const hits: SearchHit[] = (Array.isArray(response.web?.results) ? response.web.results : [])
        .filter((result) => typeof result.url === 'string')
        .map((result) => ({ url: result.url ?? '', title: result.title ?? null }));
      const hit = firstOwnSite(hits, options.directoryHosts);
      const site = hit === null ? null : websiteRecord('brave-search-api', hit, 'first non-directory Brave result');
      return site === null ? [] : [site];
    },
    async check(context: ProviderContext): Promise<void> {
      await apiRequest(() => context.http.request({
        url: searchUrl(CHECK_QUERY, 'GB', 1), kind: 'json', headers: { [KEY_HEADER]: searchApiKey(context) },
      }), API_NAME);
    },
  };
}
