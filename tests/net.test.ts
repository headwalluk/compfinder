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

const COMPRESSION_BOMB_BYTES = 3 * 1024 * 1024;
const SHORT_TIMEOUT_MS = 200;

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

  test('a metered client stops when the budget is used up', async () => {
    const meter = new CallMeter(true, [new CallBudget(1)]);
    await client(meter).request({ url: `${baseUrl}/page`, kind: 'html' });
    await assert.rejects(client(meter).request({ url: `${baseUrl}/page`, kind: 'html' }), { name: 'BudgetExhaustedError' });
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
  });
});

describe('redaction', () => {
  test('removes known secrets and credential-looking query parameters', () => {
    assert.equal(redact('GET https://api.example.com/x?q=1&key=abc123 failed', []), 'GET https://api.example.com/x?q=1&key=[redacted] failed');
    assert.equal(redact('auth with sk-secret-value rejected', ['sk-secret-value']), 'auth with [redacted] rejected');
  });
});
