/**
 * Contract tests for the Deep Corpus Research flow (formerly Robust Research Task).
 *
 * This flow is expensive: subagents read the whole research corpus at planning, at every step and
 * at every gate. Two things must therefore hold and stay visible to an agent choosing a workflow:
 * the catalog identity must not read as a Robust Task variant, and the cost/consent requirement
 * must be enforced inside the flow, not only in the description.
 */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { GraphValidator, type WorkflowGraph } from "@mcp-moira/workflow-engine";

const catalogEntry = findSystemCatalogEntry("deep-corpus-research", "public")!;

function loadWorkflow(): WorkflowGraph {
  return structuredClone(catalogEntry.graph) as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): any {
  const found = workflow.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

describe("deep-corpus-research", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("is structurally valid", async () => {
    const result = await new GraphValidator().validateUnified(workflow);
    expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
  });

  test("carries a catalog identity that cannot be confused with Robust Task", () => {
    // Catalog identity lives on the catalog entry, not in the executable graph: the reader strips
    // slug/owner/visibility from the body, so asking the graph for a slug always answers undefined.
    expect(catalogEntry.slug).toBe("deep-corpus-research");
    expect(workflow.metadata.name).toContain("Deep Corpus Research");
    expect(workflow.metadata.name.toLowerCase()).not.toContain("robust");
    // The cost marker is in the name so it survives a list() that only shows names.
    expect(workflow.metadata.name.toLowerCase()).toContain("expensive");
  });

  test("states the cost and the consent requirement in the description", () => {
    const description = workflow.metadata.description;
    expect(description).toContain("ДОРОГОЙ");
    expect(description).toContain("ТОЛЬКО ПОСЛЕ ЯВНОГО СОГЛАСИЯ ПОЛЬЗОВАТЕЛЯ");
    // An agent scanning the catalog must be told which flow this is not.
    expect(description).toContain("НЕ Robust Task");
  });

  test("enforces the consent gate in the entry node, in both operating modes", () => {
    const entry = node(workflow, "understand-task");
    expect(entry.directive).toContain("ЦЕНА ЗАПУСКА");
    expect(entry.directive).toContain("явно согласился");
    // Autonomy removes intermediate approvals, never a cost gate.
    expect(entry.directive).toContain("`autonomous` его не снимает");
    expect(entry.completionCondition).toContain("согласие");
  });

  test("routes the plan approval by operating mode without losing the interactive gate", () => {
    expect(workflow.variableRegistry?.operating_mode?.enum).toEqual(["autonomous", "interactive"]);

    const route = node(workflow, "route-operating-mode-plan-approval");
    expect(route.type).toBe("condition");
    expect(route.condition.left.contextPath).toBe("operating_mode");
    expect(route.connections).toEqual({
      true: "check-all-steps-done",
      false: "present-plan",
    });

    // Both notification outcomes must enter the mode condition, otherwise a failed notification
    // would still stop an autonomous run at the approval gate.
    expect(node(workflow, "notify-plan-ready").connections).toEqual({
      default: "route-operating-mode-plan-approval",
      error: "route-operating-mode-plan-approval",
    });
  });

  test("decides the bounded gates on evidence instead of asking, in autonomous mode", () => {
    for (const id of [
      "ask-user-skip-or-escalate",
      "ask-user-validation-limit-reached",
      "ask-user-criteria-limit-reached",
    ]) {
      expect(node(workflow, id).directive).toContain("`autonomous` mode decide this yourself");
    }
  });
});
