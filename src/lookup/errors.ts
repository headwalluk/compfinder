/** How a provider run can fail (spec §7). Each becomes the provider's status in the result. */
export const FAILURE_STATUSES = [
  'auth_failed', 'quota_exceeded', 'blocked', 'unreadable', 'unreachable', 'timeout', 'bad_response', 'internal_error',
] as const;
export type FailureStatus = (typeof FAILURE_STATUSES)[number];

/** Statuses a provider can end a lookup with. */
export const PROVIDER_RUN_STATUSES = ['ok', 'skipped', 'not_configured', ...FAILURE_STATUSES] as const;
export type ProviderRunStatus = (typeof PROVIDER_RUN_STATUSES)[number];

/** Why a provider failed, as a short stable code (docs/output.md); an HTTP status a page or API answered is http_NNN. */
export const FAILURE_CAUSES = [
  'dns', 'connection_refused', 'connection_reset', 'tls_certificate', 'tls_handshake', 'network', 'timeout', 'too_large',
  'too_many_redirects', 'redirect_refused', 'refused_address', 'refused_url', 'not_html', 'not_json', 'bot_protection',
  'robots_disallowed', 'unreadable', 'no_api_key', 'auth_rejected', 'quota', 'internal',
] as const;
export type FailureCause = (typeof FAILURE_CAUSES)[number] | `http_${number}`;

/** The cause code for an HTTP status. */
export function httpStatusCause(status: number): FailureCause {
  return `http_${status}`;
}

/** A classified provider failure. Anything else a provider throws is reported as internal_error. */
export class ProviderError extends Error {
  readonly status: Exclude<FailureStatus, 'internal_error'>;
  readonly detail: string;
  readonly failureCause: FailureCause;

  constructor(status: Exclude<FailureStatus, 'internal_error'>, detail: string, failureCause: FailureCause, options?: { cause?: unknown }) {
    super(`${status}: ${detail}`, options);
    this.name = 'ProviderError';
    this.status = status;
    this.detail = detail;
    this.failureCause = failureCause;
  }
}

/** Thrown when a metered call would go over the lookup's or the batch's budget. */
export class BudgetExhaustedError extends Error {
  constructor() {
    super('Metered call budget used up');
    this.name = 'BudgetExhaustedError';
  }
}
