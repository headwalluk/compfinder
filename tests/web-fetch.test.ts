import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runLookup } from '../src/lookup/engine.js';
import type { QueryInput } from '../src/lookup/query.js';
import { buildResult, type LookupResult } from '../src/lookup/result.js';
import { builtInProviders } from '../src/providers/registry.js';
import { fixtureTransport, type FixtureResponse, type FixtureTransport } from './helpers/fixture-transport.js';
import { makeQuery, testConfig } from './helpers/records.js';
import { quietLogger } from './helpers/stub-providers.js';

const ROBOTS_ALLOW_ALL = { body: 'User-agent: *\nDisallow: /admin\n', headers: { 'content-type': 'text/plain' } };

const BRANCH_SITE: Record<string, FixtureResponse> = {
  'https://example.com/robots.txt': ROBOTS_ALLOW_ALL,
  'https://example.com/branches/reading/': { file: 'web-fetch/branch-page/reading.html' },
  'https://example.com/': { file: 'web-fetch/branch-page/home.html' },
  'https://example.com/contact/': { file: 'web-fetch/branch-page/contact.html' },
  'https://example.com/branches/': { file: 'web-fetch/chain/branches.html' },
};

/** Runs a lookup with the built-in providers against fixtures, and builds its result. */
async function find(input: QueryInput, routes: Record<string, FixtureResponse>, fileText?: string): Promise<{ result: LookupResult; transport: FixtureTransport }> {
  const transport = fixtureTransport(routes);
  const config = testConfig({ fileText });
  const outcome = await runLookup({ query: makeQuery(input), providers: builtInProviders(config), config, logger: quietLogger, transport });
  return { result: buildResult(outcome, { isExplain: false }), transport };
}

/** The web-fetch entry in a result's providers. */
function webFetchReport(result: LookupResult) {
  return result.providers.find((provider) => provider.name === 'web-fetch');
}

describe('web-fetch', () => {
  test('a branch page: reads the page and a few same-site pages, and finds the branch\'s details', async () => {
    const { result, transport } = await find({ name: 'Example Estates', url: 'https://example.com/branches/reading/' }, BRANCH_SITE);
    assert.deepEqual(transport.unmatched, []);
    assert.deepEqual(transport.requests, [
      'GET https://example.com/robots.txt',
      'GET https://example.com/branches/reading/',
      'GET https://example.com/contact/',
      'GET https://example.com/',
      'GET https://example.com/branches/',
    ], 'robots.txt, the page, then contact (30), home (25), branches (20); never the Wokingham branch page');
    assert.equal(webFetchReport(result)?.status, 'ok');
    assert.equal(webFetchReport(result)?.calls, 5);

    assert.equal(result.identity.confidence, 100);
    assert.deepEqual(result.identity.reasons, ['web-fetch confirms the query\'s page https://example.com/branches/reading/']);
    assert.equal(result.fields.name.value, 'Example Estates Reading');
    assert.equal(result.fields.phone.value, '+441184960000');
    assert.equal((result.fields.address.value as { postcode: string }).postcode, 'RG1 1AA');
    assert.equal((result.fields.address.value as { lat: number }).lat, 51.456);
    assert.equal(result.fields.email.value, 'reading@example.com');
    assert.equal(result.fields.website.value, 'https://example.com/branches/reading/');
    assert.equal((result.fields.logo.value as { source_url: string }).source_url, 'https://example.com/img/logo.svg');
    assert.equal(result.fields.logo.confidence, 100);
    const socials = (result.fields.socials.value as Array<{ url: string }>).map((social) => social.url);
    assert.deepEqual(socials, ['https://facebook.com/exampleestates', 'https://linkedin.com/company/example-estates', 'https://x.com/exampleestates']);
  });

  test('personal email addresses and personal profiles are counted in warnings, never returned', async () => {
    const { result } = await find({ url: 'https://example.com/branches/reading/' }, BRANCH_SITE);
    const output = JSON.stringify(result);
    assert.doesNotMatch(output, /jane/i);
    assert.ok(result.warnings.includes('1 possibly personal email address(es) seen on example.com, not returned.'));
    assert.ok(result.warnings.includes('1 personal social profile(s) seen on example.com, not returned.'));
  });

  test('a chain\'s home page with no location: the identity is the head office, and a warning says so', async () => {
    const { result, transport } = await find({ url: 'https://example.com/' }, {
      'https://example.com/robots.txt': { status: 404 },
      'https://example.com/': { file: 'web-fetch/chain/home.html' },
      'https://example.com/branches/': { file: 'web-fetch/chain/branches.html' },
    });
    assert.deepEqual(transport.unmatched, []);
    assert.deepEqual(result.identity.rules, ['identity.single-structured', 'identity.head-office']);
    assert.equal(result.fields.phone.value, '+441184960999', 'the head office\'s number, not a branch\'s');
    assert.ok(result.warnings.some((warning) => /head office/.test(warning)));
  });

  test('a Cloudflare challenge is reported as blocked, with no retry', async () => {
    const { result, transport } = await find({ url: 'https://example.com/' }, {
      'https://example.com/robots.txt': ROBOTS_ALLOW_ALL,
      'https://example.com/': { status: 403, file: 'web-fetch/edge/cloudflare.html', headers: { server: 'cloudflare' } },
    });
    assert.equal(webFetchReport(result)?.status, 'blocked');
    assert.equal(transport.requests.length, 2);
    assert.equal(result.error?.code, 'lookup.all_failed');
  });

  test('a challenge page served with 200 is still blocked', async () => {
    const { result } = await find({ url: 'https://example.com/' }, {
      'https://example.com/robots.txt': ROBOTS_ALLOW_ALL,
      'https://example.com/': { file: 'web-fetch/edge/cloudflare.html' },
    });
    assert.equal(webFetchReport(result)?.status, 'blocked');
    assert.match(webFetchReport(result)?.detail ?? '', /Cloudflare challenge/);
  });

  test('a page that builds its content with JavaScript is unreadable, not "nothing found"', async () => {
    const { result } = await find({ url: 'https://example.com/' }, {
      'https://example.com/robots.txt': ROBOTS_ALLOW_ALL,
      'https://example.com/': { file: 'web-fetch/edge/spa.html' },
    });
    assert.equal(webFetchReport(result)?.status, 'unreadable');
  });

  test('robots.txt is honoured: a disallowed page is blocked without being fetched', async () => {
    const { result, transport } = await find({ url: 'https://example.com/' }, {
      'https://example.com/robots.txt': { body: 'User-agent: *\nDisallow: /\n', headers: { 'content-type': 'text/plain' } },
    });
    assert.equal(webFetchReport(result)?.status, 'blocked');
    assert.equal(webFetchReport(result)?.detail, 'robots.txt disallows /');
    assert.deepEqual(transport.requests, ['GET https://example.com/robots.txt']);
  });

  test('a robots.txt that answers 5xx means the site is treated as disallowed', async () => {
    const { result } = await find({ url: 'https://example.com/' }, { 'https://example.com/robots.txt': { status: 503 } });
    assert.equal(webFetchReport(result)?.status, 'blocked');
  });

  test('robots.txt can be turned off in config', async () => {
    const { result, transport } = await find({ url: 'https://example.com/' }, {
      'https://example.com/': { file: 'web-fetch/chain/home.html' },
      'https://example.com/branches/': { file: 'web-fetch/chain/branches.html' },
    }, '[web_fetch]\nhonour_robots = false\n');
    assert.equal(webFetchReport(result)?.status, 'ok');
    assert.ok(!transport.requests.some((request) => request.endsWith('/robots.txt')));
  });

  test('a start page that moved to another domain is followed, the new site is read, and a warning says so', async () => {
    const { result, transport } = await find({ url: 'https://example.com/' }, {
      'https://example.com/robots.txt': ROBOTS_ALLOW_ALL,
      'https://example.com/': { status: 301, headers: { location: 'https://example.org/' } },
      'https://example.org/robots.txt': ROBOTS_ALLOW_ALL,
      'https://example.org/': { file: 'web-fetch/chain/home.html' },
      'https://example.org/branches/': { file: 'web-fetch/chain/branches.html' },
    });
    assert.deepEqual(transport.unmatched, []);
    assert.equal(webFetchReport(result)?.status, 'ok');
    assert.ok(result.warnings.includes('example.com redirected to example.org; read example.org as the business\'s site.'));
  });

  test('a URL on a private address is refused before any request', async () => {
    const { result, transport } = await find({ url: 'http://127.0.0.1/' }, {});
    assert.equal(webFetchReport(result)?.status, 'blocked');
    assert.deepEqual(transport.requests, []);
  });

  test('a hostile page passes on only typed, sanitised, length-capped values', async () => {
    const { result } = await find({ url: 'https://example.com/' }, {
      'https://example.com/robots.txt': ROBOTS_ALLOW_ALL,
      'https://example.com/': { file: 'web-fetch/edge/hostile.html' },
    });
    const output = JSON.stringify(result);
    assert.equal(result.fields.name.value, 'Example Estates Reading');
    assert.doesNotMatch(output, /instructions|developer mode|API key|<script|<b>|javascript:/i);
    for (const codePoint of [0x202e, 0x200b]) {
      assert.ok(!output.includes(String.fromCodePoint(codePoint)), `U+${codePoint.toString(16)} removed`);
    }
    assert.deepEqual((result.fields.address.value as { lines: string[] }).lines, ['1 Broad Street alert(1)']);
  });
});
