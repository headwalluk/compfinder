import { BudgetExhaustedError } from './errors.js';

/** Counts metered calls against a limit; null means no limit. Shared across lookups for a batch budget. */
export class CallBudget {
  private readonly limit: number | null;
  private used = 0;

  constructor(limit: number | null) {
    this.limit = limit;
  }

  /** Calls left; Infinity when there's no limit. */
  remaining(): number {
    return this.limit === null ? Number.POSITIVE_INFINITY : Math.max(0, this.limit - this.used);
  }

  /** Records one call, or throws BudgetExhaustedError when none is left. */
  debit(): void {
    if (this.remaining() < 1) {
      throw new BudgetExhaustedError();
    }
    this.used += 1;
  }

  /** Calls made so far. */
  spent(): number {
    return this.used;
  }
}

/** Counts one provider's calls in one lookup, debiting every budget that applies when they're metered. */
export class CallMeter {
  private readonly budgets: readonly CallBudget[];
  private readonly isMetered: boolean;
  calls = 0;
  /** Requests answered from the cache: they cost nothing and aren't in calls. */
  cachedCalls = 0;

  constructor(isMetered: boolean, budgets: readonly CallBudget[]) {
    this.isMetered = isMetered;
    this.budgets = budgets;
  }

  /** Metered calls this provider may still make. */
  remaining(): number {
    return this.isMetered ? Math.min(...this.budgets.map((budget) => budget.remaining())) : Number.POSITIVE_INFINITY;
  }

  /** Records a call about to be made; throws BudgetExhaustedError if a metered call has no budget left. */
  record(): void {
    if (this.isMetered) {
      if (this.remaining() < 1) {
        throw new BudgetExhaustedError();
      }
      for (const budget of this.budgets) {
        budget.debit();
      }
    }
    this.calls += 1;
  }
}
