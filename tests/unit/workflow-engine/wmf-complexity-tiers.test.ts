/**
 * The Workflow Management Flow teaches a workflow at the complexity it needs. The knowledge is
 * checked the way the agent receives it — the files WMF's bootstrap materializes, rendered through
 * the template processor — not the registry defaults they come from: the conversation reference
 * both requirements owners read, the starting templates (each a valid workflow as delivered), and
 * the pattern and antipattern catalogues, each entry in exactly one tier with the simple tier free
 * of review, replan, validator and evidence machinery.
 */

import { describe, expect, test } from "@jest/globals";
import {
  GraphValidator,
  renderMaterializeFiles,
  type ExecutionContext,
  type MaterializeNode,
} from "@mcp-moira/workflow-engine";
import { systemCatalogGraph } from "../../helpers/catalog-graphs.js";

const wmf = systemCatalogGraph("workflow-management-flow", "public");
const directive = (id: string): string =>
  (wmf.nodes.find((node) => node.id === id) as { directive: string }).directive;

async function materialized(): Promise<Map<string, string>> {
  const node = wmf.nodes.find(
    (candidate) => candidate.id === "materialize-workspace-bootstrap",
  ) as MaterializeNode;
  const context: ExecutionContext = {
    executionId: "wmf-tier-check",
    workflowId: wmf.id ?? "workflow-management-flow",
    userId: "tier-check",
    variables: { workspace_path: "./moira-ws/tier-check" },
    nodeStates: {},
  };
  const files = await renderMaterializeFiles(node, wmf.variableRegistry ?? {}, context);
  return new Map(files.map((file) => [file.path, file.content.toString()]));
}

/** Entry titles (`### …`) under each `## <Tier> tier` section of a catalogue. */
function tierSections(text: string): Record<string, string[]> {
  const sections: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const tier = /^## (Simple|Standard|Complex) tier$/.exec(line);
    if (tier) {
      current = tier[1].toLowerCase();
      sections[current] = [];
    } else if (line.startsWith("### ")) {
      expect(current).not.toBeNull();
      sections[current!].push(line.slice(4).trim());
    }
  }
  return sections;
}

describe("the conversation reference", () => {
  test("is materialized and read by both requirements owners", async () => {
    const files = await materialized();
    expect(files.has("reference/conversation.md")).toBe(true);
    for (const owner of ["gather-workflow-requirements", "gather-edit-requirements"]) {
      expect(directive(owner)).toContain("{{workspace_path}}/reference/conversation.md");
      // The directive names the reference; the conversation's rules live only there.
      for (const doctrine of ["with their cost", "how the person will tell", "improved later"]) {
        expect(directive(owner)).not.toContain(doctrine);
      }
    }
  });

  test("asks about the goal and success, frames the cost plainly and says a process can be improved later", async () => {
    const conversation = (await materialized()).get("reference/conversation.md")!;
    for (const fact of [
      "## Ask about the goal and about success",
      "how the person will tell that a\nrun went well",
      "Do not ask them to design the process",
      "**Simpler** is faster to build and shorter to run",
      "**More thorough** takes longer to build and gives a bigger process",
      "the quality of the\n  result is higher",
      "**A process can always be improved later.**",
      "take the level from that and do not ask again",
    ]) {
      expect(conversation).toContain(fact);
    }
  });
});

describe("the starting templates", () => {
  test.each(["checklist", "do-check-redo", "approval-gate"])(
    "reference/templates/%s.json is a valid workflow as the agent receives it",
    async (name) => {
      const delivered = (await materialized()).get(`reference/templates/${name}.json`);
      expect(delivered).toBeDefined();
      const result = await new GraphValidator().validateUnified(JSON.parse(delivered!));
      expect(result.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    },
  );
});

describe("the catalogues split by tier", () => {
  test.each([
    ["reference/patterns.md", 5],
    ["reference/antipatterns.md", 47],
  ])("every entry of %s belongs to exactly one tier", async (path, entries) => {
    const text = (await materialized()).get(path)!;
    const sections = tierSections(text);
    expect(Object.keys(sections)).toEqual(["simple", "standard", "complex"]);
    const all = Object.values(sections).flat();
    expect(all).toHaveLength(entries);
    expect(new Set(all).size).toBe(all.length);
    // No entry outside a tier section.
    expect(text.split("\n").filter((line) => line.startsWith("### "))).toHaveLength(entries);
  });

  test("the simple tier carries the short-flow entries and none of the review, replan, validator or evidence machinery", async () => {
    const files = await materialized();
    const patterns = tierSections(files.get("reference/patterns.md")!);
    const antipatterns = tierSections(files.get("reference/antipatterns.md")!);
    expect(patterns.simple).toEqual(
      expect.arrayContaining([
        "Straight-line default",
        "Routing on the answer",
        "Verifiable completion conditions",
      ]),
    );
    expect(antipatterns.simple).toEqual(
      expect.arrayContaining([
        "State without a consumer",
        "Decorative flags, statuses, result codes, and evidence",
        "Unauthorized side effects",
      ]),
    );
    for (const machinery of [
      "Review-loop algebra",
      "Unchanged or unbounded repetition",
      "Mixed validation and repair",
      "Repair before diagnosis",
      "Validator nesting",
      "Validation-only drift",
      "Mechanical validation over the validator",
      "Non-discriminating evidence",
      "Evidence modality mismatch",
      "Changed bytes without changed knowledge",
    ]) {
      expect(antipatterns.simple).not.toContain(machinery);
      expect([...antipatterns.standard, ...antipatterns.complex]).toContain(machinery);
    }
  });
});
