/**
 * The two columns a run's overview is filtered and sorted by, derived from what the run did.
 *
 * `lastActivityAt` is the moment of the run's last event of work: the latest `enteredAt` or `leftAt`
 * of its visits (a step handed in, a new directive shown, a variable adjustment by the agent or a
 * person), its `completedAt`, or its independent task identity's `changedAt`. A note, a reminder,
 * a new parent, a journal entry, a lock or the
 * agent's own «waiting for the user» move none of them, so they do not count. `refusalCount` is how
 * many entries of the journal are refusals (`countRefusals`).
 *
 * Every writer that changes `visits`, `completedAt`, task identity or `errors` stores its derived facts
 * in the same write, and the in-memory repository calls it too; migration 0047 fills existing rows
 * with the visit/completion formula in SQL; task identity is absent on those older rows.
 */

import { countRefusals, type ExecutionError } from "../types/execution-error.js";

export interface ExecutionActivitySource {
  taskIdentity?: { changedAt: number } | null;
  visits?: ReadonlyArray<{ enteredAt?: number; leftAt?: number }> | null;
  completedAt?: number | null;
  errors?: ReadonlyArray<{ errorType?: string }> | null;
}

export interface ExecutionActivity {
  /** Epoch ms of the run's last event of work, or null when it has none recorded. */
  lastActivityAt: number | null;
  refusalCount: number;
}

export function executionActivity(source: ExecutionActivitySource): ExecutionActivity {
  let latest: number | null = null;
  const consider = (value: unknown) => {
    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      (latest === null || value > latest)
    ) {
      latest = value;
    }
  };
  for (const visit of source.visits ?? []) {
    consider(visit.enteredAt);
    consider(visit.leftAt);
  }
  consider(source.completedAt ?? null);
  consider(source.taskIdentity?.changedAt);
  return { lastActivityAt: latest, refusalCount: countRefusals([...(source.errors ?? [])]) };
}

/** A stored route log, or an empty one when it is absent or does not parse. */
export function parseStoredVisits(
  json: string | null | undefined,
): Array<{ enteredAt?: number; leftAt?: number }> {
  if (!json) return [];
  try {
    const visits = JSON.parse(json) as unknown;
    return Array.isArray(visits) ? visits : [];
  } catch {
    return [];
  }
}

/** A stored journal, or an empty one when it is absent or does not parse. */
export function parseStoredErrors(json: string | null | undefined): ExecutionError[] {
  if (!json) return [];
  try {
    const errors = JSON.parse(json) as unknown;
    return Array.isArray(errors) ? (errors as ExecutionError[]) : [];
  } catch {
    return [];
  }
}
