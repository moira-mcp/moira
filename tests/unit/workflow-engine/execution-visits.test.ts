import { describe, expect, test } from "@jest/globals";
import {
  adjustmentVisit,
  appendEngineVisits,
  diffVariables,
  snapshotVariables,
  TELEPORT_EXIT_KEY,
  buildExecutionProgressVisualModel,
  projectExecutionRun,
  renderProgressVisualSvg,
  withInFlightPause,
  withInFlightVisit,
  type EngineVisit,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

function execution(visits?: WorkflowExecution["visits"]): WorkflowExecution {
  return {
    executionId: "e",
    workflowId: "w",
    userId: "u",
    currentNodeId: "work",
    waitingForInputNodeId: "work",
    globalContext: {
      variables: {},
      nodeStates: {},
      executionId: "e",
      workflowId: "w",
      userId: "u",
    },
    status: "running",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...(visits ? { visits } : {}),
  };
}

const nodeIds = new Set(["start", "work", "check"]);
/** The moment every engine visit of these tests was entered. */
const T = 1_000;

describe("variable diff of one node visit", () => {
  test("reports changed globals by name and node-local outputs as node.field", () => {
    const before = snapshotVariables({
      total: 2,
      unchanged: "same",
      work: { done: false, note: "a" },
    });
    const after = {
      total: 3,
      unchanged: "same",
      added: true,
      work: { done: true, note: "a", extra: [1] },
      check: { verdict: "ok" },
    };
    expect(diffVariables(before, after, nodeIds)).toEqual({
      total: 3,
      added: true,
      "work.done": true,
      "work.extra": [1],
      "check.verdict": "ok",
    });
  });

  test("sees a changed value even when the object identity is unchanged", () => {
    const shared = { count: 1 };
    const before = snapshotVariables({ counter: shared });
    shared.count = 2;
    expect(diffVariables(before, { counter: shared }, nodeIds)).toEqual({
      counter: { count: 2 },
    });
  });
});

describe("appending engine visits to the execution", () => {
  const cycle = (visits: EngineVisit[]) => visits;

  test("numbers visits in order and keeps a paused node's visit open", () => {
    const run = execution();
    appendEngineVisits(
      run,
      cycle([
        { nodeId: "start", exitKey: "default", changes: { total: 2 }, waited: false, enteredAt: T },
        { nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
      ]),
    );
    expect(run.visits).toEqual([
      { seq: 0, nodeId: "start", exitKey: "default", changes: { total: 2 }, enteredAt: T },
      { seq: 1, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
    ]);
  });

  test("a resumed wait continues the open visit instead of opening a second one", () => {
    const run = execution([
      { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
      { seq: 1, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
    ]);
    appendEngineVisits(
      run,
      cycle([
        {
          nodeId: "work",
          exitKey: "success",
          changes: { "work.done": true },
          waited: false,
          enteredAt: T,
        },
        { nodeId: "check", exitKey: "true", changes: {}, waited: false, enteredAt: T },
        { nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
      ]),
    );
    expect(run.visits!.map((v) => [v.seq, v.nodeId, v.exitKey, v.waited ?? false])).toEqual([
      [0, "start", "default", false],
      [1, "work", "success", true],
      [2, "check", "true", false],
      [3, "work", null, true],
    ]);
    expect(run.visits![1].changes).toEqual({ "work.done": true });
  });

  test("an answer from outside the flow is recorded as an adjustment visit with its actor after the wait it closed", () => {
    const run = execution([
      { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
      { seq: 1, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
    ]);
    const actor = { role: "user" as const, userId: "person" };
    appendEngineVisits(
      run,
      cycle([
        {
          nodeId: "work",
          exitKey: "success",
          changes: { "work.done": true },
          waited: false,
          enteredAt: T,
        },
        { nodeId: "check", exitKey: null, changes: {}, waited: true, enteredAt: T },
      ]),
      undefined,
      actor,
    );
    expect(run.visits).toEqual([
      { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
      {
        seq: 1,
        nodeId: "work",
        exitKey: "success",
        changes: { "work.done": true },
        waited: true,
        enteredAt: T,
      },
      {
        seq: 2,
        nodeId: "work",
        exitKey: null,
        changes: { "work.done": true },
        adjusted: true,
        enteredAt: T,
        leftAt: T,
        actor,
      },
      { seq: 3, nodeId: "check", exitKey: null, changes: {}, waited: true, enteredAt: T },
    ]);
  });

  test("an answer the step rejected as invalid records no adjustment", () => {
    const run = execution([
      { seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
    ]);
    appendEngineVisits(
      run,
      cycle([{ nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T }]),
      undefined,
      { role: "user", userId: "person" },
    );
    expect(run.visits).toEqual([
      { seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
    ]);
  });

  test("a resume that pauses again on invalid input leaves the open visit as it is", () => {
    const run = execution([
      { seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
    ]);
    appendEngineVisits(
      run,
      cycle([{ nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T }]),
    );
    expect(run.visits).toHaveLength(1);
    expect(run.visits![0]).toEqual({
      seq: 0,
      nodeId: "work",
      exitKey: null,
      changes: {},
      waited: true,
      enteredAt: T,
    });
  });

  test("a teleport closes the open visit with the teleport exit before the target's visit", () => {
    const run = execution([
      { seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
    ]);
    appendEngineVisits(
      run,
      cycle([{ nodeId: "jump", exitKey: null, changes: {}, waited: true, enteredAt: T }]),
      "jump",
    );
    expect(run.visits!.map((v) => [v.nodeId, v.exitKey])).toEqual([
      ["work", TELEPORT_EXIT_KEY],
      ["jump", null],
    ]);
  });

  test("a resume after an adjustment continues the open wait beneath the adjustment", () => {
    const run = execution([
      { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
      { seq: 1, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
      {
        seq: 2,
        nodeId: "work",
        exitKey: null,
        changes: { total: 9 },
        adjusted: true,
        actor: { role: "user", userId: "u" },
      },
    ]);
    appendEngineVisits(
      run,
      cycle([
        {
          nodeId: "work",
          exitKey: "success",
          changes: { "work.done": true },
          waited: false,
          enteredAt: T,
        },
        { nodeId: "check", exitKey: null, changes: {}, waited: true, enteredAt: T },
      ]),
    );
    expect(run.visits!.map((v) => [v.seq, v.nodeId, v.exitKey, v.adjusted ?? false])).toEqual([
      [0, "start", "default", false],
      [1, "work", "success", false],
      [2, "work", null, true],
      [3, "check", null, false],
    ]);
    expect(run.visits![1].changes).toEqual({ "work.done": true });
  });

  test("a teleport after an adjustment still records the exit on the wait it left", () => {
    const run = execution([
      { seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
      {
        seq: 1,
        nodeId: "work",
        exitKey: null,
        changes: { total: 9 },
        adjusted: true,
        actor: { role: "agent", userId: "u" },
      },
    ]);
    appendEngineVisits(
      run,
      cycle([{ nodeId: "jump", exitKey: null, changes: {}, waited: true, enteredAt: T }]),
      "jump",
    );
    expect(run.visits!.map((v) => [v.nodeId, v.exitKey])).toEqual([
      ["work", TELEPORT_EXIT_KEY],
      ["work", null],
      ["jump", null],
    ]);
  });

  test("an adjustment visit itself is never continued or closed by the next engine cycle", () => {
    const run = execution([
      { seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
      {
        seq: 1,
        nodeId: "work",
        exitKey: null,
        changes: { total: 9 },
        adjusted: true,
        actor: { role: "user", userId: "u" },
      },
    ]);
    appendEngineVisits(
      run,
      cycle([{ nodeId: "work", exitKey: "success", changes: {}, waited: false, enteredAt: T }]),
    );
    expect(run.visits!.map((v) => [v.seq, v.nodeId, v.exitKey, v.adjusted ?? false])).toEqual([
      [0, "work", "success", false],
      [1, "work", null, true],
    ]);
    expect(run.visits![1]).toMatchObject({ changes: { total: 9 }, actor: { role: "user" } });
  });
});

describe("in-flight visit for a node running inside the current cycle", () => {
  test("appends an open visit of that node and points the execution at it without persisting", () => {
    const run = execution([
      { seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
    ]);
    const inFlight = withInFlightVisit(run, "notify");
    expect(inFlight.currentNodeId).toBe("notify");
    expect(inFlight.visits).toEqual([
      { seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true, enteredAt: T },
      { seq: 1, nodeId: "notify", exitKey: null, changes: {}, enteredAt: expect.any(Number) },
    ]);
    expect(run.visits).toHaveLength(1);
    expect(run.currentNodeId).toBe("work");
  });
});

describe("adjustment visit", () => {
  test("targets the node the execution is on and carries the actor", () => {
    expect(adjustmentVisit(execution(), { total: 4 }, { role: "agent", userId: "u" })).toEqual({
      nodeId: "work",
      exitKey: null,
      changes: { total: 4 },
      adjusted: true,
      actor: { role: "agent", userId: "u" },
      enteredAt: expect.any(Number),
      leftAt: expect.any(Number),
    });
  });
});

describe("the execution as a notification sees it", () => {
  const base = (): WorkflowExecution =>
    ({
      executionId: "e",
      workflowId: "w",
      userId: "u",
      status: "running",
      currentNodeId: "notify",
      waitingForInputNodeId: null,
      globalContext: { variables: {}, nodeStates: {} },
      visits: [{ seq: 0, nodeId: "start", exitKey: "default", changes: {}, enteredAt: 1 }],
    }) as unknown as WorkflowExecution;
  const graphTo = (successor: { id: string; type: string; connections?: unknown }) => ({
    nodes: [
      { id: "start", type: "start", connections: { default: "notify" } },
      { id: "notify", type: "user-notification", connections: { default: successor.id } },
      successor,
    ],
  });

  test.each([
    ["a directive", { id: "next", type: "agent-directive", connections: { success: "end" } }],
    ["a lock gate", { id: "gate", type: "lock", connections: { unlocked: "end" } }],
    ["a teleport", { id: "jump", type: "teleport", connections: { default: "end" } }],
    ["a subgraph", { id: "sub", type: "subgraph", connections: { success: "end" } }],
  ])("a notification followed by %s is projected as waiting on that node", (_case, successor) => {
    const copy = withInFlightPause(graphTo(successor), base(), "notify");
    expect(copy.currentNodeId).toBe(successor.id);
    expect(copy.waitingForInputNodeId).toBe(successor.id);
    const visits = copy.visits!;
    expect(visits.map((v) => v.nodeId)).toEqual(["start", "notify", successor.id]);
    // The run has not entered the successor: its open visit carries no timestamp, so its pass
    // has no duration rather than a zero one.
    expect(visits[2].enteredAt).toBeUndefined();
    expect(visits[2].waited).toBe(true);
    expect(visits[1].enteredAt).toBeDefined();
    expect(visits.map((v) => v.seq)).toEqual([0, 1, 2]);
  });

  test("a successor the run does not pause on leaves the copy at the notification", () => {
    const copy = withInFlightPause(graphTo({ id: "end", type: "end" }), base(), "notify");
    // Both copies stamp the notification's visit with their own clock; compare everything else.
    const stamped = (e: WorkflowExecution) => ({
      ...e,
      visits: e.visits?.map(({ enteredAt: _at, ...rest }) => rest),
    });
    expect(stamped(copy)).toEqual(stamped(withInFlightVisit(base(), "notify")));
    expect(copy.waitingForInputNodeId).toBeNull();
  });

  test("a lock gate after the notification is drawn as waiting for the reader, a directive as the agent's step", () => {
    const graph = {
      metadata: { name: "Gate", version: "1.0.0", description: "x" },
      variableRegistry: {},
      progress: { nodes: [{ id: "wrap", label: "Wrap" }] },
      nodes: [
        { id: "start", type: "start", progressNodeId: "wrap", connections: { default: "notify" } },
        {
          id: "notify",
          type: "user-notification",
          progressNodeId: "wrap",
          message: "x",
          connections: { default: "gate" },
        },
        {
          id: "gate",
          type: "lock",
          progressNodeId: "wrap",
          reason: "r",
          connections: { unlocked: "end" },
        },
        { id: "end", type: "end", progressNodeId: "wrap" },
      ],
    } as unknown as WorkflowGraph;
    const projected = projectExecutionRun(graph, withInFlightPause(graph, base(), "notify"))!;
    expect(projected.waitingFor).toBe("user");
    expect(projected.nodes[0].status).toBe("waiting");
    const model = buildExecutionProgressVisualModel(projected, { viewportWidth: 720 });
    expect(model.nodes[0].statusLine).toBe("waiting for you");
    const svg = renderProgressVisualSvg(model);
    expect(svg).toContain("waiting for you");
    expect(svg).not.toContain("agent on the step");

    const agentGraph = {
      ...graph,
      nodes: graph.nodes.map((n) =>
        n.id === "gate"
          ? {
              id: "gate",
              type: "agent-directive",
              progressNodeId: "wrap",
              directive: "d",
              completionCondition: "c",
              connections: { success: "end" },
            }
          : n,
      ),
    } as unknown as WorkflowGraph;
    const agentModel = buildExecutionProgressVisualModel(
      projectExecutionRun(agentGraph, withInFlightPause(agentGraph, base(), "notify"))!,
      { viewportWidth: 720 },
    );
    expect(agentModel.nodes[0].statusLine).toBe("agent on the step");
  });

  test("never mutates the persisted execution", () => {
    const persisted = base();
    const snapshot = JSON.stringify(persisted);
    withInFlightPause(graphTo({ id: "gate", type: "lock" }), persisted, "notify");
    expect(JSON.stringify(persisted)).toBe(snapshot);
  });
});
