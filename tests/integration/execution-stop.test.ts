import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import type { GraphExecutionEngine } from "../../packages/workflow-engine/src/core/graph-execution-engine.js";
import {
  ExecutionOverviewRepository,
  getDatabase,
  getSqliteInstance,
  getWorkflowService,
  getLockService,
  user,
} from "@mcp-moira/shared";
import {
  DatabaseRepository,
  ExecutionStopService,
  InMemoryRepository,
  projectExecutionRun,
  readExecutionManagement,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { MCPEngine } from "../../packages/mcp-server/src/core/mcp-engine.js";
import { requestContext } from "../../packages/mcp-server/src/core/request-context.js";
import { getSessionInfo } from "../../packages/mcp-server/src/tools/get-session-info.js";

const USER = "execution-stop-user";
const graph: WorkflowGraph = {
  metadata: { name: "Stop test", version: "1.0.0", description: "Explicit stop contract" },
  progress: {
    nodes: [
      { id: "work-block", label: "Work" },
      { id: "end-block", label: "Finish" },
    ],
  },
  nodes: [
    { id: "start", type: "start", progressNodeId: "work-block", connections: { default: "work" } },
    {
      id: "work",
      type: "agent-directive",
      progressNodeId: "work-block",
      directive: "Work",
      completionCondition: "Done",
      connections: { success: "end" },
    },
    { id: "end", type: "end", progressNodeId: "end-block" },
  ],
};

describe("explicit execution stop", () => {
  let repository: DatabaseRepository;
  let workflow: WorkflowGraph;
  beforeAll(async () => {
    const now = new Date().toISOString();
    await getDatabase()
      .insert(user)
      .values({
        id: USER,
        email: `${USER}@example.test`,
        handle: USER,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    repository = new DatabaseRepository();
    const saved = await getWorkflowService().save({ graph, userId: USER, visibility: "private" });
    workflow = (await repository.getWorkflowGraph(saved.id, USER))!;
  });
  afterEach(() => {
    jest.restoreAllMocks();
    MCPEngine.resetInstance();
  });

  async function start(parentExecutionId?: string, definition = workflow) {
    const engine = MCPEngine.getInstance(repository);
    const id = await engine.executor.startWorkflow(
      definition,
      {},
      USER,
      undefined,
      parentExecutionId,
    );
    const text = await engine.executor.executeStep(id, undefined, undefined, {
      userId: USER,
      createPresentation: true,
    });
    return {
      id,
      engine,
      run: (await repository.getExecution(id))!,
      attemptId: text.match(/Step attempt ID:\s*([a-f0-9-]+)/i)![1],
    };
  }

  function stop(run: WorkflowExecution, reason = "User changed the task") {
    return requestContext.run({ userId: USER }, () =>
      getSessionInfo({
        action: "stop-execution",
        executionId: run.executionId,
        expectedRevision: run.revision,
        reason,
      }),
    );
  }

  test("the shared API/MCP stop facade emits effects once for a changed persisted stop", async () => {
    const { id, run } = await start();
    const audit = jest.fn(async () => {});
    const stopped = jest.fn((_workflowId: string) => {});
    const service = new ExecutionStopService(repository, { audit, stopped });
    const input = { expectedRevision: run.revision, reason: "  Scope replaced  " };
    const changed = await service.stop(id, USER, input, "api");
    const replay = await service.stop(id, USER, input, "mcp");
    expect(changed).toMatchObject({
      changed: true,
      stopReason: "Scope replaced",
      revision: run.revision + 1,
    });
    expect(replay).toEqual({ ...changed, changed: false });
    expect(stopped.mock.calls).toEqual([[run.workflowId]]);
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]).toEqual([
      expect.objectContaining({
        userId: USER,
        resourceId: id,
        source: "api",
        metadata: { reason: "Scope replaced", outcome: "stopped" },
      }),
    ]);
    await expect(
      service.stop(id, USER, { ...input, reason: "Different reason" }, "api"),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.stop(id, "foreign-actor", input, "api")).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(service.stop("missing-stop-execution", USER, input, "mcp")).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  test("the actual MCP active list excludes a marked legacy row and the Home query keeps it in recent work", async () => {
    const { id } = await start();
    getSqliteInstance()
      .prepare("UPDATE workflowExecution SET stopReason=? WHERE executionId=?")
      .run("", id);
    const listed = await requestContext.run({ userId: USER }, () =>
      getSessionInfo({ action: "executions", workflowId: workflow.id, limit: 100 }),
    );
    expect(listed.success).toBe(true);
    const data = listed.data as { executions: Array<{ executionId: string }> };
    expect(data.executions.map((item) => item.executionId)).not.toContain(id);
    const active = await repository.listExecutionsWithFilters({
      userId: USER,
      status: ["running"],
      includeStopped: false,
      limit: 100,
    });
    expect(active.executions.map((item) => item.executionId)).not.toContain(id);
    const recent = await repository.listExecutionsWithFilters({
      userId: USER,
      status: ["completed"],
      includeStopped: true,
      limit: 100,
    });
    expect(recent.executions.map((item) => item.executionId)).toContain(id);
    expect((await repository.getExecution(id))!).toMatchObject({
      status: "running",
      stopReason: "",
    });
  });

  test("stores an explicit reason, invalidates the step, clears waits, emits one status event and replays", async () => {
    const { id, run, attemptId } = await start();
    await repository.setExecutionAwaitingUser(id, USER, {
      id: "question",
      question: "Proceed?",
      since: Date.now(),
    });
    const seq = (
      getSqliteInstance().prepare("SELECT max(seq) AS seq FROM executionChange").get() as {
        seq: number;
      }
    ).seq;
    const result = await stop(run, "  User changed the task  ");
    expect(result.success).toBe(true);
    expect(await repository.getExecution(id)).toMatchObject({
      status: "completed",
      stopReason: "User changed the task",
      revision: run.revision + 1,
      waitingForInputNodeId: undefined,
      gateWaiting: false,
      awaitingUser: null,
    });
    expect(
      getSqliteInstance()
        .prepare("SELECT waitingForInputNodeId FROM workflowExecution WHERE executionId = ?")
        .get(id),
    ).toEqual({ waitingForInputNodeId: null });
    expect((await repository.getExecutionAttempt(attemptId))?.state).toBe("superseded");
    expect(result.data).toMatchObject({ changed: true });
    expect((await stop(run)).data).toEqual({ ...(result.data as object), changed: false });
    const events = getSqliteInstance()
      .prepare("SELECT kind FROM executionChange WHERE executionId = ? AND seq > ?")
      .all(id, seq);
    expect(events).toEqual([{ kind: "status" }]);
    await expect(repository.saveExecution(run)).rejects.toThrow("Execution state changed");
    expect((await repository.getExecution(id))?.stopReason).toBe("User changed the task");
  });

  test("refuses another owner, stale revisions, empty reasons and stopping ordinary completion", async () => {
    const { id, run, attemptId, engine } = await start();
    await expect(
      repository.stopExecution(id, "another-owner", run.revision, "Stop"),
    ).rejects.toThrow("belong");
    await expect(repository.stopExecution(id, USER, run.revision + 1, "Stop")).rejects.toThrow(
      "state changed",
    );
    expect((await stop(run, " ")).success).toBe(false);
    await engine.executor.executeStep(id, {}, undefined, { userId: USER, attemptId });
    const finished = (await repository.getExecution(id))!;
    expect(finished.status).toBe("completed");
    expect((await stop(finished)).success).toBe(false);
    expect((await repository.getExecution(id))?.stopReason).toBeNull();
  });

  test("refuses executing operations and fences an unknown outcome", async () => {
    const { id, run, attemptId } = await start();
    getSqliteInstance()
      .prepare("UPDATE executionMutationAttempt SET state = 'executing' WHERE attemptId = ?")
      .run(attemptId);
    expect((await stop(run)).success).toBe(false);
    expect((await repository.getExecution(id))?.status).toBe("running");
    getSqliteInstance()
      .prepare("UPDATE executionMutationAttempt SET state = 'outcome_unknown' WHERE attemptId = ?")
      .run(attemptId);
    expect((await stop(run)).success).toBe(true);
    expect((await repository.getExecutionAttempt(attemptId))?.state).toBe("superseded");
  });

  test("active work retains its stopped ancestor only as context and omits a standalone stopped run", async () => {
    const parent = await start();
    const stopped = await start(parent.id);
    const child = await start(stopped.id);
    const standalone = await start();
    expect((await stop(stopped.run)).success).toBe(true);
    expect((await stop(standalone.run)).success).toBe(true);
    const overview = new ExecutionOverviewRepository(getSqliteInstance());
    const query = {
      userId: USER,
      status: "active" as const,
      sort: "activity" as const,
      limit: 100,
      offset: 0,
    };
    const active = overview.page(query);
    expect(active.nodes.map((row) => row.executionId)).not.toContain(standalone.id);
    expect(active.nodes.find((row) => row.executionId === stopped.id)).toMatchObject({
      status: "stopped",
      matches: false,
    });
    expect(active.roots).toContain(parent.id);
    expect(active.roots).not.toContain(child.id);
    expect(active.nodes.find((row) => row.executionId === child.id)?.parentExecutionId).toBe(
      stopped.id,
    );
    const selected = overview.page({ ...query, search: child.id });
    expect(selected.total).toBe(1);
    expect(selected.roots).toEqual([parent.id]);
    expect(selected.nodes.map((row) => [row.executionId, row.matches])).toEqual(
      expect.arrayContaining([
        [parent.id, false],
        [stopped.id, false],
        [child.id, true],
      ]),
    );
    expect(selected.nodes).toHaveLength(3);
    expect((await repository.getExecution(child.id))?.status).toBe("running");
    expect(
      overview
        .page({ ...query, status: "stopped" })
        .nodes.find((row) => row.executionId === stopped.id)?.status,
    ).toBe("stopped");
    expect(
      overview.page({ ...query, status: "completed" }).nodes.map((row) => row.executionId),
    ).not.toContain(stopped.id);
  });

  test("the in-memory repository uses the same revision and retry contract", async () => {
    const { run } = await start();
    const memory = new InMemoryRepository();
    await memory.saveExecution(run);
    expect(await memory.stopExecution(run.executionId, USER, run.revision, "Stop")).toEqual({
      changed: true,
      revision: run.revision + 1,
    });
    expect(await memory.stopExecution(run.executionId, USER, run.revision, "Stop")).toEqual({
      changed: false,
      revision: run.revision + 1,
    });
    await expect(memory.saveExecution(run)).rejects.toThrow("state changed");
  });

  test.each(["gate", "question", "lock"] as const)(
    "published management readers compose actual %s facts with raw running status",
    async (kind) => {
      let definition = workflow;
      if (kind === "gate") {
        const gated = structuredClone(graph);
        gated.metadata.name = "Management gate";
        const work = gated.nodes.find((node) => node.id === "work")!;
        if (work.type !== "agent-directive") throw new Error("Expected directive fixture");
        work.humanGate = { label: "Approve the work" };
        const saved = await getWorkflowService().save({
          graph: gated,
          userId: USER,
          visibility: "private",
        });
        definition = (await repository.getWorkflowGraph(saved.id, USER))!;
      }
      const { id } = await start(undefined, definition);
      if (kind === "question")
        await repository.setExecutionAwaitingUser(id, USER, {
          id: "management-question",
          question: "Which input?",
          since: Date.now(),
        });
      const lock =
        kind === "lock"
          ? await getLockService().createLock({
              executionId: id,
              nodeId: "work",
              reason: "Confirm the work",
              lockedBy: USER,
            })
          : null;
      try {
        const current = (await repository.getExecution(id))!;
        expect(current.status).toBe("running");
        const memory = new InMemoryRepository();
        await memory.saveExecution(current);
        const lockedIds = await getLockService().getActiveExecutionIds();
        const stored = await readExecutionManagement(repository, [current], USER, lockedIds);
        const inMemory = await readExecutionManagement(
          memory,
          [(await memory.getExecution(id))!],
          USER,
          lockedIds,
        );
        const expected = {
          revision: current.revision,
          displayStatus: kind === "lock" ? "locked" : "waiting-user",
          stopReason: null,
          stopCapability: { available: true, revision: current.revision },
        };
        expect(stored.get(id)).toEqual(expected);
        expect(inMemory.get(id)).toEqual(expected);
      } finally {
        if (lock) await getLockService().ownerUnlock(lock.lockId, USER);
      }
    },
  );

  test("stopped progress freezes time without inventing completed work or entering duration statistics", async () => {
    const { id, run } = await start();
    expect((await stop(run)).success).toBe(true);
    const stopped = (await repository.getExecution(id))!;
    const progress = await requestContext.run({ userId: USER }, () =>
      getSessionInfo({ action: "progress", executionId: id }),
    );
    expect(progress.success).toBe(true);
    expect(progress.data).toMatchObject({
      source: "trace",
      executionStatus: "completed",
      stopReason: "User changed the task",
    });
    const first = projectExecutionRun(workflow, stopped, { now: stopped.completedAt! + 10_000 })!;
    const later = projectExecutionRun(workflow, stopped, { now: stopped.completedAt! + 90_000 })!;
    expect(first.nodes.map((node) => node.status)).toEqual(["active", "pending"]);
    expect(first.waitingFor).toBeNull();
    expect(first.nodes.map((node) => node.timing)).toEqual(later.nodes.map((node) => node.timing));
    expect(
      (await repository.listExecutionsByWorkflowVersion(workflow.id!, "1.0.0", USER)).map(
        (sample) => sample.executionId,
      ),
    ).not.toContain(id);
  });

  test("metadata-only published progress distinguishes stopping without inventing blocks", async () => {
    const plain = structuredClone(graph);
    plain.metadata.name = "Stopped metadata";
    delete plain.progress;
    for (const node of plain.nodes) delete node.progressNodeId;
    const saved = await getWorkflowService().save({
      graph: plain,
      userId: USER,
      visibility: "private",
    });
    const definition = (await repository.getWorkflowGraph(saved.id, USER))!;
    const { id, run } = await start(undefined, definition);
    expect((await stop(run, "Scope replaced")).success).toBe(true);
    const result = await requestContext.run({ userId: USER }, () =>
      getSessionInfo({ action: "progress", executionId: id }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      source: "metadata",
      taskTitle: "Stopped metadata",
      executionStatus: "completed",
      stopReason: "Scope replaced",
    });
    expect(result.data).not.toHaveProperty("nodes");
    expect(result.data).not.toHaveProperty("process");
  });

  test("a legacy empty stored stop marker remains visible and freezes the open partial frontier", async () => {
    const { id, run } = await start();
    expect((await stop(run)).success).toBe(true);
    getSqliteInstance()
      .prepare("UPDATE workflowExecution SET stopReason='' WHERE executionId=?")
      .run(id);
    const current = (await repository.getExecution(id))!;
    const first = projectExecutionRun(workflow, current, { now: current.completedAt! + 10_000 })!;
    const later = projectExecutionRun(workflow, current, { now: current.completedAt! + 90_000 })!;
    expect(first.nodes.map((node) => node.status)).toEqual(["active", "pending"]);
    expect(first.nodes.map((node) => node.timing)).toEqual(later.nodes.map((node) => node.timing));
    expect(first).toHaveProperty("stopReason", "");
  });

  test("a run-page answer holds an executing claim before dispatch, so stop refuses until it finishes", async () => {
    const { id, run, engine, attemptId } = await start();
    const graphEngine = (engine.executor as unknown as { graphEngine: GraphExecutionEngine })
      .graphEngine;
    const original = graphEngine.executeGraph.bind(graphEngine);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    jest.spyOn(graphEngine, "executeGraph").mockImplementation(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const answer = engine.executor.executeStep(id, {}, undefined, {
      userId: USER,
      createPresentation: true,
      answeredBy: { role: "user", userId: USER },
    });
    try {
      await ready;
      expect((await repository.getCurrentExecutionAttempt(id, USER))?.state).toBe("executing");
      expect((await stop(run)).success).toBe(false);
      expect((await repository.getExecution(id))?.stopReason).toBeNull();
    } finally {
      release();
    }
    await answer;
    expect((await repository.getExecutionAttempt(attemptId))?.state).toBe("superseded");
    expect((await repository.getExecution(id))?.visits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ adjusted: true, actor: { role: "user", userId: USER } }),
      ]),
    );
  });

  test.each([false, true])(
    "a stop accepted before a direct presentation claims ownership prevents dispatch (answer=%s)",
    async (answer) => {
      const { id, run, engine } = await start();
      const graphEngine = (engine.executor as unknown as { graphEngine: GraphExecutionEngine })
        .graphEngine;
      const dispatch = jest.spyOn(graphEngine, "executeGraph");
      const original = repository.claimExecutionAttempt.bind(repository);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      jest.spyOn(repository, "claimExecutionAttempt").mockImplementation(async (input) => {
        entered();
        await gate;
        return original(input);
      });
      const operation = engine.executor.executeStep(id, answer ? {} : undefined, undefined, {
        userId: USER,
        createPresentation: true,
        ...(answer ? { answeredBy: { role: "user" as const, userId: USER } } : {}),
      });
      const rejected = expect(operation).rejects.toThrow("ATTEMPT_STALE");
      try {
        await ready;
        expect((await stop(run)).success).toBe(true);
      } finally {
        release();
      }
      await rejected;
      expect(dispatch).not.toHaveBeenCalled();
      expect((await repository.getExecution(id))?.stopReason).toBe("User changed the task");
    },
  );
});
