/**
 * Bound lists and pass timings of the run projection: a block reads the list it is bound to from
 * the run's variables (items, counters, or both), passes are timed from the route's timestamps,
 * an open pass is measured to the projection moment, runs without timestamps report null, and
 * the notification line names done/total and the current item.
 */

import { describe, expect, test } from "@jest/globals";
import {
  boundListLine,
  nearestBoundList,
  projectExecutionRun,
  type ExecutionVisit,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

function graph(): WorkflowGraph {
  return {
    metadata: { name: "Lists", version: "2.0.0", description: "List fixture" },
    variableRegistry: {
      tasks: { type: "array", description: "Checklist", default: [] },
      current_task: { type: "number", description: "1-based cursor", default: 1 },
      total_tasks: { type: "number", description: "Length", default: 0 },
      current_step: { type: "number", description: "0-based unit cursor", default: 0 },
      total_steps: { type: "number", description: "Unit count", default: 3 },
    },
    progress: {
      nodes: [
        {
          id: "work",
          label: "Work",
          content: { summary: "Work the checklist" },
          list: { items: "tasks", title: "action", current: "current_task", total: "total_tasks" },
        },
        {
          id: "units",
          label: "Units",
          content: { summary: "Execute units" },
          list: { current: "current_step", total: "total_steps", indexBase: 0 },
        },
        { id: "wrap", label: "Wrap", content: { summary: "Finish" } },
      ],
    },
    nodes: [
      { id: "start", type: "start", progressNodeId: "work", connections: { default: "task" } },
      {
        id: "task",
        type: "agent-directive",
        progressNodeId: "work",
        directive: "Do the task",
        completionCondition: "Done",
        inputSchema: {
          type: "object",
          properties: {},
          globalInputs: ["current_task", "tasks", "total_tasks"],
        },
        connections: { success: "unit" },
        connectionLabels: { success: "task done" },
      },
      {
        id: "unit",
        type: "agent-directive",
        progressNodeId: "units",
        directive: "Do the unit",
        completionCondition: "Done",
        inputSchema: { type: "object", properties: {}, globalInputs: ["current_step"] },
        connections: { success: "end" },
        connectionLabels: { success: "unit done" },
      },
      { id: "end", type: "end", progressNodeId: "wrap" },
    ],
  };
}

const tasks = [
  { action: "Write the parser", expected_result: "parses" },
  { action: "Wire the CLI", expected_result: "runs" },
  { action: "Document it", expected_result: "docs" },
];

function execution(
  visits: ExecutionVisit[],
  variables: Record<string, unknown>,
  status: "running" | "completed" = "running",
): WorkflowExecution {
  const last = visits[visits.length - 1];
  return {
    executionId: "run",
    workflowId: "wf",
    userId: "user",
    currentNodeId: last?.nodeId ?? null,
    waitingForInputNodeId: last?.exitKey === null && last.waited ? last.nodeId : null,
    globalContext: {
      variables,
      nodeStates: {},
      executionId: "run",
      workflowId: "wf",
      userId: "user",
    },
    status,
    revision: 1,
    workflowVersion: "2.0.0",
    createdAt: 1,
    updatedAt: 1,
    visits,
  };
}

describe("bound lists", () => {
  test("a block bound to an items array shows titles, done/total and the current item", () => {
    const run = execution(
      [
        { seq: 0, nodeId: "start", exitKey: "default", changes: { tasks, total_tasks: 3 } },
        { seq: 1, nodeId: "task", exitKey: "success", changes: { current_task: 2 }, waited: true },
        { seq: 2, nodeId: "task", exitKey: null, changes: {}, waited: true },
      ],
      { tasks, total_tasks: 3, current_task: 2 },
    );
    const work = projectExecutionRun(graph(), run)!.nodes[0];
    expect(work.list).toEqual({
      items: [
        { index: 0, title: "Write the parser", done: true, current: false, durationMs: null },
        { index: 1, title: "Wire the CLI", done: false, current: true, durationMs: null },
        { index: 2, title: "Document it", done: false, current: false, durationMs: null },
      ],
      done: 1,
      total: 3,
      current: 1,
      currentTitle: "Wire the CLI",
    });
  });

  test("counters alone give done/total with a zero-based cursor and no items", () => {
    const run = execution([{ seq: 0, nodeId: "start", exitKey: "default", changes: {} }], {
      current_step: 2,
      total_steps: 3,
    });
    const units = projectExecutionRun(graph(), run)!.nodes[1];
    expect(units.list).toEqual({
      items: null,
      done: 2,
      total: 3,
      current: 2,
      currentTitle: null,
    });
  });

  test("a cursor past the end (a finished checklist) reports everything done and no current item", () => {
    const run = execution(
      [{ seq: 0, nodeId: "start", exitKey: "default", changes: {} }],
      { tasks, total_tasks: 3, current_task: 4 },
      "completed",
    );
    const work = projectExecutionRun(graph(), run)!.nodes[0];
    expect(work.list).toMatchObject({ done: 3, total: 3, current: null, currentTitle: null });
    expect(work.list!.items!.every((item) => item.done)).toBe(true);
  });

  test("a binding whose paths hold nothing yet resolves to no list, with a diagnostic, and the run still projects", () => {
    const definition = graph();
    definition.variableRegistry = {
      ...definition.variableRegistry,
      tasks: { type: "array", description: "Checklist" },
      current_task: { type: "number", description: "cursor" },
      total_tasks: { type: "number", description: "total" },
    };
    const run = execution([{ seq: 0, nodeId: "start", exitKey: "default", changes: {} }], {});
    const projected = projectExecutionRun(definition, run)!;
    expect(projected.nodes[0].list).toBeNull();
    expect(projected.diagnostics).toContain(
      "Block 'work': list binding did not resolve (items=tasks, current=current_task, total=total_tasks)",
    );
    expect(projected.nodes[2].list).toBeNull();
  });

  test("a title path that names nothing on the items keeps the list and adds a diagnostic", () => {
    const definition = graph();
    definition.progress!.nodes[0].list = {
      items: "tasks",
      title: "headline",
      current: "current_task",
    };
    const run = execution([{ seq: 0, nodeId: "start", exitKey: "default", changes: {} }], {
      tasks,
      current_task: 1,
    });
    const projected = projectExecutionRun(definition, run)!;
    expect(projected.nodes[0].list).toMatchObject({
      done: 0,
      total: 3,
      current: 0,
      currentTitle: "",
    });
    expect(projected.diagnostics).toContain(
      "Block 'work': list.title 'headline' resolves to nothing on the items of tasks",
    );
  });

  test("the list follows the cursor: at an earlier visit the earlier counter value is shown", () => {
    const run = execution(
      [
        {
          seq: 0,
          nodeId: "start",
          exitKey: "default",
          changes: { tasks, total_tasks: 3, current_task: 1 },
        },
        { seq: 1, nodeId: "task", exitKey: "success", changes: { current_task: 2 }, waited: true },
        { seq: 2, nodeId: "task", exitKey: "success", changes: { current_task: 3 }, waited: true },
        { seq: 3, nodeId: "task", exitKey: null, changes: {}, waited: true },
      ],
      { tasks, total_tasks: 3, current_task: 3 },
    );
    expect(projectExecutionRun(graph(), run, { at: 1 })!.nodes[0].list).toMatchObject({
      done: 1,
      current: 1,
      currentTitle: "Wire the CLI",
    });
    expect(projectExecutionRun(graph(), run)!.nodes[0].list).toMatchObject({
      done: 2,
      current: 2,
      currentTitle: "Document it",
    });
  });
});

describe("pass timings", () => {
  const T = 1_700_000_000_000;

  test("closed passes carry their duration, the open pass is measured to now, and items collect the passes that worked on them", () => {
    const run = execution(
      [
        {
          seq: 0,
          nodeId: "start",
          exitKey: "default",
          changes: { tasks, total_tasks: 3, current_task: 1 },
          enteredAt: T,
          leftAt: T + 5,
        },
        {
          seq: 1,
          nodeId: "task",
          exitKey: "success",
          changes: { current_task: 2 },
          waited: true,
          enteredAt: T + 10,
          leftAt: T + 1_010,
        },
        {
          seq: 2,
          nodeId: "task",
          exitKey: "success",
          changes: { current_task: 3 },
          waited: true,
          enteredAt: T + 1_020,
          leftAt: T + 3_020,
        },
        { seq: 3, nodeId: "task", exitKey: null, changes: {}, waited: true, enteredAt: T + 3_030 },
      ],
      { tasks, total_tasks: 3, current_task: 3 },
    );
    const work = projectExecutionRun(graph(), run, { now: T + 4_030 })!.nodes[0];
    expect(work.timing).toEqual({
      recorded: true,
      totalMs: 1_000 + 2_000 + 1_000,
      currentMs: 1_000,
      passes: [
        {
          seq: 1,
          nodeId: "task",
          enteredAt: T + 10,
          leftAt: T + 1_010,
          durationMs: 1_000,
          open: false,
          itemIndex: 0,
        },
        {
          seq: 2,
          nodeId: "task",
          enteredAt: T + 1_020,
          leftAt: T + 3_020,
          durationMs: 2_000,
          open: false,
          itemIndex: 1,
        },
        {
          seq: 3,
          nodeId: "task",
          enteredAt: T + 3_030,
          leftAt: null,
          durationMs: 1_000,
          open: true,
          itemIndex: 2,
        },
      ],
    });
    expect(work.list!.items!.map((item) => item.durationMs)).toEqual([1_000, 2_000, 1_000]);
    // The route carries the same timestamps; a routing node's visit is not a pass.
    const projected = projectExecutionRun(graph(), run, { now: T + 4_030 })!;
    expect(projected.route[0]).toMatchObject({ nodeId: "start", enteredAt: T, leftAt: T + 5 });
    expect(projected.projectedAt).toBe(T + 4_030);
    expect(projected.executionWorkflowVersion).toBe("2.0.0");
  });

  test("an open pass grows between two projections", () => {
    const run = execution(
      [
        { seq: 0, nodeId: "start", exitKey: "default", changes: {}, enteredAt: T, leftAt: T },
        { seq: 1, nodeId: "task", exitKey: null, changes: {}, waited: true, enteredAt: T + 100 },
      ],
      { tasks, total_tasks: 3, current_task: 1 },
    );
    const earlier = projectExecutionRun(graph(), run, { now: T + 600 })!.nodes[0].timing;
    const later = projectExecutionRun(graph(), run, { now: T + 2_600 })!.nodes[0].timing;
    expect(earlier.currentMs).toBe(500);
    expect(later.currentMs).toBe(2_500);
    expect(later.totalMs).toBe(2_500);
  });

  test("a run recorded without timestamps reports null durations, never zero", () => {
    const run = execution(
      [
        { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
        { seq: 1, nodeId: "task", exitKey: "success", changes: {}, waited: true },
        { seq: 2, nodeId: "task", exitKey: null, changes: {}, waited: true },
      ],
      { tasks, total_tasks: 3, current_task: 2 },
    );
    const work = projectExecutionRun(graph(), run)!.nodes[0];
    expect(work.timing.recorded).toBe(false);
    expect(work.timing.totalMs).toBeNull();
    expect(work.timing.currentMs).toBeNull();
    expect(work.timing.passes.map((pass) => pass.durationMs)).toEqual([null, null]);
  });

  test("a finished run has no open pass: its last pass is closed by its exit", () => {
    const run = execution(
      [
        { seq: 0, nodeId: "start", exitKey: "default", changes: {}, enteredAt: T, leftAt: T },
        {
          seq: 1,
          nodeId: "task",
          exitKey: "success",
          changes: {},
          waited: true,
          enteredAt: T,
          leftAt: T + 100,
        },
        {
          seq: 2,
          nodeId: "unit",
          exitKey: "success",
          changes: {},
          waited: true,
          enteredAt: T + 100,
          leftAt: T + 400,
        },
        { seq: 3, nodeId: "end", exitKey: null, changes: {}, enteredAt: T + 400, leftAt: T + 400 },
      ],
      { tasks, total_tasks: 3, current_task: 4, current_step: 3, total_steps: 3 },
      "completed",
    );
    const projected = projectExecutionRun(graph(), run, { now: T + 10_000 })!;
    expect(projected.nodes[1].timing).toMatchObject({ totalMs: 300, currentMs: null });
    expect(projected.nodes[2].timing.passes[0]).toMatchObject({ open: false, durationMs: 0 });
  });
});

describe("notification line", () => {
  test("names done/total and the current item of the bound block nearest the run", () => {
    const run = execution(
      [
        { seq: 0, nodeId: "start", exitKey: "default", changes: {} },
        { seq: 1, nodeId: "task", exitKey: "success", changes: {}, waited: true },
        { seq: 2, nodeId: "unit", exitKey: null, changes: {}, waited: true },
      ],
      { tasks, total_tasks: 3, current_task: 2, current_step: 1, total_steps: 3 },
    );
    const projected = projectExecutionRun(graph(), run);
    // The active block (units) binds counters only: the line has no item title.
    expect(nearestBoundList(projected)).toMatchObject({ done: 1, total: 3, items: null });
    expect(boundListLine(projected)).toBe("📝 1/3");
    // At the checklist wait the active block is the checklist itself.
    const atTask = projectExecutionRun(graph(), run, { at: 1 });
    expect(boundListLine(atTask)).toBe("📝 1/3: Wire the CLI");
    // A run that reached no bound block has no line.
    const unbound = execution([{ seq: 0, nodeId: "end", exitKey: null, changes: {} }], {});
    expect(boundListLine(projectExecutionRun(graph(), unbound))).toBeNull();
  });
});
