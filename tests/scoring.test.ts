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

describe('linking records into places', () => {
  const googlePlace = (placeId: string, name: string, phone: string, postcode: string, subject: string) => record('google-places-api', [
    fact.name(name), fact.phone(phone), fact.address({ lines: ['66 Grosvenor St'], postcode }), fact.placeId(placeId),
  ], { subject });

  test('two places with different place IDs never merge, even sharing a phone and a building', () => {
    const cityOfBooks = googlePlace(PLACE_ID, 'Example City of Books', PHONE, POSTCODE, 'city');
    const airport = googlePlace(OTHER_PLACE_ID, 'Example Books at the Airport', PHONE, POSTCODE, 'pdx');
    const result = score({ name: 'Example Books', address: 'Reading' }, [cityOfBooks, airport]);
    assert.equal(result.identity.leaders.length, 2, 'two places, so a tie, not one hybrid');
    assert.deepEqual(result.identity.leaders.map((leader) => leader.candidate.records.length), [1, 1]);
  });

  test('a record whose strongest key fits several places joins none of them', () => {
    const headOffice = record('web-fetch', [fact.address({ lines: ['66 Grosvenor St'], postcode: POSTCODE })]);
    const mayfair = googlePlace(PLACE_ID, 'Example Estates Mayfair', PHONE, POSTCODE, 'mayfair');
    const lettings = googlePlace(OTHER_PLACE_ID, 'Example Estates Lettings', OTHER_PHONE, POSTCODE, 'lettings');
    const result = score({ url: 'https://example.com/' }, [headOffice, mayfair, lettings]);
    const sizes = [...result.identity.leaders, ...result.identity.others].map((assessment) => assessment.candidate.records.length);
    assert.deepEqual(sizes.sort(), [1, 1, 1]);
  });

  test('the strongest shared key decides: a shared phone beats a shared building', () => {
    const site = record('web-fetch', [fact.name('Example Brewery'), fact.phone(PHONE), fact.address({ lines: [], postcode: POSTCODE })]);
    const brewery = googlePlace(PLACE_ID, 'Example Brewery Ltd', PHONE, POSTCODE, 'brewery');
    const shop = googlePlace(OTHER_PLACE_ID, 'Example Brewery Shop', OTHER_PHONE, POSTCODE, 'shop');
    const result = score({ name: 'Example Brewery' }, [site, brewery, shop]);
    assert.equal(result.identity.confidence, 100);
    assert.deepEqual(result.identity.leaders[0]?.candidate.records.map((entry) => entry.subject), ['web-fetch-test', 'brewery']);
  });

  test('when the strongest key fits several places, the one with the same name is joined, and wins in its building', () => {
    const site = record('web-fetch', [fact.name('Example Brewery'), fact.phone(PHONE)]);
    const brewery = googlePlace(PLACE_ID, 'Example Brewery Ltd', PHONE, POSTCODE, 'brewery');
    const tap = googlePlace(OTHER_PLACE_ID, 'Example Brewery Tap', PHONE, POSTCODE, 'tap');
    const result = score({ name: 'Example Brewery' }, [site, brewery, tap]);
    assert.equal(result.identity.confidence, 100, 'the brewery, not a tie with its tap room');
    assert.equal(result.fields.place_id.value, PLACE_ID);
  });

  test('a site\'s address with no postcode links to Google\'s by its street, however it\'s spelt', () => {
    const site = record('web-fetch', [fact.name('Example Woodworks'), fact.phone(PHONE), fact.address({ lines: ['329 W 18th St, Ste 914'], town: 'Chicago' })]);
    const google = record('google-places-api', [fact.name('Example Woodworks'), fact.address({ lines: ['Ste 914', '329 West 18th Street'], town: 'Chicago', postcode: '60616' }),
      fact.website('https://example.com/'), fact.placeId(PLACE_ID)]);
    const result = score({ name: 'Example Woodworks', url: 'https://example.com/' }, [site, google]);
    expectRules(result.identity.rules, ['identity.independent-agreement']);
    assert.ok(result.identity.reasons[0]?.includes('address 329 w 18th st'), 'the reason names the key the two sources share');
  });

  test('one switchboard for two listings: the site joins the listing whose street it shares, and is preferred on its home page', () => {
    const site = record('web-fetch', [fact.name('Example Roofing'), fact.phone(PHONE), fact.address({ lines: ['6 Fern Road, Sandyford'], town: 'Dublin' }), fact.website('https://example.com/')]);
    const fern = record('google-places-api', [fact.name('Example Roofing'), fact.phone(PHONE), fact.address({ lines: ['6 Fern Road'], postcode: 'D18 FP98' }),
      fact.website('https://example.com/'), fact.placeId(PLACE_ID)], { subject: 'fern' });
    const clontarf = record('google-places-api', [fact.name('Example Roofing'), fact.phone(PHONE), fact.address({ lines: ['57 Clontarf Road'], postcode: 'D03 A7P0' }),
      fact.website('https://example.com/'), fact.placeId(OTHER_PLACE_ID)], { subject: 'clontarf' });
    const result = score({ name: 'Example Roofing', url: 'https://example.com/' }, [site, fern, clontarf]);
    expectRules(result.identity.rules, ['identity.independent-agreement']);
    assert.equal(result.fields.place_id.value, PLACE_ID);
  });

  test('a record that says nothing about a place (an About page\'s markup) joins its site\'s other records', () => {
    const home = record('web-fetch', [fact.name('Example Property'), fact.phone(PHONE), fact.website('https://example.com/')], { subject: 'home' });
    const about = record('web-fetch', [fact.name('Example Property'), fact.website('https://example.com/'), fact.email('contact@example.com', 'loose')], { subject: 'about' });
    const google = record('google-places-api', [fact.name('Example Property Limited'), fact.phone(PHONE), fact.address({ postcode: POSTCODE }), fact.placeId(PLACE_ID)]);
    const result = score({ name: 'Example Property', url: 'https://example.com/' }, [home, about, google]);
    assert.equal(result.identity.leaders.length, 1, 'not a second place');
    expectRules(result.identity.rules, ['identity.independent-agreement']);
  });

  test('a page asked about that a source gives exactly is the website shown, not a longer page from the markup', () => {
    const page = record('web-fetch', [fact.name('Example Lettings'), fact.phone(PHONE), fact.website('https://example.com/uk')], { subject: 'page' });
    const about = record('web-fetch', [fact.name('Example Lettings'), fact.phone(PHONE), fact.website('https://example.com/uk/about-us/')], { subject: 'about' });
    const result = score({ name: 'Example Lettings', url: 'https://example.com/uk' }, [page, about]);
    assert.equal(result.fields.website.value?.url, 'https://example.com/uk');
  });

  test('on a branch page, a listing whose page is an alias of it beats the head office on the home page', () => {
    const site = record('web-fetch', [fact.name('Example Property Wokingham'), fact.phone(PHONE), fact.address({ lines: ['16 Market Place'], postcode: 'RG40 1AL' }),
      fact.website('https://example.com/contact-us/estate-agents-wokingham')], { subject: 'site' });
    const branch = record('google-places-api', [fact.name('Example Property - Estate Agents Wokingham'), fact.phone(PHONE), fact.address({ lines: ['16 Market Place'], postcode: 'RG40 1AL' }),
      fact.website('https://example.com/contact-us/estate-agents-wokingham'), fact.placeId(PLACE_ID)], { subject: 'branch' });
    const office = record('web-fetch', [fact.name('Example Property'), fact.phone(OTHER_PHONE), fact.address({ lines: ['34 Falcon Way'], postcode: 'RG12 8DQ' }),
      fact.website('https://example.com/')], { subject: 'office' });
    const result = score({ name: 'Example Property Wokingham', url: 'https://example.com/contact-us/estate-agents-wokingham-branch.html' }, [site, branch, office]);
    assert.equal(result.identity.leaders.length, 1);
    assert.equal(result.fields.place_id.value, PLACE_ID);
  });

  test('a branch page isn\'t an alias of one that adds a place word: Kensington isn\'t South Kensington', () => {
    const south = record('google-places-api', [fact.name('Example South Kensington Estate Agents'), fact.address({ postcode: 'SW7 3RD' }),
      fact.website('https://example.com/contact/example_South_Kensington_estate_agents'), fact.placeId(PLACE_ID)]);
    const result = score({ name: 'Example Kensington', url: 'https://example.com/contact/example_kensington_estate_agents' }, [south]);
    assert.equal(result.identity.confidence, 0);
  });

  test('a query\'s town that a listing\'s name leaves out, in its address, isn\'t a name mismatch', () => {
    const listing = record('google-places-api', [fact.name('Example Poole Estate Agents'), fact.address({ lines: ['12 High Street'], town: 'Nunthorpe', postcode: 'TS7 0AA' }),
      fact.website('https://example.com/our-offices/nunthorpe'), fact.placeId(PLACE_ID)]);
    const result = score({ name: 'Example Poole Nunthorpe', url: 'https://example.com/our-offices/nunthorpe' }, [listing]);
    assert.ok(!result.identity.rules.includes('identity.name-mismatch'));
    const district = record('google-places-api', [fact.name('Example Poole Estate Agents'), fact.address({ lines: ['95 Guisborough Road'], town: 'Middlesbrough',
      postcode: 'TS7 0JS', formatted: '95 Guisborough Rd, Nunthorpe, Middlesbrough TS7 0JS' }), fact.website('https://example.com/'), fact.placeId(PLACE_ID)]);
    const inFormatted = score({ name: 'Example Poole  Nunthorpe', url: 'https://example.com/our-offices/nunthorpe' }, [district]);
    assert.ok(!inFormatted.identity.rules.includes('identity.name-mismatch'), 'a district named only in Google\'s formatted line counts too');
  });

  test('a query\'s town found only in a street\'s name, or after a place qualifier, is a different name', () => {
    const accrington = record('google-places-api', [fact.name('Example Estates - Accrington Branch'), fact.phone(PHONE),
      fact.address({ lines: ['7 Blackburn Road'], town: 'Accrington', postcode: 'BB5 1HF', formatted: '7 Blackburn Rd, Accrington BB5 1HF' }), fact.placeId(PLACE_ID)]);
    const byStreet = score({ name: 'Example Estates Blackburn', address: 'Blackburn' }, [accrington]);
    expectRules(byStreet.identity.rules, ['identity.none']);
    const southKensington = record('google-places-api', [fact.name('Example Estates South Kensington'), fact.phone(PHONE),
      fact.address({ lines: ['1 Example Road'], town: 'London', postcode: 'SW7 3RD', formatted: '1 Example Rd, South Kensington, London SW7 3RD' }), fact.placeId(PLACE_ID)]);
    const byQualifier = score({ name: 'Example Estates Kensington', address: 'Kensington' }, [southKensington]);
    assert.equal(byQualifier.identity.confidence, 0, 'South Kensington isn\'t Kensington');
    const asked = score({ name: 'Example Estates South Kensington', address: 'South Kensington' }, [southKensington]);
    assert.equal(asked.identity.confidence, 60);
  });

  test('an address without a postcode agrees with the same street given with one', () => {
    const site = record('web-fetch', [fact.name('Example Woodworks'), fact.phone(PHONE), fact.address({ lines: ['329 W 18th St, Ste 914'], town: 'Chicago' })]);
    const google = record('google-places-api', [fact.name('Example Woodworks'), fact.phone(PHONE), fact.address({ lines: ['329 West 18th Street'], town: 'Chicago', postcode: '60616' }), fact.placeId(PLACE_ID)]);
    const result = score({ name: 'Example Woodworks' }, [site, google]);
    assert.deepEqual(result.fields.address.conflicts, []);
  });

  test('a site\'s record isn\'t joined to another website\'s place by sharing its building', () => {
    const site = record('web-fetch', [fact.phone(PHONE, 'loose'), fact.address({ postcode: POSTCODE }, 'loose')], { origin: 'site:example.com' });
    const neighbour = record('google-places-api', [fact.name('Rival Mortgages'), fact.address({ lines: ['1 Broad St'], postcode: POSTCODE }),
      fact.website('https://rival.example.org/'), fact.placeId(PLACE_ID)]);
    const result = score({ name: 'Example Mortgages', url: 'https://example.com/' }, [site, neighbour]);
    expectRules(result.identity.rules, ['identity.single-loose']);
    assert.equal(result.fields.phone.value?.e164, PHONE_E164, 'the site\'s own details stand when the neighbour is rejected');
  });

  test('on a home page, the site\'s own postcode that Google\'s listing disagrees with is a conflict, not dropped', () => {
    const site = record('web-fetch', [fact.address({ postcode: 'SW16 3BF' }, 'loose')], { origin: 'site:example.com' });
    const google = record('google-places-api', [fact.name('Example Sales'), fact.address({ lines: ['1 Empire Mews'], postcode: 'SW16 2BF' }),
      fact.website('https://example.com/'), fact.placeId(PLACE_ID)]);
    const result = score({ name: 'Example Sales Training', url: 'https://example.com/' }, [site, google]);
    assert.equal(result.fields.place_id.value, PLACE_ID);
    assert.ok(result.fields.address.conflicts.some((conflict) => (conflict.value as { postcode: string }).postcode === 'SW16 3BF'));
    assert.equal(result.identity.confidence, 60, 'the site\'s record isn\'t counted as agreement');
  });

  test('identity.head-office-only: a branch was asked for, but every source describes the head office', () => {
    const office = record('web-fetch', [fact.name('Example Homes'), fact.phone(PHONE), fact.address({ lines: ['24 Greville Street'], town: 'London', postcode: 'EC1N 8SS' })], { role: 'head-office' });
    const result = score({ name: 'Example Homes Chelmsford', url: 'https://example.com/chelmsford' }, [office]);
    expectRules(result.identity.rules, ['identity.single-structured', 'identity.head-office-only']);
    assert.equal(result.identity.confidence, 30);
    assert.ok(result.identity.warnings.some((warning) => warning.includes('(London)')));
  });

  test('identity.site-brand-only: an inner page gives only the site\'s own brand (a network\'s agent page)', () => {
    const brand = record('web-fetch', [fact.name('Exhomes'), fact.website('https://example.com/')], { scope: 'brand' });
    const result = score({ name: 'Exhomes Jane Smith', url: 'https://example.com/our-agents/jane-smith/' }, [brand]);
    expectRules(result.identity.rules, ['identity.single-structured', 'identity.site-brand-only']);
    assert.equal(result.identity.confidence, 40);
    const home = score({ name: 'Exhomes', url: 'https://example.com/' }, [brand]);
    assert.ok(!home.identity.rules.includes('identity.site-brand-only'), 'on a home page the brand is the business');
  });

  test('a search\'s first result on a listing\'s own branch page is a second origin, but never breaks a tie', () => {
    const listing = (subject: string, postcode: string, page: string, placeId: string): ReturnType<typeof record> => record('google-places-api', [
      fact.name('Example Estates Reading'), fact.address({ lines: ['1 Broad St'], town: 'Reading', postcode }), fact.website(page), fact.placeId(placeId),
    ], { subject });
    const found = (page: string): ReturnType<typeof record> => record('brave-search-api', [fact.website(page, 'loose')], { origin: 'site:example.com', scope: 'brand' });
    const broadStreet = listing('broad', POSTCODE, 'https://example.com/branches/reading/', PLACE_ID);
    const sole = score({ name: 'Example Estates', address: 'Reading' }, [broadStreet, found('https://example.com/branches/reading/')]);
    expectRules(sole.identity.rules, ['identity.independent-agreement']);
    assert.equal(sole.identity.confidence, 100);
    const home = score({ name: 'Example Estates', address: 'Reading' }, [listing('broad', POSTCODE, 'https://example.com/', PLACE_ID), found('https://example.com/')]);
    assert.equal(home.identity.confidence, 60, 'a site\'s home page is every branch\'s, so it confirms none');
    const oxfordRoad = listing('oxford', OTHER_POSTCODE, 'https://example.com/branches/reading-oxford-road/', OTHER_PLACE_ID);
    const tie = score({ name: 'Example Estates', address: 'Reading' }, [broadStreet, oxfordRoad, found('https://example.com/branches/reading/')]);
    expectRules(tie.identity.rules, ['identity.single-structured', 'identity.tie']);
    assert.equal(tie.identity.confidence, 30);
  });

  test('one ZIP code isn\'t one building: branches with different building numbers still tie', () => {
    const market = record('google-places-api', [fact.name('Example Chowder'), fact.address({ lines: ['1530 Post Alley'], postcode: '98101' }), fact.placeId(PLACE_ID)], { subject: 'market' });
    const mall = record('google-places-api', [fact.name('Example Chowder - Pacific Place'), fact.address({ lines: ['600 Pine St'], postcode: '98101' }), fact.placeId(OTHER_PLACE_ID)], { subject: 'mall' });
    const result = score({ name: 'Example Chowder', address: 'Seattle' }, [market, mall]);
    assert.equal(result.identity.leaders.length, 2, 'the exact name doesn\'t win across buildings');
  });

  test('a thin duplicate listing (same name, same building, only a postcode) is co-listed with the full one', () => {
    const full = record('google-places-api', [fact.name('Example Restaurant'), fact.phone(PHONE), fact.address({ lines: ['High St'], postcode: POSTCODE }), fact.placeId(PLACE_ID)], { subject: 'full' });
    const thin = record('google-places-api', [fact.name('Example Restaurant'), fact.address({ lines: [], postcode: POSTCODE }), fact.placeId(OTHER_PLACE_ID)], { subject: 'thin' });
    const result = score({ name: 'Example Restaurant' }, [full, thin]);
    assert.ok(result.identity.rules.includes('identity.co-listed'));
    assert.equal(result.identity.confidence, 60);
  });

  test('one place listed twice (same name and page, neighbouring postcodes, no differing phone) is co-listed', () => {
    const site = record('web-fetch', [fact.name('Example Palace'), fact.phone(PHONE), fact.address({ postcode: 'OX20 1PP' })], { origin: 'site:example-palace.com' });
    const full = record('google-places-api', [fact.name('Example Palace'), fact.phone(PHONE), fact.address({ town: 'Woodstock', postcode: 'OX20 1PS' }),
      fact.website('https://www.example-palace.com/'), fact.placeId(PLACE_ID)], { subject: 'full' });
    const second = record('google-places-api', [fact.name('Example Palace'), fact.address({ town: 'Woodstock', postcode: 'OX20 1PX' }),
      fact.website('http://example-palace.com/'), fact.placeId(OTHER_PLACE_ID)], { subject: 'second' });
    const heritage = record('google-places-api', [fact.name('Example Palace'), fact.address({ town: 'Woodstock' }),
      fact.website('https://heritage.example.org/listing/1000434'), fact.placeId('ChIJexampleHeritage01')], { subject: 'heritage' });
    const result = score({ name: 'Example Palace', address: 'Woodstock' }, [site, full, second, heritage]);
    expectRules(result.identity.rules, ['identity.independent-agreement', 'identity.co-listed']);
    assert.equal(result.identity.confidence, 100);
    assert.equal(result.fields.place_id.value, PLACE_ID, 'the listing the site agrees with is shown');
    assert.ok(result.identity.others.some((other) => other.candidate.records.includes(heritage)), 'the listing on another site is beaten, not tied');
    assert.ok(result.identity.reasons.some((reason) => reason.includes('heritage.example.org')));
  });

  test('a listing page asked about ties the places it links to, and still rejects the pages it doesn\'t link to', () => {
    const brand = record('web-fetch', [fact.name('Example Vets'), fact.website('https://example.com/')], { scope: 'brand' });
    brand.listedPages = ['/practices/north-oxford', '/practices/east-oxford'];
    const place = (subject: string, path: string, placeId: string) => record('google-places-api', [
      fact.name(`Example Vets ${subject}`), fact.address({ town: 'Oxford', postcode: POSTCODE }), fact.website(`https://example.com${path}/`), fact.placeId(placeId)], { subject });
    const result = score({ url: 'https://example.com/practices/area/vets-in-oxford/' }, [brand,
      place('North Oxford', '/practices/north-oxford', PLACE_ID), place('East Oxford', '/practices/east-oxford', OTHER_PLACE_ID),
      place('Wheatley', '/practices/wheatley', 'ChIJexampleWheatley01')]);
    assert.equal(result.identity.leaders.length, 2);
    assert.ok(result.identity.rules.includes('identity.tie'));
    assert.equal(result.identity.rejected.length, 1, 'Wheatley is still a different page');
    assert.ok(result.identity.warnings.some((warning) => warning.includes('lists several places')));
  });

  test('branches with the same name and website but their own phones still tie', () => {
    const first = record('google-places-api', [fact.name('Example Bakery'), fact.phone(PHONE), fact.address({ postcode: 'RG1 1AA' }),
      fact.website('https://example.com/'), fact.placeId(PLACE_ID)], { subject: 'first' });
    const second = record('google-places-api', [fact.name('Example Bakery'), fact.phone(OTHER_PHONE), fact.address({ postcode: 'RG1 1BB' }),
      fact.website('https://example.com/'), fact.placeId(OTHER_PLACE_ID)], { subject: 'second' });
    const result = score({ name: 'Example Bakery', address: 'Reading' }, [first, second]);
    assert.ok(result.identity.rules.includes('identity.tie'));
  });

  test('without the business\'s own site agreeing, a listing on another site isn\'t set aside', () => {
    const own = record('google-places-api', [fact.name('Example Palace'), fact.address({ town: 'Woodstock', postcode: 'OX20 1PS' }), fact.website('https://example-palace.com/'), fact.placeId(PLACE_ID)], { subject: 'own' });
    const heritage = record('google-places-api', [fact.name('Example Palace'), fact.address({ town: 'Woodstock' }), fact.website('https://heritage.example.org/1'), fact.placeId(OTHER_PLACE_ID)], { subject: 'heritage' });
    const result = score({ name: 'Example Palace', address: 'Woodstock' }, [own, heritage]);
    assert.ok(result.identity.rules.includes('identity.tie'));
  });

  test('a home page whose only match is one of its branch pages on Google is the chain, not that branch', () => {
    const brand = record('web-fetch', [fact.name('Example Gyms'), fact.website('https://example.com/')], { scope: 'brand' });
    const leeds = record('google-places-api', [fact.name('Example Gyms Leeds'), fact.website('https://example.com/gyms/leeds/'), fact.placeId(PLACE_ID)]);
    const result = score({ url: 'https://example.com/' }, [brand, leeds]);
    assert.ok(result.identity.rules.includes('identity.chain'));
    assert.equal(result.fields.name.value, 'Example Gyms');
    assert.equal(result.fields.website.value?.url, 'https://example.com/', 'a chain\'s website is the home page asked about');
  });

  test('when the query\'s site redirected to another domain, places on that domain are on the query\'s site', () => {
    const site = record('web-fetch', [fact.name('Example Vets North Oxford'), fact.website('https://example-group.com/practices/north-oxford/')], { origin: 'site:example-group.com' });
    const redirected = { ...site, redirectedFrom: 'example.co.uk' };
    const result = score({ url: 'https://www.example.co.uk/practices/north-oxford/' }, [redirected]);
    assert.ok(result.identity.rules.includes('identity.input-confirmed'), JSON.stringify(result.identity.reasons));
  });

  test('branches at different postcodes still tie when the query can\'t tell them apart', () => {
    const reading = googlePlace(PLACE_ID, 'Example Estates', PHONE, POSTCODE, 'reading');
    const wokingham = googlePlace(OTHER_PLACE_ID, 'Example Estates Wokingham', OTHER_PHONE, OTHER_POSTCODE, 'wokingham');
    const result = score({ name: 'Example Estates', address: 'Berkshire' }, [reading, wokingham]);
    assert.equal(result.identity.leaders.length, 2, 'the exact name only decides within one building');
    assert.match(result.identity.reasons.join(' '), /there may be more/);
  });
});

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

  test('identity.co-listed: tied listings sharing one address and phone are one place, not a tie', () => {
    const sales = record('google-places-api', [fact.name('Example Estates'), fact.phone(PHONE), fact.address({ lines: ['113 Chorley Rd'], postcode: POSTCODE }), fact.placeId(PLACE_ID)], { subject: 'sales' });
    const lettings = record('google-places-api', [fact.name('Example Lettings Ltd'), fact.phone(PHONE), fact.address({ lines: ['113 Chorley Rd'], postcode: POSTCODE }), fact.placeId(OTHER_PLACE_ID)], { subject: 'lettings' });
    const result = score({ name: 'Example', phone: PHONE }, [sales, lettings]);
    assert.equal(result.identity.confidence, 100, 'not divided between the listings');
    expectRules(result.identity.rules, ['identity.input-confirmed', 'identity.co-listed']);
    const site = record('web-fetch', [fact.name('Example Lettings'), fact.website('https://example-lettings.com/')], { scope: 'brand', origin: 'site:example-lettings.com' });
    const withSite = score({ name: 'Example', phone: PHONE }, [sales, lettings, site]);
    assert.equal(withSite.fields.name.value, 'Example Lettings', 'the listing a found site\'s name supports is shown, the site and Google agreeing on its name');
    assert.equal(withSite.fields.website.value?.url, 'https://example-lettings.com/', 'and that site is its website');
  });

  test('identity.chain: a chain\'s home page that matches several of its places is the chain, with the brand\'s fields', () => {
    const brand = record('web-fetch', [fact.name('Example Estates'), fact.website('https://example.com/')], { scope: 'brand' });
    const reading = record('google-places-api', [fact.name('Example Estates Reading'), fact.address({ lines: ['1 Broad St'], postcode: POSTCODE }), fact.website('https://example.com/reading/'), fact.placeId(PLACE_ID)], { subject: 'reading' });
    const wokingham = record('google-places-api', [fact.name('Example Estates Wokingham'), fact.address({ lines: ['2 Market Pl'], postcode: OTHER_POSTCODE }), fact.website('https://example.com/wokingham/'), fact.placeId(OTHER_PLACE_ID)], { subject: 'wokingham' });
    const result = score({ url: 'https://example.com/' }, [brand, reading, wokingham]);
    expectRules(result.identity.rules, ['identity.single-structured', 'identity.tie', 'identity.chain']);
    assert.equal(result.fields.name.value, 'Example Estates', 'the brand\'s name, not a branch\'s');
    assert.equal(result.fields.website.value?.url, 'https://example.com/');
    assert.equal(result.fields.address.value, null, 'no one place\'s address stands for the chain');
    assert.ok(result.fields.name.confidence > result.identity.confidence, 'brand fields keep the brand\'s confidence');
  });

  test('a branch page isn\'t contradicted by an alias URL for it, but a clearly different page is', () => {
    const google = record('google-places-api', [fact.name('Example Books'), fact.website('https://example.com/shops/reading-broad-street'), fact.placeId(PLACE_ID)]);
    const alias = score({ url: 'https://example.com/shops/reading' }, [google]);
    assert.equal(alias.identity.confidence, 60, 'the site is confirmed; the page is neither confirmed nor contradicted');
    const wordsWithin = score({ url: 'https://example.com/shops/example-books-reading-broad-street' }, [
      record('google-places-api', [fact.name('Example Books'), fact.website('https://example.com/shops/reading'), fact.placeId(PLACE_ID)]),
    ]);
    assert.equal(wordsWithin.identity.confidence, 60, 'every word of /reading is in the other segment: an alias, not a contradiction');
    const elsewhere = score({ url: 'https://example.com/shops/wokingham' }, [google]);
    assert.equal(elsewhere.identity.confidence, 0);
    const siteRead = record('web-fetch', [fact.name('Example Books')], { scope: 'brand' });
    const read = score({ url: 'https://example.com/shops/reading' }, [google, siteRead]);
    assert.equal(read.identity.rejected.length, 0, 'read or not, an alias URL (an old scheme, a longer slug) is no contradiction');
  });

  test('identity.head-office: a chain\'s home page with no location is the head office', () => {
    const headOffice = record('web-fetch', [fact.name('Example Estates'), fact.phone(PHONE)], { role: 'head-office' });
    const result = score({ url: 'https://example.com/' }, [headOffice]);
    expectRules(result.identity.rules, ['identity.single-structured', 'identity.head-office']);
    assert.equal(result.warnings.length, 1);
  });
});

describe('field rules', () => {
  test('between names that contradict each other, with equal backing, the one the query agrees with wins', () => {
    const site = record('web-fetch', [fact.name('Example Estate & Lettings Agents in England and Wales'), fact.address({ postcode: POSTCODE }, 'loose')]);
    const office = record('google-places-api', [fact.name('Example Property Centre Tendring'), fact.address({ postcode: POSTCODE }), fact.placeId(PLACE_ID)]);
    const result = score({ name: 'Example Property Centre - Tendring', url: 'https://example.com/offices/property-centre-tendring' }, [site, office]);
    assert.equal(result.fields.name.value, 'Example Property Centre Tendring');
  });

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
