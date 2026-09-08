import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import {
  AuditAction,
  getDatabase,
  getWorkflowService,
  metricsRegistry,
  user,
} from "@mcp-moira/shared";
import {
  DatabaseRepository,
  ExecutionMutationCoordinator,
  stepMutationFingerprint,
  workflowGraphDigest,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { startWorkflow } from "../../packages/mcp-server/src/tools/start-workflow.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";

const USER_ID = "replay-audit-user";

describe("replay-safe step audit classification", () => {
  beforeAll(async () => {
    const now = new Date().toISOString();
    await getDatabase()
      .insert(user)
      .values({
        id: USER_ID,
        email: `${USER_ID}@example.test`,
        handle: USER_ID,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
  });

  afterEach(() => MCPEngine.resetInstance());

  test("records bounded outcomes without request, fingerprint, or receipt content", async () => {
    const repository = new DatabaseRepository();
    const graph: WorkflowGraph = {
      metadata: { name: "Replay audit", version: "1.0.0", description: "Audit test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "task" } },
        {
          type: "agent-directive",
          id: "task",
          directive: "Return nothing",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    const saved = await getWorkflowService().save({
      graph,
      userId: USER_ID,
      visibility: "private",
    });
    const stored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
    const engine = MCPEngine.getInstance(repository);
    const executionId = await engine.executor.startWorkflow(stored, undefined, USER_ID);
    const presentation = await engine.executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    const attemptId = presentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
    expect(attemptId).toBeDefined();
    let secondExecutionId: string | undefined;

    try {
      const original = await requestContext.run({ userId: USER_ID }, () =>
        engine.executeStep(executionId, {}, undefined, attemptId!),
      );
      await requestContext.run({ userId: USER_ID }, () =>
        engine.executeStep(executionId, {}, undefined, attemptId!),
      );
      await expect(
        requestContext.run({ userId: USER_ID }, () =>
          engine.executeStep(executionId, { changed: true }, undefined, attemptId!),
        ),
      ).rejects.toThrow("ATTEMPT_CONFLICT");

      secondExecutionId = await engine.executor.startWorkflow(stored, undefined, USER_ID);
      const secondPresentation = await engine.executor.executeStep(
        secondExecutionId,
        undefined,
        undefined,
        { userId: USER_ID, createPresentation: true },
      );
      const secondAttemptId = secondPresentation.match(/Step attempt ID:\s*([a-f0-9-]+)/i)?.[1];
      expect(secondAttemptId).toBeDefined();
      await expect(
        requestContext.run({ userId: USER_ID }, () =>
          engine.executeStep(secondExecutionId!, {}, undefined, attemptId!),
        ),
      ).rejects.toThrow("ATTEMPT_INVALID_OR_EXPIRED");

      const secondExecution = (await repository.getExecution(secondExecutionId))!;
      const claim = await repository.claimExecutionAttempt({
        attemptId: secondAttemptId!,
        userId: USER_ID,
        executionId: secondExecutionId,
        executionRevision: secondExecution.revision,
        nodeId: secondExecution.currentNodeId!,
        workflowId: secondExecution.workflowId,
        workflowVersion: stored.metadata.version,
        workflowDigest: workflowGraphDigest(stored),
        inputFingerprint: stepMutationFingerprint({}),
        ownerId: "busy-audit-owner",
        now: Date.now(),
        leaseMs: 30_000,
      });
      expect(claim.kind).toBe("claimed");
      (
        engine.executor as unknown as {
          mutationCoordinator: ExecutionMutationCoordinator;
        }
      ).mutationCoordinator = new ExecutionMutationCoordinator(repository, Date.now, 15, 1);
      await expect(
        requestContext.run({ userId: USER_ID }, () =>
          engine.executeStep(secondExecutionId!, {}, undefined, secondAttemptId!),
        ),
      ).rejects.toThrow("ATTEMPT_PROCESSING");
      expect(
        await repository.markExecutionAttemptOutcomeUnknown(
          secondAttemptId!,
          "busy-audit-owner",
          claim.kind === "claimed" ? claim.fence : 0,
          Date.now(),
        ),
      ).toBe(true);
      await expect(
        requestContext.run({ userId: USER_ID }, () =>
          engine.executeStep(secondExecutionId!, {}, undefined, secondAttemptId!),
        ),
      ).rejects.toThrow("ATTEMPT_OUTCOME_UNKNOWN");

      const logs = await repository.listAuditLogs({
        userId: USER_ID,
        action: AuditAction.EXECUTION_STEP_ATTEMPT,
        limit: 50,
      });
      const classifications = logs
        .filter(
          (entry) =>
            entry.resource === "execution_attempt" &&
            (entry.resourceId === executionId || entry.resourceId === secondExecutionId),
        )
        .map((entry) => JSON.parse(entry.metadata ?? "{}") as Record<string, unknown>);
      expect(classifications).toEqual(
        expect.arrayContaining([
          { operation: "step", outcome: "original" },
          { operation: "step", outcome: "safe_replay" },
          { operation: "step", outcome: "conflicting_replay" },
          { operation: "step", outcome: "stale_rejection" },
          { operation: "step", outcome: "processing" },
          { operation: "step", outcome: "outcome_unknown" },
        ]),
      );
      const serialized = JSON.stringify(classifications);
      expect(serialized).not.toContain(attemptId);
      expect(serialized).not.toContain(original);
      expect(serialized).not.toContain("inputFingerprint");
      const metrics = await metricsRegistry.metrics();
      for (const outcome of [
        "original",
        "safe_replay",
        "conflicting_replay",
        "stale_rejection",
        "processing",
        "outcome_unknown",
      ]) {
        expect(metrics).toContain(`operation="step",outcome="${outcome}"`);
      }
      expect(metrics).not.toContain(attemptId);
      expect(metrics).not.toContain(original);
    } finally {
      if (secondExecutionId) await repository.deleteExecution(secondExecutionId);
      await repository.deleteExecution(executionId);
      await repository.deleteWorkflow(saved.id, USER_ID);
    }
  });

  test("records start originals and replays without attempt payload or receipt content", async () => {
    const repository = new DatabaseRepository();
    const graph: WorkflowGraph = {
      metadata: { name: "Start replay audit", version: "1.0.0", description: "Start audit" },
      nodes: [
        { type: "start", id: "start", connections: { default: "task" } },
        {
          type: "agent-directive",
          id: "task",
          directive: "Private directive must not enter attempt audit",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    const saved = await getWorkflowService().save({
      graph,
      userId: USER_ID,
      visibility: "private",
    });
    const engine = MCPEngine.getInstance(repository);
    let executionId: string | undefined;
    try {
      const prepared = await requestContext.run({ userId: USER_ID }, () =>
        startWorkflow({
          action: "prepare",
          workflowId: saved.id,
          parentExecutionId: "none",
          skipNotificationCheck: true,
          note: "Private note must not enter attempt audit",
        }),
      );
      const startAttemptId = prepared.data?.match(/Start attempt ID:\s*([a-f0-9-]+)/i)?.[1];
      expect(startAttemptId).toBeDefined();
      const original = await requestContext.run({ userId: USER_ID }, () =>
        startWorkflow({ action: "execute", startAttemptId: startAttemptId! }),
      );
      const replay = await requestContext.run({ userId: USER_ID }, () =>
        startWorkflow({ action: "execute", startAttemptId: startAttemptId! }),
      );
      expect(replay).toEqual(original);
      executionId = original.data?.match(/Process ID:\s*([a-f0-9-]+)/i)?.[1];

      const rejectedPreparation = await requestContext.run({ userId: USER_ID }, () =>
        startWorkflow({
          action: "prepare",
          workflowId: saved.id,
          parentExecutionId: "none",
          skipNotificationCheck: true,
        }),
      );
      const rejectedAttemptId = rejectedPreparation.data?.match(
        /Start attempt ID:\s*([a-f0-9-]+)/i,
      )?.[1];
      const rejectedReservedId = rejectedPreparation.data?.match(
        /Process ID:\s*([a-f0-9-]+)/i,
      )?.[1];
      expect(rejectedAttemptId).toBeDefined();
      expect(rejectedReservedId).toBeDefined();
      await requestContext.run({ userId: USER_ID }, () =>
        engine.rejectPreparedWorkflowStart(
          rejectedAttemptId!,
          "START_PRECONDITION_CHANGED: test receipt",
        ),
      );

      const logs = await repository.listAuditLogs({
        userId: USER_ID,
        action: AuditAction.EXECUTION_STEP_ATTEMPT,
        limit: 50,
      });
      const classifications = logs
        .map((entry) => JSON.parse(entry.metadata ?? "{}") as Record<string, unknown>)
        .filter((metadata) => metadata.operation === "start");
      expect(classifications).toEqual(
        expect.arrayContaining([
          { operation: "start", outcome: "original" },
          { operation: "start", outcome: "safe_replay" },
        ]),
      );
      const serialized = JSON.stringify(classifications);
      expect(serialized).not.toContain(startAttemptId);
      expect(serialized).not.toContain(original.data);
      expect(serialized).not.toContain("Private note");
      expect(serialized).not.toContain("Private directive");
      expect(logs.some((entry) => entry.resourceId === rejectedReservedId)).toBe(true);
      expect(JSON.stringify(logs)).not.toContain(rejectedAttemptId);
      const metrics = await metricsRegistry.metrics();
      expect(metrics).toContain('operation="start",outcome="original"');
      expect(metrics).toContain('operation="start",outcome="safe_replay"');
      const lifecycle = await repository.listAuditLogs({
        userId: USER_ID,
        action: AuditAction.EXECUTION_START,
        limit: 50,
      });
      expect(lifecycle.filter((entry) => entry.resourceId === executionId)).toHaveLength(1);
    } finally {
      if (executionId) await repository.deleteExecution(executionId);
      await repository.deleteWorkflow(saved.id, USER_ID);
    }
  });

  test("records bounded start processing, unknown, and stale outcomes without payload content", async () => {
    const repository = new DatabaseRepository();
    const graph: WorkflowGraph = {
      metadata: { name: "Start bounded audit", version: "1.0.0", description: "Start outcomes" },
      nodes: [
        { type: "start", id: "start", connections: { default: "task" } },
        {
          type: "agent-directive",
          id: "task",
          directive: "Wait",
          completionCondition: "Done",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    const saved = await getWorkflowService().save({
      graph,
      userId: USER_ID,
      visibility: "private",
    });
    const stored = (await repository.getWorkflowGraph(saved.id, USER_ID))!;
    const engine = MCPEngine.getInstance(repository);
    let executionId: string | undefined;
    try {
      const preparation = await requestContext.run({ userId: USER_ID }, () =>
        startWorkflow({
          action: "prepare",
          workflowId: saved.id,
          parentExecutionId: "none",
          skipNotificationCheck: true,
        }),
      );
      const startAttemptId = preparation.data?.match(/Start attempt ID:\s*([a-f0-9-]+)/i)?.[1];
      executionId = preparation.data?.match(/Process ID:\s*([a-f0-9-]+)/i)?.[1];
      expect(startAttemptId).toBeDefined();
      expect(executionId).toBeDefined();
      const attempt = (await repository.getExecutionAttempt(startAttemptId!))!;
      const execution = engine.executor.createWorkflowExecution(
        stored,
        undefined,
        USER_ID,
        undefined,
        undefined,
        executionId!,
      );
      const claim = await repository.claimStartExecutionAttempt({
        attemptId: startAttemptId!,
        userId: USER_ID,
        workflowId: saved.id,
        workflowVersion: stored.metadata.version,
        workflowDigest: workflowGraphDigest(stored),
        ownerId: "busy-start-audit-owner",
        now: Date.now(),
        leaseMs: 30_000,
        execution,
      });
      expect(claim.kind).toBe("claimed");
      (
        engine as unknown as { mutationCoordinator: ExecutionMutationCoordinator }
      ).mutationCoordinator = new ExecutionMutationCoordinator(repository, Date.now, 15, 1);
      const processing = await requestContext.run({ userId: USER_ID }, () =>
        startWorkflow({ action: "execute", startAttemptId: startAttemptId! }),
      );
      expect(processing.success).toBe(false);
      expect(processing.error).toContain("ATTEMPT_PROCESSING");
      expect(processing.error).toContain("same Process ID, attempt ID, and input");
      expect(processing.error?.toLowerCase()).not.toContain("stop");
      expect(
        await repository.markExecutionAttemptOutcomeUnknown(
          startAttemptId!,
          "busy-start-audit-owner",
          claim.kind === "claimed" ? claim.fence : 0,
          Date.now(),
        ),
      ).toBe(true);
      const unknown = await requestContext.run({ userId: USER_ID }, () =>
        startWorkflow({ action: "execute", startAttemptId: startAttemptId! }),
      );
      expect(unknown.data).toContain("ATTEMPT_OUTCOME_UNKNOWN");
      const invalidId = "00000000-0000-4000-8000-000000000099";
      const stale = await requestContext.run({ userId: USER_ID }, () =>
        startWorkflow({ action: "execute", startAttemptId: invalidId }),
      );
      expect(stale.success).toBe(false);

      const logs = await repository.listAuditLogs({
        userId: USER_ID,
        action: AuditAction.EXECUTION_STEP_ATTEMPT,
        limit: 100,
      });
      const classifications = logs
        .map((entry) => JSON.parse(entry.metadata ?? "{}") as Record<string, unknown>)
        .filter((metadata) => metadata.operation === "start");
      expect(classifications).toEqual(
        expect.arrayContaining([
          { operation: "start", outcome: "processing" },
          { operation: "start", outcome: "outcome_unknown" },
          { operation: "start", outcome: "stale_rejection" },
        ]),
      );
      const serialized = JSON.stringify(classifications);
      expect(serialized).not.toContain(startAttemptId);
      expect(serialized).not.toContain(invalidId);
      expect(serialized).not.toContain(attempt.requestPayload);
      const metrics = await metricsRegistry.metrics();
      for (const outcome of ["processing", "outcome_unknown", "stale_rejection"]) {
        expect(metrics).toContain(`operation="start",outcome="${outcome}"`);
      }
      await requestContext.run({ userId: USER_ID }, () =>
        getSessionInfo({ action: "cancel-execution", executionId, expectedRevision: 0 }),
      );
    } finally {
      if (executionId) await repository.deleteExecution(executionId);
      await repository.deleteWorkflow(saved.id, USER_ID);
    }
  });
});
