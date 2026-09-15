import { describe, expect, test } from "@jest/globals";
import { findSystemCatalogEntry } from "../../../packages/shared/src/services/workflow-catalog.js";
import {
  projectExecutionRun,
  type ExecutionVisit,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";

const workflow = structuredClone(
  systemCatalogGraph("software-development-flow", "public"));

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

/**
 * A route to `target`: the shortest authored path from the start node, every node exited through
 * the connection the path took, the target left open as the wait. Real runs are longer; the
 * shortest path is enough to place the run truthfully on the process.
 */
function routeTo(target: string): ExecutionVisit[] {
  const byId = new Map(workflow.nodes.map((node) => [node.id, node]));
  const start = workflow.nodes.find((node) => node.type === "start")!;
  const previous = new Map<string, { from: string; key: string }>();
  const queue = [start.id];
  const seen = new Set([start.id]);
  while (queue.length) {
    const id = queue.shift()!;
    if (id === target) break;
    const connections = (byId.get(id)?.connections ?? {}) as Record<string, string>;
    for (const [key, next] of Object.entries(connections)) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, { from: id, key });
      queue.push(next);
    }
  }
  if (target !== start.id && !previous.has(target)) throw new Error(`${target} is unreachable`);
  const path: Array<{ nodeId: string; exitKey: string | null }> = [
    { nodeId: target, exitKey: null },
  ];
  let cursor = target;
  while (cursor !== start.id) {
    const step = previous.get(cursor)!;
    path.unshift({ nodeId: step.from, exitKey: step.key });
    cursor = step.from;
  }
  return path.map((entry, seq) => ({
    seq,
    ...entry,
    changes: {},
    ...(entry.exitKey === null ? { waited: true } : {}),
  }));
}

function execution(
  currentNodeId: string | null,
  status: "running" | "completed" = "running",
  visits: ExecutionVisit[] = currentNodeId ? routeTo(currentNodeId) : [],
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
    visits,
  };
}

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
