import { ProviderError } from '../lookup/errors.js';
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
  return new ProviderError(statuses[error.failure], error.message);
}

/** Parses a JSON API response, or throws the ProviderError its status and body mean. */
export function parseApiResponse(response: HttpResponse, api: string): unknown {
  const text = response.body.toString('utf8');
  const detail = `${api} answered HTTP ${response.status}: ${text.slice(0, MAX_DETAIL_CHARS).replace(/\s+/g, ' ')}`;
  let parsed: unknown;
  if (response.status === UNAUTHORISED || response.status === FORBIDDEN || (response.status === BAD_REQUEST && AUTH_MARKERS.test(text))) {
    throw new ProviderError('auth_failed', detail);
  }
  if (response.status === TOO_MANY_REQUESTS || QUOTA_MARKERS.test(response.status >= BAD_REQUEST ? text : '')) {
    throw new ProviderError('quota_exceeded', detail);
  }
  if (response.status >= SERVER_ERROR_MIN) {
    throw new ProviderError('unreachable', detail);
  }
  if (response.status < SUCCESS_MIN || response.status > SUCCESS_MAX) {
    throw new ProviderError('bad_response', detail);
  }
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    throw new ProviderError('bad_response', `${api} answered with something that isn't JSON`);
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
