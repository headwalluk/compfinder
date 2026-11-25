import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { checkProviders, runLookup } from '../src/lookup/engine.js';
import type { QueryInput } from '../src/lookup/query.js';
import { buildResult, type LookupResult } from '../src/lookup/result.js';
import type { Transport, TransportRequest } from '../src/net/transport.js';
import { pathHint, searchPlan, searchText } from '../src/providers/google-places-api/index.js';
import { nameFromDomain } from '../src/normalise/url.js';
import { builtInProviders } from '../src/providers/registry.js';
import { fixtureTransport, type FixtureResponse, type FixtureRoute, type FixtureTransport } from './helpers/fixture-transport.js';
import { makeQuery, testConfig } from './helpers/records.js';
import { quietLogger } from './helpers/stub-providers.js';

/** How long the never-answering fixture holds the event loop open; far beyond the request timeout under test. */
const FIXTURE_HOLD_MS = 30_000;
const API_KEY = 'test-google-key-not-real';
const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const DETAILS_URL = 'https://places.googleapis.com/v1/places/ChIJexampleReading001';
const SCHEMA = JSON.parse(readFileSync(new URL('../schema/result-1.0.json', import.meta.url), 'utf8')) as object;
const validate = new Ajv2020({ allErrors: true }).compile(SCHEMA);

/** A JSON fixture response from tests/fixtures/google-places/. */
function google(file: string, status = 200): FixtureResponse {
  return { status, file: `google-places/${file}`, headers: { 'content-type': 'application/json' } };
}

/** Records each Google request's headers and body, then answers with a fixture. */
function recordingRoute(file: string, seen: TransportRequest[], status = 200): FixtureRoute {
  return (request) => {
    seen.push(request);
    return google(file, status);
  };
}

const SITE: Record<string, FixtureRoute> = {
  'https://example.com/robots.txt': { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
  'https://example.com/branches/reading/': { file: 'web-fetch/branch-page/reading.html' },
  'https://example.com/': { file: 'web-fetch/branch-page/home.html' },
  'https://example.com/contact/': { file: 'web-fetch/branch-page/contact.html' },
  'https://example.com/branches/': { file: 'web-fetch/chain/branches.html' },
};

/** Runs a lookup with every built-in provider, Google's key set, against fixtures. */
async function find(input: QueryInput, routes: Record<string, FixtureRoute>): Promise<{ result: LookupResult; transport: FixtureTransport }> {
  const transport = fixtureTransport(routes);
  const config = testConfig({ variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: API_KEY } });
  const outcome = await runLookup({ query: makeQuery(input), providers: builtInProviders(config), config, logger: quietLogger, transport, isDownloadSkipped: true });
  const result = buildResult(outcome, { isExplain: false });
  assert.ok(validate(result), JSON.stringify(validate.errors));
  return { result, transport };
}

/** Google's entry in a result's providers. */
function googleReport(result: LookupResult) {
  return result.providers.find((provider) => provider.name === 'google-places-api');
}

describe('google-places-api', () => {
  test('1. the site and Google agree: name, phone, address and place ID all reach 100', async () => {
    const seen: TransportRequest[] = [];
    const { result, transport } = await find({ name: 'Example Estates', url: 'https://example.com/branches/reading/' }, {
      ...SITE, [SEARCH_URL]: recordingRoute('search-reading.json', seen),
    });
    assert.deepEqual(transport.unmatched, []);
    const confidences = Object.fromEntries(Object.entries(result.fields).map(([field, value]) => [field, value.confidence]));
    assert.deepEqual(confidences, { name: 100, website: 100, address: 100, phone: 100, email: 60, logo: 100, place_id: 100, socials: 60 });
    assert.equal(result.fields.address.normalised_by, 'google-places-api');
    assert.equal(googleReport(result)?.calls, 1);
    assert.equal(googleReport(result)?.metered, true);

    const request = seen[0];
    assert.equal(request?.method, 'POST');
    assert.equal(request?.headers['x-goog-api-key'], API_KEY, 'the key goes in a header');
    assert.ok(!request?.url.href.includes(API_KEY), 'never in the URL');
    assert.match(request?.headers['x-goog-fieldmask'] ?? '', /^places\.id,places\.displayName,.*places\.businessStatus$/);
    assert.deepEqual(JSON.parse(request?.body ?? '{}'), { textQuery: 'Example Estates, RG1 1AA', regionCode: 'gb', pageSize: 5 },
      'the query\'s name with the postcode web-fetch read');
  });

  test('a Google Maps cid in the site\'s schema links it to Google\'s listing, even when phone and address differ', async () => {
    const CID = '16220045999431265364';
    /** A branch page that has moved: new phone and address, and optionally its Maps link. */
    const movedPage = (hasMap: boolean): FixtureResponse => ({
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: `<html><head><title>Example Estates</title><script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@type': 'RealEstateAgent', name: 'Example Estates Reading', url: 'https://example.com/',
        telephone: '0118 496 0111', address: { '@type': 'PostalAddress', streetAddress: '5 King Street', addressLocality: 'Reading', postalCode: 'RG1 2AB' },
        ...(hasMap ? { hasMap: `https://maps.google.com/?cid=${CID}`, sameAs: [`https://www.google.co.uk/maps?cid=${CID}`] } : {}),
      })}</script></head><body></body></html>`,
    });
    const listing = JSON.parse(readFileSync(new URL('./fixtures/google-places/search-reading.json', import.meta.url), 'utf8')) as { places: Array<Record<string, unknown>> };
    const withUri = { places: listing.places.map((place) => ({ ...place, websiteUri: 'https://example.com/', googleMapsUri: `https://maps.google.com/?cid=${CID}` })) };
    const routes = (hasMap: boolean): Record<string, FixtureRoute> => ({
      'https://example.com/robots.txt': SITE['https://example.com/robots.txt'] as FixtureRoute,
      'https://example.com/': movedPage(hasMap),
      [SEARCH_URL]: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(withUri) },
    });

    const linked = await find({ name: 'Example Estates' , url: 'https://example.com/' }, routes(true));
    assert.equal(linked.result.identity.confidence, 100);
    assert.match(linked.result.identity.reasons[0] ?? '', /agree on Google Maps listing cid 16220045999431265364/);
    assert.equal(linked.result.fields.place_id.value, 'ChIJexampleReading001');
    assert.equal(linked.result.fields.place_id.confidence, 100);
    assert.equal(linked.result.fields.phone.conflicts.length, 1, 'the two phones are shown, not hidden');
    assert.ok(!JSON.stringify(linked.result.fields).includes(CID), 'the cid links records but is never a field value');

    const unlinked = await find({ name: 'Example Estates', url: 'https://example.com/' }, routes(false));
    assert.ok(unlinked.result.identity.confidence < 100, 'without the cid, nothing links the moved branch to the old listing');
  });

  test('a known place ID uses Place Details, and confirms the identity', async () => {
    const seen: TransportRequest[] = [];
    const { result } = await find({ place_id: 'ChIJexampleReading001' }, { [DETAILS_URL]: recordingRoute('details-reading.json', seen) });
    assert.equal(seen[0]?.method, 'GET');
    assert.match(seen[0]?.headers['x-goog-fieldmask'] ?? '', /^id,displayName,/);
    assert.equal(result.identity.confidence, 100);
    assert.deepEqual(result.identity.rules, ['identity.input-confirmed']);
  });

  test('5. no website given: Google supplies one, and web-fetch reads it in the late pass', async () => {
    const { result, transport } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, {
      ...SITE, [SEARCH_URL]: google('search-reading.json'),
    });
    assert.deepEqual(transport.unmatched, []);
    assert.equal(transport.requests[0], `POST ${SEARCH_URL}`, 'Google first: nothing for web-fetch to read yet');
    assert.ok(transport.requests.includes('GET https://example.com/branches/reading/'));
    assert.equal(result.providers.find((provider) => provider.name === 'web-fetch')?.status, 'ok');
    assert.equal(result.fields.phone.confidence, 100);
  });

  test('3. two branches match a name with no location: both are listed, and the identity is shared', async () => {
    const { result } = await find({ name: 'Example Estates', phone: '0118 496 0999' }, { [SEARCH_URL]: google('search-two-branches.json') });
    assert.equal(result.identity.candidates.length, 0, 'the query phone matches neither, so neither is pinned; both are contradicted and dropped');
    const tied = await find({ name: 'Example Estates', address: 'Berkshire' }, { [SEARCH_URL]: google('search-two-branches.json') });
    assert.equal(tied.result.identity.candidates.length, 2);
    assert.equal(tied.result.identity.confidence, 30);
  });

  test('2. a site read after Google\'s lead doesn\'t break a tie: both branches match the query equally', async () => {
    const seen: TransportRequest[] = [];
    const { result } = await find({ name: 'Example Estates', address: 'Berkshire' }, { ...SITE, [SEARCH_URL]: recordingRoute('search-two-branches.json', seen) });
    assert.equal(JSON.parse(seen[0]?.body ?? '{}').textQuery, 'Example Estates, Berkshire', 'the query\'s own location is searched');
    assert.ok(result.identity.rules.includes('identity.tie'), JSON.stringify(result.identity));
    assert.deepEqual(result.identity.candidates.map((candidate) => candidate.name), ['Example Estates Wokingham', 'Example Estates Reading', 'Example Estates'],
      'both branches, and the head office the site describes: "Berkshire" tells none of them apart');
  });

  test('the query\'s own address is searched before a postcode another provider found', () => {
    const knowledge = {
      query: makeQuery({ name: 'Kwik Fit', address: 'Bracknell' }),
      fields: { address: { lines: [], town: 'Bracknell', county: null, postcode: 'RG12 9SE', country_code: 'GB', formatted: null, lat: null, lon: null } },
    } as unknown as Parameters<typeof searchText>[0];
    assert.equal(searchText(knowledge), 'Kwik Fit, Bracknell');
  });

  test('search plans: the query\'s phone before a found location; a branch path before a page\'s phone, which comes before a page-kind path', () => {
    const knowledge = (input: QueryInput, fields: Record<string, unknown> = {}) => ({ query: makeQuery(input), fields } as unknown as Parameters<typeof searchText>[0]);
    const foundAddress = { lines: [], town: 'Accrington', county: null, postcode: 'BB5 1HF', country_code: 'GB', formatted: null, lat: null, lon: null };
    const foundPhone = { e164: '+441182172098', display: '0118 217 2098' };
    assert.equal(searchText(knowledge({ name: 'Keenans', phone: '0161 793 9622' }, { address: foundAddress })), '0161 793 9622');
    assert.equal(searchText(knowledge({ url: 'https://example.com/branches/burnley/' }, { name: 'Keenans', phone: foundPhone })), 'Keenans, burnley');
    assert.equal(searchText(knowledge({ name: 'Example Caversham', url: 'https://example.com/our-offices/estate-agents-in-caversham/' }, { phone: foundPhone })),
      'Example Caversham, estate agents in caversham', 'a call-tracking number on the page isn\'t searched before the branch\'s path');
    assert.equal(searchText(knowledge({ name: 'Example Plumbing', url: 'https://example.com/contact-us/' }, { phone: foundPhone })), '0118 217 2098',
      'a path naming only a kind of page says nothing about the place');
  });

  test('a home page with a name but no location searches the name alone, kept to the site; no name puts the path before a page\'s phone', () => {
    const plan = (input: QueryInput, fields: Record<string, unknown>) => searchPlan({ query: makeQuery(input), fields } as unknown as Parameters<typeof searchText>[0]);
    assert.deepEqual(plan({ url: 'https://example.com/' }, { name: 'Example Estates' }), { text: 'Example Estates', siteDomain: 'example.com' });
    assert.deepEqual(plan({ url: 'https://www.example.co.uk/offices/estate-agents-in-wokingham/' }, { phone: { e164: '+441182178418', display: '0118 217 8418' } }),
      { text: 'example, estate agents in wokingham', siteDomain: 'example.co.uk' });
    assert.deepEqual(plan({ url: 'https://www.example-gym.com/' }, { name: 'ExampleGym', address: { lines: [], town: null, county: null, postcode: 'LS2 8LY', country_code: 'GB', formatted: null, lat: null, lon: null } }),
      { text: 'ExampleGym, LS2 8LY', siteDomain: 'example-gym.com' }, 'a found name that only spells the domain is kept to the site, as the domain would be');
    assert.equal(plan({ url: 'https://www.example-gym.com/gyms/leeds/' }, { name: 'ExampleGym' })?.siteDomain, null, 'but not for an inner page');
  });

  test('with no name known, the domain stands in for it, and only places on that site are kept', async () => {
    assert.deepEqual(searchPlan({ query: makeQuery({ url: 'https://www.example-books.co.uk/shops/reading' }), fields: {} } as unknown as Parameters<typeof searchText>[0]),
      { text: 'example books, reading', siteDomain: 'example-books.co.uk' });
    assert.equal(nameFromDomain('keenans-estateagents.co.uk'), 'keenans estateagents');
    assert.equal(pathHint('https://example.com/'), null);
    const routes: Record<string, FixtureRoute> = {
      'https://example.com/robots.txt': { status: 403, body: '' },
      [SEARCH_URL]: { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ places: [
        { id: 'ChIJnamesakeElsewhere01', displayName: { text: 'Example Estates' }, websiteUri: 'https://not-example.org/' },
        { id: 'ChIJexampleReading001', displayName: { text: 'Example Estates Reading' }, websiteUri: 'https://example.com/' },
      ] }) },
    };
    const { result } = await find({ url: 'https://example.com/' }, routes);
    assert.equal(result.providers.find((provider) => provider.name === 'web-fetch')?.status, 'blocked');
    assert.equal(result.fields.place_id.value, 'ChIJexampleReading001', 'the namesake on another site is dropped');
  });

  test('a branch page renamed by a redirect is confirmed by Google\'s place on the new page, which is the website shown', async () => {
    const { result } = await find({ name: 'Example Estates Putney', url: 'https://example.com/branches/putney-roehampton-and-putney-vale' }, {
      'https://example.com/robots.txt': { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
      'https://example.com/branches/putney-roehampton-and-putney-vale': { status: 301, headers: { location: 'https://example.com/putney-branch/' } },
      'https://example.com/putney-branch/': { body: '<html><head><title>Putney</title></head><body><a href="tel:020 8944 2918">Call</a> SW15 6TD</body></html>' },
      [SEARCH_URL]: { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ places: [
        { id: 'ChIJexamplePutney0001', displayName: { text: 'Example Estates | Putney' }, websiteUri: 'https://example.com/putney-branch/',
          nationalPhoneNumber: '020 8944 2918', formattedAddress: '212 Upper Richmond Rd, London SW15 6TD',
          addressComponents: [{ longText: 'SW15 6TD', types: ['postal_code'] }, { longText: 'London', types: ['postal_town'] }] },
      ] }) },
    });
    assert.equal(result.identity.confidence, 100);
    assert.equal(result.fields.place_id.value, 'ChIJexamplePutney0001');
    assert.equal(result.fields.website.value, 'https://example.com/putney-branch/');
  });

  test('a branch page that times out is unread: Google\'s place under an alias URL isn\'t contradicted', async () => {
    const PAGE = 'https://example.com/offices/example-chiswick-estate-agents';
    const fixtures = fixtureTransport({
      'https://example.com/robots.txt': { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
      [SEARCH_URL]: { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ places: [
        { id: 'ChIJexampleChiswick01', displayName: { text: 'Example Chiswick Estate Agents' }, websiteUri: 'https://example.com/offices/chiswick' },
      ] }) },
    });
    // The branch page never answers: the request is abandoned when its timeout fires, as with a slow site. The timeout's
    // timer is unref'd, so a referenced one keeps the event loop alive until then, as an open socket would.
    const transport: Transport = {
      send: (request) => (request.url.href === PAGE
        ? new Promise((unusedResolve, reject) => {
          const openSocket = setTimeout(() => reject(new Error('the request was never aborted')), FIXTURE_HOLD_MS);
          request.signal.addEventListener('abort', () => {
            clearTimeout(openSocket);
            reject(new Error('aborted'));
          });
        })
        : fixtures.send(request)),
    };
    const config = testConfig({ variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: API_KEY }, fileText: '[timeouts]\nrequest_ms = 1000\nlookup_ms = 5000\n' });
    const outcome = await runLookup({ query: makeQuery({ url: PAGE }), providers: builtInProviders(config), config, logger: quietLogger, transport, isDownloadSkipped: true });
    const result = buildResult(outcome, { isExplain: false });
    assert.equal(result.providers.find((provider) => provider.name === 'web-fetch')?.status, 'timeout');
    assert.equal(result.fields.place_id.value, 'ChIJexampleChiswick01');
    assert.equal(result.identity.confidence, 60, 'one source, the site confirmed; the page neither confirmed nor contradicted');
  });

  test('a namesake\'s website that redirects to the query\'s site is on the query\'s site', async () => {
    const { result, transport } = await find({ name: 'Example Lettings', url: 'https://example.com/' }, {
      'https://example.com/robots.txt': { status: 403, body: '' },
      [SEARCH_URL]: { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ places: [
        { id: 'ChIJexampleReading001', displayName: { text: 'Example Lettings' }, websiteUri: 'http://www.example.co.uk/' },
      ] }) },
      'http://www.example.co.uk/': { status: 301, headers: { location: 'https://www.example.com/' } },
    });
    assert.equal(result.fields.place_id.value, 'ChIJexampleReading001', 'kept, though the search keeps only places on the site');
    assert.equal(result.fields.website.value, 'https://example.com/');
    assert.ok(result.fields.website.sources.includes('google-places-api'), 'Google\'s website, followed, agrees with the query');
    assert.ok(!transport.requests.includes('GET https://www.example.com/'), 'the query\'s own page isn\'t fetched by the check');
    assert.equal(googleReport(result)?.metered_calls, 1, 'the website check is a plain page fetch: not metered');
    assert.equal(googleReport(result)?.calls, 2, 'but it is a request Google\'s provider made, so calls counts it');
  });

  test('a namesake\'s website whose host doesn\'t resolve is left out, so it doesn\'t contradict the query', async () => {
    const fixtures = fixtureTransport({
      'https://example.com/robots.txt': { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
      'https://example.com/branch/stevenage/': { body: '<html><head><title>Stevenage</title></head><body><h1>Example Homes Stevenage</h1></body></html>' },
      [SEARCH_URL]: { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ places: [
        { id: 'ChIJexampleStevenage1', displayName: { text: 'Example Homes Stevenage' }, websiteUri: 'https://old-example.co.uk/stevenage' },
      ] }) },
    });
    const transport: Transport = {
      send: (request) => (request.url.hostname === 'old-example.co.uk'
        ? Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND old-example.co.uk'), { code: 'ENOTFOUND' }))
        : fixtures.send(request)),
    };
    const config = testConfig({ variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: API_KEY } });
    const outcome = await runLookup({
      query: makeQuery({ name: 'Example Homes Stevenage', url: 'https://example.com/branch/stevenage/' }),
      providers: builtInProviders(config), config, logger: quietLogger, transport, isDownloadSkipped: true,
    });
    const result = buildResult(outcome, { isExplain: false });
    assert.equal(result.fields.place_id.value, 'ChIJexampleStevenage1');
    assert.ok(result.warnings.some((warning) => warning.includes('doesn\'t answer')));
  });

  test('a website that doesn\'t resolve fails web-fetch with cause dns; an HTTP status, with http_NNN', async () => {
    const dead: Transport = { send: () => Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND example.com'), { code: 'ENOTFOUND' })) };
    const config = testConfig();
    const outcome = await runLookup({ query: makeQuery({ url: 'https://example.com/' }), providers: builtInProviders(config), config, logger: quietLogger, transport: dead, isDownloadSkipped: true });
    const report = buildResult(outcome, { isExplain: false }).providers.find((provider) => provider.name === 'web-fetch');
    assert.equal(report?.status, 'unreachable');
    assert.equal(report?.cause, 'dns');
    const { result } = await find({ url: 'https://example.com/branch/gone/' }, {
      'https://example.com/robots.txt': { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
      'https://example.com/branch/gone/': { status: 404, body: '' },
    });
    assert.equal(result.providers.find((provider) => provider.name === 'web-fetch')?.cause, 'http_404');
    assert.ok(validate(result), 'the result still fits the schema');
  });

  test('a permanently closed place is reported in warnings', async () => {
    const { result } = await find({ name: 'Example Estates', postcode: 'RG9 1AA' }, { [SEARCH_URL]: google('search-closed.json') });
    assert.ok(result.warnings.includes('Google lists Example Estates Henley as closed permanently.'));
    assert.equal(result.identity.business_status, 'closed_permanently');
  });

  test('no results is a successful call that found nothing', async () => {
    const { result } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, { [SEARCH_URL]: google('search-empty.json') });
    assert.equal(googleReport(result)?.status, 'ok');
    assert.equal(result.identity.confidence, 0);
    assert.equal(result.error, null);
  });

  test('API errors are classified, and the key never appears in the detail', async () => {
    const cases: Array<[string, number, string]> = [
      ['error-permission-denied.json', 403, 'auth_failed'],
      ['error-key-invalid.json', 400, 'auth_failed'],
      ['error-quota.json', 429, 'quota_exceeded'],
      ['search-empty.json', 503, 'unreachable'],
    ];
    for (const [file, status, expected] of cases) {
      const { result } = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, { [SEARCH_URL]: google(file, status) });
      assert.equal(googleReport(result)?.status, expected, file);
      assert.equal(result.error?.code, 'lookup.all_failed');
    }
    const echoesKey = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, {
      [SEARCH_URL]: { status: 400, body: `{"error":{"message":"API key ${API_KEY} not valid","details":[{"reason":"API_KEY_INVALID"}]}}` },
    });
    assert.doesNotMatch(JSON.stringify(echoesKey.result), new RegExp(API_KEY));
    const notJson = await find({ name: 'Example Estates', postcode: 'RG1 1AA' }, { [SEARCH_URL]: { body: '<html>Oops</html>' } });
    assert.equal(googleReport(notJson.result)?.status, 'bad_response');
  });

  test('with no name and location to search with, Google waits, then is skipped with the reason', async () => {
    const { result, transport } = await find({ name: 'Example Estates' }, {});
    assert.deepEqual(transport.requests, []);
    assert.equal(googleReport(result)?.reason, 'no place ID, and no name with a location (or a phone) to search with');
  });

  test('the metered-call budget stops Google before it runs', async () => {
    const transport = fixtureTransport({ [SEARCH_URL]: google('search-reading.json') });
    const config = testConfig({ variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: API_KEY }, fileText: '[budgets]\nmetered_calls_per_lookup = 0\n' });
    const outcome = await runLookup({ query: makeQuery({ name: 'Example Estates', postcode: 'RG1 1AA' }), providers: builtInProviders(config), config, logger: quietLogger, transport });
    assert.equal(outcome.reports.find((report) => report.name === 'google-places-api')?.reason, 'over budget');
    assert.deepEqual(transport.requests, []);
  });
});

describe('providers check', () => {
  test('makes one IDs-only call per configured provider, and classifies a failure', async () => {
    const seen: TransportRequest[] = [];
    const config = testConfig({ variables: { COMPFINDER_GOOGLE_PLACES_API_KEY: API_KEY } });
    const reports = await checkProviders({
      providers: builtInProviders(config), config, logger: quietLogger,
      transport: fixtureTransport({ [SEARCH_URL]: recordingRoute('search-empty.json', seen) }),
    });
    assert.deepEqual(reports.map((report) => `${report.name}: ${report.status}`), [
      'web-fetch: ok', 'google-places-api: ok', 'brave-search-api: not_configured',
    ]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.headers['x-goog-fieldmask'], 'places.id');

    const failed = await checkProviders({
      providers: builtInProviders(config), config, logger: quietLogger, only: ['google-places-api'],
      transport: fixtureTransport({ [SEARCH_URL]: google('error-key-invalid.json', 400) }),
    });
    assert.deepEqual(failed.map((report) => report.status), ['auth_failed']);
  });
});
