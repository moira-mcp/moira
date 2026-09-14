/**
 * The Workflow Management Flow is the executable knowledge base for authoring. This pins that the
 * bundled WMF teaches and demands the process block contract: its materialised progress reference
 * states every rule, code and command, and the gate directives that design, review and build a
 * workflow name the contract and the reference that owns it.
 */

import { describe, expect, test } from "@jest/globals";
import { findSystemCatalogEntry } from "../../../packages/shared/src/services/workflow-catalog.js";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const wmf = findSystemCatalogEntry("workflow-management-flow", "public")!.graph as WorkflowGraph;
const reference = wmf.variableRegistry!.workflow_reference_progress.default as string;
const directive = (id: string): string =>
  (wmf.nodes.find((node) => node.id === id) as { directive: string }).directive;

describe("Workflow Management Flow carries the process block contract", () => {
  test.each([
    "progressNodeId",
    "content.summary",
    "connectionLabels",
    "cycle",
    "unowned-node",
    "unknown-block",
    "empty-block",
    "empty-description",
    "unlabeled-edge",
    "unexplained-cycle",
    "outcome-duplicate",
    "outcome-unowned",
    "unconnected-block",
    "**Every block is connected.**",
    "set-block",
    "add-block",
    "edit-block",
    "set-label",
    "clear-label",
    "derive",
    "repeated",
    "skipped",
    "routeRecorded: false",
    // The four facts the unit 4 review left for the reference pass (parent unit 8).
    "`no-start`, which only\n`derive` reports",
    "before the furthest visited block in process order",
    "routing nodes alone",
    "`progress.nodes[].connections.default`, is still\n  accepted",
    "`maxItems`, 18 today",
  ])("the materialised progress reference states %s", (fact) => {
    expect(reference).toContain(fact);
  });

  test("the progress reference no longer describes the retired model", () => {
    for (const retired of ["milestone", "display connection", "observable waiting node"]) {
      expect(reference.toLowerCase()).not.toContain(retired);
    }
  });

  test.each([
    ["design-workflow-structure", "process view"],
    ["create-edit-plan", "process view"],
    ["review-workflow-design", "process view"],
    ["review-workflow-quality", "`derive`"],
    ["create-workflow-json", "`derive`"],
    ["apply-workflow-changes", "`derive`"],
  ])("%s demands the contract and points at the reference", (id, marker) => {
    const text = directive(id);
    expect(text).toContain(marker);
    expect(text).toContain("reference/progress.md");
  });

  test("the quality repair step completes a process-view repair only with derive clean", () => {
    expect(directive("fix-quality-issues")).toContain(
      "run the CLI `derive` on the changed artifact: the repair completes only when it reports no diagnostic",
    );
  });

  test("the design repair owners read the reference when a finding concerns the process view", () => {
    for (const id of ["fix-create-design", "fix-edit-plan"]) {
      expect(directive(id)).toContain("{{workspace_path}}/reference/progress.md");
    }
  });
});
