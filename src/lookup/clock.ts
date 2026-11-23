/** The time source for cache expiry; injected so tests control it. The only place that reads the wall clock. */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number;
}

export const SYSTEM_CLOCK: Clock = { now: () => Date.now() };
