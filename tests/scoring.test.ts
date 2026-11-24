import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { RULE_IDS, type RuleId } from '../src/scoring/rules.js';
import { fact, record, score } from './helpers/records.js';

const PHONE = '0118 496 0000';
const PHONE_E164 = '+441184960000';
const OTHER_PHONE = '0118 496 0999';
const POSTCODE = 'RG1 1AA';
const OTHER_POSTCODE = 'RG1 2BB';
const PLACE_ID = 'ChIJexampleReading001';
const OTHER_PLACE_ID = 'ChIJexampleWokingham01';

/** Rule IDs that some test below has asserted; checked against RULE_IDS at the end. */
const covered = new Set<RuleId>();

/** Asserts a score's rules, in order, and marks them covered. */
function expectRules(actual: readonly RuleId[], expected: readonly RuleId[]): void {
  assert.deepEqual(actual, expected);
  for (const rule of expected) {
    covered.add(rule);
  }
}

/** The site's own LocalBusiness block for the Reading branch. */
const siteBranch = record('web-fetch', [
  fact.name('Example Estates Reading'),
  fact.phone(PHONE),
  fact.address({ lines: ['1 Broad Street'], town: 'Reading', postcode: POSTCODE }),
  fact.website('https://example.com/branches/reading/'),
  fact.email('reading@example.com'),
]);

/** Google's listing for the same branch. */
const googleBranch = record('google-places-api', [
  fact.name('Example Estates Reading'),
  fact.phone(PHONE),
  fact.address({ lines: ['1 Broad St'], town: 'Reading', postcode: POSTCODE, formatted: '1 Broad St, Reading RG1 1AA, UK' }),
  fact.website('https://example.com/'),
  fact.placeId(PLACE_ID),
]);

describe('identity rules', () => {
  test('identity.input-confirmed: a structured source confirms the query\'s postcode', () => {
    const result = score({ name: 'Example Estates', postcode: POSTCODE }, [googleBranch]);
    assert.equal(result.identity.confidence, 100);
    expectRules(result.identity.rules, ['identity.input-confirmed']);
  });

  test('identity.independent-agreement: the site and Google describe the same place', () => {
    const result = score({ url: 'https://example.com/' }, [siteBranch, googleBranch]);
    assert.equal(result.identity.confidence, 100);
    expectRules(result.identity.rules, ['identity.independent-agreement']);
    assert.match(result.identity.reasons[0] ?? '', /web-fetch and google-places-api agree on phone \+441184960000/);
  });

  test('identity.single-structured: one source, with structured data', () => {
    const result = score({ url: 'https://example.com/' }, [siteBranch]);
    assert.equal(result.identity.confidence, 60);
    expectRules(result.identity.rules, ['identity.single-structured']);
  });

  test('identity.single-loose: one source, with loose page content only', () => {
    const loose = record('web-fetch', [fact.phone(PHONE, 'loose'), fact.address({ postcode: POSTCODE }, 'loose')]);
    const result = score({ url: 'https://example.com/' }, [loose]);
    assert.equal(result.identity.confidence, 40);
    expectRules(result.identity.rules, ['identity.single-loose']);
  });

  test('identity.none: every candidate contradicts the query', () => {
    const result = score({ name: 'Example Estates', postcode: OTHER_POSTCODE }, [googleBranch]);
    assert.equal(result.identity.confidence, 0);
    expectRules(result.identity.rules, ['identity.none']);
    assert.equal(result.identity.rejected.length, 1);
  });

  test('a confirmed pinning key keeps a candidate whose other details contradict the query, as stale data', () => {
    const result = score({ url: 'https://example.com/branches/reading/', phone: OTHER_PHONE }, [siteBranch, googleBranch]);
    assert.equal(result.identity.leaders.length, 1, 'the page URL is confirmed, so the changed phone doesn\'t reject the branch');
    assert.equal(result.identity.rejected.length, 0);
    assert.equal(result.fields.phone.value?.e164, PHONE_E164);
    assert.deepEqual(result.fields.phone.conflicts.map((conflict) => conflict.sources), [['query']]);
  });

  test('identity.tie: two branches match equally; the score is shared and both are listed', () => {
    const reading = record('google-places-api', [
      fact.name('Example Estates Reading'), fact.address({ postcode: POSTCODE }), fact.placeId(PLACE_ID), fact.website('https://example.com/'),
    ], { subject: 'reading' });
    const wokingham = record('google-places-api', [
      fact.name('Example Estates Wokingham'), fact.address({ postcode: 'RG40 1AA' }), fact.placeId(OTHER_PLACE_ID), fact.website('https://example.com/'),
    ], { subject: 'wokingham' });
    const brand = record('web-fetch', [fact.logo('https://example.com/logo.svg', 'schema-org')], { scope: 'brand' });
    const result = score({ name: 'Example Estates' }, [reading, wokingham, brand]);
    assert.equal(result.identity.confidence, 30);
    expectRules(result.identity.rules, ['identity.single-structured', 'identity.tie']);
    assert.equal(result.identity.leaders.length, 2);
    assert.equal(result.identity.brandConfidence, 60, 'both leaders are on example.com, so the brand isn\'t in doubt');
  });

  test('identity.none names each rejected candidate and what it contradicts', () => {
    const result = score({ name: 'Other Agents' }, [googleBranch]);
    assert.equal(result.identity.confidence, 0);
    assert.deepEqual(result.identity.reasons, ['every candidate contradicts the query: Example Estates Reading (different name)']);
  });

  test('identity.name-mismatch: the query\'s site is confirmed but its name isn\'t; kept, capped at 40', () => {
    const result = score({ name: 'Totally Different Agents', url: 'https://example.com/' }, [siteBranch]);
    assert.equal(result.identity.confidence, 40);
    expectRules(result.identity.rules, ['identity.single-structured', 'identity.name-mismatch']);
    assert.equal(result.fields.phone.confidence, 40);
    assert.ok(result.identity.warnings.some((warning) => warning.includes('"Example Estates Reading"')));
    const otherSite = score({ name: 'Totally Different Agents', url: 'https://other.example/' }, [siteBranch]);
    assert.equal(otherSite.identity.confidence, 0, 'with the site not confirmed either, it\'s still dropped');
  });

  test('identity.head-office: a chain\'s home page with no location is the head office', () => {
    const headOffice = record('web-fetch', [fact.name('Example Estates'), fact.phone(PHONE)], { role: 'head-office' });
    const result = score({ url: 'https://example.com/' }, [headOffice]);
    expectRules(result.identity.rules, ['identity.single-structured', 'identity.head-office']);
    assert.equal(result.warnings.length, 1);
  });
});

describe('field rules', () => {
  test('field.independent-agreement: the site and Google agree on the phone', () => {
    const result = score({ url: 'https://example.com/' }, [siteBranch, googleBranch]);
    assert.equal(result.fields.phone.value?.e164, PHONE_E164);
    assert.equal(result.fields.phone.confidence, 100);
    expectRules(result.fields.phone.rules, ['field.independent-agreement']);
    assert.deepEqual(result.fields.phone.sources, ['web-fetch', 'google-places-api']);
  });

  test('field.input-confirmed: one structured source confirms the query\'s phone', () => {
    const result = score({ phone: PHONE }, [googleBranch]);
    assert.equal(result.fields.phone.confidence, 100);
    expectRules(result.fields.phone.rules, ['field.input-confirmed']);
    assert.deepEqual(result.fields.phone.sources, ['query', 'google-places-api']);
  });

  test('field.input-confirmed-loose: a tel: link confirms the query\'s phone', () => {
    const site = record('web-fetch', [fact.name('Example Estates Reading'), fact.phone(PHONE, 'loose')]);
    const result = score({ name: 'Example Estates', phone: PHONE }, [site]);
    assert.equal(result.fields.phone.confidence, 60);
    expectRules(result.fields.phone.rules, ['field.input-confirmed-loose']);
  });

  test('field.single-structured: one source only, from structured data', () => {
    const result = score({ url: 'https://example.com/' }, [siteBranch, googleBranch]);
    assert.equal(result.fields.email.value?.address, 'reading@example.com');
    assert.equal(result.fields.email.confidence, 60);
    expectRules(result.fields.email.rules, ['field.single-structured']);
  });

  test('field.single-loose: one source only, from loose page content', () => {
    const site = record('web-fetch', [fact.name('Example Estates Reading'), fact.phone(PHONE), fact.email('info@example.com', 'loose')]);
    const result = score({ url: 'https://example.com/' }, [site, googleBranch]);
    assert.equal(result.fields.email.confidence, 40);
    expectRules(result.fields.email.rules, ['field.single-loose']);
  });

  test('field.input-only: only the query gives the value', () => {
    const result = score({ name: 'Example Estates', postcode: POSTCODE }, []);
    assert.equal(result.fields.address.value?.postcode, POSTCODE);
    assert.equal(result.fields.address.confidence, 20);
    expectRules(result.fields.address.rules, ['field.input-only']);
    assert.deepEqual(result.fields.address.reasons, ['from the query only; no source confirms it']);
  });

  test('field.none: nothing found leaves the value null at 0', () => {
    const result = score({ url: 'https://example.com/' }, [googleBranch]);
    assert.equal(result.fields.email.value, null);
    assert.equal(result.fields.email.confidence, 0);
    expectRules(result.fields.email.rules, ['field.none']);
  });

  test('field.identity-record: Google\'s place ID is as sure as the identity its record supports', () => {
    const result = score({ url: 'https://example.com/' }, [siteBranch, googleBranch]);
    assert.equal(result.fields.place_id.value, PLACE_ID);
    assert.equal(result.fields.place_id.confidence, 100);
    expectRules(result.fields.place_id.rules, ['field.single-structured', 'field.identity-record']);
  });

  test('field.conflict: a third origin disagrees with the site and Google, so the score is 2 of 3 sources', () => {
    const otherSource = record('web-fetch', [fact.phone(OTHER_PHONE), fact.website('https://example.com/')], { scope: 'brand', origin: 'another-directory' });
    const result = score({ url: 'https://example.com/' }, [siteBranch, googleBranch, otherSource]);
    assert.equal(result.fields.phone.value?.e164, PHONE_E164);
    assert.equal(result.fields.phone.confidence, 66);
    expectRules(result.fields.phone.rules, ['field.independent-agreement', 'field.conflict']);
    assert.deepEqual(result.fields.phone.conflicts.map((conflict) => [conflict.value.e164, conflict.sources]), [['+441184960999', ['web-fetch']]]);
  });

  test('field.head-office: a branch was asked for, but only a head-office record gives the phone', () => {
    const google = record('google-places-api', [fact.name('Example Estates Reading'), fact.address({ postcode: POSTCODE }), fact.website('https://example.com/')]);
    const headOffice = record('web-fetch', [fact.phone(OTHER_PHONE), fact.website('https://example.com/')], { scope: 'brand', role: 'head-office' });
    const result = score({ name: 'Example Estates', postcode: POSTCODE }, [google, headOffice]);
    assert.equal(result.fields.phone.confidence, 30);
    expectRules(result.fields.phone.rules, ['field.single-structured', 'field.head-office']);
  });

  test('field.identity-cap: in a two-way tie, a branch\'s name is capped at the identity', () => {
    const reading = record('google-places-api', [fact.name('Example Estates Reading'), fact.placeId(PLACE_ID)], { subject: 'reading' });
    const wokingham = record('google-places-api', [fact.name('Example Estates Wokingham'), fact.placeId(OTHER_PLACE_ID)], { subject: 'wokingham' });
    const result = score({ name: 'Example Estates' }, [reading, wokingham]);
    assert.equal(result.fields.name.confidence, 30);
    expectRules(result.fields.name.rules, ['field.single-structured', 'field.identity-cap']);
  });

  test('field.brand-cap: when tied candidates are on different sites, brand values are capped too', () => {
    const reading = record('google-places-api', [fact.name('Example Estates Reading'), fact.placeId(PLACE_ID), fact.website('https://example.com/')], { subject: 'reading' });
    const other = record('google-places-api', [fact.name('Example Estates Ltd'), fact.placeId(OTHER_PLACE_ID), fact.website('https://example.org/')], { subject: 'other' });
    const brand = record('web-fetch', [fact.social('facebook', 'https://www.facebook.com/exampleestates')], { scope: 'brand' });
    const result = score({ name: 'Example Estates' }, [reading, other, brand]);
    assert.equal(result.identity.confidence, 30);
    assert.equal(result.fields.socials.confidence, 30);
    expectRules(result.fields.socials.rules, ['field.single-structured', 'field.brand-cap']);
  });
});

describe('logo rules', () => {
  const google = record('google-places-api', [fact.name('Example Estates Reading'), fact.phone(PHONE), fact.website('https://example.com/')]);

  /** Scores a site whose brand record carries the given logos, with the website confirmed by Google. */
  function logoResult(logos: ReturnType<typeof fact.logo>[]) {
    const site = record('web-fetch', [fact.name('Example Estates Reading'), fact.phone(PHONE), fact.website('https://example.com/')]);
    const brand = record('web-fetch', logos, { scope: 'brand' });
    return score({ url: 'https://example.com/' }, [site, google, brand]).fields.logo;
  }

  test('logo.schema-org: the site\'s own schema.org logo wins over its og:image, at 100', () => {
    const logo = logoResult([fact.logo('https://example.com/og.jpg', 'social-image', 1200), fact.logo('https://example.com/logo.svg', 'schema-org')]);
    assert.equal(logo.value?.source_url, 'https://example.com/logo.svg');
    assert.equal(logo.confidence, 100);
    expectRules(logo.rules, ['logo.schema-org']);
  });

  test('logo.manifest-icon: a large app icon scores 60', () => {
    const logo = logoResult([fact.logo('https://example.com/icon-512.png', 'manifest-icon', 512)]);
    assert.equal(logo.confidence, 60);
    expectRules(logo.rules, ['logo.manifest-icon']);
  });

  test('logo.social-image: an og:image scores 40', () => {
    const logo = logoResult([fact.logo('https://example.com/og.jpg', 'social-image', 1200)]);
    assert.equal(logo.confidence, 40);
    expectRules(logo.rules, ['logo.social-image']);
  });

  test('logo.favicon: a favicon scores 40', () => {
    const logo = logoResult([fact.logo('https://example.com/favicon.ico', 'favicon', 32)]);
    assert.equal(logo.confidence, 40);
    expectRules(logo.rules, ['logo.favicon']);
  });

  test('logo.website-cap: a logo is capped at the website\'s confidence', () => {
    const site = record('web-fetch', [fact.name('Example Estates Reading'), fact.phone(PHONE), fact.website('https://example.com/')]);
    const brand = record('web-fetch', [fact.logo('https://example.com/logo.svg', 'schema-org')], { scope: 'brand' });
    const confirmed = score({ url: 'https://example.com/' }, [site, google, brand]).fields;
    assert.equal(confirmed.website.confidence, 100, 'Google confirms the site');
    assert.equal(confirmed.logo.confidence, 100);
    const siteOnly = score({ url: 'https://example.com/' }, [site, brand]).fields;
    assert.equal(siteOnly.website.confidence, 60, 'a site vouching for itself is one source');
    assert.equal(siteOnly.logo.confidence, 60);
    expectRules(siteOnly.logo.rules, ['logo.schema-org', 'logo.website-cap']);
  });
});

describe('field values', () => {
  test('a branch page from the query is shown over Google\'s home page, as the same site', () => {
    const result = score({ url: 'https://example.com/branches/reading/' }, [siteBranch, googleBranch]);
    assert.equal(result.fields.website.value?.url, 'https://example.com/branches/reading/');
    assert.equal(result.fields.website.confidence, 100);
  });

  test('Google\'s address is shown, and a compatible shorter name isn\'t a conflict', () => {
    const brand = record('web-fetch', [fact.name('Example Estates')], { scope: 'brand' });
    const result = score({ url: 'https://example.com/branches/reading/' }, [siteBranch, googleBranch, brand]);
    assert.equal(result.fields.address.valueSource, 'google-places-api');
    assert.equal(result.fields.name.value, 'Example Estates Reading');
    assert.deepEqual(result.fields.name.conflicts, []);
  });

  test('a different building number at the same postcode is a different address', () => {
    const site = record('web-fetch', [fact.name('Example Estates Reading'), fact.phone(PHONE), fact.address({ lines: ['3 Broad Street'], postcode: POSTCODE })]);
    const result = score({ url: 'https://example.com/' }, [site, googleBranch]);
    assert.equal(result.fields.address.conflicts.length, 1);
  });
});

// Runs last: tests in a file run in order, so every rule test above has marked its rules.
test('every rule in rules.ts has a test', () => {
  assert.deepEqual(RULE_IDS.filter((rule) => !covered.has(rule)), []);
});
