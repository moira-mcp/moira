import type { WorkflowExecution } from "./base-types.js";

export type ExecutionAttemptOperation = "step" | "start";
/**
 * `superseded`: a presented step attempt the run moved past without the agent submitting it —
 * a person answered the waiting step on the run page. It is kept for the agent to meet as
 * stale; the presentation for the new node is linked through `nextAttemptId`.
 */
export type ExecutionAttemptState =
  "presented" | "executing" | "completed" | "outcome_unknown" | "superseded";

export interface ReconciledExecutionAttemptCounts {
  start: number;
  step: number;
}

export interface ExecutionAttempt {
  attemptId: string;
  operation: ExecutionAttemptOperation;
  userId: string;
  executionId: string | null;
  reservedExecutionId: string | null;
  executionRevision: number | null;
  nodeId: string | null;
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  /**
   * Step attempts only: digest of the run's continuation surface (see `continuation-surface.ts`).
   * It, not `workflowVersion`/`workflowDigest`, decides whether a paused run may still continue
   * against the current definition. `null` on start attempts, and on step attempts persisted
   * before the continuation binding existed — a null never matches, so such an attempt is stale.
   */
  continuationDigest: string | null;
  /**
   * Step attempts only: the canonical JSON fact map the continuation digest is computed from, kept
   * so a run that no longer matches can be told which facts differ rather than only that something
   * did. `null` wherever `continuationDigest` is null, and on attempts written before it existed.
   */
  continuationFacts: string | null;
  requestPayload: string | null;
  inputFingerprint: string | null;
  state: ExecutionAttemptState;
  ownerId: string | null;
  fence: number;
  heartbeatAt: number | null;
  leaseExpiresAt: number | null;
  response: string | null;
  nextAttemptId: string | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface PresentedExecutionAttempt {
  attemptId: string;
  userId: string;
  executionId: string;
  executionRevision: number;
  nodeId: string;
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  continuationDigest: string;
  continuationFacts: string;
  response: string | null;
  createdAt: number;
}

export interface StartAttemptRequestPayload {
  note: string | null;
  parentExecutionId: string | null;
  skipNotificationCheck: boolean;
}

export interface PreparedStartExecutionAttempt {
  attemptId: string;
  userId: string;
  reservedExecutionId: string;
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  requestPayload: string;
  inputFingerprint: string;
  expiresAt: number;
  createdAt: number;
}

export interface ClaimStartExecutionAttemptInput {
  attemptId: string;
  userId: string;
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  ownerId: string;
  now: number;
  leaseMs: number;
  execution: WorkflowExecution;
}

export type StartPreconditionCompletionResult =
  | { kind: "completed" | "replay"; response: string }
  | { kind: "processing" | "outcome_unknown"; attempt: ExecutionAttempt }
  | { kind: "invalid" };

export type ExecutionAttemptClaimResult =
  | { kind: "claimed"; attempt: ExecutionAttempt; fence: number }
  | { kind: "completed"; attempt: ExecutionAttempt; response: string }
  | { kind: "processing"; attempt: ExecutionAttempt }
  | { kind: "outcome_unknown"; attempt: ExecutionAttempt }
  | { kind: "conflict" | "stale" | "invalid" };

/**
 * Move a paused execution to a node it can resume from, under the same guards an ordinary step
 * applies. The attempt the run was holding is retired and a fresh one is installed for the target in
 * the same transaction, so the run is never left waiting on a node with no attempt — a state no MCP
 * call can leave, because presenting the current step refuses an execution whose waiting node and
 * current node disagree, and stepping requires an attempt id nothing would then mint.
 *
 * The fresh attempt carries no rendered text yet. Rendering it is the caller's next act and may
 * replace this attempt with a rendered one; if that never happens, the run still holds a usable
 * attempt.
 */
export interface RecoverExecutionToNodeInput {
  /** The execution as it should be after the move, waiting on the target node. */
  execution: WorkflowExecution;
  /** The execution as the caller read it; the write refuses if anything about it changed. */
  expectedExecution: WorkflowExecution;
  /** The attempt the run holds at the target until a rendered one replaces it. */
  nextAttempt: PresentedExecutionAttempt;
}

export type RecoverExecutionToNodeResult =
  | "recovered"
  /** The execution changed under the caller; read it again and decide again. */
  | "execution_changed"
  /** An agent is executing the current attempt, or its outcome is unknown; recovery must not race. */
  | "attempt_in_progress";

export interface CompleteExecutionAttemptInput {
  attemptId: string;
  ownerId: string;
  fence: number;
  inputFingerprint: string;
  execution: WorkflowExecution;
  expectedExecution: WorkflowExecution;
  response: string;
  nextAttempt?: PresentedExecutionAttempt;
}
