import { readFileSync } from 'node:fs';
import type { Transport, TransportRequest, TransportResponse } from '../../src/net/transport.js';

const FIXTURES_URL = new URL('../fixtures/', import.meta.url);
const NOT_FOUND = 404;

export interface FixtureResponse {
  status?: number;
  headers?: Record<string, string>;
  /** Inline body text. */
  body?: string;
  /** A file under tests/fixtures/, read as the body. */
  file?: string;
  /** Binary body bytes. */
  bytes?: Buffer;
}

export interface FixtureTransport extends Transport {
  /** Every request made, as "METHOD url". */
  requests: string[];
  /** Requests with no fixture; they get a 404, and a test should assert this stays empty. */
  unmatched: string[];
}

/** A route: a fixed response, or a function of the request (to check headers or a POST body). */
export type FixtureRoute = FixtureResponse | ((request: TransportRequest) => FixtureResponse);

/** A transport that answers from fixtures, keyed by absolute URL. */
export function fixtureTransport(routes: Record<string, FixtureRoute>): FixtureTransport {
  const requests: string[] = [];
  const unmatched: string[] = [];
  return {
    requests,
    unmatched,
    async send(request: TransportRequest): Promise<TransportResponse> {
      const key = request.url.href;
      requests.push(`${request.method} ${key}`);
      const entry = routes[key];
      const route = typeof entry === 'function' ? entry(request) : entry;
      if (route === undefined) {
        unmatched.push(`${request.method} ${key}`);
      }
      let body: Buffer;
      if (route?.bytes !== undefined) {
        body = route.bytes;
      } else if (route?.file !== undefined) {
        body = readFileSync(new URL(route.file, FIXTURES_URL));
      } else {
        body = Buffer.from(route?.body ?? '');
      }
      return {
        status: route?.status ?? (route === undefined ? NOT_FOUND : 200),
        headers: { 'content-type': 'text/html; charset=utf-8', ...route?.headers },
        body: (async function* yieldBody() {
          yield body;
        })(),
      };
    },
  };
}
