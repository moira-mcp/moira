import {
  buildContextVariables,
  getGlobalVariableNames,
  getNodeIds,
  getVariableDescriptions,
  sortVariablesByName,
  type ContextVariable,
} from "../../../packages/web-frontend/src/utils/context-variable-model";
import type { WorkflowGraph } from "../../../packages/web-frontend/src/types/workflow-types";

function makeWorkflow(
  nodes: unknown[],
  variableRegistry?: WorkflowGraph["variableRegistry"],
): WorkflowGraph {
  return {
    id: "wf-test",
    metadata: { name: "Test", version: "1.0.0", description: "" },
    nodes: nodes as WorkflowGraph["nodes"],
    variableRegistry,
  };
}

const workflow = makeWorkflow(
  [
    { type: "start", id: "start", connections: { default: "ask" } },
    {
      type: "agent-directive",
      id: "ask",
      directive: "Ask",
      completionCondition: "Done",
      connections: { success: "end" },
    },
    { type: "end", id: "end" },
  ],
  {
    current_iteration: { type: "number", description: "Stores current iteration", default: 1 },
    quality_standards: { type: "string", description: "Quality standards", default: "high" },
  },
);

describe("getGlobalVariableNames", () => {
  it("returns names declared in the variableRegistry", () => {
    const names = getGlobalVariableNames(workflow);
    expect(names.has("current_iteration")).toBe(true);
    expect(names.has("quality_standards")).toBe(true);
    expect(names.has("ask")).toBe(false);
  });

  it("tolerates a missing registry", () => {
    expect(getGlobalVariableNames(undefined).size).toBe(0);
    expect(getGlobalVariableNames(makeWorkflow([{ type: "start", id: "s" }])).size).toBe(0);
  });
});

describe("getNodeIds", () => {
  it("returns all node ids in the workflow", () => {
    const ids = getNodeIds(workflow);
    expect(ids.has("start")).toBe(true);
    expect(ids.has("ask")).toBe(true);
    expect(ids.has("end")).toBe(true);
  });
});

describe("getVariableDescriptions", () => {
  it("collects descriptions from the registry (single source of truth)", () => {
    const d = getVariableDescriptions(workflow);
    expect(d.current_iteration).toBe("Stores current iteration");
    expect(d.quality_standards).toBe("Quality standards");
  });

  it("returns empty map without a registry", () => {
    expect(getVariableDescriptions(undefined)).toEqual({});
  });
});

describe("buildContextVariables", () => {
  it("classifies origin: global (registry) vs node-local (node id) vs runtime", () => {
    const vars = buildContextVariables(
      {
        current_iteration: 3, // registry global
        ask: { result: "answered" }, // node-local scope (node id 'ask')
        runtime_only: "appeared", // neither
      },
      workflow,
    );
    const byName = Object.fromEntries(vars.map((v) => [v.name, v]));
    expect(byName.current_iteration.origin).toBe("global");
    expect(byName.ask.origin).toBe("node-local");
    expect(byName.runtime_only.origin).toBe("runtime");
  });

  it("attaches registry descriptions to globals only", () => {
    const vars = buildContextVariables(
      {
        current_iteration: 3,
        ask: { result: "answered" },
        runtime_only: "appeared",
      },
      workflow,
    );
    const byName = Object.fromEntries(vars.map((v) => [v.name, v]));
    expect(byName.current_iteration.description).toBe("Stores current iteration");
    expect(byName.ask.description).toBeUndefined();
    expect(byName.runtime_only.description).toBeUndefined();
  });

  it("returns empty list for empty/undefined context", () => {
    expect(buildContextVariables(undefined, workflow)).toEqual([]);
    expect(buildContextVariables({}, workflow)).toEqual([]);
  });

  it("works without a workflow definition (all runtime, no descriptions)", () => {
    const vars = buildContextVariables({ a: 1, b: { x: 1 } }, undefined);
    expect(vars).toHaveLength(2);
    for (const v of vars) {
      expect(v.origin).toBe("runtime");
      expect(v.description).toBeUndefined();
    }
  });
});

describe("sortVariablesByName", () => {
  it("sorts case-insensitively by name and does not mutate input", () => {
    const input: ContextVariable[] = [
      { name: "Zebra", value: 1, origin: "runtime" },
      { name: "alpha", value: 1, origin: "runtime" },
      { name: "Beta", value: 1, origin: "runtime" },
    ];
    const sorted = sortVariablesByName(input);
    expect(sorted.map((v) => v.name)).toEqual(["alpha", "Beta", "Zebra"]);
    // input untouched
    expect(input.map((v) => v.name)).toEqual(["Zebra", "alpha", "Beta"]);
  });
});
