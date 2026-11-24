import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, type Config } from '../../src/config.js';
import { normaliseQuery, queryRecord, type QueryInput } from '../../src/lookup/query.js';
import type {
  AddressValue,
  Evidence,
  EvidenceQuality,
  LogoSource,
  Query,
  RecordRole,
  RecordScope,
  SocialNetwork,
  SourceName,
  SourceRecord,
} from '../../src/lookup/types.js';
import { normalisePhone } from '../../src/normalise/phone.js';
import { normaliseUrl } from '../../src/normalise/url.js';
import { scoreLookup, type ScoreResult } from '../../src/scoring/index.js';

/** Builds evidence values in test-friendly shorthand. */
export const fact = {
  name: (value: string, quality: EvidenceQuality = 'structured'): Evidence => ({ field: 'name', value, quality, reference: { detail: 'test' } }),
  phone: (display: string, quality: EvidenceQuality = 'structured'): Evidence => {
    const value = normalisePhone(display, 'GB');
    if (value === null) {
      throw new Error(`Test phone ${display} isn't valid`);
    }
    return { field: 'phone', value, quality, reference: { detail: 'test' } };
  },
  address: (parts: Partial<AddressValue>, quality: EvidenceQuality = 'structured'): Evidence => ({
    field: 'address',
    value: { lines: [], town: null, county: null, postcode: null, country_code: 'GB', formatted: null, lat: null, lon: null, ...parts },
    quality,
    reference: { detail: 'test' },
  }),
  website: (url: string, quality: EvidenceQuality = 'structured'): Evidence => {
    const value = normaliseUrl(url);
    if (value === null) {
      throw new Error(`Test URL ${url} isn't valid`);
    }
    return { field: 'website', value, quality, reference: { url: value.url, detail: 'test' } };
  },
  placeId: (value: string): Evidence => ({ field: 'place_id', value, quality: 'structured', reference: { recordId: value, detail: 'test' } }),
  email: (address: string, quality: EvidenceQuality = 'structured'): Evidence => ({
    field: 'email', value: { address, kind: 'role' }, quality, reference: { detail: 'test' },
  }),
  logo: (sourceUrl: string, source: LogoSource, width: number | null = null): Evidence => ({
    field: 'logo',
    value: {
      source_url: sourceUrl,
      kind: source === 'schema-org' ? 'logo' : source === 'social-image' ? 'social-image' : 'icon',
      source, width, height: null, path: null, mime: null, converted_from: null,
    },
    quality: 'structured',
    reference: { url: sourceUrl, detail: `${source} logo` },
  }),
  social: (network: SocialNetwork, url: string, quality: EvidenceQuality = 'structured'): Evidence => ({
    field: 'socials', value: { network, url }, quality, reference: { detail: 'test' },
  }),
};

/** Builds a record; origin defaults by source (the site for web-fetch, Google's for google-places-api). */
export function record(
  source: SourceName,
  evidence: Evidence[],
  options: { origin?: string; scope?: RecordScope; role?: RecordRole; subject?: string } = {},
): SourceRecord {
  const defaultOrigins: Partial<Record<SourceName, string>> = {
    'web-fetch': 'site:example.com',
    'google-places-api': 'google-business-profile',
  };
  return {
    source,
    origin: options.origin ?? defaultOrigins[source] ?? source,
    subject: options.subject ?? `${source}-test`,
    scope: options.scope ?? 'location',
    role: options.role ?? 'unknown',
    evidence,
  };
}

/** A fresh, empty cache directory for one test. */
export function temporaryCacheDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'compfinder-cache-'));
}

/** The default test config: no variables, and a fresh temporary cache directory unless the file text sets one. */
export function testConfig(changes: { fileText?: string; variables?: Record<string, string> } = {}): Config {
  const fileText = changes.fileText ?? '';
  return loadConfig({
    variables: changes.variables ?? {},
    configPath: '/home/tester/.config/compfinder/config.toml',
    isConfigPathExplicit: false,
    fileText: /^cache_dir\s*=/m.test(fileText) ? fileText : `cache_dir = ${JSON.stringify(temporaryCacheDir())}\n${fileText}`,
    overrides: {},
    workingDirectory: '/work',
    homeDirectory: '/home/tester',
  });
}

/** Normalises a query, failing the test if it has problems. */
export function makeQuery(input: QueryInput): Query {
  const { query, problems } = normaliseQuery(input, 'GB');
  if (problems.length > 0) {
    throw new Error(`Test query has problems: ${problems.join(' ')}`);
  }
  return query;
}

/** Scores records against a query with the default priorities. */
export function score(input: QueryInput, records: SourceRecord[]): ScoreResult {
  const query = makeQuery(input);
  return scoreLookup(records, query, queryRecord(query), testConfig().priority);
}
