import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CallBudget } from '../src/lookup/budget.js';
import { runLookup, type LookupRequest, type ProviderReport } from '../src/lookup/engine.js';
import { ProviderError } from '../src/lookup/errors.js';
import type { Provider } from '../src/providers/contract.js';
import type { ProviderName } from '../src/providers/declarations.js';
import { fact, makeQuery, record, testConfig } from './helpers/records.js';
import { needsWebsite, onlyWithoutWebsite, quietLogger, stubProvider } from './helpers/stub-providers.js';

const ALL_KEYS = {
  COMPFINDER_GOOGLE_PLACES_API_KEY: 'test-key',
  COMPFINDER_SEARCHAPI_IO_API_KEY: 'test-key',
  COMPFINDER_BRAVE_SEARCH_API_KEY: 'test-key',
  COMPFINDER_APOLLO_API_KEY: 'test-key',
};
const PHONE = '0118 496 0000';

/** Runs a lookup with the given providers, all providers' keys set, and any request changes. */
async function lookup(providers: Provider[], changes: Partial<LookupRequest> & { fileText?: string; variables?: Record<string, string> } = {}) {
  const { fileText, variables, ...requestChanges } = changes;
  const config = testConfig({ fileText, variables: variables ?? ALL_KEYS });
  return runLookup({ query: makeQuery({ name: 'Example Estates', url: 'https://example.com/' }), providers, config, logger: quietLogger, ...requestChanges });
}

/** Finds one provider's report. */
function reportFor(reports: readonly ProviderReport[], name: ProviderName): ProviderReport | undefined {
  return reports.find((report) => report.name === name);
}

const siteRecord = record('web-fetch', [fact.name('Example Estates Reading'), fact.phone(PHONE), fact.website('https://example.com/')]);
const googleRecord = record('google-places-api', [fact.name('Example Estates Reading'), fact.phone(PHONE), fact.placeId('ChIJexampleReading001')]);

describe('runLookup', () => {
  test('providers run by stage, free before metered, and each sees what earlier ones found', async () => {
    const order: string[] = [];
    const tracked = (name: ProviderName, records = [] as ReturnType<typeof record>[]) => {
      const provider = stubProvider(name, { records });
      const run = provider.run.bind(provider);
      provider.run = async (knowledge, context) => {
        order.push(name);
        return run(knowledge, context);
      };
      return provider;
    };
    const outcome = await lookup([
      tracked('apollo-io'), tracked('google-places-api', [googleRecord]), tracked('web-fetch', [siteRecord]),
      tracked('brave-search-api'), tracked('searchapi-io'),
    ], { query: makeQuery({ name: 'Example Estates' }) });
    assert.deepEqual(order, ['searchapi-io', 'brave-search-api', 'web-fetch', 'google-places-api', 'apollo-io']);
    assert.equal(outcome.score.fields.phone.confidence, 100);
  });

  test('a provider waiting for a website runs in the late pass once a later stage finds one', async () => {
    const webFetch = stubProvider('web-fetch', { readiness: needsWebsite, records: [siteRecord] });
    const google = stubProvider('google-places-api', {
      records: [record('google-places-api', [fact.name('Example Estates Reading'), fact.phone(PHONE), fact.website('https://example.com/')])],
    });
    const outcome = await lookup([webFetch, google], { query: makeQuery({ name: 'Example Estates', postcode: 'RG1 1AA' }) });
    assert.equal(webFetch.runs.length, 1);
    assert.equal(webFetch.runs[0]?.fields.website?.domain, 'example.com');
    assert.equal(reportFor(outcome.reports, 'web-fetch')?.status, 'ok');
  });

  test('a provider still waiting after the late pass is skipped with its reason', async () => {
    const webFetch = stubProvider('web-fetch', { readiness: needsWebsite });
    const outcome = await lookup([webFetch], { query: makeQuery({ name: 'Example Estates' }) });
    assert.deepEqual(reportFor(outcome.reports, 'web-fetch'), {
      name: 'web-fetch', status: 'skipped', reason: 'no website known', detail: null, calls: 0, metered: false,
    });
  });

  test('a search provider never runs once the website is known', async () => {
    const search = stubProvider('searchapi-io', { readiness: onlyWithoutWebsite });
    const outcome = await lookup([search]);
    assert.equal(search.runs.length, 0);
    assert.equal(reportFor(outcome.reports, 'searchapi-io')?.reason, 'website already known');
  });

  test('providers that can\'t run are reported: excluded, disabled, not configured, not wanted, not available', async () => {
    const outcome = await lookup([stubProvider('web-fetch'), stubProvider('google-places-api'), stubProvider('searchapi-io')], {
      variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: 'test-key', COMPFINDER_SEARCHAPI_IO_API_KEY: 'test-key' },
      fileText: '[providers.searchapi-io]\nenabled = false\n',
      exclude: ['web-fetch'],
      fields: ['place_id', 'name'],
    });
    const reasons = Object.fromEntries(outcome.reports.map((report) => [report.name, `${report.status}: ${report.reason ?? ''}`]));
    assert.deepEqual(reasons, {
      'web-fetch': 'skipped: excluded',
      'google-places-api': 'ok: ',
      'searchapi-io': 'skipped: disabled in config',
      'brave-search-api': 'not_configured: set COMPFINDER_BRAVE_SEARCH_API_KEY',
      'apollo-io': 'not_configured: set COMPFINDER_APOLLO_API_KEY',
    });
    const unwanted = await lookup([stubProvider('google-places-api')], { fields: ['logo'] });
    assert.equal(reportFor(unwanted.reports, 'google-places-api')?.reason, 'fields not requested');
    assert.equal(reportFor(unwanted.reports, 'apollo-io')?.reason, 'fields not requested');
    assert.equal(reportFor(unwanted.reports, 'web-fetch')?.reason, 'not available in this version');
  });

  test('a metered provider is skipped when every field it could supply is already settled', async () => {
    const apollo = stubProvider('apollo-io');
    const outcome = await lookup([stubProvider('web-fetch', { records: [siteRecord] }), stubProvider('google-places-api', { records: [googleRecord] }), apollo], {
      fields: ['phone'],
    });
    assert.equal(apollo.runs.length, 0);
    assert.equal(reportFor(outcome.reports, 'apollo-io')?.reason, 'fields already settled');
  });

  test('a metered provider is skipped when the lookup\'s budget is used up', async () => {
    const outcome = await lookup([stubProvider('google-places-api'), stubProvider('apollo-io')], {
      fileText: '[budgets]\nmetered_calls_per_lookup = 1\n',
    });
    assert.equal(reportFor(outcome.reports, 'google-places-api')?.calls, 1);
    assert.equal(reportFor(outcome.reports, 'apollo-io')?.reason, 'over budget');
  });

  test('a provider that hits the budget mid-run stops there, keeping the calls it made', async () => {
    const outcome = await lookup([stubProvider('google-places-api', { calls: 3 })], { fileText: '[budgets]\nmetered_calls_per_lookup = 2\n' });
    const report = reportFor(outcome.reports, 'google-places-api');
    assert.equal(report?.status, 'ok');
    assert.equal(report?.calls, 2);
    assert.equal(report?.detail, 'stopped at the metered call budget');
  });

  test('a batch budget is shared across lookups', async () => {
    const batchBudget = new CallBudget(1);
    await lookup([stubProvider('google-places-api')], { batchBudget });
    const second = await lookup([stubProvider('google-places-api')], { batchBudget });
    assert.equal(reportFor(second.reports, 'google-places-api')?.reason, 'over budget');
  });

  test('a classified failure and an unexpected error are each recorded, and the lookup carries on', async () => {
    const outcome = await lookup([
      stubProvider('web-fetch', { error: new ProviderError('blocked', 'HTTP 403 from example.com') }),
      stubProvider('google-places-api', { error: new TypeError('Cannot read properties of undefined') }),
      stubProvider('apollo-io', { records: [record('apollo-io', [fact.name('Example Estates')], { scope: 'brand' })] }),
    ]);
    assert.equal(reportFor(outcome.reports, 'web-fetch')?.status, 'blocked');
    assert.equal(reportFor(outcome.reports, 'web-fetch')?.detail, 'HTTP 403 from example.com');
    assert.equal(reportFor(outcome.reports, 'google-places-api')?.status, 'internal_error');
    assert.equal(reportFor(outcome.reports, 'apollo-io')?.status, 'ok');
    assert.equal(outcome.score.fields.name.value, 'Example Estates');
  });
});
