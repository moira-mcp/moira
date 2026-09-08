import type { WorkflowExecution } from "./base-types.js";

export type ExecutionAttemptOperation = "step" | "start";
export type ExecutionAttemptState = "presented" | "executing" | "completed" | "outcome_unknown";

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
