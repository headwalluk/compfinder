import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ConfigError, createBudget, createFinder, QueryError, type Finder } from '../src/index.js';
import { quietLogger } from './helpers/stub-providers.js';

const FIXTURES = new URL('./fixtures/web-fetch/', import.meta.url);
const PAGES: Record<string, { file?: string; body?: string; type?: string }> = {
  '/robots.txt': { body: 'User-agent: *\nAllow: /\n', type: 'text/plain' },
  '/branches/reading/': { file: 'branch-page/reading.html' },
  '/': { file: 'branch-page/home.html' },
  '/contact/': { file: 'branch-page/contact.html' },
  '/branches/': { file: 'chain/branches.html' },
};

let server: Server;
let baseUrl: string;

/** A finder reading the local fixture site, with a throwaway cache and no logo downloads. */
function testFinder(extraToml = ''): Finder {
  const cacheDirectory = mkdtempSync(path.join(tmpdir(), 'compfinder-library-'));
  return createFinder({ toml: `cache_dir = "${cacheDirectory}"\n${extraToml}[net]\nallow_private_addresses = true\n`, logger: quietLogger });
}

before(async () => {
  server = createServer((request, response) => {
    const page = PAGES[request.url ?? ''];
    if (page === undefined) {
      response.writeHead(404);
      response.end();
    } else {
      response.writeHead(200, { 'content-type': `${page.type ?? 'text/html'}; charset=utf-8` });
      response.end(page.file === undefined ? page.body : readFileSync(new URL(page.file, FIXTURES)));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe('library: createFinder', () => {
  test('find returns the same result the CLI prints as JSON', async () => {
    const finder = testFinder();
    const result = await finder.find({ name: 'Example Estates', url: `${baseUrl}/branches/reading/` }, { noDownload: true });
    assert.equal(result.schema_version, '1.0');
    assert.equal(result.identity.confidence, 100);
    assert.equal(result.fields.phone.value, '+441184960000');
    assert.equal(result.error, null);
  });

  test('an unusable query throws QueryError with every problem and the error code', () => {
    const finder = testFinder();
    assert.throws(() => finder.plan({}), (error: unknown) => error instanceof QueryError && error.code === 'input.no_query');
    assert.throws(() => finder.plan({ url: 'not a url at all', phone: 'abc' }), (error: unknown) => (
      error instanceof QueryError && error.code === 'input.bad_value' && error.problems.length === 2
    ));
  });

  test('untyped input, such as a JSON request body, is checked: unknown keys and non-strings are QueryErrors', () => {
    const finder = testFinder();
    const body: unknown = JSON.parse('{"name": 42, "colour": "red"}');
    assert.throws(() => finder.plan(body as never), (error: unknown) => (
      error instanceof QueryError && error.code === 'input.bad_value' && error.problems.length === 2
    ));
    assert.throws(() => finder.plan(null as never), QueryError);
  });

  test('find rejects with QueryError too, rather than returning a result', async () => {
    await assert.rejects(testFinder().find({}), QueryError);
  });

  test('invalid settings throw ConfigError listing every problem', () => {
    assert.throws(() => createFinder({ toml: 'country = "Britain"\n[budgets]\nmetered_calls_per_lookup = -1\n', variables: { COMPFINDER_NOT_A_SETTING: 'x' } }),
      (error: unknown) => error instanceof ConfigError && error.problems.length === 3);
  });

  test('settings passed in code never read the environment', () => {
    const finder = createFinder({ variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: 'from-code' }, logger: quietLogger });
    assert.equal(finder.config.providers['google-places-api'].apiKey, 'from-code');
    assert.equal(createFinder({ logger: quietLogger }).config.providers['google-places-api'].apiKey, null);
  });

  test('plan costs a lookup without calling anything; a shared budget caps lookups together', async () => {
    const finder = createFinder({ variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: 'test-key' }, logger: quietLogger });
    assert.equal(finder.plan({ name: 'Example Estates', postcode: 'RG1 1AA' }).maxMeteredCalls, 1);
    const budget = createBudget(0);
    const result = await finder.find({ name: 'Example Estates', postcode: 'RG1 1AA' }, { budget, providers: ['google-places-api'] });
    assert.equal(result.providers.find((provider) => provider.name === 'google-places-api')?.reason, 'over budget');
    assert.equal(budget.spent(), 0);
  });
});
