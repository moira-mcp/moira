import { describe, expect, test } from "@jest/globals";
import {
  adjustmentVisit,
  appendEngineVisits,
  diffVariables,
  snapshotVariables,
  TELEPORT_EXIT_KEY,
  withInFlightVisit,
  type EngineVisit,
  type WorkflowExecution,
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
        { nodeId: "start", exitKey: "default", changes: { total: 2 }, waited: false },
        { nodeId: "work", exitKey: null, changes: {}, waited: true },
      ]),
    );
    expect(run.visits).toEqual([
      { seq: 0, nodeId: "start", exitKey: "default", changes: { total: 2 } },
      { seq: 1, nodeId: "work", exitKey: null, changes: {}, waited: true },
    ]);
  });

  test("a resumed wait continues the open visit instead of opening a second one", () => {
    const run = execution([
      { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
      { seq: 1, nodeId: "work", exitKey: null, changes: {}, waited: true },
    ]);
    appendEngineVisits(
      run,
      cycle([
        { nodeId: "work", exitKey: "success", changes: { "work.done": true }, waited: false },
        { nodeId: "check", exitKey: "true", changes: {}, waited: false },
        { nodeId: "work", exitKey: null, changes: {}, waited: true },
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

  test("a resume that pauses again on invalid input leaves the open visit as it is", () => {
    const run = execution([{ seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true }]);
    appendEngineVisits(run, cycle([{ nodeId: "work", exitKey: null, changes: {}, waited: true }]));
    expect(run.visits).toHaveLength(1);
    expect(run.visits![0]).toEqual({
      seq: 0,
      nodeId: "work",
      exitKey: null,
      changes: {},
      waited: true,
    });
  });

  test("a teleport closes the open visit with the teleport exit before the target's visit", () => {
    const run = execution([{ seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true }]);
    appendEngineVisits(
      run,
      cycle([{ nodeId: "jump", exitKey: null, changes: {}, waited: true }]),
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
      { seq: 1, nodeId: "work", exitKey: null, changes: {}, waited: true },
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
        { nodeId: "work", exitKey: "success", changes: { "work.done": true }, waited: false },
        { nodeId: "check", exitKey: null, changes: {}, waited: true },
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
      { seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true },
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
      cycle([{ nodeId: "jump", exitKey: null, changes: {}, waited: true }]),
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
      { seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true },
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
      cycle([{ nodeId: "work", exitKey: "success", changes: {}, waited: false }]),
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
    const run = execution([{ seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true }]);
    const inFlight = withInFlightVisit(run, "notify");
    expect(inFlight.currentNodeId).toBe("notify");
    expect(inFlight.visits).toEqual([
      { seq: 0, nodeId: "work", exitKey: null, changes: {}, waited: true },
      { seq: 1, nodeId: "notify", exitKey: null, changes: {} },
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
    });
  });
});
