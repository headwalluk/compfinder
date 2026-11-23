import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate, type Gunzip } from 'node:zlib';
import type { CallMeter } from '../lookup/budget.js';
import type { Logger } from '../logger.js';
import type { ProviderCache } from '../cache/store.js';
import { isAddressAllowed } from './address-guard.js';
import { redact } from './redact.js';
import type { Transport } from './transport.js';

/** What a request fetches; decides its byte cap and Accept header. */
export const REQUEST_KINDS = {
  html: { maxBytes: 2 * 1024 * 1024, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1' },
  json: { maxBytes: 1024 * 1024, accept: 'application/json' },
  image: { maxBytes: 5 * 1024 * 1024, accept: 'image/svg+xml,image/png,image/webp,image/jpeg,image/gif,image/x-icon,*/*;q=0.1' },
  robots: { maxBytes: 512 * 1024, accept: 'text/plain' },
  manifest: { maxBytes: 64 * 1024, accept: 'application/manifest+json,application/json' },
} as const;
export type RequestKind = keyof typeof REQUEST_KINDS;

const MAX_REDIRECTS = 5;
const DEFAULT_PORTS = new Set(['', '80', '443']);
const WEB_PROTOCOLS = new Set(['http:', 'https:']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SEE_OTHER = 303;
const ACCEPT_ENCODING = 'gzip, deflate, br';

/** Why a request failed before a usable response; providers map these to failure statuses. */
export const HTTP_FAILURES = ['refused_address', 'refused_url', 'redirect_refused', 'too_many_redirects', 'too_large', 'timeout', 'network'] as const;
export type HttpFailure = (typeof HTTP_FAILURES)[number];

export class HttpError extends Error {
  readonly failure: HttpFailure;
  readonly url: string;

  constructor(failure: HttpFailure, url: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HttpError';
    this.failure = failure;
    this.url = url;
  }
}

export interface HttpRequest {
  url: string;
  kind: RequestKind;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  /** A JSON body, sent as application/json. */
  json?: unknown;
  /** Says whether to follow a redirect; refusing ends the request with redirect_refused. */
  canFollowRedirect?: (from: URL, to: URL, hop: number) => boolean;
  /** Keep a GET response in the provider's cache this long; absent or 0 means don't. */
  cacheTtlSeconds?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** The URL that answered, after redirects. */
  url: string;
  /** Decompressed body bytes. */
  body: Buffer;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface HttpClientOptions {
  transport: Transport;
  userAgent: string;
  requestTimeoutMs: number;
  allowPrivateAddresses: boolean;
  meter: CallMeter;
  /** The lookup's deadline. */
  signal: AbortSignal;
  /** Logs each request at debug: method, URL, status, bytes and time taken. URLs pass through redact. */
  logger?: Logger;
  /** Values to keep out of logged URLs. */
  secrets?: readonly string[];
  /** The provider's response cache, for requests that ask to be cached. */
  cache?: ProviderCache;
}

/** A cached response, as stored. */
interface CachedResponse {
  status: number;
  headers: Record<string, string>;
  url: string;
  body: string;
}

/** Statuses not worth caching: refusals and server errors may be temporary. */
const UNCACHEABLE_STATUSES = new Set([401, 403, 429]);
const SERVER_ERROR_MIN = 500;
/** Response headers kept in the cache; nothing that could identify the caller. */
const CACHED_HEADERS = ['content-type', 'server', 'cf-mitigated'];

/** Picks a decompressor for a Content-Encoding, or null for identity. */
function decompressor(encoding: string | undefined): Gunzip | ReturnType<typeof createBrotliDecompress> | null {
  const name = encoding?.trim().toLowerCase() ?? '';
  let stream: Gunzip | ReturnType<typeof createBrotliDecompress> | null = null;
  if (name === 'gzip' || name === 'x-gzip') {
    stream = createGunzip();
  } else if (name === 'deflate') {
    stream = createInflate();
  } else if (name === 'br') {
    stream = createBrotliDecompress();
  }
  return stream;
}

/** Reads a body to the end, decompressing as it goes, and stops at maxBytes of decompressed data. */
async function readBody(body: AsyncIterable<Uint8Array>, encoding: string | undefined, maxBytes: number, url: string): Promise<Buffer> {
  const source = Readable.from(body);
  const decoder = decompressor(encoding);
  const decoded: AsyncIterable<Uint8Array> = decoder === null ? source : source.pipe(decoder);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of decoded) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        throw new HttpError('too_large', url, `${url} is larger than ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(chunk));
    }
  } finally {
    source.destroy();
    decoder?.destroy();
  }
  return Buffer.concat(chunks);
}

/** Discards a response body that won't be read, such as a redirect's. */
async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  const source = Readable.from(body);
  source.destroy();
}

/** Refuses URLs compfinder never fetches: not http(s), an odd port, or a literal private address. */
function checkUrl(url: URL, allowPrivateAddresses: boolean): void {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!WEB_PROTOCOLS.has(url.protocol)) {
    throw new HttpError('refused_url', url.href, `${url.href} isn't http or https`);
  }
  if (!allowPrivateAddresses && !DEFAULT_PORTS.has(url.port)) {
    throw new HttpError('refused_url', url.href, `${url.href} uses port ${url.port}; only 80 and 443 are allowed`);
  }
  // Node skips DNS lookup for an IP literal, so the connect-time guard never sees it: check here.
  if (!allowPrivateAddresses && isIP(host) !== 0 && !isAddressAllowed(host)) {
    throw new HttpError('refused_address', url.href, `${host} is a private or reserved address`);
  }
}

/** Builds the one client every provider's requests go through (docs/security.md). */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  return {
    async request(request: HttpRequest): Promise<HttpResponse> {
      const ttlSeconds = request.method === 'POST' ? 0 : (request.cacheTtlSeconds ?? 0);
      const cacheKey = redact(request.url, options.secrets ?? []);
      const cached = ttlSeconds > 0 ? options.cache?.get(request.kind, cacheKey) as CachedResponse | undefined : undefined;
      if (cached !== undefined) {
        options.meter.cachedCalls += 1;
        options.logger?.debug(`GET ${cacheKey} ${cached.status} from cache`);
        return { status: cached.status, headers: cached.headers, url: cached.url, body: Buffer.from(cached.body, 'base64') };
      }
      const kind = REQUEST_KINDS[request.kind];
      let url = new URL(request.url);
      let method = request.method ?? 'GET';
      let body = request.json === undefined ? null : JSON.stringify(request.json);
      let response: HttpResponse | null = null;
      for (let hop = 0; response === null; hop += 1) {
        checkUrl(url, options.allowPrivateAddresses);
        options.meter.record();
        const signal = AbortSignal.any([AbortSignal.timeout(options.requestTimeoutMs), options.signal]);
        const headers: Record<string, string> = {
          'user-agent': options.userAgent,
          accept: kind.accept,
          'accept-encoding': ACCEPT_ENCODING,
          ...(body === null ? {} : { 'content-type': 'application/json' }),
          ...request.headers,
        };
        const startedAt = performance.now();
        const logged = redact(url.href, options.secrets ?? []);
        let sent;
        try {
          sent = await options.transport.send({ url, method, headers, body, signal, allowPrivateAddresses: options.allowPrivateAddresses });
        } catch (error) {
          const failure: HttpFailure = signal.aborted ? 'timeout' : 'network';
          throw new HttpError(failure, url.href, `${url.href}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        const location = sent.headers.location;
        if (REDIRECT_STATUSES.has(sent.status) && location !== undefined) {
          await drain(sent.body);
          options.logger?.debug(`${method} ${logged} ${sent.status} -> ${redact(location, options.secrets ?? [])}`);
          const next = new URL(location, url);
          if (hop + 1 > MAX_REDIRECTS) {
            throw new HttpError('too_many_redirects', url.href, `${request.url} redirected more than ${MAX_REDIRECTS} times`);
          }
          if (request.canFollowRedirect !== undefined && !request.canFollowRedirect(url, next, hop + 1)) {
            throw new HttpError('redirect_refused', next.href, `${url.href} redirects to ${next.href}`);
          }
          if (sent.status === SEE_OTHER) {
            method = 'GET';
            body = null;
          }
          url = next;
        } else {
          let bytes: Buffer;
          try {
            bytes = await readBody(sent.body, sent.headers['content-encoding'], kind.maxBytes, url.href);
          } catch (error) {
            if (error instanceof HttpError) {
              throw error;
            }
            const failure: HttpFailure = signal.aborted ? 'timeout' : 'network';
            throw new HttpError(failure, url.href, `${url.href}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
          options.logger?.debug(`${method} ${logged} ${sent.status} ${bytes.byteLength} bytes in ${Math.round(performance.now() - startedAt)} ms`);
          response = { status: sent.status, headers: sent.headers, url: url.href, body: bytes };
        }
      }
      if (ttlSeconds > 0 && response.status < SERVER_ERROR_MIN && !UNCACHEABLE_STATUSES.has(response.status)) {
        const headers = Object.fromEntries(CACHED_HEADERS.filter((name) => response.headers[name] !== undefined).map((name) => [name, response.headers[name] ?? '']));
        options.cache?.set(request.kind, cacheKey, { status: response.status, headers, url: response.url, body: response.body.toString('base64') } satisfies CachedResponse, ttlSeconds);
      }
      return response;
    },
  };
}
