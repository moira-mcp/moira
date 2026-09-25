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
  GraphTemplateProcessor,
  GraphValidator,
  inlineGlobalInputs,
  renderMaterializeFiles,
  type AgentDirectiveNode,
  type ExecutionContext,
  type MaterializeNode,
} from "@mcp-moira/workflow-engine";
import { SchemaValidator } from "../../../packages/workflow-engine/src/utils/schema-validator.js";
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
      "In an interactive run, propose the level in plain words",
      "In an autonomous run, decide it yourself and write down why",
    ]) {
      expect(conversation).toContain(fact);
    }
  });
});

describe("the starting templates", () => {
  test("the conversation recommends exactly the templates the bootstrap delivers", async () => {
    const files = await materialized();
    const conversation = files.get("reference/conversation.md")!;
    const delivered = [...files.keys()]
      .filter((path) => path.startsWith("reference/templates/"))
      .map((path) => path.slice("reference/templates/".length));
    expect(delivered.sort()).toEqual([
      "approval-gate.json",
      "checklist.json",
      "do-check-redo.json",
    ]);
    for (const name of delivered) expect(conversation).toContain(`(\`${name}\`)`);
  });

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

/** The downstream outcomes an escalation resets, because the build and delivery are redone. */
const RESETS = { progress_build_outcome: "Pending", progress_delivery_outcome: "Pending" };

/** Validates an answer against the schema the engine actually applies to the node. */
function acceptsAnswer(nodeId: string, answer: Record<string, unknown>): boolean {
  const node = wmf.nodes.find((candidate) => candidate.id === nodeId)!;
  const schema = (inlineGlobalInputs(node, wmf.variableRegistry) as AgentDirectiveNode)
    .inputSchema as Record<string, unknown>;
  return SchemaValidator.validate(answer, schema).isValid;
}

describe("the level only rises during a create run", () => {
  test("the requirements owner sets any level", () => {
    for (const complexity_tier of ["simple", "standard", "complex"]) {
      expect(
        acceptsAnswer("gather-workflow-requirements", {
          complexity_tier,
          progress_requirements_outcome: "Requirements captured",
        }),
      ).toBe(true);
    }
  });

  test.each([
    ["review-workflow-minimum", "light_review_outcome"],
    ["fix-light-review-findings", "repair_outcome"],
  ])(
    "%s, reached only on simple, raises to standard or complex and never answers simple",
    (id, outcome) => {
      const escalate = (complexity_tier: string) => ({
        [outcome]: "escalate",
        complexity_tier,
        escalation_reason: "It needs a review-and-redo loop",
        ...RESETS,
        progress_review_outcome: "Level raised",
      });
      expect(acceptsAnswer(id, escalate("standard"))).toBe(true);
      expect(acceptsAnswer(id, escalate("complex"))).toBe(true);
      expect(acceptsAnswer(id, escalate("simple"))).toBe(false);
      // Not even alongside an ordinary answer.
      const ordinary = id === "review-workflow-minimum" ? "pass" : "changed";
      expect(
        acceptsAnswer(id, {
          [outcome]: ordinary,
          complexity_tier: "simple",
          progress_review_outcome: "Done",
        }),
      ).toBe(false);
    },
  );

  test.each([
    ["review-workflow-minimum", { light_review_outcome: "pass" }],
    ["review-workflow-minimum", { light_review_outcome: "repair" }],
    ["fix-light-review-findings", { repair_outcome: "changed" }],
    ["review-workflow-quality", { quality_review_outcome: "pass" }],
    ["review-workflow-quality", { quality_review_outcome: "repair" }],
  ])("%s changes neither the level nor its reason without escalating (%o)", (id, outcome) => {
    const ordinary = { ...outcome, progress_review_outcome: "Done" };
    expect(acceptsAnswer(id, ordinary)).toBe(true);
    expect(acceptsAnswer(id, { ...ordinary, complexity_tier: "complex" })).toBe(false);
    expect(acceptsAnswer(id, { ...ordinary, escalation_reason: "It grew" })).toBe(false);
  });

  test("the full quality review, shared by standard and complex, can only raise to complex", () => {
    const answer = (complexity_tier: string) => ({
      quality_review_outcome: "escalate",
      complexity_tier,
      escalation_reason: "Two loops now interact",
      ...RESETS,
      progress_review_outcome: "Level raised",
    });
    expect(acceptsAnswer("review-workflow-quality", answer("complex"))).toBe(true);
    expect(acceptsAnswer("review-workflow-quality", answer("standard"))).toBe(false);
    expect(acceptsAnswer("review-workflow-quality", answer("simple"))).toBe(false);
    expect(
      acceptsAnswer("review-workflow-quality", {
        quality_review_outcome: "pass",
        complexity_tier: "simple",
        progress_review_outcome: "Passed",
      }),
    ).toBe(false);
  });
});

describe("the create owners carry the level", () => {
  test.each(["create-workflow-json", "fix-quality-issues", "fix-light-review-findings"])(
    "%s records exactly one complexity tag and keeps the other tags",
    (id) => {
      const text = directive(id);
      expect(text).toMatch(/exactly one `complexity:(\{\{complexity_tier\}\}|simple)` tag/u);
      expect(text).toMatch(/`set-tags` replaces the whole list/u);
    },
  );

  test.each(["review-workflow-quality", "review-workflow-minimum"])(
    "%s verifies the tag and the non-removable minimum, the unreachable-node warning blocking",
    (id) => {
      const text = directive(id);
      expect(text).toMatch(/exactly one `complexity:(\{\{complexity_tier\}\}|simple)` tag/u);
      expect(text).toContain("no unreachable node");
      expect(text).toMatch(/unreachable-node warning is a blocker/u);
      expect(text).toMatch(/every route from `start` ends at an `end`/u);
    },
  );

  test("the build holds the minimum before handing over", () => {
    const text = directive("create-workflow-json");
    expect(text).toContain("no unreachable node");
    expect(text).toMatch(/every route from `start` ends at an `end`/u);
  });

  test("the light review asks the two questions", () => {
    const text = directive("review-workflow-minimum");
    expect(text).toContain("does the workflow do what the person asked");
    expect(text).toContain(
      "does every completion condition name an observable result rather than an intention",
    );
  });

  test.each(["user-final-review", "report-final-result"])(
    "%s names what a level below complex skipped and the way back",
    (id) => {
      const text = directive(id);
      expect(text).toContain("below `complex`, name in plain words what this level skipped");
      expect(text).toContain("no independent design review");
      expect(text).toContain("start this flow again in edit mode on this workflow");
      expect(text).toContain("on the `simple` level, the requirements file");
    },
  );

  test("the autonomous report states the level, its reason and any raise", () => {
    expect(directive("report-final-result")).toContain(
      "State the level, why it was chosen, and any raise of the level during the run with its reason",
    );
  });

  test("every catalogue reader applies its level's sections and those below, not higher ones", () => {
    const readers = wmf.nodes
      .filter((node) =>
        (node as { directive?: string }).directive?.includes("reference/patterns.md"),
      )
      .map((node) => node.id);
    expect(readers.length).toBeGreaterThan(0);
    for (const id of readers) {
      const text = directive(id);
      const scoped =
        text.includes("the current `{{complexity_tier}}` tier and every tier below it") ||
        text.includes("the `## Simple tier` sections");
      expect({ id, scoped }).toEqual({ id, scoped: true });
    }
  });
});

describe("a return to design after a build", () => {
  const rendered = (id: string, variables: Record<string, unknown>): string =>
    new GraphTemplateProcessor().processDirective(directive(id), {
      executionId: "wmf-tier-check",
      workflowId: wmf.id ?? "workflow-management-flow",
      userId: "tier-check",
      variables: { workspace_path: "./moira-ws/tier-check", ...variables },
      nodeStates: {},
    });
  const built = { workflow_artifact_path: "./moira-ws/tier-check/workflow.json" };

  test("without a raise, design reads the built workflow and claims no raise", () => {
    const text = rendered("design-workflow-structure", { ...built, complexity_tier: "standard" });
    expect(text).toContain("A workflow was already built at `./moira-ws/tier-check/workflow.json`");
    expect(text).not.toMatch(/raised/u);
  });

  test.each(["design-workflow-structure", "report-final-result"])(
    "after a raise, %s states the raised level and the reason the review gave",
    (id) => {
      const text = rendered(id, {
        ...built,
        complexity_tier: "complex",
        escalation_reason: "the flow has to call a sub-process",
      });
      expect(text).toContain(
        "The level was raised to `complex` during this run, and the review gave this reason: “the flow has to call a sub-process”.",
      );
    },
  );

  test.each(["approve-structure", "user-final-review"])(
    "in an interactive run, %s tells the person why the process grew and what it costs",
    (id) => {
      const raised = rendered(id, {
        ...built,
        complexity_tier: "standard",
        escalation_reason: "the check must be redone until it passes",
      });
      expect(raised).toContain(
        "tell the person in plain words that the level was raised to `standard` during this run, and the review gave this reason: “the check must be redone until it passes”",
      );
      expect(raised).toContain("what it costs");
      expect(rendered(id, { ...built, complexity_tier: "standard" })).not.toMatch(/raised/u);
    },
  );
});
