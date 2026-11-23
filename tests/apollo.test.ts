import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { runLookup } from '../src/lookup/engine.js';
import type { QueryInput } from '../src/lookup/query.js';
import { buildResult, type LookupResult } from '../src/lookup/result.js';
import type { TransportRequest } from '../src/net/transport.js';
import { APOLLO_ENRICH_URL } from '../src/providers/apollo-io/index.js';
import { builtInProviders } from '../src/providers/registry.js';
import { fixtureTransport, type FixtureResponse, type FixtureRoute, type FixtureTransport } from './helpers/fixture-transport.js';
import { makeQuery, testConfig } from './helpers/records.js';
import { quietLogger } from './helpers/stub-providers.js';

const APOLLO_KEY = 'test-apollo-key';
const GOOGLE_KEY = 'test-google-key';
const ENRICH_URL = `${APOLLO_ENRICH_URL}?domain=example.com`;
const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

const SITE: Record<string, FixtureRoute> = {
  'https://example.com/robots.txt': { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
  'https://example.com/branches/reading/': { file: 'web-fetch/branch-page/reading.html' },
  'https://example.com/': { file: 'web-fetch/branch-page/home.html' },
  'https://example.com/contact/': { file: 'web-fetch/branch-page/contact.html' },
  'https://example.com/branches/': { file: 'web-fetch/chain/branches.html' },
};

/** A JSON fixture response. */
function json(file: string, status = 200): FixtureResponse {
  return { status, file, headers: { 'content-type': 'application/json' } };
}

/** Runs a lookup with Apollo (and optionally Google) configured, against fixtures. */
async function find(input: QueryInput, routes: Record<string, FixtureRoute>, variables: Record<string, string>): Promise<{ result: LookupResult; transport: FixtureTransport }> {
  const transport = fixtureTransport(routes);
  const config = testConfig({ variables });
  const outcome = await runLookup({ query: makeQuery(input), providers: builtInProviders(config), config, logger: quietLogger, transport, isDownloadSkipped: true });
  return { result: buildResult(outcome, { isExplain: true }), transport };
}

describe('apollo-io', () => {
  test('enriches by domain through the organisation endpoint only, with the key in a header', async () => {
    const seen: TransportRequest[] = [];
    const { result, transport } = await find({ url: 'https://example.com/' }, {
      ...SITE,
      [ENRICH_URL]: (request) => {
        seen.push(request);
        return json('apollo/organisation.json');
      },
    }, { COMPFINDER_APOLLO_API_KEY: APOLLO_KEY });
    assert.deepEqual(transport.unmatched, []);
    const apolloRequests = transport.requests.filter((request) => request.includes('apollo.io'));
    assert.deepEqual(apolloRequests, [`GET ${ENRICH_URL}`]);
    assert.ok(apolloRequests.every((request) => request.includes('/organizations/')), 'never a people endpoint');
    assert.equal(seen[0]?.headers['x-api-key'], APOLLO_KEY);
    assert.ok(!seen[0]?.url.href.includes(APOLLO_KEY));
    assert.equal(result.providers.find((provider) => provider.name === 'apollo-io')?.status, 'ok');
  });

  test('people in an Apollo response are never read: no names, emails or personal profiles reach the output', async () => {
    const { result } = await find({ url: 'https://example.com/' }, { ...SITE, [ENRICH_URL]: json('apollo/organisation.json') }, { COMPFINDER_APOLLO_API_KEY: APOLLO_KEY });
    const output = JSON.stringify(result);
    for (const personal of ['Jane Smith', 'jane.smith', 'John', 'john.doe', '7700900123', 'linkedin.com/in/', 'Branch Manager']) {
      assert.ok(!output.includes(personal), `${personal} must not appear`);
    }
  });

  test('stale-record check: the site and Google agree on the phone, Apollo differs, so it\'s 2 of 3 sources: 66', async () => {
    const { result } = await find({ name: 'Example Estates', url: 'https://example.com/branches/reading/' }, {
      ...SITE,
      [SEARCH_URL]: json('google-places/search-reading.json'),
      [ENRICH_URL]: json('apollo/organisation.json'),
    }, { COMPFINDER_APOLLO_API_KEY: APOLLO_KEY, COMPFINDER_GOOGLE_PLACES_API_KEY: GOOGLE_KEY });
    assert.equal(result.fields.phone.value, '+441184960000');
    assert.equal(result.fields.phone.confidence, 66);
    assert.deepEqual(result.fields.phone.rules, ['field.independent-agreement', 'field.conflict']);
    assert.deepEqual(result.fields.phone.conflicts, [{ value: '+441184960999', sources: ['apollo-io'] }]);
  });

  test('Apollo\'s address is the head office: for a branch query it doesn\'t displace the branch\'s', async () => {
    const { result } = await find({ name: 'Example Estates', url: 'https://example.com/branches/reading/' }, {
      ...SITE, [ENRICH_URL]: json('apollo/organisation.json'),
    }, { COMPFINDER_APOLLO_API_KEY: APOLLO_KEY });
    assert.equal((result.fields.address.value as { postcode: string }).postcode, 'RG1 1AA');
    assert.deepEqual(result.fields.address.conflicts.map((conflict) => conflict.sources), [['apollo-io']]);
  });

  test('a domain Apollo doesn\'t know is a successful call that adds nothing', async () => {
    const { result } = await find({ url: 'https://example.com/' }, { ...SITE, [ENRICH_URL]: json('apollo/not-found.json') }, { COMPFINDER_APOLLO_API_KEY: APOLLO_KEY });
    assert.equal(result.providers.find((provider) => provider.name === 'apollo-io')?.status, 'ok');
    assert.ok(!result.fields.name.sources.includes('apollo-io'));
  });

  test('a rejected key is auth_failed; a quota error is quota_exceeded', async () => {
    const rejected = await find({ url: 'https://example.com/' }, { ...SITE, [ENRICH_URL]: { status: 401, body: '{"error":"Invalid access credentials."}' } }, { COMPFINDER_APOLLO_API_KEY: APOLLO_KEY });
    assert.equal(rejected.result.providers.find((provider) => provider.name === 'apollo-io')?.status, 'auth_failed');
    const limited = await find({ url: 'https://example.com/' }, { ...SITE, [ENRICH_URL]: { status: 429, body: '{"message":"rate limit exceeded"}' } }, { COMPFINDER_APOLLO_API_KEY: APOLLO_KEY });
    assert.equal(limited.result.providers.find((provider) => provider.name === 'apollo-io')?.status, 'quota_exceeded');
  });

  test('the fixture really does hold people data, so the test above means something', () => {
    const fixture = readFileSync(new URL('./fixtures/apollo/organisation.json', import.meta.url), 'utf8');
    assert.match(fixture, /jane\.smith@example\.com/);
  });
});
