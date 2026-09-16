import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../utils/canonical-json.js";
import { ConflictError } from "../../errors/index.js";
import type {
  ClaimStartExecutionAttemptInput,
  CompleteExecutionAttemptInput,
  ExecutionAttempt,
  ExecutionAttemptClaimResult,
  PreparedStartExecutionAttempt,
  PresentedExecutionAttempt,
  ReconciledExecutionAttemptCounts,
  RecoverExecutionToNodeInput,
  RecoverExecutionToNodeResult,
  StartPreconditionCompletionResult,
  WorkflowExecution,
} from "@mcp-moira/workflow-engine";
import type { ExecutionError } from "../../types/execution-error.js";
import {
  stepAttemptBindingMatches,
  stepAttemptContinuationMatches,
} from "../../types/step-attempt-binding.js";

type AttemptRow = {
  attemptId: string;
  operation: "step" | "start";
  userId: string;
  executionId: string | null;
  reservedExecutionId: string | null;
  executionRevision: number | null;
  nodeId: string | null;
  workflowId: string;
  workflowVersion: string;
  workflowDigest: string;
  continuationDigest: string | null;
  continuationFacts: string | null;
  requestPayload: string | null;
  inputFingerprint: string | null;
  state: "presented" | "executing" | "completed" | "outcome_unknown" | "superseded";
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
};

const STEP_RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STEP_RECEIPT_LIMIT = 1_000;
const START_PREPARATION_LIMIT = 100;
const START_RECEIPT_LIMIT = 1_000;

function asAttempt(row: AttemptRow): ExecutionAttempt {
  return { ...row };
}

function serializeExecution(execution: WorkflowExecution) {
  return {
    state: execution.status,
    currentNodeId: execution.currentNodeId,
    waitingForInputNodeId: execution.waitingForInputNodeId ?? null,
    context: JSON.stringify(execution.globalContext),
    error: execution.error ?? null,
    errors: execution.errors?.length ? JSON.stringify(execution.errors) : null,
    note: execution.note ?? null,
    parentExecutionId: execution.parentExecutionId ?? null,
    reminders: JSON.stringify(execution.reminders ?? []),
    visits: JSON.stringify(execution.visits ?? []),
    updatedAt: execution.updatedAt,
    completedAt: execution.completedAt ?? null,
  };
}

export class ExecutionAttemptRepository {
  constructor(private readonly sqlite: Database.Database) {}

  prepareStart(attempt: PreparedStartExecutionAttempt): void {
    this.sqlite
      .transaction(() => {
        this.sqlite
          .prepare(
            `DELETE FROM executionMutationAttempt
             WHERE operation = 'start' AND state = 'presented' AND userId = ? AND expiresAt <= ?`,
          )
          .run(attempt.userId, attempt.createdAt);
        const live = this.sqlite
          .prepare(
            `SELECT count(*) AS count FROM executionMutationAttempt
             WHERE operation = 'start' AND state = 'presented' AND userId = ?`,
          )
          .get(attempt.userId) as { count: number };
        const overflow = live.count - START_PREPARATION_LIMIT + 1;
        if (overflow > 0) {
          this.sqlite
            .prepare(
              `DELETE FROM executionMutationAttempt WHERE attemptId IN (
                 SELECT attemptId FROM executionMutationAttempt
                 WHERE operation = 'start' AND state = 'presented' AND userId = ?
                 ORDER BY createdAt ASC, attemptId ASC LIMIT ?
               )`,
            )
            .run(attempt.userId, overflow);
        }
        this.sqlite
          .prepare(
            `INSERT INTO executionMutationAttempt (
              attemptId, operation, userId, reservedExecutionId, workflowId, workflowVersion,
              workflowDigest, requestPayload, inputFingerprint, state, expiresAt, createdAt,
              updatedAt
            ) VALUES (?, 'start', ?, ?, ?, ?, ?, ?, ?, 'presented', ?, ?, ?)`,
          )
          .run(
            attempt.attemptId,
            attempt.userId,
            attempt.reservedExecutionId,
            attempt.workflowId,
            attempt.workflowVersion,
            attempt.workflowDigest,
            attempt.requestPayload,
            attempt.inputFingerprint,
            attempt.expiresAt,
            attempt.createdAt,
            attempt.createdAt,
          );
      })
      .immediate();
  }

  claimStart(input: ClaimStartExecutionAttemptInput): ExecutionAttemptClaimResult {
    return this.sqlite
      .transaction((): ExecutionAttemptClaimResult => {
        const row = this.sqlite
          .prepare("SELECT * FROM executionMutationAttempt WHERE attemptId = ?")
          .get(input.attemptId) as AttemptRow | undefined;
        if (!row || row.operation !== "start" || row.userId !== input.userId)
          return { kind: "invalid" };
        if (row.state === "completed" && row.response !== null)
          return { kind: "completed", attempt: asAttempt(row), response: row.response };
        if (row.state === "outcome_unknown")
          return { kind: "outcome_unknown", attempt: asAttempt(row) };
        if (row.state === "executing") return { kind: "processing", attempt: asAttempt(row) };
        if (row.expiresAt === null || row.expiresAt <= input.now) {
          this.sqlite
            .prepare("DELETE FROM executionMutationAttempt WHERE attemptId = ?")
            .run(row.attemptId);
          return { kind: "invalid" };
        }
        if (
          row.reservedExecutionId !== input.execution.executionId ||
          row.workflowId !== input.workflowId ||
          row.workflowVersion !== input.workflowVersion ||
          row.workflowDigest !== input.workflowDigest ||
          row.inputFingerprint === null
        )
          return { kind: "stale" };

        const storedWorkflow = this.sqlite
          .prepare(`SELECT graph, version, userId, visibility, deleted FROM workflow WHERE id = ?`)
          .get(row.workflowId) as
          | { graph: string; version: string; userId: string; visibility: string; deleted: number }
          | undefined;
        if (
          !storedWorkflow ||
          storedWorkflow.deleted === 1 ||
          (storedWorkflow.userId !== input.userId && storedWorkflow.visibility !== "public") ||
          storedWorkflow.version !== row.workflowVersion
        )
          return { kind: "stale" };
        try {
          const digest = createHash("sha256")
            .update(canonicalJson(JSON.parse(storedWorkflow.graph)))
            .digest("hex");
          if (digest !== row.workflowDigest) return { kind: "stale" };
        } catch {
          return { kind: "stale" };
        }

        if (input.execution.parentExecutionId) {
          const parent = this.sqlite
            .prepare(`SELECT userId, state FROM workflowExecution WHERE executionId = ?`)
            .get(input.execution.parentExecutionId) as
            { userId: string; state: string } | undefined;
          if (!parent || parent.userId !== input.userId || parent.state !== "running")
            return { kind: "stale" };
        }
        if (
          this.sqlite
            .prepare("SELECT 1 FROM workflowExecution WHERE executionId = ?")
            .get(input.execution.executionId)
        )
          return { kind: "stale" };

        const execution = serializeExecution(input.execution);
        this.sqlite
          .prepare(
            `INSERT INTO workflowExecution (
              executionId, workflowId, userId, state, currentNodeId, waitingForInputNodeId,
              context, error, errors, note, parentExecutionId, revision, reminders, visits,
              workflowVersion, createdAt, updatedAt, completedAt
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.execution.executionId,
            input.execution.workflowId,
            input.execution.userId,
            execution.state,
            execution.currentNodeId,
            execution.waitingForInputNodeId,
            execution.context,
            execution.error,
            execution.errors,
            execution.note,
            execution.parentExecutionId,
            input.execution.revision,
            execution.reminders,
            execution.visits,
            input.execution.workflowVersion ?? null,
            input.execution.createdAt,
            execution.updatedAt,
            execution.completedAt,
          );
        const fence = row.fence + 1;
        const changed = this.sqlite
          .prepare(
            `UPDATE executionMutationAttempt
             SET executionId = ?, executionRevision = ?, nodeId = ?, state = 'executing',
                 ownerId = ?, fence = ?, heartbeatAt = ?, leaseExpiresAt = ?, updatedAt = ?
             WHERE attemptId = ? AND state = 'presented' AND fence = ?`,
          )
          .run(
            input.execution.executionId,
            input.execution.revision,
            input.execution.currentNodeId,
            input.ownerId,
            fence,
            input.now,
            input.now + input.leaseMs,
            input.now,
            input.attemptId,
            row.fence,
          );
        if (changed.changes !== 1) throw new Error("Start attempt ownership changed during claim");
        return {
          kind: "claimed",
          fence,
          attempt: asAttempt({
            ...row,
            executionId: input.execution.executionId,
            executionRevision: input.execution.revision,
            nodeId: input.execution.currentNodeId,
            state: "executing",
            ownerId: input.ownerId,
            fence,
            heartbeatAt: input.now,
            leaseExpiresAt: input.now + input.leaseMs,
            updatedAt: input.now,
          }),
        };
      })
      .immediate();
  }

  completeStartPrecondition(
    attemptId: string,
    userId: string,
    response: string,
    now: number,
  ): StartPreconditionCompletionResult {
    return this.sqlite
      .transaction((): StartPreconditionCompletionResult => {
        const row = this.sqlite
          .prepare("SELECT * FROM executionMutationAttempt WHERE attemptId = ?")
          .get(attemptId) as AttemptRow | undefined;
        if (!row || row.operation !== "start" || row.userId !== userId) return { kind: "invalid" };
        if (row.state === "completed" && row.response !== null)
          return { kind: "replay", response: row.response };
        if (row.state === "executing") return { kind: "processing", attempt: asAttempt(row) };
        if (row.state === "outcome_unknown")
          return { kind: "outcome_unknown", attempt: asAttempt(row) };
        if (row.expiresAt === null || row.expiresAt <= now) {
          this.sqlite
            .prepare("DELETE FROM executionMutationAttempt WHERE attemptId = ?")
            .run(attemptId);
          return { kind: "invalid" };
        }
        const changed = this.sqlite
          .prepare(
            `UPDATE executionMutationAttempt SET state = 'completed', response = ?,
             completedAt = ?, updatedAt = ? WHERE attemptId = ? AND state = 'presented'`,
          )
          .run(response, now, now, attemptId);
        return changed.changes === 1 ? { kind: "completed", response } : { kind: "invalid" };
      })
      .immediate();
  }

  getBlockingStart(executionId: string, userId: string): ExecutionAttempt | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM executionMutationAttempt WHERE operation = 'start' AND state = 'outcome_unknown'
         AND executionId = ? AND userId = ? LIMIT 1`,
      )
      .get(executionId, userId) as AttemptRow | undefined;
    return row ? asAttempt(row) : null;
  }

  cancelWithStartAttempt(
    executionId: string,
    userId: string,
    expectedRevision: number,
    error: ExecutionError,
  ): boolean {
    return this.sqlite
      .transaction(() => {
        const row = this.sqlite
          .prepare(
            `SELECT errors, currentNodeId FROM workflowExecution
             WHERE executionId = ? AND userId = ? AND state = 'running' AND revision = ?
               AND EXISTS (
                 SELECT 1 FROM executionMutationAttempt
                 WHERE operation = 'start' AND state = 'outcome_unknown'
                   AND executionId = ? AND userId = ?
               )`,
          )
          .get(executionId, userId, expectedRevision, executionId, userId) as
          { errors: string | null; currentNodeId: string | null } | undefined;
        if (!row) return false;
        const errors = row.errors ? (JSON.parse(row.errors) as ExecutionError[]) : [];
        errors.push(error);
        const changed = this.sqlite
          .prepare(
            `UPDATE workflowExecution SET state = 'completed', error = ?, errors = ?, completedAt = ?,
             updatedAt = ?
             WHERE executionId = ? AND userId = ? AND state = 'running' AND revision = ?`,
          )
          .run(
            error.message,
            JSON.stringify(errors),
            error.timestamp,
            error.timestamp,
            executionId,
            userId,
            expectedRevision,
          );
        if (changed.changes !== 1) return false;
        this.sqlite
          .prepare(
            `DELETE FROM executionMutationAttempt
             WHERE operation = 'start' AND state = 'outcome_unknown'
               AND executionId = ? AND userId = ?`,
          )
          .run(executionId, userId);
        return true;
      })
      .immediate();
  }

  createPresented(attempt: PresentedExecutionAttempt): void {
    this.sqlite
      .prepare(
        `INSERT INTO executionMutationAttempt (
          attemptId, operation, userId, executionId, executionRevision, nodeId,
          workflowId, workflowVersion, workflowDigest, continuationDigest, continuationFacts,
          state, response, createdAt, updatedAt
        ) VALUES (?, 'step', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'presented', ?, ?, ?)`,
      )
      .run(
        attempt.attemptId,
        attempt.userId,
        attempt.executionId,
        attempt.executionRevision,
        attempt.nodeId,
        attempt.workflowId,
        attempt.workflowVersion,
        attempt.workflowDigest,
        attempt.continuationDigest,
        attempt.continuationFacts,
        attempt.response,
        attempt.createdAt,
        attempt.createdAt,
      );
  }

  /**
   * Replace the execution's current presentation with `next`: the presented attempt (if any) is
   * marked `superseded` and linked to the new one, which is created in its place. Refuses while
   * an agent is executing the current attempt or its outcome is unknown.
   */
  supersedePresented(next: PresentedExecutionAttempt): void {
    this.sqlite
      .transaction(() => {
        const current = this.getCurrent(next.executionId, next.userId);
        if (current && current.state !== "presented") {
          throw new ConflictError(
            "An agent step is in progress on this execution; wait for it to finish before answering",
            { executionId: next.executionId, attemptId: current.attemptId, state: current.state },
          );
        }
        if (current) {
          this.sqlite
            .prepare(
              `UPDATE executionMutationAttempt SET state = 'superseded', nextAttemptId = ?,
               completedAt = ?, updatedAt = ? WHERE attemptId = ? AND state = 'presented'`,
            )
            .run(next.attemptId, next.createdAt, next.createdAt, current.attemptId);
        }
        this.createPresented(next);
      })
      .immediate();
  }

  ensureCurrentPresented(candidate: PresentedExecutionAttempt): ExecutionAttempt {
    return this.sqlite
      .transaction(() => {
        const current = this.getCurrent(candidate.executionId, candidate.userId);
        if (!current) {
          this.createPresented(candidate);
          const created = this.get(candidate.attemptId);
          if (!created) throw new Error("Created execution attempt was not persisted");
          return created;
        }
        const revisionOnlyStale =
          current.state === "presented" && stepAttemptContinuationMatches(current, candidate);
        if (!revisionOnlyStale || current.executionRevision === candidate.executionRevision) {
          return current;
        }
        const changed = this.sqlite
          .prepare(
            `UPDATE executionMutationAttempt SET executionRevision = ?, updatedAt = ?
             WHERE attemptId = ? AND state = 'presented' AND executionRevision IS ?`,
          )
          .run(
            candidate.executionRevision,
            candidate.createdAt,
            current.attemptId,
            current.executionRevision,
          );
        if (changed.changes !== 1) {
          const authoritative = this.getCurrent(candidate.executionId, candidate.userId);
          if (!authoritative) throw new Error("Current execution attempt disappeared");
          return authoritative;
        }
        return {
          ...current,
          executionRevision: candidate.executionRevision,
          updatedAt: candidate.createdAt,
        };
      })
      .immediate();
  }

  get(attemptId: string): ExecutionAttempt | null {
    const row = this.sqlite
      .prepare("SELECT * FROM executionMutationAttempt WHERE attemptId = ?")
      .get(attemptId) as AttemptRow | undefined;
    return row ? asAttempt(row) : null;
  }

  updatePresentedResponse(
    attemptId: string,
    userId: string,
    response: string,
    now: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE executionMutationAttempt SET response = ?, updatedAt = ?
           WHERE attemptId = ? AND userId = ? AND state = 'presented'`,
        )
        .run(response, now, attemptId, userId).changes === 1
    );
  }

  getCurrent(executionId: string, userId: string): ExecutionAttempt | null {
    const row = this.sqlite
      .prepare(
        `SELECT * FROM executionMutationAttempt
         WHERE executionId = ? AND userId = ? AND operation = 'step'
           AND state IN ('presented', 'executing', 'outcome_unknown')
         ORDER BY createdAt DESC LIMIT 1`,
      )
      .get(executionId, userId) as AttemptRow | undefined;
    return row ? asAttempt(row) : null;
  }

  claim(input: {
    attemptId: string;
    userId: string;
    executionId: string;
    executionRevision: number;
    nodeId: string;
    workflowId: string;
    continuationDigest: string;
    inputFingerprint: string;
    ownerId: string;
    now: number;
    leaseMs: number;
  }): ExecutionAttemptClaimResult {
    return this.sqlite
      .transaction((): ExecutionAttemptClaimResult => {
        const row = this.sqlite
          .prepare("SELECT * FROM executionMutationAttempt WHERE attemptId = ?")
          .get(input.attemptId) as AttemptRow | undefined;
        if (!row || row.operation !== "step" || row.userId !== input.userId)
          return { kind: "invalid" };
        if (row.executionId !== input.executionId) return { kind: "stale" };
        if (row.state === "superseded") return { kind: "stale" };
        if (row.inputFingerprint !== null && row.inputFingerprint !== input.inputFingerprint) {
          return { kind: "conflict" };
        }
        if (row.state === "completed" && row.response !== null) {
          return { kind: "completed", attempt: asAttempt(row), response: row.response };
        }
        if (!stepAttemptBindingMatches(row, input)) return { kind: "stale" };
        if (row.state === "outcome_unknown")
          return { kind: "outcome_unknown", attempt: asAttempt(row) };
        if (row.state === "executing") return { kind: "processing", attempt: asAttempt(row) };

        const fence = row.fence + 1;
        const result = this.sqlite
          .prepare(
            `UPDATE executionMutationAttempt
           SET state = 'executing', inputFingerprint = ?, ownerId = ?, fence = ?,
               heartbeatAt = ?, leaseExpiresAt = ?, updatedAt = ?
           WHERE attemptId = ? AND state = 'presented' AND fence = ?`,
          )
          .run(
            input.inputFingerprint,
            input.ownerId,
            fence,
            input.now,
            input.now + input.leaseMs,
            input.now,
            input.attemptId,
            row.fence,
          );
        if (result.changes !== 1) return { kind: "processing", attempt: asAttempt(row) };
        return {
          kind: "claimed",
          fence,
          attempt: asAttempt({
            ...row,
            state: "executing",
            inputFingerprint: input.inputFingerprint,
            ownerId: input.ownerId,
            fence,
            heartbeatAt: input.now,
            leaseExpiresAt: input.now + input.leaseMs,
            updatedAt: input.now,
          }),
        };
      })
      .immediate();
  }

  heartbeat(
    attemptId: string,
    ownerId: string,
    fence: number,
    now: number,
    leaseMs: number,
  ): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE executionMutationAttempt SET heartbeatAt = ?, leaseExpiresAt = ?, updatedAt = ?
           WHERE attemptId = ? AND state = 'executing' AND ownerId = ? AND fence = ?`,
        )
        .run(now, now + leaseMs, now, attemptId, ownerId, fence).changes === 1
    );
  }

  /**
   * Move a paused execution to a node it can resume from and retire the attempt it was holding.
   * One transaction, guarded on the execution exactly as a step completion is: the caller's read of
   * the execution must still be what is stored, or the move is refused rather than applied to a
   * state the caller never saw. An attempt that is being executed, or whose outcome is unknown, is
   * refused too — recovery must not race a caller that may still commit.
   *
   * The retired attempt is marked superseded and linked to the fresh one installed for the target in
   * the same transaction, so the run always holds an attempt. Rendering that attempt's text happens
   * afterwards through the ordinary presentation path; if it never happens, the run is still usable
   * from the attempt written here.
   */
  recoverToNode(input: RecoverExecutionToNodeInput): RecoverExecutionToNodeResult {
    return this.sqlite
      .transaction((): RecoverExecutionToNodeResult => {
        const current = this.getCurrent(input.execution.executionId, input.execution.userId);
        if (current && current.state !== "presented") return "attempt_in_progress";

        const execution = serializeExecution(input.execution);
        const expected = serializeExecution(input.expectedExecution);
        const now = Date.now();
        const update = this.sqlite
          .prepare(
            `UPDATE workflowExecution SET state = ?, currentNodeId = ?, waitingForInputNodeId = ?,
               context = ?, updatedAt = ?, revision = revision + 1
             WHERE executionId = ? AND revision = ? AND state = ?
               AND currentNodeId IS ? AND waitingForInputNodeId IS ? AND context = ?`,
          )
          .run(
            execution.state,
            execution.currentNodeId,
            execution.waitingForInputNodeId,
            execution.context,
            now,
            input.execution.executionId,
            input.expectedExecution.revision,
            expected.state,
            expected.currentNodeId,
            expected.waitingForInputNodeId,
            expected.context,
          );
        if (update.changes !== 1) return "execution_changed";

        if (current) {
          this.sqlite
            .prepare(
              `UPDATE executionMutationAttempt SET state = 'superseded', nextAttemptId = ?,
                 completedAt = ?, updatedAt = ? WHERE attemptId = ? AND state = 'presented'`,
            )
            .run(input.nextAttempt.attemptId, now, now, current.attemptId);
        }
        this.createPresented(input.nextAttempt);
        return "recovered";
      })
      .immediate();
  }

  complete(input: CompleteExecutionAttemptInput): boolean {
    const nextRevision = input.execution.revision + 1;
    const completedTransaction = this.sqlite
      .transaction(() => {
        const current = this.sqlite
          .prepare(
            `SELECT executionRevision FROM executionMutationAttempt
           WHERE attemptId = ? AND state = 'executing' AND ownerId = ? AND fence = ?`,
          )
          .get(input.attemptId, input.ownerId, input.fence) as
          { executionRevision: number } | undefined;
        if (!current) return false;

        const execution = serializeExecution(input.execution);
        const expectedExecution = serializeExecution(input.expectedExecution);
        const noteChanged = input.execution.note !== input.expectedExecution.note;
        const update = this.sqlite
          .prepare(
            `UPDATE workflowExecution SET state = ?, currentNodeId = ?, waitingForInputNodeId = ?,
             context = ?, visits = ?, note = CASE WHEN ? = 1 THEN ? ELSE note END,
             updatedAt = ?, completedAt = ?, revision = revision + 1
           WHERE executionId = ? AND revision = ? AND state = ?
             AND currentNodeId IS ? AND waitingForInputNodeId IS ? AND context = ?
             AND (? = 0 OR note IS ?)`,
          )
          .run(
            execution.state,
            execution.currentNodeId,
            execution.waitingForInputNodeId,
            execution.context,
            execution.visits,
            noteChanged ? 1 : 0,
            execution.note,
            execution.updatedAt,
            execution.completedAt,
            input.execution.executionId,
            input.execution.revision,
            expectedExecution.state,
            expectedExecution.currentNodeId,
            expectedExecution.waitingForInputNodeId,
            expectedExecution.context,
            noteChanged ? 1 : 0,
            expectedExecution.note,
          );
        if (update.changes !== 1) return false;
        const now = Date.now();
        const completed = this.sqlite
          .prepare(
            `UPDATE executionMutationAttempt SET state = 'completed', response = ?, nextAttemptId = ?,
             ownerId = NULL, heartbeatAt = NULL, leaseExpiresAt = NULL, completedAt = ?, updatedAt = ?
           WHERE attemptId = ? AND state = 'executing' AND ownerId = ? AND fence = ?
             AND inputFingerprint = ?`,
          )
          .run(
            input.response,
            input.nextAttempt?.attemptId ?? null,
            now,
            now,
            input.attemptId,
            input.ownerId,
            input.fence,
            input.inputFingerprint,
          );
        if (completed.changes !== 1) throw new Error("Attempt ownership changed during completion");
        if (input.nextAttempt) {
          const next = { ...input.nextAttempt, executionRevision: nextRevision };
          this.createPresented(next);
        }
        return true;
      })
      .immediate();
    if (completedTransaction) input.execution.revision = nextRevision;
    return completedTransaction;
  }

  markOutcomeUnknown(attemptId: string, ownerId: string, fence: number, now: number): boolean {
    return (
      this.sqlite
        .prepare(
          `UPDATE executionMutationAttempt SET state = 'outcome_unknown', response = NULL,
             ownerId = NULL, heartbeatAt = NULL, leaseExpiresAt = NULL, updatedAt = ?
           WHERE attemptId = ? AND state = 'executing' AND ownerId = ? AND fence = ?`,
        )
        .run(now, attemptId, ownerId, fence).changes === 1
    );
  }

  reconcileExpired(now: number): ReconciledExecutionAttemptCounts {
    const rows = this.sqlite
      .prepare(
        `UPDATE executionMutationAttempt SET state = 'outcome_unknown', response = NULL,
           ownerId = NULL, heartbeatAt = NULL, leaseExpiresAt = NULL, updatedAt = ?
         WHERE state = 'executing' AND leaseExpiresAt < ?
         RETURNING operation`,
      )
      .all(now, now) as Array<{ operation: "start" | "step" }>;
    return rows.reduce<ReconciledExecutionAttemptCounts>(
      (counts, row) => ({ ...counts, [row.operation]: counts[row.operation] + 1 }),
      { start: 0, step: 0 },
    );
  }

  cleanup(now: number): number {
    return this.sqlite
      .transaction(() => {
        let removed = this.sqlite
          .prepare(
            `DELETE FROM executionMutationAttempt
           WHERE operation = 'step' AND state IN ('completed', 'superseded') AND completedAt < ?`,
          )
          .run(now - STEP_RECEIPT_TTL_MS).changes;
        removed += this.sqlite
          .prepare(
            `DELETE FROM executionMutationAttempt WHERE attemptId IN (
             SELECT attemptId FROM (
               SELECT attemptId, row_number() OVER (
                 PARTITION BY executionId ORDER BY completedAt DESC, attemptId DESC
               ) AS position
               FROM executionMutationAttempt
               WHERE operation = 'step' AND state IN ('completed', 'superseded')
             ) WHERE position > ?
           )`,
          )
          .run(STEP_RECEIPT_LIMIT).changes;
        removed += this.sqlite
          .prepare(
            `DELETE FROM executionMutationAttempt
             WHERE operation = 'start' AND state = 'presented' AND expiresAt <= ?`,
          )
          .run(now).changes;
        removed += this.sqlite
          .prepare(
            `DELETE FROM executionMutationAttempt
             WHERE operation = 'start' AND state = 'completed' AND completedAt < ?`,
          )
          .run(now - STEP_RECEIPT_TTL_MS).changes;
        removed += this.sqlite
          .prepare(
            `DELETE FROM executionMutationAttempt WHERE attemptId IN (
             SELECT attemptId FROM (
               SELECT attemptId, row_number() OVER (
                 PARTITION BY userId ORDER BY completedAt DESC, attemptId DESC
               ) AS position
               FROM executionMutationAttempt
               WHERE operation = 'start' AND state = 'completed'
             ) WHERE position > ?
           )`,
          )
          .run(START_RECEIPT_LIMIT).changes;
        return removed;
      })
      .immediate();
  }
}
