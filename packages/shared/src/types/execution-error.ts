/**
 * Execution Error Types
 * Persistent error log per execution (Issue #386)
 */

/**
 * Type of error that occurred during execution
 * - validation: Input validation failed (schema mismatch, missing fields)
 * - handler: Node handler threw an error (business logic error)
 * - system: System-level error (network, database, timeout)
 * - degradation: The step ran, but without something it names — behaviour text it could not read.
 *   Recorded so a run does not lose it silently; it is not a failure, and consumers that count
 *   failures must not count it.
 */
export type ExecutionErrorType = "validation" | "handler" | "system" | "degradation";

/**
 * Single error entry in execution error log
 * Immutable record of an error that occurred during workflow execution
 */
export interface ExecutionError {
  /** Unix timestamp (ms) when error occurred */
  timestamp: number;

  /** ID of the node where error occurred */
  nodeId: string;

  /** Category of error */
  errorType: ExecutionErrorType;

  /** Human-readable error message */
  message: string;

  /** Agent input that caused the error (sanitized, may be truncated) */
  input?: unknown;
}

/**
 * Whether a journal entry means the step was refused.
 *
 * Every consumer that reads the journal to answer "did this step fail" asks this, because the
 * journal holds two different kinds of fact: a refusal, where the step did not happen, and a
 * degradation, where it happened without behaviour text it names. The rule lives here rather than
 * at each consumer, because a consumer that keeps its own copy of it audits an accepted step as a
 * failed attempt the moment the copies disagree.
 */
export function isRefusal(entry: { errorType?: string }): boolean {
  return entry.errorType !== "degradation";
}

/** How many entries in this journal are refusals. */
export function countRefusals(entries: { errorType?: string }[] | undefined): number {
  return (entries ?? []).filter(isRefusal).length;
}

/** The most recent refusal in this journal, or undefined when it holds none. */
export function latestRefusal<T extends { errorType?: string }>(
  entries: T[] | undefined,
): T | undefined {
  const refusals = (entries ?? []).filter(isRefusal);
  return refusals[refusals.length - 1];
}

/**
 * Execution status stored in database (Issue #386)
 * - running: Execution is active (processing or waiting for input)
 * - completed: Execution finished (success or explicit end)
 */
export type ExecutionStatus = "running" | "completed";

/**
 * Execution status as returned in API responses.
 * Extends DB status with "locked" — a derived status when an active lock exists.
 * DB always stores "running"; "locked" is computed at query time from lock table.
 */
export type ExecutionStatusResponse = ExecutionStatus | "locked";

/**
 * Legacy execution status values for backward compatibility
 * Used for API filter mapping (old clients may send these values)
 */
export type LegacyExecutionStatus = "running" | "waiting" | "completed" | "failed" | "locked";

/**
 * Map legacy status to DB status for backward compatibility.
 * "locked" is NOT a DB status — it's resolved separately via lock table.
 * Returns null for "locked" to signal the caller should handle it via lock join.
 */
export function mapLegacyStatus(status: LegacyExecutionStatus): ExecutionStatus | null {
  switch (status) {
    case "waiting":
      return "running";
    case "failed":
      return "completed";
    case "locked":
      return null;
    default:
      return status;
  }
}

/**
 * Map array of legacy statuses to DB statuses.
 * Strips "locked" from the mapped result (handled separately via lock join).
 * Returns { dbStatuses, hasLockedFilter } to let callers handle lock filtering.
 */
export function mapLegacyStatusArray(statuses: LegacyExecutionStatus[]): {
  dbStatuses: ExecutionStatus[];
  hasLockedFilter: boolean;
} {
  let hasLockedFilter = false;
  const mapped: ExecutionStatus[] = [];

  for (const s of statuses) {
    const result = mapLegacyStatus(s);
    if (result === null) {
      hasLockedFilter = true;
    } else {
      mapped.push(result);
    }
  }

  return {
    dbStatuses: Array.from(new Set(mapped)),
    hasLockedFilter,
  };
}
