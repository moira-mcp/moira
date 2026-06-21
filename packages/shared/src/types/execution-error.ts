/**
 * Execution Error Types
 * Persistent error log per execution (Issue #386)
 */

/**
 * Type of error that occurred during execution
 * - validation: Input validation failed (schema mismatch, missing fields)
 * - handler: Node handler threw an error (business logic error)
 * - system: System-level error (network, database, timeout)
 */
export type ExecutionErrorType = "validation" | "handler" | "system";

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
