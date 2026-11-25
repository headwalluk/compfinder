import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { CallBudget, CallMeter } from '../src/lookup/budget.js';
import { guardedLookup, isAddressAllowed, BLOCKED_ADDRESS_CODE } from '../src/net/address-guard.js';
import { decodeBody } from '../src/net/charset.js';
import { createHttpClient, HttpError, type HttpClient } from '../src/net/http-client.js';
import { redact } from '../src/net/redact.js';
import { isPathAllowed, parseRobots } from '../src/net/robots.js';
import { LIVE_TRANSPORT } from '../src/net/transport.js';
import type { ProviderCache } from '../src/cache/store.js';
import { fixtureTransport } from './helpers/fixture-transport.js';
import { httpFailureCause } from '../src/providers/api-errors.js';

const COMPRESSION_BOMB_BYTES = 3 * 1024 * 1024;
const SHORT_TIMEOUT_MS = 200;
/** How long the test server waits before resetting a connection it has started answering. */
const RESET_DELAY_MS = 50;

/** Routes for the local test server. */
const ROUTES: Record<string, (request: IncomingMessage, response: ServerResponse) => void> = {
  '/page': (unusedRequest, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<p>Hello</p>');
  },
  '/redirect': (unusedRequest, response) => {
    response.writeHead(302, { location: '/page' });
    response.end();
  },
  '/loop': (unusedRequest, response) => {
    response.writeHead(301, { location: '/loop' });
    response.end();
  },
  '/elsewhere': (unusedRequest, response) => {
    response.writeHead(302, { location: 'https://example.org/' });
    response.end();
  },
  '/gzip': (unusedRequest, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    response.end(gzipSync('<p>Compressed</p>'));
  },
  '/bomb': (unusedRequest, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    response.end(gzipSync(Buffer.alloc(COMPRESSION_BOMB_BYTES)));
  },
  '/user-agent': (request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(request.headers['user-agent'] ?? '');
  },
  '/silent': () => {
    // Never answers, to test the timeout.
  },
  '/reset-mid-body': (request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.write('<p>Half a page');
    setTimeout(() => request.socket.destroy(), RESET_DELAY_MS);
  },
  '/reset-mid-gzip': (request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    response.write(gzipSync(Buffer.alloc(COMPRESSION_BOMB_BYTES)).subarray(0, 1024));
    setTimeout(() => request.socket.destroy(), RESET_DELAY_MS);
  },
  '/redirect-then-reset': (request, response) => {
    // A redirect whose body never ends, then a reset: the redirect's unread body must not crash the process.
    response.writeHead(302, { location: '/page', 'content-type': 'text/html' });
    response.write('<p>Moved');
    setTimeout(() => request.socket.destroy(), RESET_DELAY_MS);
  },
};

let server: Server;
let baseUrl: string;

/** A client for the local server: private addresses allowed, a fresh meter. */
function client(meter = new CallMeter(false, []), requestTimeoutMs = 5000): HttpClient {
  return createHttpClient({
    transport: LIVE_TRANSPORT,
    userAgent: 'compfinder-test/0.0.0',
    requestTimeoutMs,
    allowPrivateAddresses: true,
    meter,
    signal: new AbortController().signal,
  });
}

/** How many connections the test server has open. */
function connectionCount(): Promise<number> {
  return new Promise((resolve, reject) => server.getConnections((error, count) => (error === null ? resolve(count) : reject(error))));
}

/** Asserts that a promise rejects with an HttpError of the given kind. */
async function rejectsWith(promise: Promise<unknown>, failure: HttpError['failure']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof HttpError && error.failure === failure);
}

before(async () => {
  server = createServer((request, response) => {
    const handler = ROUTES[request.url ?? ''];
    if (handler === undefined) {
      response.writeHead(404);
      response.end();
    } else {
      handler(request, response);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe('address guard', () => {
  test('refuses private, loopback, link-local, documentation and reserved addresses, and allows public ones', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.10', '::1', 'fe80::1', 'fd00::1', '2001:db8::1']) {
      assert.equal(isAddressAllowed(address), false, address);
    }
    for (const address of ['93.184.215.14', '8.8.8.8', '2606:4700:4700::1111']) {
      assert.equal(isAddressAllowed(address), true, address);
    }
  });

  test('checks the IPv4 address inside an IPv4-mapped or NAT64 IPv6 address', () => {
    assert.equal(isAddressAllowed('::ffff:127.0.0.1'), false);
    assert.equal(isAddressAllowed('::ffff:8.8.8.8'), true);
    assert.equal(isAddressAllowed('64:ff9b::a00:1'), false, '64:ff9b::10.0.0.1');
  });

  test('an embedded IPv4 address is found however the IPv6 address is spelt; prefixes it can\'t read are refused', () => {
    for (const address of ['64:ff9b::10.0.0.1', '64:ff9b:0:0:0:0:a00:1', '64:ff9b:0000::0a00:0001', '::ffff:a00:1', '2002:a00:1::1', '::10.0.0.1', '64:ff9b:1::808:808', 'fe80::1%eth0', '1::2::3']) {
      assert.equal(isAddressAllowed(address), false, address);
    }
    for (const address of ['64:ff9b::8.8.8.8', '64:ff9b:0:0:0:0:808:808', '2002:808:808::1', '2606:4700:4700:0:0:0:0:1111']) {
      assert.equal(isAddressAllowed(address), true, address);
    }
  });

  test('refuses a host name that resolves to a private address, at lookup time', async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      guardedLookup('localhost', {}, (lookupError) => resolve(lookupError));
    });
    assert.equal(error?.code, BLOCKED_ADDRESS_CODE);
  });
});

describe('HTTP client', () => {
  test('follows redirects, counting each request', async () => {
    const meter = new CallMeter(false, []);
    const response = await client(meter).request({ url: `${baseUrl}/redirect`, kind: 'html' });
    assert.equal(response.status, 200);
    assert.equal(response.url, `${baseUrl}/page`);
    assert.equal(response.body.toString(), '<p>Hello</p>');
    assert.equal(meter.calls, 2);
  });

  test('stops a redirect loop after five redirects', async () => {
    await rejectsWith(client().request({ url: `${baseUrl}/loop`, kind: 'html' }), 'too_many_redirects');
  });

  test('refuses a redirect the caller doesn\'t allow, such as one off the site', async () => {
    const sameHost = (from: URL, to: URL): boolean => from.host === to.host;
    await rejectsWith(client().request({ url: `${baseUrl}/elsewhere`, kind: 'html', canFollowRedirect: sameHost }), 'redirect_refused');
  });

  test('a request carrying its own headers (an API key) never follows a redirect to another origin', async () => {
    const credentialed = { [`x-api-key`]: 'secret-value' };
    await rejectsWith(client().request({ url: `${baseUrl}/elsewhere`, kind: 'json', headers: credentialed, canFollowRedirect: () => true }), 'redirect_refused');
    const sameOrigin = await client().request({ url: `${baseUrl}/redirect`, kind: 'html', headers: credentialed });
    assert.equal(sameOrigin.status, 200, 'a redirect on the same origin is still followed');
  });

  test('decompresses gzip, and cuts off a compression bomb at the byte cap', async () => {
    const response = await client().request({ url: `${baseUrl}/gzip`, kind: 'html' });
    assert.equal(response.body.toString(), '<p>Compressed</p>');
    await rejectsWith(client().request({ url: `${baseUrl}/bomb`, kind: 'html' }), 'too_large');
  });

  test('sends the configured User-Agent', async () => {
    const response = await client().request({ url: `${baseUrl}/user-agent`, kind: 'robots' });
    assert.equal(response.body.toString(), 'compfinder-test/0.0.0');
  });

  test('times out a server that never answers', async () => {
    await rejectsWith(client(new CallMeter(false, []), SHORT_TIMEOUT_MS).request({ url: `${baseUrl}/silent`, kind: 'html' }), 'timeout');
  });

  test('refuses literal private addresses and odd ports unless private addresses are allowed', async () => {
    const guarded = createHttpClient({
      transport: LIVE_TRANSPORT, userAgent: 'test', requestTimeoutMs: 1000, allowPrivateAddresses: false,
      meter: new CallMeter(false, []), signal: new AbortController().signal,
    });
    await rejectsWith(guarded.request({ url: 'http://127.0.0.1/', kind: 'html' }), 'refused_address');
    await rejectsWith(guarded.request({ url: 'http://[::1]/', kind: 'html' }), 'refused_address');
    await rejectsWith(guarded.request({ url: 'http://example.com:8080/', kind: 'html' }), 'refused_url');
    await rejectsWith(guarded.request({ url: 'file:///etc/passwd', kind: 'html' }), 'refused_url');
  });

  test('a host name that resolves to a private address is refused at connect time, as refused_address', async () => {
    const guarded = createHttpClient({
      transport: LIVE_TRANSPORT, userAgent: 'test', requestTimeoutMs: 1000, allowPrivateAddresses: false,
      meter: new CallMeter(false, []), signal: new AbortController().signal,
    });
    await rejectsWith(guarded.request({ url: 'http://localhost/', kind: 'html' }), 'refused_address');
  });

  test('a connection reset part-way through a body is a network failure with cause connection_reset, not a crash', async () => {
    const failure = await client().request({ url: `${baseUrl}/reset-mid-body`, kind: 'html' }).then(() => null, (error: unknown) => error);
    assert.ok(failure instanceof HttpError && failure.failure === 'network', String(failure));
    assert.equal(httpFailureCause(failure), 'connection_reset');
    const compressed = await client().request({ url: `${baseUrl}/reset-mid-gzip`, kind: 'html' }).then(() => null, (error: unknown) => error);
    assert.ok(compressed instanceof HttpError && compressed.failure === 'network', `a compressed body too: ${String(compressed)}`);
  });

  test('a reset on a redirect\'s unread body, after the redirect is followed, doesn\'t crash the process', async () => {
    const before = await connectionCount();
    const response = await client().request({ url: `${baseUrl}/redirect-then-reset`, kind: 'html' });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(await connectionCount() <= before, 'the redirect\'s connection is closed, not left open until the server gives up');
    // The reset lands after the request has returned: an unhandled 'error' event would surface here as a failure.
    await new Promise((resolve) => setTimeout(resolve, RESET_DELAY_MS * 4));
  });

  test('a metered client stops when the budget is used up', async () => {
    const meter = new CallMeter(true, [new CallBudget(1)]);
    await client(meter).request({ url: `${baseUrl}/page`, kind: 'html' });
    await assert.rejects(client(meter).request({ url: `${baseUrl}/page`, kind: 'html' }), { name: 'BudgetExhaustedError' });
  });
});

describe('HTTP client and the response cache', () => {
  /** An in-memory cache, to see what the client stores and replays. */
  const memoryCache = (): ProviderCache & { entries: Map<string, unknown> } => {
    const entries = new Map<string, unknown>();
    return { entries, get: (kind, key) => entries.get(`${kind} ${key}`), set: (kind, key, data) => { entries.set(`${kind} ${key}`, data); } };
  };
  const cachedClient = (cache: ProviderCache, transport: ReturnType<typeof fixtureTransport>, allowPrivateAddresses = false): HttpClient => createHttpClient({
    transport, userAgent: 'test', requestTimeoutMs: 1000, allowPrivateAddresses, meter: new CallMeter(false, []), signal: new AbortController().signal, cache,
  });

  test('a cached redirect is checked against the current request\'s policy before it is used', async () => {
    const transport = fixtureTransport({
      'https://old.example.com/': { status: 301, headers: { location: 'https://new.example.org/' } },
      'https://new.example.org/': { body: '<p>Moved</p>' },
    });
    const cache = memoryCache();
    const anywhere = await cachedClient(cache, transport).request({ url: 'https://old.example.com/', kind: 'html', cacheTtlSeconds: 60, canFollowRedirect: () => true });
    assert.equal(anywhere.url, 'https://new.example.org/');
    const sent = transport.requests.length;
    const onSite = (from: URL, to: URL): boolean => from.hostname === to.hostname;
    await rejectsWith(cachedClient(cache, transport).request({ url: 'https://old.example.com/', kind: 'html', cacheTtlSeconds: 60, canFollowRedirect: onSite }), 'redirect_refused');
    assert.equal(transport.requests.length, sent, 'refused from the cache, without a request');
  });

  test('distinct URLs are cached apart, and so are responses fetched with private addresses allowed', async () => {
    const transport = fixtureTransport({
      'https://example.com/page?token=one': { body: 'first' },
      'https://example.com/page?token=two': { body: 'second' },
    });
    const cache = memoryCache();
    await cachedClient(cache, transport).request({ url: 'https://example.com/page?token=one', kind: 'html', cacheTtlSeconds: 60 });
    const second = await cachedClient(cache, transport).request({ url: 'https://example.com/page?token=two', kind: 'html', cacheTtlSeconds: 60 });
    assert.equal(second.body.toString(), 'second');
    await cachedClient(cache, transport, true).request({ url: 'https://example.com/page?token=one', kind: 'html', cacheTtlSeconds: 60 });
    assert.equal(transport.requests.length, 3, 'the private-addresses run doesn\'t share the guarded run\'s entry');
  });
});

describe('charset', () => {
  test('uses the header, then <meta charset>, then UTF-8', () => {
    const latin1 = Buffer.from('<meta charset="iso-8859-1"><p>Café</p>', 'latin1');
    assert.match(decodeBody(latin1, 'text/html'), /Café/);
    assert.match(decodeBody(Buffer.from('<p>Café</p>'), 'text/html; charset=utf-8'), /Café/);
    assert.match(decodeBody(Buffer.from('<p>Café</p>'), 'text/html; charset=not-a-charset'), /Café/);
  });
});

describe('robots.txt', () => {
  const rules = parseRobots([
    'User-agent: *',
    'Disallow: /private',
    'Allow: /private/open',
    'Disallow: /*.pdf$',
    '',
    'User-agent: compfinder',
    'User-agent: otherbot',
    'Disallow: /branches/secret # comment',
  ].join('\n'));

  test('uses our own group when there is one, else *', () => {
    assert.equal(isPathAllowed(rules, 'compfinder', '/private'), true, 'our group doesn\'t disallow /private');
    assert.equal(isPathAllowed(rules, 'compfinder', '/branches/secret/x'), false);
    assert.equal(isPathAllowed(rules, 'somebot', '/private/page'), false);
  });

  test('the longest matching rule wins, with * and $ wildcards', () => {
    assert.equal(isPathAllowed(rules, 'somebot', '/private/open/page'), true);
    assert.equal(isPathAllowed(rules, 'somebot', '/docs/file.pdf'), false);
    assert.equal(isPathAllowed(rules, 'somebot', '/docs/file.pdf?x=1'), true);
    assert.equal(isPathAllowed(parseRobots(''), 'compfinder', '/anything'), true);
    const wildcards = parseRobots('User-agent: *\nDisallow: /*/branches/*/team\nDisallow: /a*b$\n');
    assert.equal(isPathAllowed(wildcards, 'compfinder', '/uk/branches/reading/team/jane'), false);
    assert.equal(isPathAllowed(wildcards, 'compfinder', '/uk/branches/reading'), true);
    assert.equal(isPathAllowed(wildcards, 'compfinder', '/a-to-b'), false);
    assert.equal(isPathAllowed(wildcards, 'compfinder', '/a-to-b/c'), true);
    assert.equal(isPathAllowed(parseRobots('User-agent: *\nDisallow: /*.'), 'compfinder', '/file.pdf'), false, 'a . is literal, not any character');
    assert.equal(isPathAllowed(parseRobots('User-agent: *\nDisallow: /*.'), 'compfinder', '/file'), true);
  });

  test('a rule full of wildcards is matched in bounded time, not by backtracking', () => {
    const hostile = parseRobots(`User-agent: *\nDisallow: /${'*a'.repeat(200)}b$\n`);
    const startedAt = performance.now();
    assert.equal(isPathAllowed(hostile, 'compfinder', `/${'a'.repeat(300)}`), true);
    assert.ok(performance.now() - startedAt < 1000, 'matched well within a second');
  });
});

describe('redaction', () => {
  test('removes a URL\'s user and password, and signed-URL parameters', () => {
    assert.equal(redact('GET https://jane:hunter2@example.com/logo.png failed', []), 'GET https://[redacted]@example.com/logo.png failed');
    assert.equal(redact('https://cdn.example.com/a.png?X-Amz-Signature=abc&w=1', []), 'https://cdn.example.com/a.png?X-Amz-Signature=[redacted]&w=1');
  });

  test('removes known secrets and credential-looking query parameters', () => {
    assert.equal(redact('GET https://api.example.com/x?q=1&key=abc123 failed', []), 'GET https://api.example.com/x?q=1&key=[redacted] failed');
    assert.equal(redact('auth with sk-secret-value rejected', ['sk-secret-value']), 'auth with [redacted] rejected');
  });
});
