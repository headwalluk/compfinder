import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { guardedLookup } from './address-guard.js';

export interface TransportRequest {
  url: URL;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string | null;
  signal: AbortSignal;
  /** When false, every resolved address is checked by the address guard at connect time. */
  allowPrivateAddresses: boolean;
}

export interface TransportResponse {
  status: number;
  /** Lower-case names; repeated headers joined with ", ". */
  headers: Record<string, string>;
  /** Raw bytes as sent, still content-encoded. */
  body: AsyncIterable<Uint8Array>;
}

/** Sends one HTTP request and returns the response unread. The seam where tests swap in fixtures. */
export interface Transport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

/** Flattens Node's header object to single strings. */
function flattenHeaders(message: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (value !== undefined) {
      headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
    }
  }
  return headers;
}

/**
 * A response body that can't crash the process: Node throws an 'error' event no one listens to (a connection reset
 * before the body is read), so one is listened for from the start and rethrown to whoever reads the body. A body
 * abandoned unread (a redirect's) closes the response.
 */
function readIncoming(incoming: IncomingMessage): AsyncIterable<Uint8Array> {
  let failure: Error | null = null;
  incoming.on('error', (error) => {
    failure = error;
  });
  return {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      const chunks = incoming[Symbol.asyncIterator]() as AsyncIterator<Uint8Array>;
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (failure !== null) {
            throw failure;
          }
          return chunks.next();
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          incoming.destroy();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

/** The real network: node:http and node:https, with the address guard on every connection. */
export const LIVE_TRANSPORT: Transport = {
  send(request: TransportRequest): Promise<TransportResponse> {
    const send = request.url.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const outgoing = send(request.url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        agent: false,
        ...(request.allowPrivateAddresses ? {} : { lookup: guardedLookup }),
      }, (incoming) => {
        resolve({ status: incoming.statusCode ?? 0, headers: flattenHeaders(incoming), body: readIncoming(incoming) });
      });
      outgoing.on('error', reject);
      outgoing.end(request.body ?? undefined);
    });
  },
};
