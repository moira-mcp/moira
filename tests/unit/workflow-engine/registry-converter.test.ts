/**
 * Unit tests for convertWorkflowToRegistry — legacy initialData.variables → variableRegistry.
 */
import { describe, test, expect } from "@jest/globals";
import { convertWorkflowToRegistry, inferRegistryType } from "@mcp-moira/workflow-engine";

function flow(vars?: Record<string, { description?: string; value?: unknown }>) {
  return {
    id: "wf-1",
    metadata: { name: "WF", version: "1.0.0", description: "" },
    nodes: [
      { type: "start", id: "start", initialData: vars ? { variables: vars } : undefined },
      { type: "end", id: "end" },
    ],
  };
}

describe("inferRegistryType", () => {
  test.each([
    ["s", "string"],
    [3, "number"],
    [true, "boolean"],
    [{ a: 1 }, "object"],
    [[1, 2], "array"],
    [null, "null"],
    [undefined, "null"],
  ])("infers %p as %s", (value, expected) => {
    expect(inferRegistryType(value)).toBe(expected);
  });
});

describe("convertWorkflowToRegistry", () => {
  test("builds a registry from initialData.variables with type/description/default", () => {
    const { workflow, changed, variableCount } = convertWorkflowToRegistry(
      flow({
        feature_name: { description: "Feature", value: "auth" },
        count: { description: "Count", value: 0 },
      }),
    );
    expect(changed).toBe(true);
    expect(variableCount).toBe(2);
    expect(workflow.variableRegistry).toEqual({
      feature_name: { type: "string", description: "Feature", default: "auth" },
      count: { type: "number", description: "Count", default: 0 },
    });
  });

  test("omits default when legacy value is undefined", () => {
    const { workflow } = convertWorkflowToRegistry(flow({ x: { description: "X" } }));
    expect(workflow.variableRegistry!.x).toEqual({ type: "null", description: "X" });
    expect("default" in workflow.variableRegistry!.x).toBe(false);
  });

  test("is idempotent: a workflow that already has a registry is unchanged", () => {
    const migrated = convertWorkflowToRegistry(
      flow({ a: { description: "A", value: 1 } }),
    ).workflow;
    const second = convertWorkflowToRegistry(migrated);
    expect(second.changed).toBe(false);
    expect(second.workflow).toBe(migrated);
    expect(second.variableCount).toBe(1);
  });

  test("missing-tolerant: no start node yields an empty registry", () => {
    const { workflow, changed, variableCount } = convertWorkflowToRegistry({
      id: "wf",
      metadata: { name: "n", version: "1.0.0", description: "" },
      nodes: [{ type: "end", id: "end" }],
    });
    expect(changed).toBe(true);
    expect(variableCount).toBe(0);
    expect(workflow.variableRegistry).toEqual({});
  });

  test("missing-tolerant: start node without initialData yields an empty registry", () => {
    const { workflow, variableCount } = convertWorkflowToRegistry(flow(undefined));
    expect(variableCount).toBe(0);
    expect(workflow.variableRegistry).toEqual({});
  });

  test("leaves original initialData.variables intact (transition reads still work)", () => {
    const { workflow } = convertWorkflowToRegistry(flow({ a: { description: "A", value: 1 } }));
    const start = workflow.nodes.find((n) => n.type === "start")!;
    expect(start.initialData!.variables!.a).toEqual({ description: "A", value: 1 });
  });
});
