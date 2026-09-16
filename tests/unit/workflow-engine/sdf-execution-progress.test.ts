import { describe, expect, test } from "@jest/globals";
import { projectExecutionRun, type ExecutionVisit } from "@mcp-moira/workflow-engine";
import { sdfExecution, sdfRouteTo, sdfWorkflow } from "../../helpers/sdf-progress-fixture.js";

const workflow = sdfWorkflow();

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

const routeTo = (target: string): ExecutionVisit[] => sdfRouteTo(workflow, target);
const execution = (
  currentNodeId: string | null,
  status: "running" | "completed" = "running",
  visits?: ExecutionVisit[],
) => sdfExecution(workflow, currentNodeId, status, visits);

describe("bundled Software Development Flow progress", () => {
  test.each([
    {
      nodeId: "capture-task-and-context",
      activeId: "intake",
      activeLabel: "Capture task and repository context",
    },
    { nodeId: "create-plan", activeId: "plan", activeLabel: "Plan r3" },
    {
      nodeId: "prepare-plan-unit-implementation",
      activeId: "implement",
      activeLabel: "Prepare · 2/5",
    },
    { nodeId: "validate-cheap", activeId: "unit-validation", activeLabel: "2/5 i4 · Checks" },
    {
      nodeId: "review-architecture",
      activeId: "unit-validation",
      activeLabel: "2/5 i4 · Arch review",
    },
    { nodeId: "checkpoint-plan-unit", activeId: "checkpoint", activeLabel: "Checkpoint · 2/5" },
    { nodeId: "create-final-report", activeId: "final-review", activeLabel: "Create final report" },
    {
      nodeId: "repair-user-feedback",
      activeId: "user-review",
      activeLabel: "2/5 i4 · Feedback fix",
    },
  ])("projects $nodeId onto the block its route reached", ({ nodeId, activeId, activeLabel }) => {
    const run = execution(nodeId);
    const projected = projectExecutionRun(workflow, run)!;

    expect(projected).toMatchObject({
      title: "Software Development · plan r3",
      activeNodeId: activeId,
      workflowVersion: workflow.metadata.version,
      executionRevision: 12,
      routeRecorded: true,
    });
    expect(projected.nodes.map((node) => node.id)).toEqual(progressNodeIds);
    const active = projected.nodes.find((node) => node.id === activeId)!;
    expect(active).toMatchObject({ status: "waiting", label: activeLabel, currentNodeId: nodeId });

    // Only blocks the route actually passed through are done; a block the shortest path never
    // touched is skipped when it lies before the active block, pending after it.
    const visited = new Set(
      run.visits!.map(
        (visit) => workflow.nodes.find((node) => node.id === visit.nodeId)!.progressNodeId,
      ),
    );
    const activeIndex = progressNodeIds.indexOf(activeId);
    projected.nodes.forEach((node, index) => {
      if (node.id === activeId) return;
      if (visited.has(node.id)) expect(["done", "repeated", "skipped"]).toContain(node.status);
      else expect(node.status).toBe(index < activeIndex ? "skipped" : "pending");
    });
  });

  test("a teleported replan shows the teleport exit and the replan block active", () => {
    const visits = routeTo("implement-plan-unit");
    visits[visits.length - 1] = { ...visits[visits.length - 1], exitKey: "teleport", waited: true };
    visits.push({
      seq: visits.length,
      nodeId: "teleport-replan",
      exitKey: null,
      changes: {},
      waited: true,
    });
    const projected = projectExecutionRun(
      workflow,
      execution("teleport-replan", "running", visits),
    )!;
    expect(projected.activeNodeId).toBe("replan");
    expect(projected.nodes.find((node) => node.id === "replan")).toMatchObject({
      status: "waiting",
      label: "Replan · r3",
    });
    expect(projected.nodes.find((node) => node.id === "implement")?.status).toBe("done");
    expect(projected.route.at(-2)).toMatchObject({
      nodeId: "implement-plan-unit",
      exitKey: "teleport",
    });
  });

  test("projects successful completion with every visited block done and nothing else", () => {
    const visits = routeTo("end");
    visits[visits.length - 1] = { ...visits[visits.length - 1], waited: false };
    delete (visits[visits.length - 1] as { waited?: boolean }).waited;
    const projected = projectExecutionRun(workflow, execution(null, "completed", visits))!;

    expect(projected.activeNodeId).toBeNull();
    expect(projected.nodes.map((node) => node.id)).toEqual(progressNodeIds);
    const visited = new Set(
      visits.map(
        (visit) => workflow.nodes.find((node) => node.id === visit.nodeId)!.progressNodeId,
      ),
    );
    for (const node of projected.nodes) {
      if (visited.has(node.id)) expect(["done", "skipped"]).toContain(node.status);
      else expect(["pending", "skipped"]).toContain(node.status);
      expect(node.status).not.toBe("active");
    }
    expect(projected.nodes.find((node) => node.id === "finalize")?.status).toBe("done");
  });

  test("an execution without a recorded route reports only its current block", () => {
    const projected = projectExecutionRun(
      workflow,
      execution("review-architecture", "running", []),
    )!;
    expect(projected.routeRecorded).toBe(false);
    expect(projected.nodes.map((node) => node.status)).toEqual(
      progressNodeIds.map((id) => (id === "unit-validation" ? "waiting" : "pending")),
    );
  });
});
