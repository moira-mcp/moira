import { describe, expect, test } from "@jest/globals";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { findSystemCatalogEntry } from "../../../packages/shared/src/services/workflow-catalog.js";
import { renderWorkflowDerivation } from "../../../packages/workflow-cli/src/workflow-derive.js";

function bundled(slug: string): WorkflowGraph {
  return structuredClone(findSystemCatalogEntry(slug, "public")!.graph) as WorkflowGraph;
}

describe("moira-workflow derive", () => {
  test("prints the annotated Quick Task as blocks with transitions, returns and no diagnostics", () => {
    const output = renderWorkflowDerivation(bundled("quick-task"));
    expect(output.split("\n")[0]).toMatch(
      /^PROCESS Quick Task v[\d.]+: 7 blocks, 11 transitions, 5 returns, 0 diagnostics$/,
    );
    expect(output).toContain("BLOCK 3. plan-review — Independent plan review");
    expect(output).toContain("RETURN → plan-review (Independent plan review): review found issues");
    expect(output).toContain("ends when: A review with zero blocking findings.");
    expect(output).toContain("NEXT → execute (Execute plan steps): approved, or autonomous");
    expect(output).toContain("edges: repair-plan.success");
    expect(output.trim().endsWith("DIAGNOSTICS: none")).toBe(true);
  });

  test("prints every diagnostic of a flow whose annotation is incomplete", () => {
    const workflow = bundled("todo-list");
    delete workflow.nodes.find((node) => node.id === "start")!.progressNodeId;
    for (const node of workflow.nodes) {
      if (node.progressNodeId === "prepare") node.progressNodeId = "work";
    }
    const output = renderWorkflowDerivation(workflow);
    expect(output).toContain("DIAGNOSTICS");
    expect(output).toMatch(/unowned-node node=start: Node 'start' must declare progressNodeId/);
    expect(output).toMatch(/empty-block block=/);
  });

  test("says when a workflow has no block view", () => {
    const workflow = bundled("quick-task");
    delete workflow.progress;
    expect(renderWorkflowDerivation(workflow)).toMatch(/no progress definition/);
  });

  test("is deterministic for the same workflow", () => {
    expect(renderWorkflowDerivation(bundled("software-development-flow"))).toBe(
      renderWorkflowDerivation(bundled("software-development-flow")),
    );
  });
});
