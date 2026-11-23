/** How a provider run can fail (spec §7). Each becomes the provider's status in the result. */
export const FAILURE_STATUSES = [
  'auth_failed', 'quota_exceeded', 'blocked', 'unreadable', 'unreachable', 'timeout', 'bad_response', 'internal_error',
] as const;
export type FailureStatus = (typeof FAILURE_STATUSES)[number];

/** Statuses a provider can end a lookup with. */
export const PROVIDER_RUN_STATUSES = ['ok', 'skipped', 'not_configured', ...FAILURE_STATUSES] as const;
export type ProviderRunStatus = (typeof PROVIDER_RUN_STATUSES)[number];

/** A classified provider failure. Anything else a provider throws is reported as internal_error. */
export class ProviderError extends Error {
  readonly status: Exclude<FailureStatus, 'internal_error'>;
  readonly detail: string;

  constructor(status: Exclude<FailureStatus, 'internal_error'>, detail: string) {
    super(`${status}: ${detail}`);
    this.name = 'ProviderError';
    this.status = status;
    this.detail = detail;
  }
}

/** Thrown when a metered call would go over the lookup's or the batch's budget. */
export class BudgetExhaustedError extends Error {
  constructor() {
    super('Metered call budget used up');
    this.name = 'BudgetExhaustedError';
  }
}
