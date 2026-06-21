/**
 * Engine-level tests for variable-registry default seeding at workflow start.
 *
 * The engine seeds a workflow-global value from `variableRegistry[name].default`
 * when the start node has no matching initialData/input value, and an explicit
 * initialData/input value takes precedence over the registry default.
 */
import { describe, test, expect } from "@jest/globals";
import { runScenario, type TestScenario } from "../../helpers/scenario-runner.js";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

/** Build a minimal start→end workflow with a registry and optional start initialData. */
function buildWorkflow(opts: {
  registry?: WorkflowGraph["variableRegistry"];
  initialData?: { variables?: Record<string, { description: string; value?: unknown }> };
}): WorkflowGraph {
  return {
    id: "registry-seeding-test",
    metadata: {
      name: "Registry Seeding Test",
      version: "1.0.0",
      description: "Verifies registry default seeding at start",
    },
    variableRegistry: opts.registry,
    nodes: [
      {
        type: "start",
        id: "start",
        ...(opts.initialData ? { initialData: opts.initialData } : {}),
        connections: { default: "end" },
      },
      { type: "end", id: "end" },
    ],
  };
}

const completeScenario: TestScenario = {
  name: "seed-defaults",
  mockInputs: {},
  expect: { status: "completed" },
};

describe("Registry default seeding at workflow start", () => {
  test("seeds a registry default when the start node has no matching initialData value", async () => {
    const workflow = buildWorkflow({
      registry: {
        max_retries: { type: "number", description: "Retry budget", default: 3 },
        feature_flag: { type: "boolean", description: "Flag", default: false },
      },
    });

    const result = await runScenario(workflow, completeScenario);

    expect(result.status).toBe("completed");
    expect(result.finalContext.max_retries).toBe(3);
    expect(result.finalContext.feature_flag).toBe(false);
  });

  test("an explicit initialData value takes precedence over the registry default", async () => {
    const workflow = buildWorkflow({
      registry: {
        max_retries: { type: "number", description: "Retry budget", default: 3 },
      },
      initialData: {
        variables: {
          max_retries: { description: "Retry budget", value: 10 },
        },
      },
    });

    const result = await runScenario(workflow, completeScenario);

    expect(result.status).toBe("completed");
    expect(result.finalContext.max_retries).toBe(10);
  });

  test("registry entry without a default does not create a global", async () => {
    const workflow = buildWorkflow({
      registry: {
        optional_note: { type: "string", description: "No default provided" },
      },
    });

    const result = await runScenario(workflow, completeScenario);

    expect(result.status).toBe("completed");
    expect("optional_note" in result.finalContext).toBe(false);
  });

  test("workflow without a registry still seeds initialData values (no regression)", async () => {
    const workflow = buildWorkflow({
      initialData: {
        variables: {
          legacy_var: { description: "Legacy", value: "kept" },
        },
      },
    });

    const result = await runScenario(workflow, completeScenario);

    expect(result.status).toBe("completed");
    expect(result.finalContext.legacy_var).toBe("kept");
  });
});
