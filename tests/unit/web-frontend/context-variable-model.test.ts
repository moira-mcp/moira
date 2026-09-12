import {
  getGlobalVariableNames,
  getNodeIds,
  getVariableDescriptions,
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
