import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normaliseQuery } from '../src/lookup/query.js';
import { countryRules } from '../src/normalise/country/index.js';
import { classifyEmail, normaliseEmail } from '../src/normalise/email.js';
import { mapsCid } from '../src/normalise/maps.js';
import { compareNames, compareQueryName, comparableName, isOneEditApart } from '../src/normalise/name.js';
import { normalisePhone } from '../src/normalise/phone.js';
import { decodeEscapes, sanitiseText, TEXT_LIMITS } from '../src/normalise/text.js';
import { isSameSite, isSiteRoot, normaliseUrl, pagePath } from '../src/normalise/url.js';

describe('UK postcodes', () => {
  const gb = countryRules('gb');

  test('are capitalised with one space, and checked against the format', () => {
    assert.equal(gb.normalisePostcode('rg1 1aa'), 'RG1 1AA');
    assert.equal(gb.normalisePostcode('RG11AA'), 'RG1 1AA');
    assert.equal(gb.normalisePostcode(' sw1a  2aa '), 'SW1A 2AA');
    assert.equal(gb.normalisePostcode('EC1A1BB'), 'EC1A 1BB');
    assert.equal(gb.normalisePostcode('RG1'), null);
    assert.equal(gb.normalisePostcode('12345'), null);
  });

  test('are found in running text, once each, in order', () => {
    assert.deepEqual(gb.findPostcodes('Visit us at 1 Broad St, Reading RG1 1AA or rg40 1aa. RG1 1AA again.'), ['RG1 1AA', 'RG40 1AA']);
  });

  test('a country without a module finds nothing, rather than guessing', () => {
    assert.equal(countryRules('FR').normalisePostcode('75001'), null);
  });
});

describe('phone numbers', () => {
  test('become E.164 with a national display form', () => {
    assert.deepEqual(normalisePhone('0118 496 0000', 'GB'), { e164: '+441184960000', display: '0118 496 0000' });
    assert.deepEqual(normalisePhone('tel:+44%20118%20496%200000', 'GB'), { e164: '+441184960000', display: '0118 496 0000' });
  });

  test('that aren\'t valid numbers are rejected', () => {
    assert.equal(normalisePhone('999', 'GB'), null);
    assert.equal(normalisePhone('not a number', 'GB'), null);
    assert.equal(normalisePhone('tel:%E0%A4%A', 'GB'), null, 'a malformed escape is compared as given, not thrown');
  });
});

describe('web addresses', () => {
  test('get https:// when given without a scheme, and lose any fragment', () => {
    assert.deepEqual(normaliseUrl('example.com'), { url: 'https://example.com/', domain: 'example.com' });
    assert.deepEqual(normaliseUrl('http://www.Example.com/Branches/Reading/#map'), { url: 'http://www.example.com/Branches/Reading/', domain: 'example.com' });
  });

  test('that aren\'t http(s), or have no dotted host, are rejected', () => {
    assert.equal(normaliseUrl('ftp://example.com/'), null);
    assert.equal(normaliseUrl('javascript:alert(1)'), null);
    assert.equal(normaliseUrl('localhost'), null);
    assert.equal(normaliseUrl('not a url at all'), null);
  });

  test('are the same site when hosts match or one is a subdomain, ignoring www.', () => {
    assert.equal(isSameSite('www.example.com', 'example.com'), true);
    assert.equal(isSameSite('reading.example.com', 'example.com'), true);
    assert.equal(isSameSite('example.com', 'example.org'), false);
    assert.equal(isSameSite('notexample.com', 'example.com'), false);
  });

  test('compare pages by path, without a trailing slash', () => {
    assert.equal(pagePath('https://example.com/Branches/Reading/'), '/branches/reading');
    assert.equal(isSiteRoot('https://example.com/'), true);
    assert.equal(isSiteRoot('https://example.com/?ref=x'), true);
    assert.equal(isSiteRoot('https://example.com/contact'), false);
  });
});

describe('business names', () => {
  test('compare without case, punctuation, & or legal suffixes', () => {
    assert.equal(comparableName('Example & Sons Ltd.'), 'example son', 'connecting words and plain plurals go too');
    assert.equal(compareNames('EXAMPLE ESTATES LIMITED', 'Example Estates'), 'equal');
  });

  test('word order, connecting words and plain plurals don\'t make names differ', () => {
    assert.equal(compareNames('Martin & Co Estate Agents & Letting Agents in Reading', 'Martin & Co Reading Lettings & Estate Agents'), 'equal');
    assert.equal(compareNames('The Hexagon', 'Hexagon'), 'equal');
    assert.equal(compareNames('Example Estates Reading', 'Example Estates Wokingham'), 'incompatible');
  });

  test('Co, Company and & Co are legal suffixes too', () => {
    assert.equal(compareNames('Rebellion Beer Company', 'Rebellion Beer Co. Ltd.'), 'equal');
    assert.equal(compareNames('Smith & Co', 'Smith'), 'equal');
    assert.equal(comparableName('Co-op Funeralcare'), 'co op funeralcare', 'only at the end');
  });

  test('are compatible when one\'s words are all in the other', () => {
    assert.equal(compareNames('Example Estates', 'Example Estates - Reading'), 'compatible');
    assert.equal(compareNames('Example Estates', 'Other Agents'), 'incompatible');
  });

  test('a typed query name forgives one typo in each word of five letters or more', () => {
    assert.equal(compareQueryName('Headwlal Hosting', 'Headwall Hosting'), 'compatible', 'swapped letters');
    assert.equal(compareQueryName('Exampel Estate', 'Example Estates - Reading'), 'compatible');
    assert.equal(compareQueryName('Smyth Estates', 'Smith Estates'), 'compatible');
    assert.equal(compareQueryName('Hedwal Hosting', 'Headwall Hosting'), 'incompatible', 'two edits');
    assert.equal(compareQueryName('Bake Shop', 'Bike Shop'), 'incompatible', 'short words must match exactly');
    assert.equal(compareNames('Smyth Estates', 'Smith Estates'), 'incompatible', 'source names are never fuzzy');
  });

  test('one edit apart: substitution, insertion, deletion or a swap of neighbours', () => {
    assert.ok(isOneEditApart('headwall', 'headwlal'));
    assert.ok(isOneEditApart('headwall', 'headwal'));
    assert.ok(isOneEditApart('headwall', 'headwalll'));
    assert.ok(isOneEditApart('headwall', 'headwell'));
    assert.ok(!isOneEditApart('headwall', 'hedwal'));
    assert.ok(!isOneEditApart('headwall', 'wallhead'));
  });
});

describe('Google Maps cid links', () => {
  test('read the listing\'s cid from maps.google.com and google.<country>/maps links only', () => {
    assert.equal(mapsCid('https://maps.google.com/?cid=16220045999431265364'), '16220045999431265364');
    assert.equal(mapsCid('https://www.google.co.uk/maps?cid=0016220045999431265364'), '16220045999431265364');
    assert.equal(mapsCid('https://maps.google.co.uk/?cid=42&hl=en'), '42');
    assert.equal(mapsCid('https://maps.app.goo.gl/yaKEiDcRR98Xy2av6'), null, 'a short link has no cid to read');
    assert.equal(mapsCid('https://example.com/?cid=42'), null);
    assert.equal(mapsCid('https://www.google.com/search?cid=42'), null);
    assert.equal(mapsCid('https://maps.google.com/?cid=18446744073709551616'), null, 'over 64 bits');
    assert.equal(mapsCid('https://maps.google.com/?cid=12abc'), null);
  });
});

describe('email addresses', () => {
  test('are lower-cased, with mailto: and any query removed, and checked', () => {
    assert.equal(normaliseEmail('mailto:Reading@Example.com?subject=Hello'), 'reading@example.com');
    assert.equal(normaliseEmail('not-an-email'), null);
    assert.equal(normaliseEmail('a@b'), null);
  });

  test('are role addresses only when the local part is a role word or a word from the business', () => {
    assert.equal(classifyEmail('info@example.com', []), 'role');
    assert.equal(classifyEmail('lettings.reading@example.com', ['Example Estates', 'Reading']), 'role');
    assert.equal(classifyEmail('reading@example.com', ['Reading']), 'role');
    assert.equal(classifyEmail('jane.smith@example.com', ['Example Estates']), 'possibly-personal');
    assert.equal(classifyEmail('paul@example.com', ['Example Estates']), 'possibly-personal');
  });
});

describe('untrusted text', () => {
  test('loses markup, control and bidi characters, and is capped in length', () => {
    const bidiOverride = String.fromCodePoint(0x202e);
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    const hostile = `<b>Example</b>${bidiOverride} Estates${zeroWidthSpace}\u0007\n\n Reading`;
    assert.equal(sanitiseText(hostile, 'name'), 'Example Estates Reading');
    assert.equal(Array.from(sanitiseText('x'.repeat(500), 'name')).length, TEXT_LIMITS.name);
  });

  test('a malformed %-escape is left as it was', () => {
    assert.equal(decodeEscapes('100%'), '100%');
    assert.equal(decodeEscapes('a%20b'), 'a b');
  });
});

describe('queries', () => {
  test('country must be a real two-letter code; UK means GB, and case doesn\'t matter', () => {
    assert.equal(normaliseQuery({ name: 'Example', country: 'UK' }, 'US').query.country, 'GB');
    assert.deepEqual(normaliseQuery({ name: 'Example', country: 'UK' }, 'US').query.notes, ['country "UK" was read as GB, its ISO code.']);
    assert.equal(normaliseQuery({ name: 'Example', country: 'gb' }, 'US').query.notes, undefined, 'a change of case needs no note');
    assert.equal(normaliseQuery({ name: 'Example', country: 'gb' }, 'US').query.country, 'GB');
    assert.equal(normaliseQuery({ name: 'Example', country: 'ie' }, 'GB').query.country, 'IE');
    assert.match(normaliseQuery({ name: 'Example', country: 'XX' }, 'GB').problems.join(' '), /two-letter country code/);
    assert.equal(normaliseQuery({ name: 'Example', phone: '0118 496 0000', country: 'UK' }, 'US').problems.length, 0, 'a UK row\'s national phone number reads as GB');
  });

  test('normalise every input, and find a postcode in a free-text address', () => {
    const { query, problems } = normaliseQuery({ name: ' Example Estates ', url: 'example.com/branches/reading', address: '1 Broad St, Reading rg1 1aa' }, 'GB');
    assert.deepEqual(problems, []);
    assert.equal(query.name, 'Example Estates');
    assert.equal(query.website?.url, 'https://example.com/branches/reading');
    assert.equal(query.postcode, 'RG1 1AA');
    assert.equal(query.country, 'GB');
  });

  test('list every bad input at once', () => {
    const { problems } = normaliseQuery({ url: 'ftp://x', postcode: 'nowhere', phone: '12', place_id: 'bad id!', country: 'GBR' }, 'GB');
    assert.equal(problems.length, 5);
  });

  test('with nothing to look up, is a problem', () => {
    assert.deepEqual(normaliseQuery({ name: '  ' }, 'GB').problems, ['Give at least one of: a name, url, address, postcode, phone or place_id.']);
  });
});
