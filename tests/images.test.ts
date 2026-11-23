import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { providerCache } from '../src/cache/store.js';
import { imageDimensions } from '../src/images/dimensions.js';
import { sniffImage } from '../src/images/sniff.js';
import { ImageError, rasteriseSvg } from '../src/images/svg.js';
import { runLookup } from '../src/lookup/engine.js';
import { buildResult } from '../src/lookup/result.js';
import { builtInProviders } from '../src/providers/registry.js';
import { fixtureTransport, type FixtureResponse } from './helpers/fixture-transport.js';
import { makeQuery, temporaryCacheDir, testConfig } from './helpers/records.js';
import { quietLogger } from './helpers/stub-providers.js';

/** An SVG of a given size. */
function svg(width: number, height: number): Buffer {
  return Buffer.from(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#036"/></svg>`);
}
const PNG_400_BY_120 = rasteriseSvg(svg(400, 120)).png;
/** A GIF header for 32 by 16 pixels. */
const GIF_32_BY_16 = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([32, 0, 16, 0, 0, 0, 0])]);
/** A JPEG header: SOI, an APP0 segment, then a baseline SOF0 for 640 by 480. */
const JPEG_640_BY_480 = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00,
]);
/** A WebP VP8X header for 1200 by 630. */
const WEBP_1200_BY_630 = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8X'), Buffer.alloc(4), Buffer.alloc(4),
  Buffer.from([0xaf, 0x04, 0x00, 0x75, 0x02, 0x00]),
]);
/** An ICO with a 16px and a 256px (stored as 0) image. */
const ICO_16_AND_256 = Buffer.concat([
  Buffer.from([0, 0, 1, 0, 2, 0]),
  Buffer.from([16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  Buffer.from([0, 0, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
]);

describe('images', () => {
  test('are identified by their first bytes, not by what the server says they are', () => {
    assert.equal(sniffImage(PNG_400_BY_120), 'png');
    assert.equal(sniffImage(JPEG_640_BY_480), 'jpeg');
    assert.equal(sniffImage(GIF_32_BY_16), 'gif');
    assert.equal(sniffImage(WEBP_1200_BY_630), 'webp');
    assert.equal(sniffImage(ICO_16_AND_256), 'ico');
    assert.equal(sniffImage(svg(10, 10)), 'svg');
    assert.equal(sniffImage(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')])), 'svg');
    assert.equal(sniffImage(Buffer.from('<!doctype html><html><body>Not found</body></html>')), null);
  });

  test('are measured from their headers, without decoding', () => {
    assert.deepEqual(imageDimensions(PNG_400_BY_120, 'png'), { width: 400, height: 120 });
    assert.deepEqual(imageDimensions(GIF_32_BY_16, 'gif'), { width: 32, height: 16 });
    assert.deepEqual(imageDimensions(JPEG_640_BY_480, 'jpeg'), { width: 640, height: 480 });
    assert.deepEqual(imageDimensions(WEBP_1200_BY_630, 'webp'), { width: 1200, height: 630 });
    assert.deepEqual(imageDimensions(ICO_16_AND_256, 'ico'), { width: 256, height: 256 }, 'the largest entry; 0 means 256');
  });

  test('an SVG renders to PNG at its own size, scaled down so its longest side is at most 1200 px', () => {
    assert.deepEqual([rasteriseSvg(svg(400, 120)).width, rasteriseSvg(svg(400, 120)).height], [400, 120]);
    const large = rasteriseSvg(svg(2400, 600));
    assert.deepEqual([large.width, large.height], [1200, 300]);
    assert.equal(sniffImage(large.png), 'png');
  });

  test('an SVG that doesn\'t render, or is too big, is an ImageError', () => {
    assert.throws(() => rasteriseSvg(Buffer.from('<svg><unclosed')), ImageError);
    assert.throws(() => rasteriseSvg(Buffer.alloc(2 * 1024 * 1024, 0x20)), ImageError);
  });
});

describe('response cache', () => {
  test('returns an entry until it expires, and keeps nothing with a TTL of 0', () => {
    let now = 1_000_000;
    const warnings: string[] = [];
    const cache = providerCache('web-fetch', { directory: temporaryCacheDir(), clock: { now: () => now }, logger: quietLogger, warn: (message) => warnings.push(message) });
    cache.set('html', 'https://example.com/', { status: 200 }, 60);
    cache.set('html', 'https://example.com/never', { status: 200 }, 0);
    assert.deepEqual(cache.get('html', 'https://example.com/'), { status: 200 });
    assert.equal(cache.get('html', 'https://example.com/never'), undefined);
    now += 61_000;
    assert.equal(cache.get('html', 'https://example.com/'), undefined);
    assert.deepEqual(warnings, []);
  });

  test('a corrupt entry is discarded, logged and recorded as a warning, and treated as a miss', () => {
    const directory = temporaryCacheDir();
    const warnings: string[] = [];
    const cache = providerCache('web-fetch', { directory, clock: { now: () => 0 }, logger: quietLogger, warn: (message) => warnings.push(message) });
    cache.set('html', 'key', { status: 200 }, 60);
    const responses = path.join(directory, 'responses', 'web-fetch');
    const shard = readdirFirst(responses);
    const entry = path.join(responses, shard, readdirFirst(path.join(responses, shard)));
    writeFileSync(entry, '{ not json');
    assert.equal(cache.get('html', 'key'), undefined);
    assert.equal(existsSync(entry), false);
    assert.deepEqual(warnings, ['A corrupt web-fetch cache entry was discarded.']);
  });
});

/** The first entry in a directory. */
function readdirFirst(directory: string): string {
  const [first] = readdirSync(directory);
  assert.ok(first !== undefined);
  return first;
}

const SITE: Record<string, FixtureResponse> = {
  'https://example.com/robots.txt': { body: 'User-agent: *\nAllow: /\n', headers: { 'content-type': 'text/plain' } },
  'https://example.com/branches/reading/': { file: 'web-fetch/branch-page/reading.html' },
  'https://example.com/': { file: 'web-fetch/branch-page/home.html' },
  'https://example.com/contact/': { file: 'web-fetch/branch-page/contact.html' },
  'https://example.com/branches/': { file: 'web-fetch/chain/branches.html' },
  'https://example.com/img/logo.svg': { bytes: svg(400, 120), headers: { 'content-type': 'image/svg+xml' } },
  'https://example.com/img/share.jpg': { bytes: JPEG_640_BY_480, headers: { 'content-type': 'image/jpeg' } },
};

/** Runs a branch-page lookup with the given routes and cache directory. */
async function lookupLogo(routes: Record<string, FixtureResponse>, cacheDir: string, options: { isDownloadSkipped?: boolean; isCacheBypassed?: boolean } = {}) {
  const transport = fixtureTransport(routes);
  const config = testConfig({ fileText: `cache_dir = ${JSON.stringify(cacheDir)}\n` });
  const outcome = await runLookup({
    query: makeQuery({ url: 'https://example.com/branches/reading/' }), providers: builtInProviders(config), config, logger: quietLogger, transport, ...options,
  });
  return { result: buildResult(outcome, { isExplain: false }), transport };
}

describe('logos', () => {
  test('the best logo is downloaded, an SVG converted to PNG, and stored in the logo cache', async () => {
    const cacheDir = temporaryCacheDir();
    const { result, transport } = await lookupLogo(SITE, cacheDir);
    const logo = result.fields.logo.value as { source_url: string; path: string; mime: string; width: number; height: number; converted_from: string };
    assert.equal(logo.source_url, 'https://example.com/img/logo.svg');
    assert.equal(logo.mime, 'image/png');
    assert.equal(logo.converted_from, 'svg');
    assert.deepEqual([logo.width, logo.height], [400, 120]);
    assert.ok(logo.path.startsWith(path.join(cacheDir, 'logos', 'example.com', 'logo-')) && logo.path.endsWith('.png'));
    assert.equal(sniffImage(readFileSync(logo.path)), 'png');
    assert.ok(transport.requests.includes('GET https://example.com/img/logo.svg'));
  });

  test('a second lookup reuses the cached pages and logo, making no requests', async () => {
    const cacheDir = temporaryCacheDir();
    await lookupLogo(SITE, cacheDir);
    const { result, transport } = await lookupLogo(SITE, cacheDir);
    assert.deepEqual(transport.requests, []);
    const webFetch = result.providers.find((provider) => provider.name === 'web-fetch');
    assert.equal(webFetch?.calls, 0);
    assert.equal(webFetch?.cached_calls, 5);
    assert.ok((result.fields.logo.value as { path: string }).path.endsWith('.png'));
  });

  test('--no-cache reads nothing from the caches', async () => {
    const cacheDir = temporaryCacheDir();
    await lookupLogo(SITE, cacheDir);
    const { transport } = await lookupLogo(SITE, cacheDir, { isCacheBypassed: true });
    assert.ok(transport.requests.includes('GET https://example.com/branches/reading/'));
    assert.ok(transport.requests.includes('GET https://example.com/img/logo.svg'));
  });

  test('a logo that fails falls back to the next best, trying each URL once, three at most', async () => {
    const routes = { ...SITE, 'https://example.com/img/logo.svg': { body: '<html>Not found</html>' } };
    const { result, transport } = await lookupLogo(routes, temporaryCacheDir());
    const logo = result.fields.logo.value as { source_url: string; mime: string };
    assert.deepEqual(transport.requests.filter((request) => /\/img\/|icon/.test(request)), [
      'GET https://example.com/img/logo.svg',
      'GET https://example.com/apple-touch-icon.png',
      'GET https://example.com/img/share.jpg',
    ], 'the schema.org logo (found on two pages) once, the apple-touch-icon (404), then og:image');
    assert.equal(logo.source_url, 'https://example.com/img/share.jpg');
    assert.equal(logo.mime, 'image/jpeg');
    assert.equal(result.fields.logo.confidence, 40);
  });

  test('--no-download reports the logo URL with no path, and fetches no image', async () => {
    const { result, transport } = await lookupLogo(SITE, temporaryCacheDir(), { isDownloadSkipped: true });
    const logo = result.fields.logo.value as { source_url: string; path: string | null };
    assert.equal(logo.source_url, 'https://example.com/img/logo.svg');
    assert.equal(logo.path, null);
    assert.ok(!transport.requests.some((request) => request.includes('/img/')));
  });
});
