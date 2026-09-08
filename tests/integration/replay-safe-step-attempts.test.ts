import { describe, expect, jest, test } from "@jest/globals";
import {
  ExecutionAttemptMaintenance,
  ExecutionMutationCoordinator,
  InMemoryRepository,
  MaterializeHandler,
  stepMutationFingerprint,
  UniversalGraphExecutor,
  UserNotificationHandler,
  workflowGraphDigest,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import {
  activeExecutionsGauge,
  executionMutationAttemptsTotal,
  metricsRegistry,
  workflowExecutionsTotal,
} from "@mcp-moira/shared";

const USER_ID = "replay-safe-user";

function attemptId(response: string): string {
  const match = response.match(/Step attempt ID:\s*([a-f0-9-]+)/i);
  if (!match) throw new Error(`No step attempt in response: ${response}`);
  return match[1];
}

async function activeExecutionMetric(): Promise<number> {
  return (await activeExecutionsGauge.get()).values[0]?.value ?? 0;
}

async function completedExecutionMetric(workflowId: string): Promise<number> {
  const metric = await workflowExecutionsTotal.get();
  return (
    metric.values.find(
      (value) => value.labels.status === "completed" && value.labels.workflow_id === workflowId,
    )?.value ?? 0
  );
}

async function attemptOutcomeMetric(operation: "start" | "step"): Promise<number> {
  const metric = await executionMutationAttemptsTotal.get();
  return (
    metric.values.find(
      (value) => value.labels.operation === operation && value.labels.outcome === "outcome_unknown",
    )?.value ?? 0
  );
}

function twoEmptyStepsGraph(id: string): WorkflowGraph {
  return {
    id,
    metadata: { name: id, version: "1.0.0", description: "Replay-safe test" },
    nodes: [
      { type: "start", id: "start", connections: { default: "first" } },
      {
        type: "agent-directive",
        id: "first",
        directive: "First empty response",
        completionCondition: "First done",
        connections: { success: "second" },
      },
      {
        type: "agent-directive",
        id: "second",
        directive: "Second empty response",
        completionCondition: "Second done",
        connections: { success: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

async function setup(id: string) {
  const repository = new InMemoryRepository();
  const graph = twoEmptyStepsGraph(id);
  await repository.saveWorkflow(graph, USER_ID);
  const executor = new UniversalGraphExecutor(repository);
  const executionId = await executor.startWorkflow(graph, undefined, USER_ID);
  const first = await executor.executeStep(executionId, undefined, undefined, {
    userId: USER_ID,
    createPresentation: true,
  });
  return { repository, executor, graph, executionId, first };
}

describe("replay-safe workflow step attempts", () => {
  test("a lost response is replayed exactly and cannot consume the next empty step", async () => {
    const { repository, executor, executionId, first } = await setup("replay-empty-steps");
    const firstAttempt = attemptId(first);

    const next = await executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: firstAttempt,
    });
    expect(next).toContain("Second empty response");
    const stateAfterOriginal = await repository.getExecution(executionId);

    const replay = await executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: firstAttempt,
    });
    expect(replay).toBe(next);
    expect(await repository.getExecution(executionId)).toEqual(stateAfterOriginal);
    expect((await repository.getCurrentExecutionAttempt(executionId, USER_ID))?.attemptId).toBe(
      attemptId(next),
    );
    const metrics = await metricsRegistry.metrics();
    expect(metrics).toContain('operation="step",outcome="original"');
    expect(metrics).toContain('operation="step",outcome="safe_replay"');
    expect(metrics).not.toContain(
      (await repository.getExecutionAttempt(firstAttempt))?.inputFingerprint ?? "missing",
    );
  });

  test("concurrent identical submissions coalesce into one external notification", async () => {
    const repository = new InMemoryRepository();
    const graph: WorkflowGraph = {
      id: "replay-concurrent-effect",
      metadata: { name: "Concurrent effect", version: "1.0.0", description: "Effect test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "first" } },
        {
          type: "agent-directive",
          id: "first",
          directive: "Trigger notification",
          completionCondition: "Ready",
          connections: { success: "notify" },
        },
        {
          type: "user-notification",
          id: "notify",
          message: "One external effect",
          connections: { default: "second" },
        },
        {
          type: "agent-directive",
          id: "second",
          directive: "Notification completed",
          completionCondition: "Observed",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    await repository.saveWorkflow(graph, USER_ID);
    const executor = new UniversalGraphExecutor(repository);
    let deliveries = 0;
    let markDeliveryStarted!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => {
      markDeliveryStarted = resolve;
    });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const graphEngine = (
      executor as unknown as { graphEngine: { nodeHandlers: Map<string, unknown> } }
    ).graphEngine;
    graphEngine.nodeHandlers.set(
      "user-notification",
      new UserNotificationHandler({
        deliver: async () => {
          deliveries += 1;
          markDeliveryStarted();
          await barrier;
          return {
            status: "delivered",
            configuredChannels: 1,
            deliveredChannels: 1,
            channels: [{ channelId: "test-provider", status: "delivered" }],
          };
        },
      } as never),
    );
    const executionId = await executor.startWorkflow(graph, undefined, USER_ID);
    const first = await executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });

    const attempt = attemptId(first);
    const left = executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: attempt,
    });
    await deliveryStarted;
    const right = executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: attempt,
    });
    expect(deliveries).toBe(1);
    release();
    const [leftResult, rightResult] = await Promise.all([left, right]);
    expect(rightResult).toBe(leftResult);
    expect(leftResult).toContain("Notification completed");
    expect(deliveries).toBe(1);
    expect((await repository.getExecution(executionId))?.globalContext.variables.notify).toEqual(
      expect.objectContaining({ userNotificationStatus: "delivered", deliveredChannels: 1 }),
    );
    const stateAfterOriginal = await repository.getExecution(executionId);
    const replayAfterLostResponse = await executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: attempt,
    });
    expect(replayAfterLostResponse).toBe(leftResult);
    expect(await repository.getExecution(executionId)).toEqual(stateAfterOriginal);
    expect(deliveries).toBe(1);
  });

  test("different executions are not serialized behind one global queue", async () => {
    const repository = new InMemoryRepository();
    const graph = twoEmptyStepsGraph("replay-parallel-executions");
    await repository.saveWorkflow(graph, USER_ID);
    const executor = new UniversalGraphExecutor(repository);
    const executionIds = await Promise.all([
      executor.startWorkflow(graph, undefined, USER_ID),
      executor.startWorkflow(graph, undefined, USER_ID),
    ]);
    const presentations = await Promise.all(
      executionIds.map((executionId) =>
        executor.executeStep(executionId, undefined, undefined, {
          userId: USER_ID,
          createPresentation: true,
        }),
      ),
    );
    const graphEngine = (
      executor as unknown as {
        graphEngine: { executeGraph: (...args: unknown[]) => Promise<unknown> };
      }
    ).graphEngine;
    const original = graphEngine.executeGraph.bind(graphEngine);
    let invocations = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    graphEngine.executeGraph = async (...args: unknown[]) => {
      invocations += 1;
      await barrier;
      return original(...args);
    };

    const calls = executionIds.map((executionId, index) =>
      executor.executeStep(executionId, {}, undefined, {
        userId: USER_ID,
        attemptId: attemptId(presentations[index]),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(invocations).toBe(2);
    release();
    await Promise.all(calls);
  });

  test("conflicting and foreign submissions do no handler work", async () => {
    const { executor, executionId, first } = await setup("replay-rejections");
    const graphEngine = (
      executor as unknown as {
        graphEngine: { executeGraph: (...args: unknown[]) => Promise<unknown> };
      }
    ).graphEngine;
    const original = graphEngine.executeGraph.bind(graphEngine);
    let invocations = 0;
    graphEngine.executeGraph = async (...args: unknown[]) => {
      invocations += 1;
      return original(...args);
    };
    const attempt = attemptId(first);

    await expect(
      executor.executeStep(executionId, {}, undefined, {
        userId: "another-user",
        attemptId: attempt,
      }),
    ).rejects.toThrow("ATTEMPT_INVALID_OR_EXPIRED");
    expect(invocations).toBe(0);

    const accepted = await executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: attempt,
    });
    expect(invocations).toBe(1);
    await expect(
      executor.executeStep(executionId, { changed: true }, undefined, {
        userId: USER_ID,
        attemptId: attempt,
      }),
    ).rejects.toThrow("ATTEMPT_CONFLICT");
    expect(invocations).toBe(1);
    expect(accepted).toContain("Second empty response");
  });

  test("a changed workflow invalidates its presented attempt before handler work", async () => {
    const { repository, executor, graph, executionId, first } =
      await setup("replay-workflow-change");
    const graphEngine = (
      executor as unknown as {
        graphEngine: { executeGraph: (...args: unknown[]) => Promise<unknown> };
      }
    ).graphEngine;
    const original = graphEngine.executeGraph.bind(graphEngine);
    let invocations = 0;
    graphEngine.executeGraph = async (...args: unknown[]) => {
      invocations += 1;
      return original(...args);
    };
    await repository.saveWorkflow(
      { ...graph, metadata: { ...graph.metadata, description: "changed after presentation" } },
      USER_ID,
    );

    await expect(
      executor.executeStep(executionId, {}, undefined, {
        userId: USER_ID,
        attemptId: attemptId(first),
      }),
    ).rejects.toThrow("ATTEMPT_STALE");
    expect(invocations).toBe(0);
  });

  test("repository claims reject stale revisions, nodes, and workflow versions without mutation", async () => {
    for (const staleBinding of ["revision", "node", "workflow-version"] as const) {
      const { repository, graph, executionId, first } = await setup(`replay-stale-${staleBinding}`);
      const execution = (await repository.getExecution(executionId))!;
      const currentAttempt = attemptId(first);
      const beforeAttempt = await repository.getExecutionAttempt(currentAttempt);
      const claim = await repository.claimExecutionAttempt({
        attemptId: currentAttempt,
        userId: USER_ID,
        executionId,
        executionRevision:
          staleBinding === "revision" ? execution.revision + 1 : execution.revision,
        nodeId: staleBinding === "node" ? "second" : execution.currentNodeId!,
        workflowId: execution.workflowId,
        workflowVersion: staleBinding === "workflow-version" ? "2.0.0" : graph.metadata.version,
        workflowDigest: workflowGraphDigest(graph),
        inputFingerprint: stepMutationFingerprint({}),
        ownerId: `stale-${staleBinding}-owner`,
        now: Date.now(),
        leaseMs: 30_000,
      });
      expect(claim.kind).toBe("stale");
      expect(await repository.getExecutionAttempt(currentAttempt)).toEqual(beforeAttempt);
      expect(await repository.getExecution(executionId)).toEqual(execution);
    }
  });

  test("reconciliation fences only an expired lease and prevents its old owner from committing", async () => {
    const { repository, graph, executionId, first } = await setup("replay-fencing");
    const execution = (await repository.getExecution(executionId))!;
    const currentAttempt = attemptId(first);
    const digest = (await repository.getExecutionAttempt(currentAttempt))!.workflowDigest;
    const claim = await repository.claimExecutionAttempt({
      attemptId: currentAttempt,
      userId: USER_ID,
      executionId,
      executionRevision: execution.revision,
      nodeId: execution.currentNodeId!,
      workflowId: execution.workflowId,
      workflowVersion: graph.metadata.version,
      workflowDigest: digest,
      inputFingerprint: "fingerprint",
      ownerId: "old-owner",
      now: 1_000,
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe("claimed");
    expect(await repository.reconcileExpiredExecutionAttempts(30_999)).toEqual({
      start: 0,
      step: 0,
    });
    expect(await repository.reconcileExpiredExecutionAttempts(31_001)).toEqual({
      start: 0,
      step: 1,
    });
    expect(
      await repository.completeExecutionAttempt({
        attemptId: currentAttempt,
        ownerId: "old-owner",
        fence: claim.kind === "claimed" ? claim.fence : 0,
        inputFingerprint: "fingerprint",
        execution,
        response: "must not commit",
      }),
    ).toBe(false);
    expect((await repository.getExecutionAttempt(currentAttempt))?.state).toBe("outcome_unknown");
  });

  test("a live heartbeat survives reconciliation and retains commit authority", async () => {
    const { repository, graph, executionId, first } = await setup("replay-live-owner");
    const execution = (await repository.getExecution(executionId))!;
    const currentAttempt = attemptId(first);
    const digest = (await repository.getExecutionAttempt(currentAttempt))!.workflowDigest;
    const claim = await repository.claimExecutionAttempt({
      attemptId: currentAttempt,
      userId: USER_ID,
      executionId,
      executionRevision: execution.revision,
      nodeId: execution.currentNodeId!,
      workflowId: execution.workflowId,
      workflowVersion: graph.metadata.version,
      workflowDigest: digest,
      inputFingerprint: "fingerprint",
      ownerId: "live-owner",
      now: 1_000,
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe("claimed");
    expect(
      await repository.heartbeatExecutionAttempt(
        currentAttempt,
        "live-owner",
        claim.kind === "claimed" ? claim.fence : 0,
        20_000,
        30_000,
      ),
    ).toBe(true);
    expect(await repository.reconcileExpiredExecutionAttempts(31_001)).toEqual({
      start: 0,
      step: 0,
    });
    expect(
      await repository.completeExecutionAttempt({
        attemptId: currentAttempt,
        ownerId: "live-owner",
        fence: claim.kind === "claimed" ? claim.fence : 0,
        inputFingerprint: "fingerprint",
        execution: { ...execution, status: "completed", currentNodeId: null },
        response: "completed by live owner",
      }),
    ).toBe(true);
  });

  test("materialize refreshes its grant while retaining and consuming one attempt", async () => {
    const repository = new InMemoryRepository();
    const graph: WorkflowGraph = {
      id: "replay-materialize-refresh",
      metadata: { name: "Materialize", version: "1.0.0", description: "Refresh test" },
      variableRegistry: {
        content: { type: "string", description: "File content", default: "hello" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "files" } },
        {
          type: "materialize",
          id: "files",
          basePath: "./output",
          files: [{ path: "README.md", from: "content" }],
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    await repository.saveWorkflow(graph, USER_ID);
    const executor = new UniversalGraphExecutor(repository);
    let grants = 0;
    const graphEngine = (
      executor as unknown as {
        graphEngine: { nodeHandlers: Map<string, unknown> };
      }
    ).graphEngine;
    graphEngine.nodeHandlers.set(
      "materialize",
      new MaterializeHandler(
        { createMaterializeToken: () => `refresh-token-${++grants}` },
        () => "https://moira.example",
      ),
    );
    const executionId = await executor.startWorkflow(graph, undefined, USER_ID);
    const first = await executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    const currentAttempt = attemptId(first);
    expect(first).toContain("refresh-token-1");
    const beforeRefresh = await repository.getExecution(executionId);

    const refreshed = await executor.presentCurrentStep(executionId);
    expect(refreshed).toContain("refresh-token-2");
    expect(attemptId(refreshed!)).toBe(currentAttempt);
    expect(await repository.getExecution(executionId)).toEqual(beforeRefresh);
    const completed = await executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: currentAttempt,
    });
    expect(completed).toContain("Workflow completed successfully");
    await expect(
      executor.executeStep(executionId, {}, undefined, {
        userId: USER_ID,
        attemptId: currentAttempt,
      }),
    ).resolves.toBe(completed);
    expect(grants).toBe(2);
  });

  test("teleport intent replays exactly, conflicts safely, and cannot cross executions", async () => {
    const repository = new InMemoryRepository();
    const graph: WorkflowGraph = {
      ...twoEmptyStepsGraph("replay-teleport-attempt"),
      nodes: [
        ...twoEmptyStepsGraph("replay-teleport-attempt").nodes.slice(0, -1),
        {
          type: "teleport",
          id: "replan",
          hint: "Replan",
          directive: "Write a new plan",
          completionCondition: "Plan written",
          connections: { success: "second" },
        },
        { type: "end", id: "end" },
      ],
    };
    await repository.saveWorkflow(graph, USER_ID);
    const executor = new UniversalGraphExecutor(repository);
    const executionIds = await Promise.all([
      executor.startWorkflow(graph, undefined, USER_ID),
      executor.startWorkflow(graph, undefined, USER_ID),
    ]);
    const presentations = await Promise.all(
      executionIds.map((executionId) =>
        executor.executeStep(executionId, undefined, undefined, {
          userId: USER_ID,
          createPresentation: true,
        }),
      ),
    );
    const firstAttempt = attemptId(presentations[0]);
    const teleported = await executor.executeStep(executionIds[0], undefined, "replan", {
      userId: USER_ID,
      attemptId: firstAttempt,
    });
    expect(teleported).toContain("Write a new plan");
    await expect(
      executor.executeStep(executionIds[0], undefined, "replan", {
        userId: USER_ID,
        attemptId: firstAttempt,
      }),
    ).resolves.toBe(teleported);
    await expect(
      executor.executeStep(executionIds[0], {}, undefined, {
        userId: USER_ID,
        attemptId: firstAttempt,
      }),
    ).rejects.toThrow("ATTEMPT_CONFLICT");
    await expect(
      executor.executeStep(executionIds[1], undefined, "replan", {
        userId: USER_ID,
        attemptId: firstAttempt,
      }),
    ).rejects.toThrow("ATTEMPT_STALE");
  });

  test("a duplicate receives bounded processing instead of waiting indefinitely", async () => {
    const { repository, graph, executionId, first } = await setup("replay-processing-timeout");
    const execution = (await repository.getExecution(executionId))!;
    const currentAttempt = attemptId(first);
    const digest = workflowGraphDigest(graph);
    const claim = await repository.claimExecutionAttempt({
      attemptId: currentAttempt,
      userId: USER_ID,
      executionId,
      executionRevision: execution.revision,
      nodeId: execution.currentNodeId!,
      workflowId: execution.workflowId,
      workflowVersion: graph.metadata.version,
      workflowDigest: digest,
      inputFingerprint: stepMutationFingerprint({}),
      ownerId: "busy-owner",
      now: Date.now(),
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe("claimed");
    const coordinator = new ExecutionMutationCoordinator(repository, Date.now, 15, 1);
    await expect(coordinator.claimStep(currentAttempt, execution, graph, {})).rejects.toThrow(
      "ATTEMPT_PROCESSING",
    );
    expect(await metricsRegistry.metrics()).toContain('operation="step",outcome="processing"');
  });

  test("recurring maintenance fences only the expired owner", async () => {
    jest.useFakeTimers();
    let stop: (() => void) | undefined;
    try {
      let now = 1_000;
      const repository = new InMemoryRepository();
      const graph = twoEmptyStepsGraph("replay-recurring-reconciler");
      await repository.saveWorkflow(graph, USER_ID);
      const executor = new UniversalGraphExecutor(repository);
      const startMetricsBefore = await attemptOutcomeMetric("start");
      const stepMetricsBefore = await attemptOutcomeMetric("step");
      const executionIds = await Promise.all([
        executor.startWorkflow(graph, undefined, USER_ID),
        executor.startWorkflow(graph, undefined, USER_ID),
      ]);
      const responses = await Promise.all(
        executionIds.map((executionId) =>
          executor.executeStep(executionId, undefined, undefined, {
            userId: USER_ID,
            createPresentation: true,
          }),
        ),
      );
      for (let index = 0; index < executionIds.length; index += 1) {
        const execution = (await repository.getExecution(executionIds[index]))!;
        const id = attemptId(responses[index]);
        const binding = (await repository.getExecutionAttempt(id))!;
        const claimed = await repository.claimExecutionAttempt({
          attemptId: id,
          userId: USER_ID,
          executionId: execution.executionId,
          executionRevision: execution.revision,
          nodeId: execution.currentNodeId!,
          workflowId: execution.workflowId,
          workflowVersion: graph.metadata.version,
          workflowDigest: binding.workflowDigest,
          inputFingerprint: `fingerprint-${index}`,
          ownerId: `owner-${index}`,
          now,
          leaseMs: 30,
        });
        expect(claimed.kind).toBe("claimed");
      }
      const startCoordinator = new ExecutionMutationCoordinator(repository, () => now);
      const preparedStart = await startCoordinator.prepareStart(USER_ID, graph, {
        note: null,
        parentExecutionId: null,
        skipNotificationCheck: true,
      });
      const startExecution = executor.createWorkflowExecution(
        graph,
        undefined,
        USER_ID,
        undefined,
        undefined,
        preparedStart.reservedExecutionId,
      );
      const claimedStart = await repository.claimStartExecutionAttempt({
        attemptId: preparedStart.attemptId,
        userId: USER_ID,
        workflowId: graph.id!,
        workflowVersion: graph.metadata.version,
        workflowDigest: workflowGraphDigest(graph),
        ownerId: "start-owner",
        now,
        leaseMs: 30,
        execution: startExecution,
      });
      expect(claimedStart.kind).toBe("claimed");
      const liveId = attemptId(responses[1]);
      const live = (await repository.getExecutionAttempt(liveId))!;
      await repository.heartbeatExecutionAttempt(liveId, "owner-1", live.fence, 1_020, 30);
      const maintenance = new ExecutionAttemptMaintenance(repository, {
        now: () => now,
        reconcileIntervalMs: 10,
        cleanupIntervalMs: 1_000,
      });
      stop = await maintenance.start();
      now = 1_031;
      await jest.advanceTimersByTimeAsync(10);
      expect((await repository.getExecutionAttempt(attemptId(responses[0])))?.state).toBe(
        "outcome_unknown",
      );
      expect((await repository.getExecutionAttempt(liveId))?.state).toBe("executing");
      expect((await repository.getExecutionAttempt(preparedStart.attemptId))?.state).toBe(
        "outcome_unknown",
      );
      expect(await attemptOutcomeMetric("start")).toBe(startMetricsBefore + 1);
      expect(await attemptOutcomeMetric("step")).toBe(stepMetricsBefore + 1);
    } finally {
      stop?.();
      jest.useRealTimers();
    }
  });

  test("a failed final execution compare-and-set becomes outcome unknown immediately", async () => {
    const { repository, executor, graph, executionId, first } = await setup("replay-final-cas");
    const second = await executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: attemptId(first),
    });
    const activeBefore = await activeExecutionMetric();
    const completedBefore = await completedExecutionMetric(graph.id!);
    repository.completeExecutionAttempt = async () => false;

    await expect(
      executor.executeStep(executionId, {}, undefined, {
        userId: USER_ID,
        attemptId: attemptId(second),
      }),
    ).rejects.toThrow("ATTEMPT_OUTCOME_UNKNOWN");
    expect((await repository.getExecutionAttempt(attemptId(second)))?.state).toBe(
      "outcome_unknown",
    );
    expect(await activeExecutionMetric()).toBe(activeBefore);
    expect(await completedExecutionMetric(graph.id!)).toBe(completedBefore);
  });

  test("terminal metrics publish once after durable completion", async () => {
    const { executor, graph, executionId, first } = await setup("replay-terminal-metrics");
    const second = await executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: attemptId(first),
    });
    const activeBefore = await activeExecutionMetric();
    const completedBefore = await completedExecutionMetric(graph.id!);
    const completion = await executor.executeStep(executionId, {}, undefined, {
      userId: USER_ID,
      attemptId: attemptId(second),
    });
    expect(await activeExecutionMetric()).toBe(activeBefore - 1);
    expect(await completedExecutionMetric(graph.id!)).toBe(completedBefore + 1);
    await expect(
      executor.executeStep(executionId, {}, undefined, {
        userId: USER_ID,
        attemptId: attemptId(second),
      }),
    ).resolves.toBe(completion);
    expect(await activeExecutionMetric()).toBe(activeBefore - 1);
    expect(await completedExecutionMetric(graph.id!)).toBe(completedBefore + 1);
  });

  test("a finalization exception becomes outcome unknown immediately", async () => {
    const { repository, executor, executionId, first } = await setup("replay-final-throw");
    repository.completeExecutionAttempt = async () => {
      throw new Error("injected completion failure");
    };

    await expect(
      executor.executeStep(executionId, {}, undefined, {
        userId: USER_ID,
        attemptId: attemptId(first),
      }),
    ).rejects.toThrow("injected completion failure");
    expect((await repository.getExecutionAttempt(attemptId(first)))?.state).toBe("outcome_unknown");
  });

  test("an immediate lease heartbeat exception fails a claimed Step closed before effects", async () => {
    const repository = new InMemoryRepository();
    const graph: WorkflowGraph = {
      id: "replay-lease-open-throw",
      metadata: { name: "Lease open failure", version: "1.0.0", description: "Lease test" },
      nodes: [
        { type: "start", id: "start", connections: { default: "first" } },
        {
          type: "agent-directive",
          id: "first",
          directive: "Trigger notification",
          completionCondition: "Ready",
          connections: { success: "notify" },
        },
        {
          type: "user-notification",
          id: "notify",
          message: "Must not be delivered",
          connections: { default: "second" },
        },
        {
          type: "agent-directive",
          id: "second",
          directive: "Notification completed",
          completionCondition: "Observed",
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    await repository.saveWorkflow(graph, USER_ID);
    const executor = new UniversalGraphExecutor(repository);
    let deliveries = 0;
    const graphEngine = (
      executor as unknown as { graphEngine: { nodeHandlers: Map<string, unknown> } }
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
            channels: [{ channelId: "test-provider", status: "delivered" }],
          };
        },
      } as never),
    );
    const executionId = await executor.startWorkflow(graph, undefined, USER_ID);
    const first = await executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    repository.heartbeatExecutionAttempt = async () => {
      throw new Error("injected lease heartbeat failure");
    };

    const setIntervalSpy = jest.spyOn(global, "setInterval");
    try {
      await expect(
        executor.executeStep(executionId, {}, undefined, {
          userId: USER_ID,
          attemptId: attemptId(first),
        }),
      ).rejects.toThrow("injected lease heartbeat failure");
      expect((await repository.getExecutionAttempt(attemptId(first)))?.state).toBe(
        "outcome_unknown",
      );
      expect(deliveries).toBe(0);
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  test("a receipt-formatting exception after graph traversal becomes outcome unknown", async () => {
    const { repository, executor, executionId, first } = await setup("replay-format-throw");
    (
      executor as unknown as {
        formatQueueResponse: () => Promise<string>;
      }
    ).formatQueueResponse = async () => {
      throw new Error("injected formatting failure");
    };
    await expect(
      executor.executeStep(executionId, {}, undefined, {
        userId: USER_ID,
        attemptId: attemptId(first),
      }),
    ).rejects.toThrow("injected formatting failure");
    expect((await repository.getExecutionAttempt(attemptId(first)))?.state).toBe("outcome_unknown");
  });

  test("a losing materialize refresh returns authoritative consumed state", async () => {
    const repository = new InMemoryRepository();
    const graph: WorkflowGraph = {
      id: "replay-materialize-race",
      metadata: { name: "Materialize race", version: "1.0.0", description: "Race test" },
      variableRegistry: {
        content: { type: "string", description: "File content", default: "hello" },
      },
      nodes: [
        { type: "start", id: "start", connections: { default: "files" } },
        {
          type: "materialize",
          id: "files",
          basePath: "./output",
          files: [{ path: "README.md", from: "content" }],
          connections: { success: "end" },
        },
        { type: "end", id: "end" },
      ],
    };
    await repository.saveWorkflow(graph, USER_ID);
    const executor = new UniversalGraphExecutor(repository);
    let grants = 0;
    const graphEngine = (
      executor as unknown as {
        graphEngine: { nodeHandlers: Map<string, unknown> };
      }
    ).graphEngine;
    graphEngine.nodeHandlers.set(
      "materialize",
      new MaterializeHandler(
        { createMaterializeToken: () => `race-token-${++grants}` },
        () => "https://moira.example",
      ),
    );
    const executionId = await executor.startWorkflow(graph, undefined, USER_ID);
    const first = await executor.executeStep(executionId, undefined, undefined, {
      userId: USER_ID,
      createPresentation: true,
    });
    const currentAttempt = attemptId(first);
    let completion = "";
    repository.updatePresentedExecutionAttemptResponse = async () => {
      completion = await executor.executeStep(executionId, {}, undefined, {
        userId: USER_ID,
        attemptId: currentAttempt,
      });
      return false;
    };

    const racedRead = await executor.presentCurrentStep(executionId);
    expect(racedRead).toBe(completion);
    expect(racedRead).not.toContain("race-token-2");
    expect(grants).toBe(2);
  });

  test("in-memory completion validates the next attempt before any mutation", async () => {
    const { repository, graph, executionId, first } = await setup("replay-memory-atomicity");
    const currentAttempt = attemptId(first);
    const execution = (await repository.getExecution(executionId))!;
    const claim = await repository.claimExecutionAttempt({
      attemptId: currentAttempt,
      userId: USER_ID,
      executionId,
      executionRevision: execution.revision,
      nodeId: execution.currentNodeId!,
      workflowId: execution.workflowId,
      workflowVersion: graph.metadata.version,
      workflowDigest: workflowGraphDigest(graph),
      inputFingerprint: stepMutationFingerprint({}),
      ownerId: "memory-owner",
      now: Date.now(),
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe("claimed");
    const beforeExecution = await repository.getExecution(executionId);
    const beforeAttempt = await repository.getExecutionAttempt(currentAttempt);

    await expect(
      repository.completeExecutionAttempt({
        attemptId: currentAttempt,
        ownerId: "memory-owner",
        fence: claim.kind === "claimed" ? claim.fence : 0,
        inputFingerprint: stepMutationFingerprint({}),
        execution: { ...execution, currentNodeId: "second", waitingForInputNodeId: "second" },
        response: "must not commit",
        nextAttempt: {
          attemptId: currentAttempt,
          userId: USER_ID,
          executionId,
          executionRevision: execution.revision,
          nodeId: "second",
          workflowId: execution.workflowId,
          workflowVersion: graph.metadata.version,
          workflowDigest: workflowGraphDigest(graph),
          response: "collision",
          createdAt: Date.now(),
        },
      }),
    ).rejects.toThrow("Next execution attempt already exists");
    expect(await repository.getExecution(executionId)).toEqual(beforeExecution);
    expect(await repository.getExecutionAttempt(currentAttempt)).toEqual(beforeAttempt);
  });

  test("in-memory completion rejects a fingerprint different from the claimed request", async () => {
    const { repository, graph, executionId, first } = await setup("replay-memory-fingerprint");
    const currentAttempt = attemptId(first);
    const execution = (await repository.getExecution(executionId))!;
    const claimedFingerprint = stepMutationFingerprint({ answer: "claimed" });
    const claim = await repository.claimExecutionAttempt({
      attemptId: currentAttempt,
      userId: USER_ID,
      executionId,
      executionRevision: execution.revision,
      nodeId: execution.currentNodeId!,
      workflowId: execution.workflowId,
      workflowVersion: graph.metadata.version,
      workflowDigest: workflowGraphDigest(graph),
      inputFingerprint: claimedFingerprint,
      ownerId: "memory-owner",
      now: Date.now(),
      leaseMs: 30_000,
    });
    expect(claim.kind).toBe("claimed");
    const beforeExecution = await repository.getExecution(executionId);
    const beforeAttempt = await repository.getExecutionAttempt(currentAttempt);
    const nextAttemptId = "mismatched-fingerprint-next-attempt";

    expect(
      await repository.completeExecutionAttempt({
        attemptId: currentAttempt,
        ownerId: "memory-owner",
        fence: claim.kind === "claimed" ? claim.fence : 0,
        inputFingerprint: stepMutationFingerprint({ answer: "different" }),
        execution: { ...execution, currentNodeId: "second", waitingForInputNodeId: "second" },
        response: "must not commit",
        nextAttempt: {
          attemptId: nextAttemptId,
          userId: USER_ID,
          executionId,
          executionRevision: execution.revision,
          nodeId: "second",
          workflowId: execution.workflowId,
          workflowVersion: graph.metadata.version,
          workflowDigest: workflowGraphDigest(graph),
          response: "must not exist",
          createdAt: Date.now(),
        },
      }),
    ).toBe(false);
    expect(await repository.getExecution(executionId)).toEqual(beforeExecution);
    expect(await repository.getExecutionAttempt(currentAttempt)).toEqual(beforeAttempt);
    expect(await repository.getExecutionAttempt(nextAttemptId)).toBeNull();
  });
});
