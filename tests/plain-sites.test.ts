import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { runLookup } from '../src/lookup/engine.js';
import type { QueryInput } from '../src/lookup/query.js';
import { buildResult, type LookupResult } from '../src/lookup/result.js';
import { collapseRepeatedPhrase, decodeEntities } from '../src/normalise/text.js';
import { normaliseUrl } from '../src/normalise/url.js';
import { builtInProviders } from '../src/providers/registry.js';
import { fixtureTransport, type FixtureResponse, type FixtureTransport } from './helpers/fixture-transport.js';
import { makeQuery, testConfig } from './helpers/records.js';
import { quietLogger } from './helpers/stub-providers.js';

/** Sites with no schema.org location markup: only tel: links and text, like many chains' sites. */
const ROBOTS = { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } };
const BRANCH_PHONES = ['01282 469023', '01706 396140', '01254 389384', '0161 751 0340'];
const FOOTER = `<footer>${BRANCH_PHONES.map((phone) => `<a href="tel:${phone}">${phone}</a>`).join(' ')} Registered office BB5 1HF</footer>`;

/** An HTML page with a title, a body and some extra head markup. */
function page(title: string, body: string, head = ''): FixtureResponse {
  return { body: `<html><head><title>${title}</title>${head}</head><body>${body}</body></html>` };
}

/** Runs a web-fetch-only lookup against fixtures. */
async function find(input: QueryInput, routes: Record<string, FixtureResponse>): Promise<{ result: LookupResult; transport: FixtureTransport }> {
  const transport = fixtureTransport(routes);
  const config = testConfig();
  const outcome = await runLookup({ query: makeQuery(input), providers: builtInProviders(config), config, logger: quietLogger, transport, isDownloadSkipped: true });
  return { result: buildResult(outcome, { isExplain: false }), transport };
}

describe('web-fetch on sites without location markup', () => {
  test('a page that lists every branch\'s number is a listing: no number is taken as this business\'s', async () => {
    const { result } = await find({ url: 'https://example.com/' }, {
      'https://example.com/robots.txt': ROBOTS,
      'https://example.com/': page('Example Estates', `<h1>Example Estates</h1>${FOOTER}`),
    });
    assert.equal(result.fields.phone.value, null);
    assert.equal(result.fields.address.value, null);
    assert.ok(result.warnings.some((warning) => warning.includes('lists 4 phone number(s) and 1 postcode(s)')));
    assert.ok(result.identity.confidence < 100);
  });

  test('a branch page\'s own number is used, even when the site\'s other pages list every branch', async () => {
    const { result } = await find({ url: 'https://example.com/branches/burnley/' }, {
      'https://example.com/robots.txt': ROBOTS,
      'https://example.com/branches/burnley/': page('Burnley | Example Estates', '<h1>Burnley</h1><a href="tel:01282 469023">Call Burnley</a> <a href="/contact/">Contact</a>'),
      'https://example.com/contact/': page('Contact', `<h1>Contact us</h1>${FOOTER}`),
      'https://example.com/': page('Example Estates', FOOTER),
    });
    assert.equal(result.fields.phone.value, '+441282469023');
    assert.deepEqual(result.fields.phone.conflicts, [], 'the other branches\' numbers stay out');
  });

  test('a small business\'s number on its contact page still counts when the home page has none', async () => {
    const { result } = await find({ url: 'https://example.com/' }, {
      'https://example.com/robots.txt': ROBOTS,
      'https://example.com/': page('Example Plumbing', '<h1>Example Plumbing</h1><a href="/contact/">Contact</a>'),
      'https://example.com/contact/': page('Contact', '<a href="tel:0118 496 0123">0118 496 0123</a> Reading RG1 1AA'),
    });
    assert.equal(result.fields.phone.value, '+441184960123');
  });

  test('only pages on the start page\'s own host are read, never another subdomain', async () => {
    const { transport } = await find({ url: 'https://www.example.com/' }, {
      'https://www.example.com/robots.txt': ROBOTS,
      'https://www.example.com/': page('Example', '<a href="https://staging5.example.com/our-branches/">Branches</a> <a href="https://example.com/contact/">Contact</a>'),
      'https://example.com/contact/': page('Contact', '<a href="tel:0118 496 0123">Call</a>'),
    });
    assert.ok(!transport.requests.some((request) => request.includes('staging5')));
    assert.ok(transport.requests.includes('GET https://example.com/contact/'), 'www. and the bare host are the same host');
  });

  test('robots.txt that redirects to another host is followed, and the site it leads to is read', async () => {
    const { result } = await find({ url: 'https://example.co.uk/' }, {
      'https://example.co.uk/robots.txt': { status: 301, headers: { location: 'https://example-group.com/robots.txt' } },
      'https://example-group.com/robots.txt': ROBOTS,
      'https://example.co.uk/': { status: 301, headers: { location: 'https://example-group.com/' } },
      'https://example-group.com/': page('Example Group', '<a href="tel:0118 496 0123">Call</a> <a href="/cdn-cgi/l/email-protection">email</a>'),
    });
    assert.equal(result.providers.find((provider) => provider.name === 'web-fetch')?.status, 'ok');
    assert.equal(result.fields.phone.value, '+441184960123');
    assert.ok(result.warnings.some((warning) => warning.includes('redirected to example-group.com')));
  });

  test('a branch named only by its town takes the brand\'s name; a postcode in the street line isn\'t repeated', async () => {
    const markup = JSON.stringify([
      { '@context': 'https://schema.org', '@type': 'Organization', name: 'Example Gardens', address: { '@type': 'PostalAddress', streetAddress: '1 Head St', postalCode: 'IP12 4AF' } },
      { '@context': 'https://schema.org', '@type': 'GardenStore', name: 'Oxford', telephone: '01865 343454',
        address: { '@type': 'PostalAddress', streetAddress: 'Nuneham Courtenay, Oxford, OX44 9PY', postalCode: 'OX44 9PY' } },
    ]);
    const { result, transport } = await find({ url: 'https://example.com/centres/oxford' }, {
      'https://example.com/robots.txt': ROBOTS,
      'https://example.com/centres/oxford': page('Oxford', '<a href="/cdn-cgi/l/email-protection">email</a>', `<script type="application/ld+json">${markup}</script>`),
    });
    assert.equal(result.fields.name.value, 'Example Gardens Oxford');
    assert.equal((result.fields.address.value as { formatted: string }).formatted, 'Nuneham Courtenay, Oxford, OX44 9PY');
    assert.ok(!transport.requests.some((request) => request.includes('/cdn-cgi/')), 'Cloudflare\'s own links are never read');
  });

  test('a home page\'s title that spells the domain names the brand; an inner page\'s title doesn\'t', async () => {
    const home = await find({ url: 'https://www.example-gym.com/' }, {
      'https://www.example-gym.com/robots.txt': ROBOTS,
      'https://www.example-gym.com/': page('Cheap Gym Memberships | No Contract | ExampleGym', '<a href="tel:0113 496 0000">Call us</a>'),
    });
    assert.equal(home.result.fields.name.value, 'ExampleGym');
    const inner = await find({ url: 'https://www.example-gym.com/about/' }, {
      'https://www.example-gym.com/robots.txt': ROBOTS,
      'https://www.example-gym.com/about/': page('About us | ExampleGym', '<a href="tel:0113 496 0000">Call us</a>'),
      'https://www.example-gym.com/': page('Cheap Gym Memberships | ExampleGym', ''),
    });
    assert.equal(inner.result.fields.name.value, null);
  });

  test('an Organization read from another page, when an inner page was asked for, is the head office', async () => {
    const organisation = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Organization', name: 'Example Vets', telephone: '01923 470000',
      address: { '@type': 'PostalAddress', streetAddress: '38 Clarendon Road', addressLocality: 'Watford', postalCode: 'WD17 1HZ' } });
    const { result } = await find({ url: 'https://example.com/practices/area/vets-in-oxford/' }, {
      'https://example.com/robots.txt': ROBOTS,
      'https://example.com/practices/area/vets-in-oxford/': page('Vets in Oxford', '<a href="/practices/north-oxford/">North Oxford</a> <a href="/practices/east-oxford/">East Oxford</a>'),
      'https://example.com/': page('Example Vets', '', `<script type="application/ld+json">${organisation}</script>`),
    });
    assert.equal(result.fields.phone.value, '+441923470000');
    assert.ok(result.fields.phone.rules.includes('field.head-office'));
  });

  test('relative links resolve against <base href>, as a browser resolves them', async () => {
    const { transport } = await find({ url: 'https://example.com/contact/solicitors-wokingham' }, {
      'https://example.com/robots.txt': ROBOTS,
      'https://example.com/contact/solicitors-wokingham': page('Wokingham', '<a href="contact/">Contact</a> <a href="tel:0118 978 1234">Call</a>', '<base href="/">'),
      'https://example.com/contact/': page('Contact', ''),
    });
    assert.ok(transport.requests.includes('GET https://example.com/contact/'));
    assert.ok(!transport.requests.some((request) => request.includes('/contact/contact/')));
  });
});

describe('schema.org organisations that aren\'t the business', () => {
  test('departments and parent companies written inline are other organisations, not names for this one', async () => {
    const markup = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'RealEstateAgent', name: 'Example Estates Reading', telephone: '0118 496 0000',
      address: { '@type': 'PostalAddress', streetAddress: '1 Broad Street', addressLocality: 'Reading', postalCode: 'RG1 1AA' },
      department: [{ '@type': 'Organization', name: 'Sales' }, { '@type': 'Organization', name: 'Lettings' }],
      parentOrganization: { '@type': 'Corporation', name: 'Example Holdings PLC' },
    });
    const { result } = await find({ url: 'https://example.com/reading/' }, {
      'https://example.com/robots.txt': ROBOTS,
      'https://example.com/reading/': page('Reading', '', `<script type="application/ld+json">${markup}</script>`),
    });
    assert.equal(result.fields.name.value, 'Example Estates Reading');
    assert.deepEqual(result.fields.name.conflicts, [], 'no Sales, Lettings or Example Holdings PLC');
  });
});

describe('cleaning values', () => {
  test('HTML character references in text are decoded', () => {
    assert.equal(decodeEntities('Hunters Estate Agents &amp; Letting Agents'), 'Hunters Estate Agents & Letting Agents');
    assert.equal(decodeEntities('Caf&#233; &#x2013; &rsquo;'), 'Café – ’');
    assert.equal(decodeEntities('AT&T &unknown; &#0;'), 'AT&T &unknown; &#0;', 'anything else is left as written');
  });

  test('a phrase repeated straight after itself in a name is collapsed', () => {
    assert.equal(collapseRepeatedPhrase('Dexters Brentford Estate Agents Estate Agents'), 'Dexters Brentford Estate Agents');
    assert.equal(collapseRepeatedPhrase('Bang Bang'), 'Bang');
    assert.equal(collapseRepeatedPhrase('Estate Agents & Letting Agents'), 'Estate Agents & Letting Agents', 'a repeated word that isn\'t adjacent stays');
  });

  test('tracking parameters are removed from URLs; other parameters stay', () => {
    assert.equal(normaliseUrl('https://example.com/reading/?utm_source=gmb&utm_medium=organic')?.url, 'https://example.com/reading/');
    assert.equal(normaliseUrl('https://example.com/?branch=12&gclid=abc&fbclid=def')?.url, 'https://example.com/?branch=12');
  });
});
