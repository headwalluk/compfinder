import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { runLookup } from '../src/lookup/engine.js';
import type { QueryInput } from '../src/lookup/query.js';
import { buildResult, type LookupResult } from '../src/lookup/result.js';
import type { Provider } from '../src/providers/contract.js';
import { fact, makeQuery, record, testConfig } from './helpers/records.js';
import { needsWebsite, quietLogger, stubProvider } from './helpers/stub-providers.js';

const SCHEMA = JSON.parse(readFileSync(new URL('../schema/result-1.0.json', import.meta.url), 'utf8')) as object;
const validate = new Ajv2020({ allErrors: true }).compile(SCHEMA);
const KEYS = { COMPFINDER_GOOGLE_PLACES_API_KEY: 'test-key', COMPFINDER_APOLLO_API_KEY: 'test-key' };

/** Runs a lookup through the engine and builds its result, checking it against the published schema. */
async function find(input: QueryInput, providers: Provider[], isExplain = false): Promise<LookupResult> {
  const outcome = await runLookup({ query: makeQuery(input), providers, config: testConfig({ variables: KEYS }), logger: quietLogger, isDownloadSkipped: true });
  const result = buildResult(outcome, { isExplain });
  const isValid = validate(result);
  assert.ok(isValid, JSON.stringify(validate.errors, null, 2));
  return result;
}

/** The Reading branch as its own page describes it. */
const readingPage = record('web-fetch', [
  fact.name('Example Estates Reading'),
  fact.phone('0118 496 0000'),
  fact.address({ lines: ['1 Broad Street'], town: 'Reading', county: 'Berkshire', postcode: 'RG1 1AA' }),
  fact.website('https://example.com/branches/reading/'),
  fact.email('reading@example.com'),
], { role: 'branch', subject: 'https://example.com/branches/reading/#0' });
const brandMarkup = record('web-fetch', [
  fact.name('Example Estates'),
  fact.logo('https://example.com/img/logo.svg', 'schema-org'),
  fact.social('facebook', 'https://www.facebook.com/exampleestates'),
], { scope: 'brand', subject: 'https://example.com/branches/reading/#1' });

/** Google's listing for a branch. */
function googlePlace(town: string, postcode: string, phone: string, placeId: string) {
  return record('google-places-api', [
    fact.name(`Example Estates ${town}`),
    fact.phone(phone),
    fact.address({ lines: ['1 Broad St'], town, postcode, formatted: `1 Broad St, ${town} ${postcode}, UK`, lat: 51.456, lon: -0.973 }),
    fact.website('https://example.com/'),
    fact.placeId(placeId),
  ], { subject: placeId });
}
const googleReading = googlePlace('Reading', 'RG1 1AA', '0118 496 0000', 'ChIJexampleReading001');
const googleWokingham = googlePlace('Wokingham', 'RG40 1AA', '0118 496 0123', 'ChIJexampleWokingham01');

describe('use cases, end to end with stub providers', () => {
  test('1. a name and a branch page: the site and Google agree, so the core fields are certain', async () => {
    const result = await find({ name: 'Example Estates', url: 'https://example.com/branches/reading/' }, [
      stubProvider('web-fetch', { readiness: needsWebsite, records: [readingPage, brandMarkup] }),
      stubProvider('google-places-api', { records: [googleReading] }),
    ]);
    assert.equal(result.identity.confidence, 100);
    assert.deepEqual(result.identity.candidates, []);
    const confidences = Object.fromEntries(Object.entries(result.fields).map(([field, value]) => [field, value.confidence]));
    assert.deepEqual(confidences, { name: 100, website: 100, address: 100, phone: 100, email: 60, logo: 100, place_id: 100, socials: 60 });
    assert.equal(result.fields.website.value, 'https://example.com/branches/reading/');
    assert.equal(result.fields.website.domain, 'example.com');
    assert.equal(result.fields.phone.value, '+441184960000');
    assert.equal(result.fields.phone.display, '0118 496 0000');
    assert.equal(result.fields.address.normalised_by, 'google-places-api');
    assert.equal((result.fields.address.value as { postcode: string }).postcode, 'RG1 1AA');
    assert.equal(result.fields.email.kind, 'role');
    assert.equal(result.error, null);
  });

  test('3. a name and a town: the branch in that town wins; with no town, two branches tie and both are listed', async () => {
    const providers = (): Provider[] => [stubProvider('google-places-api', { records: [googleWokingham, googleReading] })];
    const withTown = await find({ name: 'Example Estates', address: 'Reading' }, providers());
    assert.equal(withTown.fields.place_id.value, 'ChIJexampleReading001');
    assert.equal(withTown.identity.confidence, 60, 'Google alone is one source');
    assert.deepEqual(withTown.identity.candidates, []);

    const withoutTown = await find({ name: 'Example Estates' }, providers());
    assert.equal(withoutTown.identity.confidence, 30);
    assert.deepEqual(withoutTown.identity.rules, ['identity.single-structured', 'identity.tie']);
    assert.deepEqual(withoutTown.identity.candidates.map((candidate) => [candidate.place_id, candidate.confidence]), [
      ['ChIJexampleWokingham01', 30],
      ['ChIJexampleReading001', 30],
    ]);
    assert.equal(withoutTown.fields.place_id.confidence, 30, 'a branch value is capped at the identity');
  });

  test('7. checking a stored record: a changed phone number shows as a conflict with the query', async () => {
    const result = await find({ name: 'Example Estates', url: 'https://example.com/branches/reading/', phone: '0118 496 0999' }, [
      stubProvider('web-fetch', { readiness: needsWebsite, records: [readingPage, brandMarkup] }),
      stubProvider('google-places-api', { records: [googleReading] }),
    ], true);
    assert.equal(result.fields.phone.value, '+441184960000');
    assert.equal(result.fields.phone.confidence, 100);
    assert.deepEqual(result.fields.phone.rules, ['field.independent-agreement', 'field.conflict']);
    assert.deepEqual(result.fields.phone.conflicts, [{ value: '+441184960999', sources: ['query'] }]);
    assert.equal(result.fields.phone.evidence?.length, 3);
    assert.equal(result.identity.considered?.[0]?.status, 'leader');
  });

  test('the same provider responses always give byte-identical output', async () => {
    const providers = (): Provider[] => [
      stubProvider('web-fetch', { readiness: needsWebsite, records: [readingPage, brandMarkup] }),
      stubProvider('google-places-api', { records: [googleWokingham, googleReading] }),
    ];
    const input = { name: 'Example Estates', url: 'https://example.com/branches/reading/', phone: '0118 496 0999' };
    const first = JSON.stringify(await find(input, providers(), true));
    const second = JSON.stringify(await find(input, providers(), true));
    assert.equal(first, second);
  });

  test('nothing can run: the result says so with lookup.no_provider', async () => {
    const result = await find({ name: 'Example Estates' }, []);
    assert.equal(result.error?.code, 'lookup.no_provider');
    assert.equal(result.identity.confidence, 0);
    assert.equal(result.fields.name.confidence, 20, 'the query\'s own name, unconfirmed');
  });
});
