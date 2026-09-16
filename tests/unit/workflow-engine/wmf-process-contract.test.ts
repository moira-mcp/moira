/**
 * The Workflow Management Flow is the executable knowledge base for authoring. This pins that the
 * bundled WMF teaches and demands the process block contract: its materialised progress reference
 * states every rule, code and command, and the gate directives that design, review and build a
 * workflow name the contract and the reference that owns it.
 */

import { describe, expect, test } from "@jest/globals";
import { systemCatalogGraph } from "../../helpers/catalog-graphs.js";

const wmf = systemCatalogGraph("workflow-management-flow", "public");
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

describe("Workflow Management Flow prefers routing on the deciding node", () => {
  const engine = wmf.variableRegistry!.workflow_reference_engine.default as string;
  const design = wmf.variableRegistry!.workflow_reference_design.default as string;
  const patterns = wmf.variableRegistry!.workflow_reference_patterns.default as string;
  const antipatterns = wmf.variableRegistry!.workflow_reference_antipatterns.default as string;

  test("the engine reference states the current routing contract and none of the retired one", () => {
    for (const fact of [
      "`cases: [{ when, output }]`",
      "required `default`",
      "routes on its own validated answer",
      "`unreachable-output`",
      "`metadata.schemaVersion`",
    ]) {
      expect(engine).toContain(fact);
    }
    for (const retired of ["only `true`/`false`", "input-retry-exhaustion", "maxRetries"]) {
      expect(engine).not.toContain(retired);
    }
  });

  test("the design reference carries the preference as an outcome with its reason and the rule for a separate node", () => {
    expect(design).toContain("### Decide on the node that has the evidence");
    expect(design).toContain("Why: every extra node is a hop");
    expect(design).toContain(
      "Keep a separate `condition` or `expression` node when it reads better alone",
    );
    expect(design).toContain("The standalone nodes are\nnot deprecated");
  });

  test("the patterns and antipatterns references name routing on the answer and avoidable routing scaffolding", () => {
    expect(patterns).toContain("### Routing on the answer");
    expect(antipatterns).toContain("### Avoidable routing scaffolding");
    expect(antipatterns).toContain("an `expressions` entry\non the node that has the evidence");
  });

  test("the progress reference states the list binding as an outcome with its reason", () => {
    expect(reference).toContain("**A block that works through a list binds it.**");
    expect(reference).toContain("`list: { items?, title?, current?, done?, total?, indexBase? }`");
    expect(reference).toContain("edit-block <id> --list");
    expect(reference).toContain("Nothing in the binding names a plan or a checklist");
  });

  test.each([
    ["design-workflow-structure", "node that has its evidence"],
    ["create-edit-plan", "avoidable routing scaffolding"],
    ["create-workflow-json", "cases on the deciding node"],
    ["apply-workflow-changes", "cases on the deciding node"],
    ["review-workflow-design", "avoidable routing scaffolding"],
    ["review-workflow-quality", "avoidable routing scaffolding"],
  ])("%s demands the routing shape", (id, marker) => {
    expect(directive(id)).toContain(marker);
  });

  test("the producers and gates bind a listed stage's list", () => {
    for (const id of [
      "design-workflow-structure",
      "create-edit-plan",
      "review-workflow-design",
      "review-workflow-quality",
    ]) {
      expect(directive(id)).toMatch(/bind(s|ing)? (it|the list)|without binding it/u);
    }
  });
});
