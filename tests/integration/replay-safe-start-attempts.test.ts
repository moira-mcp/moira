import { afterEach, describe, expect, jest, test } from "@jest/globals";
import {
  ExecutionMutationCoordinator,
  InMemoryRepository,
  UserNotificationHandler,
  workflowGraphDigest,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";
import { startWorkflow } from "../../packages/mcp-server/src/tools/start-workflow.js";
import {
  activeExecutionsGauge,
  AuditAction,
  executionMutationAttemptsTotal,
  workflowExecutionsTotal,
} from "@mcp-moira/shared";

const USER_ID = "replay-safe-start-user";

function graph(id: string, effect = false): WorkflowGraph {
  return {
    id,
    metadata: { name: id, version: "1.0.0", description: "Replay-safe start test" },
    nodes: [
      { type: "start", id: "start", connections: { default: effect ? "notify" : "task" } },
      ...(effect
        ? [
            {
              type: "user-notification" as const,
              id: "notify",
              message: "One start effect",
              connections: { default: "task" },
            },
          ]
        : []),
      {
        type: "agent-directive",
        id: "task",
        directive: "Continue",
        completionCondition: "Done",
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

function startAttemptId(response: string): string {
  const value = response.match(/Start attempt ID:\s*([a-f0-9-]+)/i)?.[1];
  if (!value) throw new Error(`Missing start attempt: ${response}`);
  return value;
}

function processId(response: string): string {
  const value = response.match(/Process ID:\s*([a-f0-9-]+)/i)?.[1];
  if (!value) throw new Error(`Missing process ID: ${response}`);
  return value;
}

function installEngine(repository: InMemoryRepository) {
  Object.assign(repository, { logAudit: async () => undefined });
  return MCPEngine.getInstance(repository);
}

async function prepare(workflowId: string) {
  const result = await requestContext.run({ userId: USER_ID }, () =>
    startWorkflow({
      action: "prepare",
      workflowId,
      parentExecutionId: "none",
      skipNotificationCheck: true,
    }),
  );
  expect(result.success).toBe(true);
  return result.data!;
}

async function execute(attemptId: string) {
  return requestContext.run({ userId: USER_ID }, () =>
    startWorkflow({ action: "execute", startAttemptId: attemptId }),
  );
}

async function activeExecutionMetric(): Promise<number> {
  return (await activeExecutionsGauge.get()).values[0]?.value ?? 0;
}

async function startedExecutionMetric(workflowId: string): Promise<number> {
  return (
    (await workflowExecutionsTotal.get()).values.find(
      (value) => value.labels.status === "started" && value.labels.workflow_id === workflowId,
    )?.value ?? 0
  );
}

async function startUnknownMetric(): Promise<number> {
  return (
    (await executionMutationAttemptsTotal.get()).values.find(
      (value) => value.labels.operation === "start" && value.labels.outcome === "outcome_unknown",
    )?.value ?? 0
  );
}

describe("replay-safe workflow start attempts", () => {
  afterEach(() => MCPEngine.resetInstance());

  test("prepare reserves an ID without creating an execution and separate preparations remain intentional", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-two-intentional");
    await repository.saveWorkflow(workflow, USER_ID);
    installEngine(repository);

    const firstPreparation = await prepare(workflow.id!);
    const secondPreparation = await prepare(workflow.id!);
    expect(startAttemptId(firstPreparation)).not.toBe(startAttemptId(secondPreparation));
    expect(processId(firstPreparation)).not.toBe(processId(secondPreparation));
    expect(await repository.getExecution(processId(firstPreparation))).toBeNull();

    const [first, second] = await Promise.all([
      execute(startAttemptId(firstPreparation)),
      execute(startAttemptId(secondPreparation)),
    ]);
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(await repository.getExecution(processId(first.data!))).not.toBeNull();
    expect(await repository.getExecution(processId(second.data!))).not.toBeNull();
  });

  test("concurrent and later duplicate execute calls produce one process, one effect, and one exact receipt", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-concurrent-effect", true);
    await repository.saveWorkflow(workflow, USER_ID);
    const engine = installEngine(repository);
    let deliveries = 0;
    let started!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => (release = resolve));
    const graphEngine = (
      engine.executor as unknown as { graphEngine: { nodeHandlers: Map<string, unknown> } }
    ).graphEngine;
    graphEngine.nodeHandlers.set(
      "user-notification",
      new UserNotificationHandler({
        deliver: async () => {
          deliveries += 1;
          started();
          await barrier;
          return {
            status: "delivered",
            configuredChannels: 1,
            deliveredChannels: 1,
            channels: [{ channelId: "test", status: "delivered" }],
          };
        },
      } as never),
    );

    const preparation = await prepare(workflow.id!);
    const attemptId = startAttemptId(preparation);
    const first = execute(attemptId);
    await deliveryStarted;
    const duplicate = execute(attemptId);
    expect(deliveries).toBe(1);
    release();
    const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);
    expect(duplicateResult).toEqual(firstResult);
    expect(await execute(attemptId)).toEqual(firstResult);
    expect(deliveries).toBe(1);
    expect(processId(firstResult.data!)).toBe(processId(preparation));
  });

  test("a lifecycle audit failure after claim immediately fails closed before workflow effects", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-post-claim-audit-failure", true);
    await repository.saveWorkflow(workflow, USER_ID);
    let failedLifecycleAudit = false;
    Object.assign(repository, {
      logAudit: async (entry: { action: string }) => {
        if (entry.action === AuditAction.EXECUTION_START && !failedLifecycleAudit) {
          failedLifecycleAudit = true;
          throw new Error("injected lifecycle audit failure");
        }
      },
    });
    const engine = MCPEngine.getInstance(repository);
    const unknownBefore = await startUnknownMetric();
    let deliveries = 0;
    const graphEngine = (
      engine.executor as unknown as { graphEngine: { nodeHandlers: Map<string, unknown> } }
    ).graphEngine;
    graphEngine.nodeHandlers.set(
      "user-notification",
      new UserNotificationHandler({
        deliver: async () => {
          deliveries += 1;
          return {
            status: "delivered",
            configuredChannels: 1,
            deliveredChannels: 1,
            channels: [{ channelId: "test", status: "delivered" }],
          };
        },
      } as never),
    );

    const preparation = await prepare(workflow.id!);
    const result = await execute(startAttemptId(preparation));
    const attempt = await repository.getExecutionAttempt(startAttemptId(preparation));

    expect(result.success).toBe(false);
    expect(result.error).toContain("ATTEMPT_OUTCOME_UNKNOWN");
    expect(attempt?.state).toBe("outcome_unknown");
    expect(attempt?.executionId).toBe(processId(preparation));
    expect(await repository.getExecution(processId(preparation))).not.toBeNull();
    expect(deliveries).toBe(0);
    expect(await startUnknownMetric()).toBe(unknownBefore + 1);
  });

  test("a worker fenced while post-claim audit is blocked cannot enter workflow effects", async () => {
    let now = 1_000;
    const repository = new InMemoryRepository();
    const workflow = graph("start-post-claim-fenced", true);
    await repository.saveWorkflow(workflow, USER_ID);
    let auditStarted!: () => void;
    const started = new Promise<void>((resolve) => (auditStarted = resolve));
    let releaseAudit!: () => void;
    const auditBarrier = new Promise<void>((resolve) => (releaseAudit = resolve));
    Object.assign(repository, {
      logAudit: async (entry: { action: string }) => {
        if (entry.action !== AuditAction.EXECUTION_START) return;
        auditStarted();
        await auditBarrier;
      },
    });
    const engine = MCPEngine.getInstance(repository);
    (
      engine as unknown as { mutationCoordinator: ExecutionMutationCoordinator }
    ).mutationCoordinator = new ExecutionMutationCoordinator(repository, () => now);
    let deliveries = 0;
    const graphEngine = (
      engine.executor as unknown as { graphEngine: { nodeHandlers: Map<string, unknown> } }
    ).graphEngine;
    graphEngine.nodeHandlers.set(
      "user-notification",
      new UserNotificationHandler({
        deliver: async () => {
          deliveries += 1;
          return {
            status: "delivered",
            configuredChannels: 1,
            deliveredChannels: 1,
            channels: [{ channelId: "test", status: "delivered" }],
          };
        },
      } as never),
    );

    const preparation = await prepare(workflow.id!);
    const pending = execute(startAttemptId(preparation));
    await started;
    now = 31_001;
    expect(await repository.reconcileExpiredExecutionAttempts(now)).toEqual({
      start: 1,
      step: 0,
    });
    releaseAudit();
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.error).toContain("ATTEMPT_OUTCOME_UNKNOWN");
    expect((await repository.getExecutionAttempt(startAttemptId(preparation)))?.state).toBe(
      "outcome_unknown",
    );
    expect(deliveries).toBe(0);
  });

  test("heartbeat renewal protects a Start claim while lifecycle audit is delayed", async () => {
    jest.useFakeTimers();
    let now = 1_000;
    try {
      const repository = new InMemoryRepository();
      const workflow = graph("start-post-claim-heartbeat", true);
      await repository.saveWorkflow(workflow, USER_ID);
      let auditStarted!: () => void;
      const started = new Promise<void>((resolve) => (auditStarted = resolve));
      let releaseAudit!: () => void;
      const auditBarrier = new Promise<void>((resolve) => (releaseAudit = resolve));
      Object.assign(repository, {
        logAudit: async (entry: { action: string }) => {
          if (entry.action !== AuditAction.EXECUTION_START) return;
          auditStarted();
          await auditBarrier;
        },
      });
      const engine = MCPEngine.getInstance(repository);
      (
        engine as unknown as { mutationCoordinator: ExecutionMutationCoordinator }
      ).mutationCoordinator = new ExecutionMutationCoordinator(repository, () => now);
      let deliveries = 0;
      const graphEngine = (
        engine.executor as unknown as { graphEngine: { nodeHandlers: Map<string, unknown> } }
      ).graphEngine;
      graphEngine.nodeHandlers.set(
        "user-notification",
        new UserNotificationHandler({
          deliver: async () => {
            deliveries += 1;
            return {
              status: "delivered",
              configuredChannels: 1,
              deliveredChannels: 1,
              channels: [{ channelId: "test", status: "delivered" }],
            };
          },
        } as never),
      );

      const preparation = await prepare(workflow.id!);
      const pending = execute(startAttemptId(preparation));
      await started;
      for (let heartbeat = 1; heartbeat <= 7; heartbeat += 1) {
        now = 1_000 + heartbeat * 5_000;
        await jest.advanceTimersByTimeAsync(5_000);
      }
      expect(await repository.reconcileExpiredExecutionAttempts(now + 1)).toEqual({
        start: 0,
        step: 0,
      });
      releaseAudit();
      const result = await pending;

      expect(result.success).toBe(true);
      expect(deliveries).toBe(1);
      expect((await repository.getExecutionAttempt(startAttemptId(preparation)))?.state).toBe(
        "completed",
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test("in-memory recovery cancellation requires the matching unknown Start attempt", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-cancel-attempt-authority");
    await repository.saveWorkflow(workflow, USER_ID);
    const engine = installEngine(repository);
    const ordinaryExecutionId = await engine.executor.startWorkflow(workflow, undefined, USER_ID);
    const ordinaryBefore = await repository.getExecution(ordinaryExecutionId);
    const cancellationError = {
      timestamp: 10_000,
      nodeId: "start",
      errorType: "system" as const,
      message: "Cancelled during recovery",
    };

    expect(
      await repository.cancelExecutionWithStartAttempt(
        ordinaryExecutionId,
        USER_ID,
        ordinaryBefore!.revision,
        cancellationError,
      ),
    ).toBe(false);
    expect(await repository.getExecution(ordinaryExecutionId)).toEqual(ordinaryBefore);

    await repository.createPresentedExecutionAttempt(
      new ExecutionMutationCoordinator(repository).newPresentedAttempt(
        ordinaryBefore!,
        workflow,
        "Wrong-operation attempt",
        "6c53e8a8-f468-48c0-942f-cb88f15e3be8",
      ),
    );
    expect(
      await repository.cancelExecutionWithStartAttempt(
        ordinaryExecutionId,
        USER_ID,
        ordinaryBefore!.revision,
        cancellationError,
      ),
    ).toBe(false);
    expect(await repository.getExecution(ordinaryExecutionId)).toEqual(ordinaryBefore);

    const coordinator = new ExecutionMutationCoordinator(repository);
    const prepared = await coordinator.prepareStart(USER_ID, workflow, {
      note: null,
      parentExecutionId: null,
      skipNotificationCheck: true,
    });
    const blockedExecution = engine.executor.createWorkflowExecution(
      workflow,
      undefined,
      USER_ID,
      undefined,
      undefined,
      prepared.reservedExecutionId,
    );
    const claim = await repository.claimStartExecutionAttempt({
      attemptId: prepared.attemptId,
      userId: USER_ID,
      workflowId: workflow.id!,
      workflowVersion: workflow.metadata.version,
      workflowDigest: workflowGraphDigest(workflow),
      ownerId: "cancel-authority-owner",
      now: 1_000,
      leaseMs: 30_000,
      execution: blockedExecution,
    });
    expect(claim.kind).toBe("claimed");
    const executingBefore = await repository.getExecution(prepared.reservedExecutionId);
    expect(
      await repository.cancelExecutionWithStartAttempt(
        prepared.reservedExecutionId,
        USER_ID,
        executingBefore!.revision,
        cancellationError,
      ),
    ).toBe(false);
    expect(await repository.getExecution(prepared.reservedExecutionId)).toEqual(executingBefore);
    expect(
      await repository.markExecutionAttemptOutcomeUnknown(
        prepared.attemptId,
        "cancel-authority-owner",
        claim.kind === "claimed" ? claim.fence : 0,
        2_000,
      ),
    ).toBe(true);
    const blockedBefore = await repository.getExecution(prepared.reservedExecutionId);

    expect(
      await repository.cancelExecutionWithStartAttempt(
        prepared.reservedExecutionId,
        "foreign-user",
        blockedBefore!.revision,
        cancellationError,
      ),
    ).toBe(false);
    expect(
      await repository.cancelExecutionWithStartAttempt(
        prepared.reservedExecutionId,
        USER_ID,
        blockedBefore!.revision + 1,
        cancellationError,
      ),
    ).toBe(false);
    expect(await repository.getExecution(prepared.reservedExecutionId)).toEqual(blockedBefore);

    expect(
      await repository.cancelExecutionWithStartAttempt(
        prepared.reservedExecutionId,
        USER_ID,
        blockedBefore!.revision,
        cancellationError,
      ),
    ).toBe(true);
    expect(await repository.getExecutionAttempt(prepared.attemptId)).toBeNull();
    expect(await repository.getExecution(prepared.reservedExecutionId)).toMatchObject({
      status: "completed",
      error: cancellationError.message,
      revision: blockedBefore!.revision,
    });
  });

  test("prepare and replay do not duplicate active or started execution lifecycle metrics", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-lifecycle-metrics");
    await repository.saveWorkflow(workflow, USER_ID);
    installEngine(repository);
    const activeBefore = await activeExecutionMetric();
    const startedBefore = await startedExecutionMetric(workflow.id!);
    const preparation = await prepare(workflow.id!);
    expect(await activeExecutionMetric()).toBe(activeBefore);
    expect(await startedExecutionMetric(workflow.id!)).toBe(startedBefore);
    const original = await execute(startAttemptId(preparation));
    expect(await activeExecutionMetric()).toBe(activeBefore + 1);
    expect(await startedExecutionMetric(workflow.id!)).toBe(startedBefore + 1);
    expect(await execute(startAttemptId(preparation))).toEqual(original);
    expect(await activeExecutionMetric()).toBe(activeBefore + 1);
    expect(await startedExecutionMetric(workflow.id!)).toBe(startedBefore + 1);
  });

  test("prepare has no communication preflight effect while execute enforces current ordinary and lock delivery state", async () => {
    for (const [id, node] of [
      [
        "start-ordinary-execute-preflight",
        {
          type: "user-notification" as const,
          id: "gate",
          message: "Notify",
          connections: { default: "task" },
        },
      ],
      [
        "start-lock-execute-preflight",
        {
          type: "lock" as const,
          id: "gate",
          reason: "Approval",
          connections: { unlocked: "task" },
        },
      ],
    ] as const) {
      MCPEngine.resetInstance();
      const repository = new InMemoryRepository();
      const workflow = graph(id);
      workflow.nodes = workflow.nodes.map((current) =>
        current.id === "start" ? { ...current, connections: { default: "gate" } } : current,
      );
      workflow.nodes.splice(1, 0, node);
      await repository.saveWorkflow(workflow, USER_ID);
      installEngine(repository);
      const preparation = await requestContext.run({ userId: USER_ID }, () =>
        startWorkflow({ action: "prepare", workflowId: id, parentExecutionId: "none" }),
      );
      expect(preparation.success).toBe(true);
      expect(preparation.data).toContain("Start attempt ID:");
      expect(await repository.getExecution(processId(preparation.data!))).toBeNull();
      const result = await execute(startAttemptId(preparation.data!));
      expect(result.success).toBe(true);
      expect(result.data).toContain("START_PRECONDITION_CHANGED");
      expect(await repository.getExecution(processId(preparation.data!))).toBeNull();
    }
  });

  test("a foreign Start attempt is indistinguishable from a missing one and cannot create its reservation", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-foreign-attempt");
    await repository.saveWorkflow(workflow, USER_ID);
    installEngine(repository);
    const preparation = await prepare(workflow.id!);
    const attemptId = startAttemptId(preparation);
    const foreign = await requestContext.run({ userId: "foreign-user" }, () =>
      startWorkflow({ action: "execute", startAttemptId: attemptId }),
    );
    const missing = await requestContext.run({ userId: "foreign-user" }, () =>
      startWorkflow({
        action: "execute",
        startAttemptId: "00000000-0000-4000-8000-000000000098",
      }),
    );
    expect(foreign).toEqual(missing);
    expect(foreign.success).toBe(false);
    expect(foreign.error).toContain("ATTEMPT_INVALID_OR_EXPIRED");
    expect(await repository.getExecution(processId(preparation))).toBeNull();
  });

  test("a changed workflow completes the attempt with a stable rejection and never creates its reservation", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-precondition-change");
    await repository.saveWorkflow(workflow, USER_ID);
    installEngine(repository);
    const preparation = await prepare(workflow.id!);
    await repository.saveWorkflow(
      {
        ...workflow,
        nodes: workflow.nodes.map((node) =>
          node.id === "task" && node.type === "agent-directive"
            ? { ...node, directive: "Changed after prepare" }
            : node,
        ),
      },
      USER_ID,
    );

    const first = await execute(startAttemptId(preparation));
    const replay = await execute(startAttemptId(preparation));
    expect(first).toEqual(replay);
    expect(first.data).toContain("START_PRECONDITION_CHANGED");
    expect(await repository.getExecution(processId(preparation))).toBeNull();
  });

  test("version changes independently invalidate a preparation without creating its reservation", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-version-change");
    await repository.saveWorkflow(workflow, USER_ID);
    installEngine(repository);
    const preparation = await prepare(workflow.id!);
    await repository.saveWorkflow(
      { ...workflow, metadata: { ...workflow.metadata, version: "2.0.0" } },
      USER_ID,
    );
    const result = await execute(startAttemptId(preparation));
    expect(result.data).toContain("START_PRECONDITION_CHANGED");
    expect(await repository.getExecution(processId(preparation))).toBeNull();
  });

  test("loss of public access independently invalidates a foreign user's preparation", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-access-change");
    await repository.saveWorkflow(workflow, "workflow-owner", "public");
    installEngine(repository);
    const preparation = await prepare(workflow.id!);
    await repository.saveWorkflow(workflow, "workflow-owner", "private");
    const result = await execute(startAttemptId(preparation));
    expect(result.data).toContain("START_PRECONDITION_CHANGED");
    expect(await repository.getExecution(processId(preparation))).toBeNull();
  });

  test("an unknown claimed start is visible through current_step and owner cancellation retires it", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-recovery");
    await repository.saveWorkflow(workflow, USER_ID);
    const engine = installEngine(repository);
    const coordinator = new ExecutionMutationCoordinator(repository);
    const prepared = await coordinator.prepareStart(USER_ID, workflow, {
      note: null,
      parentExecutionId: null,
      skipNotificationCheck: true,
    });
    const execution = engine.executor.createWorkflowExecution(
      workflow,
      undefined,
      USER_ID,
      undefined,
      undefined,
      prepared.reservedExecutionId,
    );
    const claimed = await repository.claimStartExecutionAttempt({
      attemptId: prepared.attemptId,
      userId: USER_ID,
      workflowId: workflow.id!,
      workflowVersion: workflow.metadata.version,
      workflowDigest: workflowGraphDigest(workflow),
      ownerId: "failed-worker",
      now: Date.now(),
      leaseMs: 30_000,
      execution,
    });
    expect(claimed.kind).toBe("claimed");
    await repository.markExecutionAttemptOutcomeUnknown(
      prepared.attemptId,
      "failed-worker",
      claimed.kind === "claimed" ? claimed.fence : -1,
      Date.now(),
    );

    const current = await requestContext.run({ userId: USER_ID }, () =>
      getSessionInfo({ action: "current_step", executionId: execution.executionId }),
    );
    expect(current.success).toBe(true);
    expect(current.data).toContain("ATTEMPT_OUTCOME_UNKNOWN");
    const listed = await requestContext.run({ userId: USER_ID }, () =>
      getSessionInfo({ action: "executions" }),
    );
    expect(listed.success).toBe(true);
    expect(JSON.stringify(listed.data)).toContain(
      '"blockingAttempt":{"operation":"start","state":"outcome_unknown"}',
    );
    const context = await requestContext.run({ userId: USER_ID }, () =>
      getSessionInfo({ action: "execution_context", executionId: execution.executionId }),
    );
    expect(context.success).toBe(true);
    expect(JSON.stringify(context.data)).toContain(
      '"blockingAttempt":{"operation":"start","state":"outcome_unknown"}',
    );
    const foreign = await requestContext.run({ userId: "foreign-user" }, () =>
      getSessionInfo({
        action: "cancel-execution",
        executionId: execution.executionId,
        expectedRevision: 0,
      }),
    );
    expect(foreign.success).toBe(false);
    expect(foreign.error).toContain("not found");
    expect((await repository.getExecution(execution.executionId))?.status).toBe("running");
    const staleRevision = await requestContext.run({ userId: USER_ID }, () =>
      getSessionInfo({
        action: "cancel-execution",
        executionId: execution.executionId,
        expectedRevision: 1,
      }),
    );
    expect(staleRevision.success).toBe(false);
    expect((await repository.getExecution(execution.executionId))?.status).toBe("running");
    expect(
      await repository.getBlockingStartExecutionAttempt(execution.executionId, USER_ID),
    ).not.toBeNull();
    const cancelled = await requestContext.run({ userId: USER_ID }, () =>
      getSessionInfo({
        action: "cancel-execution",
        executionId: execution.executionId,
        expectedRevision: 0,
      }),
    );
    expect(cancelled).toEqual({
      success: true,
      data: { executionId: execution.executionId, cancelled: true, revision: 0 },
    });
    expect((await repository.getExecution(execution.executionId))?.status).toBe("completed");
    expect((await repository.getExecution(execution.executionId))?.error).toBe(
      "Cancelled during recovery from an unknown start outcome",
    );
    expect(
      await repository.getBlockingStartExecutionAttempt(execution.executionId, USER_ID),
    ).toBeNull();
  });

  test("an expired preparation is rejected without creating its reserved process", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-expired");
    await repository.saveWorkflow(workflow, USER_ID);
    installEngine(repository);
    const preparation = await prepare(workflow.id!);
    const reservedId = processId(preparation);
    expect(await repository.cleanupExecutionAttempts(Date.now() + 16 * 60_000)).toBe(1);
    const result = await execute(startAttemptId(preparation));
    expect(result.success).toBe(false);
    expect(result.error).toContain("ATTEMPT_INVALID_OR_EXPIRED");
    expect(await repository.getExecution(reservedId)).toBeNull();
  });

  test("a failure after atomic claim leaves a discoverable process blocked as outcome unknown", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-effect-failure", true);
    await repository.saveWorkflow(workflow, USER_ID);
    const engine = installEngine(repository);
    const graphEngine = (
      engine.executor as unknown as { graphEngine: { nodeHandlers: Map<string, unknown> } }
    ).graphEngine;
    graphEngine.nodeHandlers.set("user-notification", {
      execute: async () => {
        throw new Error("ambiguous provider failure");
      },
    } as never);
    const preparation = await prepare(workflow.id!);
    const result = await execute(startAttemptId(preparation));
    expect(result.success).toBe(false);
    const execution = await repository.getExecution(processId(preparation));
    expect(execution?.status).toBe("running");
    expect(
      (await repository.getBlockingStartExecutionAttempt(execution!.executionId, USER_ID))?.state,
    ).toBe("outcome_unknown");
    const retry = await execute(startAttemptId(preparation));
    expect(retry.success).toBe(true);
    expect(retry.data).toContain(`Process ID: ${execution!.executionId}`);
    expect(retry.data).toContain("ATTEMPT_OUTCOME_UNKNOWN");
  });

  test("a duplicate of a live start claim waits only for the bounded receipt window", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-processing-timeout");
    await repository.saveWorkflow(workflow, USER_ID);
    const engine = installEngine(repository);
    const preparingCoordinator = new ExecutionMutationCoordinator(repository);
    const prepared = await preparingCoordinator.prepareStart(USER_ID, workflow, {
      note: null,
      parentExecutionId: null,
      skipNotificationCheck: true,
    });
    const execution = engine.executor.createWorkflowExecution(
      workflow,
      undefined,
      USER_ID,
      undefined,
      undefined,
      prepared.reservedExecutionId,
    );
    const claim = await repository.claimStartExecutionAttempt({
      attemptId: prepared.attemptId,
      userId: USER_ID,
      workflowId: workflow.id!,
      workflowVersion: workflow.metadata.version,
      workflowDigest: workflowGraphDigest(workflow),
      ownerId: "busy-start-owner",
      now: Date.now(),
      leaseMs: 30_000,
      execution,
    });
    expect(claim.kind).toBe("claimed");
    const busyAttempt = (await repository.getExecutionAttempt(prepared.attemptId))!;
    const waitingCoordinator = new ExecutionMutationCoordinator(repository, Date.now, 15, 1);
    await expect(waitingCoordinator.claimStart(busyAttempt, execution, workflow)).rejects.toThrow(
      "ATTEMPT_PROCESSING",
    );
  });

  test("a precondition caller waiting on another owner reports the completed receipt as a safe replay", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-precondition-race-classification");
    await repository.saveWorkflow(workflow, USER_ID);
    const engine = installEngine(repository);
    const coordinator = new ExecutionMutationCoordinator(repository, Date.now, 100, 1);
    const prepared = await coordinator.prepareStart(USER_ID, workflow, {
      note: null,
      parentExecutionId: null,
      skipNotificationCheck: true,
    });
    const execution = engine.executor.createWorkflowExecution(
      workflow,
      undefined,
      USER_ID,
      undefined,
      undefined,
      prepared.reservedExecutionId,
    );
    const claim = await repository.claimStartExecutionAttempt({
      attemptId: prepared.attemptId,
      userId: USER_ID,
      workflowId: workflow.id!,
      workflowVersion: workflow.metadata.version,
      workflowDigest: workflowGraphDigest(workflow),
      ownerId: "winning-owner",
      now: Date.now(),
      leaseMs: 30_000,
      execution,
    });
    expect(claim.kind).toBe("claimed");
    const waiting = coordinator.completeStartPrecondition(
      prepared.attemptId,
      USER_ID,
      "must not replace the winning receipt",
    );
    await new Promise((resolve) => setTimeout(resolve, 2));
    expect(
      await repository.completeExecutionAttempt({
        attemptId: prepared.attemptId,
        ownerId: "winning-owner",
        fence: claim.kind === "claimed" ? claim.fence : 0,
        inputFingerprint: prepared.inputFingerprint,
        execution: { ...execution, currentNodeId: "task", waitingForInputNodeId: "task" },
        expectedExecution: execution,
        response: "winning start receipt",
      }),
    ).toBe(true);
    await expect(waiting).resolves.toEqual({
      response: "winning start receipt",
      outcome: "safe_replay",
    });
  });

  test("a start heartbeat preserves its owner until the renewed lease actually expires", async () => {
    const repository = new InMemoryRepository();
    const workflow = graph("start-heartbeat-reconciliation");
    await repository.saveWorkflow(workflow, USER_ID);
    const engine = installEngine(repository);
    const coordinator = new ExecutionMutationCoordinator(repository);
    const prepared = await coordinator.prepareStart(USER_ID, workflow, {
      note: null,
      parentExecutionId: null,
      skipNotificationCheck: true,
    });
    const execution = engine.executor.createWorkflowExecution(
      workflow,
      undefined,
      USER_ID,
      undefined,
      undefined,
      prepared.reservedExecutionId,
    );
    const claim = await repository.claimStartExecutionAttempt({
      attemptId: prepared.attemptId,
      userId: USER_ID,
      workflowId: workflow.id!,
      workflowVersion: workflow.metadata.version,
      workflowDigest: workflowGraphDigest(workflow),
      ownerId: "live-start-owner",
      now: 1_000,
      leaseMs: 30,
      execution,
    });
    expect(claim.kind).toBe("claimed");
    const fence = claim.kind === "claimed" ? claim.fence : 0;
    expect(
      await repository.heartbeatExecutionAttempt(
        prepared.attemptId,
        "live-start-owner",
        fence,
        1_020,
        30,
      ),
    ).toBe(true);
    expect(await repository.reconcileExpiredExecutionAttempts(1_031)).toEqual({
      start: 0,
      step: 0,
    });
    expect((await repository.getExecutionAttempt(prepared.attemptId))?.state).toBe("executing");
    expect(await repository.reconcileExpiredExecutionAttempts(1_051)).toEqual({
      start: 1,
      step: 0,
    });
    expect((await repository.getExecutionAttempt(prepared.attemptId))?.state).toBe(
      "outcome_unknown",
    );
  });
});
