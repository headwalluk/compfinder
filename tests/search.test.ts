import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runLookup } from '../src/lookup/engine.js';
import type { QueryInput } from '../src/lookup/query.js';
import { buildResult, type LookupResult } from '../src/lookup/result.js';
import type { TransportRequest } from '../src/net/transport.js';
import { builtInProviders } from '../src/providers/registry.js';
import { isDirectoryHost } from '../src/providers/search/common.js';
import { fixtureTransport, type FixtureResponse, type FixtureRoute, type FixtureTransport } from './helpers/fixture-transport.js';
import { makeQuery, testConfig } from './helpers/records.js';
import { quietLogger } from './helpers/stub-providers.js';

const SEARCHAPI_KEY = 'test-searchapi-key';
const BRAVE_KEY = 'test-brave-key';
const SEARCHAPI_URL = 'https://www.searchapi.io/api/v1/search?engine=google&q=Example+Estates+RG1+1AA&gl=uk&hl=en&num=10';
const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search?q=Example+Estates+RG1+1AA&country=GB&count=10';

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

/** Runs a lookup with the given search keys set and routes. */
async function find(input: QueryInput, routes: Record<string, FixtureRoute>, variables: Record<string, string>, fileText?: string): Promise<{ result: LookupResult; transport: FixtureTransport }> {
  const transport = fixtureTransport(routes);
  const config = testConfig({ variables, ...(fileText === undefined ? {} : { fileText }) });
  const outcome = await runLookup({ query: makeQuery(input), providers: builtInProviders(config), config, logger: quietLogger, transport, isDownloadSkipped: true });
  return { result: buildResult(outcome, { isExplain: false }), transport };
}

/** A provider's status and reason from a result. */
function statusOf(result: LookupResult, name: string): string {
  const report = result.providers.find((provider) => provider.name === name);
  return `${report?.status ?? 'missing'}${report?.reason === null || report?.reason === undefined ? '' : `: ${report.reason}`}`;
}

describe('search providers', () => {
  test('5. no website: SearchAPI.io finds the site past the directories, and web-fetch reads it', async () => {
    const seen: TransportRequest[] = [];
    const { result, transport } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, {
      ...SITE,
      [SEARCHAPI_URL]: (request) => {
        seen.push(request);
        return json('searchapi-reading.json');
      },
    }, { COMPFINDER_SEARCHAPI_IO_API_KEY: SEARCHAPI_KEY });
    assert.deepEqual(transport.unmatched, []);
    assert.equal(transport.requests[0], `GET ${SEARCHAPI_URL}`);
    assert.equal(seen[0]?.headers.authorization, `Bearer ${SEARCHAPI_KEY}`);
    assert.ok(!seen[0]?.url.href.includes(SEARCHAPI_KEY));
    assert.equal(statusOf(result, 'web-fetch'), 'ok');
    assert.equal(result.fields.website.value, 'https://example.com/branches/reading/');
    assert.equal(result.fields.phone.confidence, 100, 'the site and Google\'s business panel agree');
    assert.deepEqual(result.fields.phone.sources, ['web-fetch', 'searchapi-io']);
  });

  test('once one search provider finds the site, the other doesn\'t run, unless discover.run_all is on', async () => {
    const routes = { ...SITE, [SEARCHAPI_URL]: json('searchapi-reading.json'), [BRAVE_URL]: json('brave-reading.json') };
    const keys = { COMPFINDER_SEARCHAPI_IO_API_KEY: SEARCHAPI_KEY, COMPFINDER_BRAVE_SEARCH_API_KEY: BRAVE_KEY };
    const { result, transport } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, routes, keys);
    assert.equal(statusOf(result, 'brave-search-api'), 'skipped: website already known');
    assert.ok(!transport.requests.includes(`GET ${BRAVE_URL}`));
    const runAll = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, routes, keys, '[discover]\nrun_all = true\n');
    assert.equal(statusOf(runAll.result, 'brave-search-api'), 'skipped: fields already settled', 'run_all, but the website is already at 100');
    const runAllUnsettled = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, routes, keys, 'skip_settled = false\n[discover]\nrun_all = true\n');
    assert.equal(statusOf(runAllUnsettled.result, 'brave-search-api'), 'ok');
  });

  test('when the first finds only directories, the second gets its turn', async () => {
    const seen: TransportRequest[] = [];
    const { result } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, {
      ...SITE,
      [SEARCHAPI_URL]: json('searchapi-directories-only.json'),
      [BRAVE_URL]: (request) => {
        seen.push(request);
        return json('brave-reading.json');
      },
    }, { COMPFINDER_SEARCHAPI_IO_API_KEY: SEARCHAPI_KEY, COMPFINDER_BRAVE_SEARCH_API_KEY: BRAVE_KEY });
    assert.equal(seen[0]?.headers['x-subscription-token'], BRAVE_KEY);
    assert.equal(statusOf(result, 'searchapi-io'), 'ok');
    assert.equal(statusOf(result, 'brave-search-api'), 'ok');
    assert.equal(result.fields.website.value, 'https://example.com/branches/reading/');
  });

  test('a search hit on the site doesn\'t confirm the site: they share an origin', async () => {
    const { result } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, {
      ...SITE, [BRAVE_URL]: json('brave-reading.json'),
    }, { COMPFINDER_BRAVE_SEARCH_API_KEY: BRAVE_KEY });
    assert.equal(result.fields.website.value, 'https://example.com/branches/reading/');
    assert.ok(result.fields.website.confidence < 100, 'Brave and web-fetch are both the site: one source');
    assert.ok(!result.fields.website.rules.includes('field.independent-agreement'));
  });

  test('with a website already given, search providers never run', async () => {
    const { result, transport } = await find({ url: 'https://example.com/branches/reading/' }, SITE, { COMPFINDER_SEARCHAPI_IO_API_KEY: SEARCHAPI_KEY });
    assert.equal(statusOf(result, 'searchapi-io'), 'skipped: website already known');
    assert.ok(!transport.requests.some((request) => request.includes('searchapi.io')));
  });

  test('a rejected key is auth_failed, and the lookup carries on', async () => {
    const { result } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, {
      [SEARCHAPI_URL]: { status: 401, body: '{"error":"Invalid API key"}' },
    }, { COMPFINDER_SEARCHAPI_IO_API_KEY: SEARCHAPI_KEY });
    assert.equal(statusOf(result, 'searchapi-io'), 'auth_failed');
    assert.equal(statusOf(result, 'web-fetch'), 'skipped: no website known');
  });

  test('directory hosts match the host and its subdomains only', () => {
    const hosts = ['yell.com', 'google.com'];
    assert.equal(isDirectoryHost('yell.com', hosts), true);
    assert.equal(isDirectoryHost('maps.google.com', hosts), true);
    assert.equal(isDirectoryHost('notyell.com', hosts), false);
    assert.equal(isDirectoryHost('example.com', hosts), false);
  });
});
