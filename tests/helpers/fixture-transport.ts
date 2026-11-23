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
}

export interface FixtureTransport extends Transport {
  /** Every request made, as "METHOD url". */
  requests: string[];
  /** Requests with no fixture; they get a 404, and a test should assert this stays empty. */
  unmatched: string[];
}

/** A transport that answers from fixtures, keyed by absolute URL. */
export function fixtureTransport(routes: Record<string, FixtureResponse>): FixtureTransport {
  const requests: string[] = [];
  const unmatched: string[] = [];
  return {
    requests,
    unmatched,
    async send(request: TransportRequest): Promise<TransportResponse> {
      const key = request.url.href;
      requests.push(`${request.method} ${key}`);
      const route = routes[key];
      if (route === undefined) {
        unmatched.push(`${request.method} ${key}`);
      }
      const body = route?.file === undefined ? (route?.body ?? '') : readFileSync(new URL(route.file, FIXTURES_URL), 'utf8');
      return {
        status: route?.status ?? (route === undefined ? NOT_FOUND : 200),
        headers: { 'content-type': 'text/html; charset=utf-8', ...route?.headers },
        body: (async function* yieldBody() {
          yield Buffer.from(body);
        })(),
      };
    },
  };
}
