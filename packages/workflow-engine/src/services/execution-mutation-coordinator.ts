import { createHash, randomUUID } from "node:crypto";
import {
  ConflictError,
  createLogger,
  executionMutationAttemptsTotal,
  ValidationError,
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "../interfaces/core-interfaces.js";
import type { IDataRepository } from "../interfaces/data-repository.js";
import type {
  ExecutionAttempt,
  PreparedStartExecutionAttempt,
  StartAttemptRequestPayload,
  PresentedExecutionAttempt,
  WorkflowExecution,
} from "../types/index.js";
import { canonicalJson } from "../extensions/declared-schema.js";

export const EXECUTION_ATTEMPT_LEASE_MS = 30_000;
export const EXECUTION_ATTEMPT_HEARTBEAT_MS = 5_000;
export const EXECUTION_ATTEMPT_WAIT_MS = 10_000;
export const START_ATTEMPT_TTL_MS = 15 * 60_000;
const WAIT_POLL_MS = 50;

export type StepAttemptOutcome =
  | { kind: "claimed"; ownerId: string; fence: number; inputFingerprint: string }
  | { kind: "replay"; response: string };

export type StartAttemptOutcome =
  | { kind: "claimed"; ownerId: string; fence: number; inputFingerprint: string }
  | { kind: "replay"; response: string }
  | { kind: "outcome_unknown"; response: string };
type ReceiptWaitOutcome =
  { kind: "replay"; response: string } | { kind: "outcome_unknown"; response: string };
export interface StartPreconditionOutcome {
  response: string;
  outcome: "original" | "safe_replay" | "outcome_unknown";
}

export interface ExecutionAttemptLease {
  assertOwned(): Promise<void>;
  stop(): void;
}

export function workflowGraphDigest(graph: WorkflowGraph): string {
  return createHash("sha256").update(canonicalJson(graph)).digest("hex");
}

export function stepMutationFingerprint(input: unknown, teleportTo?: string): string {
  return createHash("sha256")
    .update(canonicalJson({ input, teleportTo: teleportTo ?? null }))
    .digest("hex");
}

export class ExecutionMutationCoordinator {
  readonly ownerId: string = randomUUID();
  private readonly logger = createLogger({ component: "ExecutionMutationCoordinator" });

  constructor(
    private readonly repository: IDataRepository,
    private readonly now: () => number = Date.now,
    private readonly waitMs = EXECUTION_ATTEMPT_WAIT_MS,
    private readonly waitPollMs = WAIT_POLL_MS,
  ) {}

  newPresentedAttempt(
    execution: WorkflowExecution,
    graph: WorkflowGraph,
    response: string | null,
    attemptId: string = randomUUID(),
  ): PresentedExecutionAttempt {
    if (!execution.currentNodeId)
      throw new Error("Cannot present an attempt without a current node");
    return {
      attemptId,
      userId: execution.userId,
      executionId: execution.executionId,
      executionRevision: execution.revision,
      nodeId: execution.currentNodeId,
      workflowId: execution.workflowId,
      workflowVersion: graph.metadata.version,
      workflowDigest: workflowGraphDigest(graph),
      response,
      createdAt: this.now(),
    };
  }

  async prepareStart(
    userId: string,
    graph: WorkflowGraph,
    payload: StartAttemptRequestPayload,
  ): Promise<PreparedStartExecutionAttempt> {
    if (!graph.id) throw new ValidationError("Cannot prepare an unsaved workflow");
    const now = this.now();
    const requestPayload = canonicalJson(payload);
    const attempt: PreparedStartExecutionAttempt = {
      attemptId: randomUUID(),
      userId,
      reservedExecutionId: randomUUID(),
      workflowId: graph.id,
      workflowVersion: graph.metadata.version,
      workflowDigest: workflowGraphDigest(graph),
      requestPayload,
      inputFingerprint: createHash("sha256").update(requestPayload).digest("hex"),
      expiresAt: now + START_ATTEMPT_TTL_MS,
      createdAt: now,
    };
    await this.repository.prepareStartExecutionAttempt(attempt);
    return attempt;
  }

  async claimStart(
    attempt: ExecutionAttempt,
    execution: WorkflowExecution,
    graph: WorkflowGraph,
  ): Promise<StartAttemptOutcome> {
    if (attempt.inputFingerprint === null)
      throw new ValidationError("ATTEMPT_INVALID_OR_EXPIRED: the attempt is unavailable.");
    const claim = await this.repository.claimStartExecutionAttempt({
      attemptId: attempt.attemptId,
      userId: attempt.userId,
      workflowId: graph.id!,
      workflowVersion: graph.metadata.version,
      workflowDigest: workflowGraphDigest(graph),
      ownerId: this.ownerId,
      now: this.now(),
      leaseMs: EXECUTION_ATTEMPT_LEASE_MS,
      execution,
    });
    switch (claim.kind) {
      case "claimed":
        return {
          kind: "claimed",
          ownerId: this.ownerId,
          fence: claim.fence,
          inputFingerprint: attempt.inputFingerprint,
        };
      case "completed":
        executionMutationAttemptsTotal.inc({ operation: "start", outcome: "safe_replay" });
        return { kind: "replay", response: claim.response };
      case "processing":
        return this.waitForReceipt(attempt.attemptId, attempt.inputFingerprint, "start");
      case "outcome_unknown":
        executionMutationAttemptsTotal.inc({ operation: "start", outcome: "outcome_unknown" });
        return { kind: "outcome_unknown", response: currentAttemptGuidance(claim.attempt) };
      case "conflict":
      case "stale":
        executionMutationAttemptsTotal.inc({ operation: "start", outcome: "stale_rejection" });
        throw new ConflictError(
          "ATTEMPT_STALE: start preconditions changed. Prepare a new start attempt.",
          { attemptOutcome: "stale_rejection", attemptMetricRecorded: true },
        );
      case "invalid":
        executionMutationAttemptsTotal.inc({ operation: "start", outcome: "stale_rejection" });
        throw new ValidationError("ATTEMPT_INVALID_OR_EXPIRED: the attempt is unavailable.", {
          attemptOutcome: "stale_rejection",
          attemptMetricRecorded: true,
        });
    }
  }

  async completeStartPrecondition(
    attemptId: string,
    userId: string,
    response: string,
  ): Promise<StartPreconditionOutcome> {
    const result = await this.repository.completeStartAttemptPrecondition(
      attemptId,
      userId,
      response,
      this.now(),
    );
    switch (result.kind) {
      case "completed":
        executionMutationAttemptsTotal.inc({ operation: "start", outcome: "original" });
        return { response: result.response, outcome: "original" };
      case "replay":
        executionMutationAttemptsTotal.inc({ operation: "start", outcome: "safe_replay" });
        return { response: result.response, outcome: "safe_replay" };
      case "processing": {
        const waited = await this.waitForReceipt(
          attemptId,
          result.attempt.inputFingerprint!,
          "start",
        );
        return {
          response: waited.response,
          outcome: waited.kind === "replay" ? "safe_replay" : "outcome_unknown",
        };
      }
      case "outcome_unknown":
        executionMutationAttemptsTotal.inc({ operation: "start", outcome: "outcome_unknown" });
        return {
          response: currentAttemptGuidance(result.attempt),
          outcome: "outcome_unknown",
        };
      case "invalid":
        executionMutationAttemptsTotal.inc({ operation: "start", outcome: "stale_rejection" });
        throw new ValidationError("ATTEMPT_INVALID_OR_EXPIRED: the attempt is unavailable.", {
          attemptOutcome: "stale_rejection",
        });
    }
  }

  async replayCompletedStep(
    attemptId: string,
    authenticatedUserId: string,
    executionId: string,
    input: unknown,
    teleportTo?: string,
  ): Promise<string | null> {
    const attempt = await this.repository.getExecutionAttempt(attemptId);
    if (!attempt || attempt.operation !== "step" || attempt.userId !== authenticatedUserId) {
      executionMutationAttemptsTotal.inc({ operation: "step", outcome: "stale_rejection" });
      throw new ValidationError("ATTEMPT_INVALID_OR_EXPIRED: the attempt is unavailable.", {
        attemptOutcome: "stale_rejection",
      });
    }
    if (attempt.executionId !== executionId) {
      executionMutationAttemptsTotal.inc({ operation: "step", outcome: "stale_rejection" });
      throw new ConflictError("ATTEMPT_STALE: the attempt belongs to another workflow state.", {
        attemptOutcome: "stale_rejection",
      });
    }
    const fingerprint = stepMutationFingerprint(input, teleportTo);
    if (attempt.inputFingerprint && attempt.inputFingerprint !== fingerprint) {
      executionMutationAttemptsTotal.inc({ operation: "step", outcome: "conflicting_replay" });
      throw new ConflictError("ATTEMPT_CONFLICT: this attempt has different input.", {
        attemptOutcome: "conflicting_replay",
      });
    }
    if (attempt.state !== "completed") return null;
    if (attempt.response === null) {
      throw new ValidationError("ATTEMPT_INVALID_OR_EXPIRED: the replay receipt is unavailable.", {
        attemptOutcome: "stale_rejection",
      });
    }
    executionMutationAttemptsTotal.inc({ operation: "step", outcome: "safe_replay" });
    return attempt.response;
  }

  async claimStep(
    attemptId: string,
    execution: WorkflowExecution,
    graph: WorkflowGraph,
    input: unknown,
    teleportTo?: string,
    authenticatedUserId = execution.userId,
  ): Promise<StepAttemptOutcome> {
    if (!execution.currentNodeId) throw new ValidationError("Execution has no current step");
    const inputFingerprint = stepMutationFingerprint(input, teleportTo);
    const claim = await this.repository.claimExecutionAttempt({
      attemptId,
      userId: authenticatedUserId,
      executionId: execution.executionId,
      executionRevision: execution.revision,
      nodeId: execution.currentNodeId,
      workflowId: execution.workflowId,
      workflowVersion: graph.metadata.version,
      workflowDigest: workflowGraphDigest(graph),
      inputFingerprint,
      ownerId: this.ownerId,
      now: this.now(),
      leaseMs: EXECUTION_ATTEMPT_LEASE_MS,
    });
    switch (claim.kind) {
      case "claimed":
        return { kind: "claimed", ownerId: this.ownerId, fence: claim.fence, inputFingerprint };
      case "completed":
        executionMutationAttemptsTotal.inc({ operation: "step", outcome: "safe_replay" });
        return { kind: "replay", response: claim.response };
      case "processing":
        return await this.waitForStepReceipt(attemptId, inputFingerprint);
      case "outcome_unknown":
        executionMutationAttemptsTotal.inc({ operation: "step", outcome: "outcome_unknown" });
        throw new ConflictError(
          "ATTEMPT_OUTCOME_UNKNOWN: this workflow mutation may already have produced effects and will not be repeated automatically. Inspect the execution and cancel it if recovery is required.",
          { attemptOutcome: "outcome_unknown" },
        );
      case "conflict":
        executionMutationAttemptsTotal.inc({ operation: "step", outcome: "conflicting_replay" });
        throw new ConflictError(
          "ATTEMPT_CONFLICT: this attempt was already submitted with different input. Use the current step attempt instead.",
          { attemptOutcome: "conflicting_replay" },
        );
      case "stale":
        executionMutationAttemptsTotal.inc({ operation: "step", outcome: "stale_rejection" });
        throw new ConflictError(
          "ATTEMPT_STALE: this attempt no longer matches the current workflow step. Read session current_step and use its attempt.",
          { attemptOutcome: "stale_rejection" },
        );
      case "invalid":
        executionMutationAttemptsTotal.inc({ operation: "step", outcome: "stale_rejection" });
        throw new ValidationError(
          "ATTEMPT_INVALID_OR_EXPIRED: the attempt is unavailable. Read session current_step and use its current attempt.",
          { attemptOutcome: "stale_rejection" },
        );
    }
  }

  async openLease(
    attemptId: string,
    fence: number,
    ownerId = this.ownerId,
  ): Promise<ExecutionAttemptLease> {
    let stopped = false;
    let ownershipLost = false;
    const renew = async (): Promise<boolean> => {
      if (stopped || ownershipLost) return false;
      const owned = await this.repository.heartbeatExecutionAttempt(
        attemptId,
        ownerId,
        fence,
        this.now(),
        EXECUTION_ATTEMPT_LEASE_MS,
      );
      if (!owned) ownershipLost = true;
      return owned;
    };
    const assertOwned = async (): Promise<void> => {
      if (!(await renew())) {
        throw new ConflictError(
          "ATTEMPT_OUTCOME_UNKNOWN: attempt ownership changed before workflow effects; the mutation will not be repeated automatically.",
          { attemptOutcome: "outcome_unknown" },
        );
      }
    };

    await assertOwned();
    const timer = setInterval(() => {
      void renew().catch((error) => this.logger.error("Workflow mutation heartbeat failed", error));
    }, EXECUTION_ATTEMPT_HEARTBEAT_MS);
    timer.unref?.();
    return {
      assertOwned,
      stop: () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private async waitForReceipt(
    attemptId: string,
    inputFingerprint: string,
    operation: "step" | "start" = "step",
  ): Promise<ReceiptWaitOutcome> {
    const deadline = this.now() + this.waitMs;
    while (this.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.waitPollMs));
      const attempt = await this.repository.getExecutionAttempt(attemptId);
      if (!attempt) {
        throw new ValidationError("ATTEMPT_INVALID_OR_EXPIRED: the attempt is unavailable.", {
          attemptOutcome: "stale_rejection",
        });
      }
      if (attempt.inputFingerprint !== inputFingerprint) {
        throw new ConflictError("ATTEMPT_CONFLICT: this attempt has different input.", {
          attemptOutcome: "conflicting_replay",
        });
      }
      if (attempt.state === "completed" && attempt.response !== null) {
        executionMutationAttemptsTotal.inc({ operation, outcome: "safe_replay" });
        return { kind: "replay", response: attempt.response };
      }
      if (attempt.state === "outcome_unknown") {
        executionMutationAttemptsTotal.inc({ operation, outcome: "outcome_unknown" });
        if (operation === "start")
          return { kind: "outcome_unknown", response: currentAttemptGuidance(attempt) };
        throw new ConflictError("ATTEMPT_OUTCOME_UNKNOWN: inspect the execution before recovery.", {
          attemptOutcome: "outcome_unknown",
        });
      }
    }
    executionMutationAttemptsTotal.inc({ operation, outcome: "processing" });
    throw new ConflictError(
      "ATTEMPT_PROCESSING: this attempt is still processing. Retry the same attempt.",
      {
        attemptOutcome: "processing",
        ...(operation === "start" && { attemptMetricRecorded: true }),
      },
    );
  }

  private async waitForStepReceipt(
    attemptId: string,
    inputFingerprint: string,
  ): Promise<StepAttemptOutcome> {
    const outcome = await this.waitForReceipt(attemptId, inputFingerprint, "step");
    if (outcome.kind === "outcome_unknown") {
      throw new ConflictError("ATTEMPT_OUTCOME_UNKNOWN: inspect the execution before recovery.", {
        attemptOutcome: "outcome_unknown",
      });
    }
    return outcome;
  }
}

export function presentedAttemptResponse(attemptId: string, response: string): string {
  const [firstLine, ...rest] = response.split("\n");
  return `${firstLine}\nStep attempt ID: ${attemptId}${rest.length ? `\n${rest.join("\n")}` : ""}`;
}

export function currentAttemptGuidance(attempt: ExecutionAttempt): string {
  if (attempt.state === "outcome_unknown") {
    return `Process ID: ${attempt.executionId}\n\nATTEMPT_OUTCOME_UNKNOWN: a previous mutation may have produced effects. It will not be repeated automatically. Inspect the execution and cancel it if recovery is required.`;
  }
  if (attempt.state === "executing") {
    return `Process ID: ${attempt.executionId}\nStep attempt ID: ${attempt.attemptId}\n\nATTEMPT_PROCESSING: this attempt is still processing. Retry the same attempt.`;
  }
  return (
    attempt.response ?? `Process ID: ${attempt.executionId}\nStep attempt ID: ${attempt.attemptId}`
  );
}
