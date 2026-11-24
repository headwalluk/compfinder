import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runLookup } from '../src/lookup/engine.js';
import type { QueryInput } from '../src/lookup/query.js';
import { buildResult, type LookupResult } from '../src/lookup/result.js';
import type { TransportRequest } from '../src/net/transport.js';
import { builtInProviders } from '../src/providers/registry.js';
import { searchUrl } from '../src/providers/brave-search-api/index.js';
import { isDirectoryHost } from '../src/providers/search/common.js';
import { fixtureTransport, type FixtureResponse, type FixtureRoute, type FixtureTransport } from './helpers/fixture-transport.js';
import { makeQuery, testConfig } from './helpers/records.js';
import { quietLogger } from './helpers/stub-providers.js';

const BRAVE_KEY = 'test-brave-key';
const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search?q=Example+Estates+RG1+1AA&country=GB&count=10';
const KEYS = { COMPFINDER_BRAVE_SEARCH_API_KEY: BRAVE_KEY };

const SITE: Record<string, FixtureRoute> = {
  'https://example.com/robots.txt': { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
  'https://example.com/branches/reading/': { file: 'web-fetch/branch-page/reading.html' },
  'https://example.com/': { file: 'web-fetch/branch-page/home.html' },
  'https://example.com/contact/': { file: 'web-fetch/branch-page/contact.html' },
  'https://example.com/branches/': { file: 'web-fetch/chain/branches.html' },
};

/** A JSON fixture from tests/fixtures/search/. */
function json(file: string, status = 200): FixtureResponse {
  return { status, file: `search/${file}`, headers: { 'content-type': 'application/json' } };
}

/** Runs a lookup with the Brave key set, against the given routes. */
async function find(input: QueryInput, routes: Record<string, FixtureRoute>): Promise<{ result: LookupResult; transport: FixtureTransport }> {
  const transport = fixtureTransport(routes);
  const config = testConfig({ variables: KEYS });
  const outcome = await runLookup({ query: makeQuery(input), providers: builtInProviders(config), config, logger: quietLogger, transport, isDownloadSkipped: true });
  return { result: buildResult(outcome, { isExplain: false }), transport };
}

/** A provider's status and reason from a result. */
function statusOf(result: LookupResult, name: string): string {
  const report = result.providers.find((provider) => provider.name === name);
  return `${report?.status ?? 'missing'}${report?.reason === null || report?.reason === undefined ? '' : `: ${report.reason}`}`;
}

describe('brave-search-api', () => {
  test('5. no website: Brave finds the site past the directories, and web-fetch reads it', async () => {
    const seen: TransportRequest[] = [];
    const { result, transport } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, {
      ...SITE,
      [BRAVE_URL]: (request) => {
        seen.push(request);
        return json('brave-reading.json');
      },
    });
    assert.deepEqual(transport.unmatched, []);
    assert.equal(transport.requests[0], `GET ${BRAVE_URL}`);
    assert.equal(seen[0]?.headers['x-subscription-token'], BRAVE_KEY, 'the key goes in a header');
    assert.ok(!seen[0]?.url.href.includes(BRAVE_KEY), 'never in the URL');
    assert.equal(statusOf(result, 'web-fetch'), 'ok');
    assert.equal(result.fields.website.value, 'https://example.com/branches/reading/');
    assert.equal(result.fields.phone.value, '+441184960000');
  });

  test('a search hit on the site doesn\'t confirm the site: they share an origin', async () => {
    const { result } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, { ...SITE, [BRAVE_URL]: json('brave-reading.json') });
    assert.ok(result.fields.website.confidence < 100, 'Brave and web-fetch are both the site: one source');
    assert.ok(!result.fields.website.rules.includes('field.independent-agreement'));
  });

  test('results that are all directories give no website, so web-fetch has nothing to read', async () => {
    const { result } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, { [BRAVE_URL]: json('brave-directories-only.json') });
    assert.equal(statusOf(result, 'brave-search-api'), 'ok');
    assert.equal(result.fields.website.value, null);
    assert.equal(statusOf(result, 'web-fetch'), 'skipped: no website known');
  });

  test('with a website already given, Brave never runs', async () => {
    const { result, transport } = await find({ url: 'https://example.com/branches/reading/' }, SITE);
    assert.equal(statusOf(result, 'brave-search-api'), 'skipped: website already known');
    assert.ok(!transport.requests.some((request) => request.includes('search.brave.com')));
  });

  test('a rejected key is auth_failed, and the lookup carries on', async () => {
    const { result } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, {
      [BRAVE_URL]: { status: 401, body: '{"type":"ErrorResponse","error":{"code":"SUBSCRIPTION_TOKEN_INVALID"}}' },
    });
    assert.equal(statusOf(result, 'brave-search-api'), 'auth_failed');
    assert.equal(statusOf(result, 'web-fetch'), 'skipped: no website known');
  });

  test('a country Brave doesn\'t support is searched as ALL', () => {
    assert.match(searchUrl('Bewley\'s, Dublin', 'IE', 10), /country=ALL/);
    assert.match(searchUrl('Example', 'gb', 10), /country=GB/);
  });

  test('directory hosts match the host and its subdomains only', () => {
    const hosts = ['yell.com', 'google.com'];
    assert.equal(isDirectoryHost('yell.com', hosts), true);
    assert.equal(isDirectoryHost('maps.google.com', hosts), true);
    assert.equal(isDirectoryHost('notyell.com', hosts), false);
    assert.equal(isDirectoryHost('example.com', hosts), false);
  });
});
