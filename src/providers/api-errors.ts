import { httpStatusCause, ProviderError, type FailureCause } from '../lookup/errors.js';
import { HttpError, type HttpResponse } from '../net/http-client.js';

const UNAUTHORISED = 401;
const FORBIDDEN = 403;
const TOO_MANY_REQUESTS = 429;
const BAD_REQUEST = 400;
const SERVER_ERROR_MIN = 500;
const SUCCESS_MIN = 200;
const SUCCESS_MAX = 299;
/** Error reasons and statuses an API uses for a bad or unauthorised key. */
const AUTH_MARKERS = /API_KEY_INVALID|API_KEY_SERVICE_BLOCKED|PERMISSION_DENIED|UNAUTHENTICATED|invalid api key|unauthori[sz]ed/i;
const QUOTA_MARKERS = /RESOURCE_EXHAUSTED|quota|rate limit/i;
const MAX_DETAIL_CHARS = 300;

/** Network error codes, and the cause each means. */
const NETWORK_CAUSES: ReadonlyArray<[RegExp, FailureCause]> = [
  [/ENOTFOUND|EAI_AGAIN|EAI_NONAME|getaddrinfo/, 'dns'],
  [/ECONNREFUSED/, 'connection_refused'],
  [/ECONNRESET|EPIPE|socket hang up/, 'connection_reset'],
  [/CERT_|_CERT|certificate|altnames/i, 'tls_certificate'],
  [/EPROTO|ERR_SSL_|ERR_TLS_|SSL routines|handshake/i, 'tls_handshake'],
];

/** The cause code for an HTTP client failure: for a network failure, from the underlying error's code and message. */
export function httpFailureCause(error: HttpError): FailureCause {
  let cause: FailureCause = error.failure;
  if (error.failure === 'network') {
    const underlying = error.cause as (Error & { code?: unknown }) | undefined;
    const text = `${typeof underlying?.code === 'string' ? underlying.code : ''} ${underlying?.message ?? ''} ${error.message}`;
    cause = NETWORK_CAUSES.find(([pattern]) => pattern.test(text))?.[1] ?? 'network';
  }
  return cause;
}

/** Maps an HTTP client failure to the status it means for an API provider. */
export function apiFailure(error: HttpError): ProviderError {
  const statuses: Record<HttpError['failure'], ConstructorParameters<typeof ProviderError>[0]> = {
    refused_address: 'blocked',
    refused_url: 'blocked',
    redirect_refused: 'bad_response',
    too_many_redirects: 'bad_response',
    too_large: 'bad_response',
    timeout: 'timeout',
    network: 'unreachable',
  };
  return new ProviderError(statuses[error.failure], error.message, httpFailureCause(error));
}

/** Parses a JSON API response, or throws the ProviderError its status and body mean. */
export function parseApiResponse(response: HttpResponse, api: string): unknown {
  const text = response.body.toString('utf8');
  const detail = `${api} answered HTTP ${response.status}: ${text.slice(0, MAX_DETAIL_CHARS).replace(/\s+/g, ' ')}`;
  let parsed: unknown;
  if (response.status === UNAUTHORISED || response.status === FORBIDDEN || (response.status === BAD_REQUEST && AUTH_MARKERS.test(text))) {
    throw new ProviderError('auth_failed', detail, 'auth_rejected');
  }
  if (response.status === TOO_MANY_REQUESTS || QUOTA_MARKERS.test(response.status >= BAD_REQUEST ? text : '')) {
    throw new ProviderError('quota_exceeded', detail, 'quota');
  }
  if (response.status >= SERVER_ERROR_MIN) {
    throw new ProviderError('unreachable', detail, httpStatusCause(response.status));
  }
  if (response.status < SUCCESS_MIN || response.status > SUCCESS_MAX) {
    throw new ProviderError('bad_response', detail, httpStatusCause(response.status));
  }
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new ProviderError('bad_response', `${api} answered with something that isn't JSON`, 'not_json');
  }
  return parsed;
}

/** Sends an API request through the provider's client, turning transport failures into ProviderErrors. */
export async function apiRequest(send: () => Promise<HttpResponse>, api: string): Promise<unknown> {
  let response: HttpResponse;
  try {
    response = await send();
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }
    throw apiFailure(error);
  }
  return parseApiResponse(response, api);
}
