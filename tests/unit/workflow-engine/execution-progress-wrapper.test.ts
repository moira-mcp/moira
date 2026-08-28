import { describe, expect, test } from "@jest/globals";
import {
  createExecutionProgressImageRenderer,
  projectExecutionProgress,
  renderExecutionProgressImage,
  renderExecutionProgressPng,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

function workflow(withProgress = true): WorkflowGraph {
  return {
    metadata: { name: "Wrapper", version: "2.3.4", description: "Wrapper fixture" },
    ...(withProgress ? { progress: { nodes: [{ id: "work", label: "Work {{unit}}" }] } } : {}),
    variableRegistry: { unit: { type: "integer", description: "Unit", default: 1 } },
    nodes: [
      { id: "start", type: "start", connections: { default: "work" } },
      {
        id: "work",
        type: "agent-directive",
        progressNodeId: "work",
        progressActiveLabel: "Implement {{unit}}/3",
        directive: "Work",
        completionCondition: "Done",
        connections: { success: "end" },
      },
      { id: "end", type: "end" },
    ],
  };
}

function execution(): WorkflowExecution {
  return {
    executionId: "execution",
    workflowId: "workflow",
    userId: "user",
    currentNodeId: "work",
    globalContext: {
      variables: { unit: 2 },
      nodeStates: {},
      executionId: "execution",
      workflowId: "workflow",
      userId: "user",
    },
    status: "running",
    revision: 9,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("public execution progress image wrapper", () => {
  test("returns complete metadata and the same bytes as shared projection plus PNG adapter", async () => {
    const graph = workflow();
    const run = execution();
    const graphBefore = structuredClone(graph);
    const runBefore = structuredClone(run);
    const rendered = await renderExecutionProgressImage(graph, run, { viewportWidth: 640 });
    const progress = projectExecutionProgress(graph, run)!;
    const lowerLevel = await renderExecutionProgressPng(progress, { viewportWidth: 640 });

    expect(rendered).toMatchObject({
      mimeType: "image/png",
      width: lowerLevel.model.width,
      height: lowerLevel.model.height,
      workflowVersion: "2.3.4",
      executionRevision: 9,
    });
    expect(rendered?.buffer.equals(lowerLevel.png)).toBe(true);
    expect(graph).toEqual(graphBefore);
    expect(run).toEqual(runBefore);
  });

  test("returns null when the workflow has no progress graph", async () => {
    expect(await renderExecutionProgressImage(workflow(false), execution())).toBeNull();
  });

  test("propagates renderer failures and does not mutate its inputs", async () => {
    const graph = workflow();
    const run = execution();
    const graphBefore = structuredClone(graph);
    const runBefore = structuredClone(run);
    const failure = new Error("render failed");
    const render = createExecutionProgressImageRenderer(async () => {
      throw failure;
    });

    await expect(render(graph, run)).rejects.toBe(failure);
    expect(graph).toEqual(graphBefore);
    expect(run).toEqual(runBefore);
  });
});
