import { describe, expect, test } from "@jest/globals";
import { findSystemCatalogEntry } from "../../../packages/shared/src/services/workflow-catalog.js";
import {
  projectExecutionProgress,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

const workflow = structuredClone(
  findSystemCatalogEntry("software-development-flow", "public")!.graph,
) as WorkflowGraph;

const progressNodeIds = [
  "intake",
  "health",
  "plan",
  "plan-approval",
  "implement",
  "unit-validation",
  "broad-validation",
  "completeness",
  "user-review",
  "checkpoint",
  "feature-validation",
  "final-review",
  "replan",
  "finalize",
  "stopped",
];

/** Index projection: blocks before the active one are completed, the rest pending. */
function statesFor(activeId: string): string[] {
  const active = progressNodeIds.indexOf(activeId);
  return progressNodeIds.map((_, i) =>
    i < active ? "completed" : i === active ? "current" : "pending",
  );
}

function execution(
  currentNodeId: string | null,
  status: "running" | "completed" = "running",
): WorkflowExecution {
  return {
    executionId: "sdf-progress-contract",
    workflowId: workflow.id ?? "software-development-flow",
    userId: "test-user",
    currentNodeId,
    waitingForInputNodeId: currentNodeId,
    globalContext: {
      variables: {
        plan_revision: 3,
        current_step_index: 2,
        total_steps: 5,
        current_iteration: 4,
      },
      nodeStates: {},
      executionId: "sdf-progress-contract",
      workflowId: workflow.id ?? "software-development-flow",
      userId: "test-user",
      currentNodeId,
    },
    status,
    revision: 12,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("bundled Software Development Flow progress", () => {
  test.each([
    {
      nodeId: "capture-task-and-context",
      activeId: "intake",
      activeLabel: "Capture task and repository context",
    },
    {
      nodeId: "create-plan",
      activeId: "plan",
      activeLabel: "Plan r3",
    },
    {
      nodeId: "prepare-plan-unit-implementation",
      activeId: "implement",
      activeLabel: "Prepare · 2/5",
    },
    {
      nodeId: "validate-cheap",
      activeId: "unit-validation",
      activeLabel: "2/5 i4 · Checks",
    },
    {
      nodeId: "review-architecture",
      activeId: "unit-validation",
      activeLabel: "2/5 i4 · Arch review",
    },
    {
      nodeId: "checkpoint-plan-unit",
      activeId: "checkpoint",
      activeLabel: "Checkpoint · 2/5",
    },
    {
      nodeId: "create-final-report",
      activeId: "final-review",
      activeLabel: "Create final report",
    },
    {
      nodeId: "repair-user-feedback",
      activeId: "user-review",
      activeLabel: "2/5 i4 · Feedback fix",
    },
    {
      nodeId: "teleport-replan",
      activeId: "replan",
      activeLabel: "Replan · r3",
    },
  ])("projects $nodeId onto the concrete SDF phase", ({ nodeId, activeId, activeLabel }) => {
    const projected = projectExecutionProgress(workflow, execution(nodeId));

    expect(projected).toMatchObject({
      title: "Software Development · plan r3",
      activeNodeId: activeId,
      workflowVersion: workflow.metadata.version,
      executionRevision: 12,
    });
    expect(projected?.nodes.map((node) => node.id)).toEqual(progressNodeIds);
    expect(projected?.nodes.map((node) => node.state)).toEqual(statesFor(activeId));
    expect(projected?.nodes.find((node) => node.state === "current")?.label).toBe(activeLabel);
  });

  test("projects successful completion with no active phase", () => {
    const projected = projectExecutionProgress(workflow, execution(null, "completed"));

    expect(projected?.activeNodeId).toBeNull();
    expect(projected?.nodes.map((node) => node.id)).toEqual(progressNodeIds);
    expect(projected?.nodes.map((node) => node.state)).toEqual(
      progressNodeIds.map(() => "completed"),
    );
  });
});
