import { ValidationError } from "../errors/app-error.js";

/** Runtime task naming is independent of the authored workflow title and arbitrary notes. */
export const EXECUTION_TASK_TITLE_LIMIT = 500;

export interface ExecutionTaskIdentity {
  title: string;
  /** Server-owned epoch milliseconds of the last meaningful rename. */
  changedAt: number;
  /** Fresh on each rename, including a same-clock A→B→A change. */
  changeId: string;
}

export interface ExecutionTaskTitleMutationResult {
  executionId: string;
  taskIdentity: ExecutionTaskIdentity;
  revision: number;
  taskIdentityRevision: string;
  changed: boolean;
}

export function normalizeExecutionTaskTitle(value: string): string {
  // Reject controls before trimming, so a newline or tab is not silently accepted as a title.
  if (/[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new ValidationError("Task title must not contain control characters");
  }
  const title = value.trim();
  if (!title || title.length > EXECUTION_TASK_TITLE_LIMIT) {
    throw new ValidationError(`Task title must contain 1–${EXECUTION_TASK_TITLE_LIMIT} characters`);
  }
  return title;
}

/** Absent or malformed optional metadata does not invent an identity for an older run. */
export function parseExecutionTaskIdentity(
  value: string | null | undefined,
): ExecutionTaskIdentity | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) return null;
    const identity = parsed as Partial<ExecutionTaskIdentity>;
    if (
      typeof identity.title !== "string" ||
      typeof identity.changedAt !== "number" ||
      !Number.isFinite(identity.changedAt) ||
      typeof identity.changeId !== "string" ||
      !identity.changeId
    )
      return null;
    if (normalizeExecutionTaskTitle(identity.title) !== identity.title) return null;
    return { title: identity.title, changedAt: identity.changedAt, changeId: identity.changeId };
  } catch {
    return null;
  }
}
