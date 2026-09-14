/**
 * The variables panel's grouping model: declared rows come from the registry and the context in
 * name order with the description, the policy's editability and the projection's history; a
 * cursor takes the value from the projection while the context stays the edit target; a global a
 * node wrote is a declared row once and not an output; a node scope with only such globals is no
 * group; an undeclared top-level key still shows as a row; without a projection rows have no
 * history.
 */

import { describe, expect, test } from "@jest/globals";
import { variableRows } from "../../../packages/web-frontend/src/components/run/variableRows";
import type { WorkflowGraph } from "../../../packages/web-frontend/src/types/workflow-types";

const workflow = {
  id: "wf",
  metadata: { name: "wf", version: "1.0.0", description: "" },
  variableRegistry: {
    beta: { type: "string", description: "Beta" },
    alpha: { type: "number", description: "Alpha" },
    unset: { type: "string", description: "Never written" },
  },
  nodes: [
    { id: "start", type: "start", connections: { default: "ask" } },
    { id: "ask", type: "agent-directive", directive: "", completionCondition: "", connections: {} },
  ],
} as unknown as WorkflowGraph;

const context = {
  beta: "b",
  alpha: 1,
  stray: true,
  ask: { alpha: 1, local_result: "r" },
  start: { alpha: 1 },
};

const projection = [
  {
    name: "alpha",
    kind: "variable" as const,
    current: 0,
    history: [
      { seq: 1, nodeId: "start", value: 0 },
      { seq: 3, nodeId: "ask", value: 1, adjusted: true },
    ],
    adjusted: true,
  },
  { name: "ask.local_result", kind: "output" as const, current: "r", history: [], adjusted: false },
];

describe("variableRows", () => {
  test("declared rows in name order with description, editability and history", () => {
    const rows = variableRows({
      context,
      workflow,
      projection,
      atCursor: false,
      editableNames: new Set(["beta"]),
    });
    expect(rows.declared.map((r) => r.name)).toEqual(["alpha", "beta", "stray", "unset"]);
    const alpha = rows.declared[0];
    expect(alpha.description).toBe("Alpha");
    expect(alpha.value).toBe(1);
    expect(alpha.history.map((h) => h.seq)).toEqual([1, 3]);
    expect(alpha.adjusted).toBe(true);
    expect(alpha.editable).toBe(false);
    expect(rows.declared[1].editable).toBe(true);
    expect(rows.declared[3]).toMatchObject({ name: "unset", value: undefined });
    expect(rows.declared[2]).toMatchObject({ name: "stray", description: undefined });
  });

  test("a cursor shows the projection's value; the context value is what an edit targets", () => {
    const rows = variableRows({
      context,
      workflow,
      projection,
      atCursor: true,
      editableNames: new Set(),
    });
    expect(rows.declared.find((r) => r.name === "alpha")?.value).toBe(0);
    expect(rows.declared.find((r) => r.name === "beta")?.value).toBe("b");
  });

  test("outputs are grouped per node without the globals the node wrote; empty scopes are no group", () => {
    const rows = variableRows({
      context,
      workflow,
      projection,
      atCursor: false,
      editableNames: new Set(),
    });
    expect(rows.outputs).toEqual([{ nodeId: "ask", value: { local_result: "r" } }]);
  });

  test("without a projection the rows carry no history and are never adjusted", () => {
    const rows = variableRows({
      context,
      workflow,
      projection: null,
      atCursor: false,
      editableNames: new Set(),
    });
    expect(rows.declared.every((r) => r.history.length === 0 && !r.adjusted)).toBe(true);
    expect(rows.declared.find((r) => r.name === "alpha")?.value).toBe(1);
  });
});
