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
  "plan",
  "implement",
  "tests",
  "review",
  "checkpoint",
  "finalize",
];

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
      states: ["current", "pending", "pending", "pending", "pending", "pending", "pending"],
    },
    {
      nodeId: "create-plan",
      activeId: "plan",
      activeLabel: "Plan r3",
      states: ["completed", "current", "pending", "pending", "pending", "pending", "pending"],
    },
    {
      nodeId: "prepare-plan-unit-implementation",
      activeId: "implement",
      activeLabel: "Prepare · 2/5",
      states: ["completed", "completed", "current", "pending", "pending", "pending", "pending"],
    },
    {
      nodeId: "validate-cheap",
      activeId: "tests",
      activeLabel: "2/5 i4 · Checks",
      states: ["completed", "completed", "completed", "current", "pending", "pending", "pending"],
    },
    {
      nodeId: "review-architecture",
      activeId: "review",
      activeLabel: "2/5 i4 · Arch review",
      states: ["completed", "completed", "completed", "completed", "current", "pending", "pending"],
    },
    {
      nodeId: "checkpoint-plan-unit",
      activeId: "checkpoint",
      activeLabel: "Checkpoint · 2/5",
      states: [
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
        "current",
        "pending",
      ],
    },
    {
      nodeId: "create-final-report",
      activeId: "finalize",
      activeLabel: "Create final report",
      states: [
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
        "completed",
        "current",
      ],
    },
    {
      nodeId: "repair-user-feedback",
      activeId: "implement",
      activeLabel: "2/5 i4 · Feedback fix",
      states: ["completed", "completed", "current", "pending", "pending", "pending", "pending"],
    },
    {
      nodeId: "teleport-replan",
      activeId: "plan",
      activeLabel: "Replan · r3",
      states: ["completed", "current", "pending", "pending", "pending", "pending", "pending"],
    },
  ])(
    "projects $nodeId onto the concrete SDF phase",
    ({ nodeId, activeId, activeLabel, states }) => {
      const projected = projectExecutionProgress(workflow, execution(nodeId));

      expect(projected).toMatchObject({
        title: "Software Development · plan r3",
        activeNodeId: activeId,
        workflowVersion: workflow.metadata.version,
        executionRevision: 12,
      });
      expect(projected?.nodes.map((node) => node.id)).toEqual(progressNodeIds);
      expect(projected?.nodes.map((node) => node.state)).toEqual(states);
      expect(projected?.nodes.find((node) => node.state === "current")?.label).toBe(activeLabel);
    },
  );

  test("projects successful completion with no active phase", () => {
    const projected = projectExecutionProgress(workflow, execution(null, "completed"));

    expect(projected?.activeNodeId).toBeNull();
    expect(projected?.nodes.map((node) => node.id)).toEqual(progressNodeIds);
    expect(projected?.nodes.map((node) => node.state)).toEqual(
      progressNodeIds.map(() => "completed"),
    );
  });
});
