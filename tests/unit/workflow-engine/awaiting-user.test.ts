import { describe, expect, test } from "@jest/globals";
import {
  adjustmentVisit,
  awaitingUserAfterMove,
  InMemoryRepository,
  projectExecutionRun,
  type ExecutionAwaitingUser,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { metadataRevision } from "@mcp-moira/shared";

/**
 * The agent's open question and the rule that ends it. The database applies the rule in SQL (see
 * `tests/integration/agent-awaiting-user.test.ts`); these cases pin the same rule where the run is
 * held in memory and where the progress projection reads it.
 */

const question: ExecutionAwaitingUser = {
  id: "q-1",
  nodeId: "ask",
  question: "Which environment should the release go to?",
  options: ["staging", "production"],
  since: 1_000,
};

function graph(gate?: Record<string, unknown>): WorkflowGraph {
  return {
    id: "awaiting-user-unit",
    metadata: { name: "Release", version: "1.0.0", description: "Agent question" },
    progress: {
      nodes: [
        { id: "work", label: "Prepare", content: { summary: "Prepare the release" } },
        { id: "done", label: "Finish", content: { summary: "Finish the release" } },
      ],
    },
    nodes: [
      { type: "start", id: "start", progressNodeId: "work", connections: { default: "ask" } },
      {
        type: "agent-directive",
        id: "ask",
        progressNodeId: "work",
        directive: "Prepare",
        completionCondition: "Prepared",
        ...(gate ? { humanGate: gate } : {}),
        connections: { success: "finish" },
        connectionLabels: { success: "prepared" },
      },
      {
        type: "agent-directive",
        id: "finish",
        progressNodeId: "done",
        directive: "Finish",
        completionCondition: "Finished",
        connections: { success: "end" },
      },
      { type: "end", id: "end", progressNodeId: "done" },
    ],
  };
}

function run(nodeId: string, overrides: Partial<WorkflowExecution> = {}): WorkflowExecution {
  return {
    executionId: "execution-1",
    workflowId: "awaiting-user-unit",
    userId: "user-1",
    currentNodeId: nodeId,
    waitingForInputNodeId: nodeId,
    globalContext: {
      variables: {},
      nodeStates: {},
      executionId: "execution-1",
      workflowId: "awaiting-user-unit",
      userId: "user-1",
    },
    status: "running",
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("awaitingUserAfterMove", () => {
  test.each([
    ["the run stays on the question's node", run("ask"), question],
    ["the run moved to another node", run("finish"), null],
    ["the run finished", run("ask", { status: "completed" }), null],
  ])("%s", (_case, next, expected) => {
    expect(awaitingUserAfterMove(question, next)).toEqual(expected);
  });

  test("no question stays no question", () => {
    expect(awaitingUserAfterMove(null, run("ask"))).toBeNull();
  });
});

describe("the progress projection of an agent's question", () => {
  test("an open question makes the run wait for the person, with the question and its choices", () => {
    const progress = projectExecutionRun(graph(), run("ask", { awaitingUser: question }))!;
    expect(progress.waitingFor).toBe("user");
    expect(progress.waitingForUser).toEqual({
      source: "agent",
      question: question.question,
      options: ["staging", "production"],
      since: 1_000,
    });
  });

  test("the agent's question takes precedence over a gate on the same step", () => {
    const progress = projectExecutionRun(
      graph({ label: "Approve the release" }),
      run("ask", { awaitingUser: question, gateWaiting: true }),
    )!;
    expect(progress.waitingForUser).toEqual(expect.objectContaining({ source: "agent" }));
  });

  test.each([
    ["asked on a node the run has left", run("finish", { awaitingUser: question })],
    ["on a finished run", run("ask", { awaitingUser: question, status: "completed" })],
  ])("a question %s is not shown", (_case, execution) => {
    const progress = projectExecutionRun(graph(), execution)!;
    expect(progress.waitingForUser).toBeNull();
    expect(progress.waitingFor).not.toBe("user");
  });

  test("a projection at a route cursor never carries it", () => {
    const visits = [
      { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
      { seq: 1, nodeId: "ask", exitKey: null, waited: true, changes: {} },
      { seq: 2, nodeId: "ask", exitKey: null, adjusted: true, changes: {} },
    ];
    const live = run("ask", { awaitingUser: question, visits });
    expect(projectExecutionRun(graph(), live)!.waitingForUser).not.toBeNull();
    const atCursor = projectExecutionRun(graph(), live, { at: 1 })!;
    expect(atCursor.waitingForUser).toBeNull();
    expect(atCursor.waitingFor).toBe("agent");
  });
});

describe("the in-memory repository follows the same rule as the database", () => {
  async function repositoryWithQuestion() {
    const repository = new InMemoryRepository();
    await repository.saveWorkflow(graph(), "user-1");
    await repository.saveExecution(run("ask"));
    const { id: _id, nodeId: _nodeId, ...raised } = question;
    await repository.setExecutionAwaitingUser("execution-1", "user-1", { ...raised, id: "q-1" });
    return repository;
  }

  test("raising binds the question to the current node without advancing the step generation", async () => {
    const repository = await repositoryWithQuestion();
    const stored = (await repository.getExecution("execution-1"))!;
    expect(stored.awaitingUser).toEqual(question);
    expect(stored.revision).toBe(0);
  });

  test("a save keeps the stored question while the run stays and clears it when the run moves", async () => {
    const repository = await repositoryWithQuestion();
    const loaded = (await repository.getExecution("execution-1"))!;
    await repository.saveExecution({ ...loaded, awaitingUser: null, note: "same node" });
    expect((await repository.getExecution("execution-1"))!.awaitingUser).toEqual(question);

    const again = (await repository.getExecution("execution-1"))!;
    await repository.saveExecution({
      ...again,
      currentNodeId: "finish",
      waitingForInputNodeId: "finish",
    });
    expect((await repository.getExecution("execution-1"))!.awaitingUser).toBeNull();
  });

  test("the agent's variable write clears it and a person's does not", async () => {
    const repository = await repositoryWithQuestion();
    const write = async (role: "agent" | "user") => {
      const current = (await repository.getExecution("execution-1"))!;
      await repository.updateExecutionContext(
        "execution-1",
        { variables: { target: role } },
        current.revision,
        metadataRevision(current.globalContext),
        adjustmentVisit(current, { target: role }, { role, userId: "user-1" }),
      );
      return (await repository.getExecution("execution-1"))!.awaitingUser;
    };
    expect(await write("user")).toEqual(question);
    expect(await write("agent")).toBeNull();
  });

  test("cancelling clears it and a finished run refuses a new one", async () => {
    const repository = await repositoryWithQuestion();
    await repository.cancelExecution("execution-1", {
      timestamp: 1,
      nodeId: "ask",
      errorType: "system",
      message: "Cancelled",
    });
    expect((await repository.getExecution("execution-1"))!.awaitingUser).toBeNull();
    await expect(
      repository.setExecutionAwaitingUser("execution-1", "user-1", {
        id: "q-2",
        question: "Still there?",
        since: 2,
      }),
    ).rejects.toThrow("already finished");
  });
});
