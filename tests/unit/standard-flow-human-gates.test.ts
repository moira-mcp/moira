/**
 * The steps where the standard flows wait for a person's decision, held as a list confirmed by
 * reading each directive. A step marked or unmarked by accident, a changed `notify`, a lost `when`
 * or reminder, all show up here as a difference from that list. The list says where the flows
 * wait; whether each `when` is right is shown by the flows' scenario runs, which read the stored
 * mark in both modes.
 */

import { describe, expect, test } from "@jest/globals";
import { readWorkflowCatalog } from "@mcp-moira/shared";
import {
  GraphValidator,
  isAgentDirectiveNode,
  type AgentDirectiveNode,
  type HumanGate,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { systemCatalogGraph } from "../helpers/catalog-graphs.js";

/** Interactive-only: the step waits for the person unless the run is autonomous. */
const INTERACTIVE = {
  operator: "neq",
  left: { contextPath: "operating_mode" },
  right: "autonomous",
};

type Gate = [nodeId: string, notify: "auto" | "off", when: "interactive" | "always"];

/**
 * Every gate, with how the person is told first and when the step waits for them. Each has a
 * one-day reminder. `auto` is kept for a step no flow message precedes; every other step is
 * announced by the flow's own message, which carries what the person decides on.
 */
const APPROVED: Record<string, Gate[]> = {
  "quick-task": [
    ["present-plan", "off", "always"],
    ["present-to-user", "off", "always"],
  ],
  "robust-task": [
    ["approve-plan", "off", "always"],
    ["ask-retry-decision", "off", "interactive"],
    ["ask-plan-review-limit", "off", "interactive"],
    ["ask-final-review-limit", "off", "interactive"],
  ],
  "software-development-flow": [
    ["confirm-requirements", "auto", "always"],
    ["approve-plan", "off", "always"],
    ["review-plan-unit-with-user", "off", "always"],
    ["approve-current-unit-closure", "off", "interactive"],
    ["report-and-accept-feature", "off", "always"],
    ["resolve-finalization-blocker", "off", "always"],
    ["wait-for-health-state-change", "off", "always"],
    ["wait-for-runtime-state-change", "off", "always"],
    ["wait-for-expensive-state-change", "off", "always"],
    ["wait-for-feature-state-change", "off", "always"],
  ],
  "workflow-management-flow": [
    ["approve-structure", "off", "always"],
    ["present-edit-plan", "off", "always"],
    ["user-final-review", "off", "always"],
    ["ask-full-antipattern-audit", "off", "interactive"],
    ["ask-upload", "off", "interactive"],
    ["handle-upload-error", "off", "interactive"],
  ],
  // The checklist runs its items without asking anyone.
  "todo-list": [],
};

function gatesOf(workflow: WorkflowGraph): Gate[] {
  return workflow.nodes.flatMap((node) => {
    if (!isAgentDirectiveNode(node) || !node.humanGate) return [];
    const gate: HumanGate = node.humanGate;
    expect([node.id, gate.remindAfter]).toEqual([node.id, "1d"]);
    expect([node.id, (gate.label ?? "").trim().length > 0]).toEqual([node.id, true]);
    if (gate.when) expect([node.id, gate.when]).toEqual([node.id, INTERACTIVE]);
    return [[node.id, gate.notify ?? "auto", gate.when ? "interactive" : "always"] as Gate];
  });
}

describe("the standard flows' human gates", () => {
  test.each(Object.keys(APPROVED))("%s marks exactly the approved steps", (slug) => {
    const byId = (gates: Gate[]) => [...gates].sort(([a], [b]) => a.localeCompare(b));
    expect(byId(gatesOf(systemCatalogGraph(slug)))).toEqual(byId(APPROVED[slug]));
  });

  test("the full audit asks at the end of its own work, so it raises the question instead of a mark", () => {
    // Marked, the step would read «waiting for you» through the whole audit; its directive has the
    // agent raise `session await-user` when it asks, which shows the wait and tells the person.
    const audit = systemCatalogGraph("workflow-management-flow").nodes.find(
      (node) => node.id === "audit-complete-workflow",
    ) as AgentDirectiveNode;
    expect(audit.humanGate).toBeUndefined();
    expect(audit.directive).toContain('session({ action: "await-user"');
  });

  test("no bundled flow tells the person twice about one wait", async () => {
    const validator = new GraphValidator();
    const doubled: string[] = [];
    for (const entry of readWorkflowCatalog()) {
      const result = await validator.validateUnified(entry.graph as unknown as WorkflowGraph);
      for (const issue of result.issues) {
        if (issue.message.includes("gate-notified-twice"))
          doubled.push(`${entry.slug}: ${issue.nodeId}`);
      }
    }
    expect(doubled).toEqual([]);
  });
});
