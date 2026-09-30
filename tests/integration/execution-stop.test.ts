import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import type { GraphExecutionEngine } from "../../packages/workflow-engine/src/core/graph-execution-engine.js";
import {
  ExecutionOverviewRepository,
  getDatabase,
  getSqliteInstance,
  getWorkflowService,
  user,
} from "@mcp-moira/shared";
import {
  DatabaseRepository,
  InMemoryRepository,
  projectExecutionRun,
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

  async function start(parentExecutionId?: string) {
    const engine = MCPEngine.getInstance(repository);
    const id = await engine.executor.startWorkflow(
      workflow,
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
    expect(await stop(run)).toEqual(result);
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

  test("active overview hides stopped descendants and exposes their active children as roots", async () => {
    const parent = await start();
    const stopped = await start(parent.id);
    const child = await start(stopped.id);
    expect((await stop(stopped.run)).success).toBe(true);
    const overview = new ExecutionOverviewRepository(getSqliteInstance());
    const query = {
      userId: USER,
      status: "active" as const,
      sort: "activity" as const,
      limit: 100,
      offset: 0,
    };
    const active = overview.page(query);
    expect(active.nodes.map((row) => row.executionId)).not.toContain(stopped.id);
    expect(active.roots).toContain(child.id);
    expect(active.nodes.find((row) => row.executionId === child.id)?.parentExecutionId).toBe(
      stopped.id,
    );
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

  test("stopped progress freezes time without inventing completed work or entering duration statistics", async () => {
    const { id, run } = await start();
    expect((await stop(run)).success).toBe(true);
    const stopped = (await repository.getExecution(id))!;
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
