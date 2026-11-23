import type { Evidence, SourceRecord } from '../../lookup/types.js';
import { normalisePhone } from '../../normalise/phone.js';
import { sanitiseText } from '../../normalise/text.js';
import { normaliseUrl } from '../../normalise/url.js';
import { apiRequest } from '../api-errors.js';
import type { Knowledge, Provider, ProviderContext } from '../contract.js';
import { PROVIDER_DECLARATIONS } from '../declarations.js';
import { addressFrom } from '../web-fetch/evidence.js';
import { firstOwnSite, googleCountry, searchApiKey, searchQuery, searchReadiness, websiteRecord, type SearchHit, type SearchOptions } from '../search/common.js';

const API_NAME = 'SearchAPI.io';
const SEARCH_URL = 'https://www.searchapi.io/api/v1/search';
const RESULTS_PER_SEARCH = 10;
/** The business panel is Google's data, so it shares Google's origin and never counts as independent of it. */
const PANEL_ORIGIN = 'google-business-profile';
const CHECK_QUERY = 'compfinder';

/** The parts of a SearchAPI.io Google response compfinder reads. */
interface SearchResponse {
  organic_results?: Array<{ link?: string; title?: string }>;
  knowledge_graph?: Panel;
  local_results?: Panel[];
}

interface Panel {
  title?: string;
  website?: string;
  phone?: string;
  address?: string;
  place_id?: string;
}

/** Builds the search URL. The key goes in the Authorization header, never here. */
function searchUrl(query: string, countryCode: string, results: number): string {
  const parameters = new URLSearchParams({ engine: 'google', q: query, gl: googleCountry(countryCode), hl: 'en', num: String(results) });
  return `${SEARCH_URL}?${parameters.toString()}`;
}

/** Google's business panel as a location record. */
function panelRecord(panel: Panel, countryCode: string): SourceRecord | null {
  const reference = { detail: 'Google business panel, via SearchAPI.io' };
  const evidence: Evidence[] = [];
  const name = panel.title === undefined ? '' : sanitiseText(panel.title, 'name');
  if (name !== '') {
    evidence.push({ field: 'name', value: name, quality: 'structured', reference });
  }
  const phone = panel.phone === undefined ? null : normalisePhone(sanitiseText(panel.phone, 'phone'), countryCode);
  if (phone !== null) {
    evidence.push({ field: 'phone', value: phone, quality: 'structured', reference });
  }
  const address = panel.address === undefined ? null : addressFrom(sanitiseText(panel.address, 'identifier'), null, countryCode);
  if (address !== null) {
    evidence.push({ field: 'address', value: { ...address, formatted: sanitiseText(panel.address ?? '', 'identifier') }, quality: 'structured', reference });
  }
  const website = panel.website === undefined ? null : normaliseUrl(sanitiseText(panel.website, 'url'));
  if (website !== null) {
    evidence.push({ field: 'website', value: website, quality: 'structured', reference: { ...reference, url: website.url } });
  }
  return evidence.length < 2 ? null : {
    source: 'searchapi-io', origin: PANEL_ORIGIN, subject: `panel:${name}`, scope: 'location', role: 'unknown', evidence,
  };
}

/** Builds the SearchAPI.io provider: finds the website, and reads Google's business panel (docs/providers.md). */
export function createSearchApiProvider(options: SearchOptions): Provider {
  return {
    declaration: PROVIDER_DECLARATIONS['searchapi-io'],
    readiness: (knowledge) => searchReadiness(knowledge, options.isRunAll),
    maxCalls: () => 1,
    async run(knowledge: Knowledge, context: ProviderContext): Promise<SourceRecord[]> {
      const countryCode = knowledge.query.country;
      const response = await apiRequest(() => context.http.request({
        url: searchUrl(searchQuery(knowledge), countryCode, RESULTS_PER_SEARCH),
        kind: 'json',
        headers: { authorization: `Bearer ${searchApiKey(context)}` },
      }), API_NAME) as SearchResponse;
      const records: SourceRecord[] = [];
      const panels = [response.knowledge_graph, ...(Array.isArray(response.local_results) ? response.local_results : [])].filter((panel) => panel !== undefined);
      for (const panel of panels) {
        const record = panelRecord(panel, countryCode);
        if (record !== null) {
          records.push(record);
        }
      }
      const hits: SearchHit[] = (Array.isArray(response.organic_results) ? response.organic_results : [])
        .filter((result) => typeof result.link === 'string')
        .map((result) => ({ url: result.link ?? '', title: result.title ?? null }));
      const hit = firstOwnSite(hits, options.directoryHosts);
      const site = hit === null ? null : websiteRecord('searchapi-io', hit, 'first non-directory Google result, via SearchAPI.io');
      if (site !== null) {
        records.push(site);
      }
      return records;
    },
    async check(context: ProviderContext): Promise<void> {
      await apiRequest(() => context.http.request({
        url: searchUrl(CHECK_QUERY, 'GB', 1), kind: 'json', headers: { authorization: `Bearer ${searchApiKey(context)}` },
      }), API_NAME);
    },
  };
}
