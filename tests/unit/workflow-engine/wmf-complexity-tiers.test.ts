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
import AjvModule from "ajv";
import {
  SchemaValidator,
  registerWorkflowSchemaKeywords,
} from "../../../packages/workflow-engine/src/utils/schema-validator.js";
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
  return SchemaValidator.validate({ ...PENDING_BY_NODE[nodeId], ...answer }, schema).isValid;
}

/**
 * The value the light review's handshake requires from each side, filled in when a check is about
 * something else; the handshake's own test passes the field explicitly.
 */
const PENDING_BY_NODE: Record<string, Record<string, string>> = {
  "review-workflow-minimum": { light_repair_pending: "" },
  "fix-light-review-findings": { light_repair_pending: "yes" },
};

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
  test.each([
    "create-workflow-json",
    "apply-workflow-changes",
    "fix-quality-issues",
    "fix-light-review-findings",
  ])("%s records exactly one complexity tag and keeps the other tags", (id) => {
    const text = directive(id);
    expect(text).toMatch(/exactly one `complexity:(\{\{complexity_tier\}\}|simple)` tag/u);
    expect(text).toMatch(/`set-tags` replaces the whole list/u);
  });

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

  test.each(["create-workflow-json", "apply-workflow-changes"])(
    "%s holds the minimum before handing over",
    (id) => {
      const text = directive(id);
      expect(text).toContain("no unreachable node");
      expect(text).toMatch(/every route from `start` ends at an `end`/u);
    },
  );

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
      expect(text).toContain(
        "on the `simple` level, `{{#eq action_type 'create'}}workflow-requirements.md{{else}}edit-requirements.md{{/eq}}`",
      );
      expect(text).toContain(
        "no edit plan, no independent plan review, no plan approval, no full antipattern audit",
      );
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

  test.each(["approve-structure", "present-edit-plan", "user-final-review"])(
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

describe("an edit starts from the level recorded on the flow", () => {
  const owner = (answer: Record<string, unknown>) =>
    acceptsAnswer("gather-edit-requirements", {
      progress_requirements_outcome: "Requirements captured",
      ...answer,
    });

  test.each([
    ["none", "simple"],
    ["none", "complex"],
    ["simple", "simple"],
    ["simple", "complex"],
    ["standard", "standard"],
    ["standard", "complex"],
    ["complex", "complex"],
  ])("recorded %s, agreed %s: accepted without a request", (recorded_tier, complexity_tier) => {
    expect(owner({ recorded_tier, complexity_tier })).toBe(true);
  });

  test.each([
    ["standard", "simple"],
    ["complex", "standard"],
    ["complex", "simple"],
  ])(
    "recorded %s, agreed %s: rejected unless the person's request is returned",
    (recorded_tier, complexity_tier) => {
      expect(owner({ recorded_tier, complexity_tier })).toBe(false);
      expect(
        owner({ recorded_tier, complexity_tier, lowering_request: "Keep it simple, please" }),
      ).toBe(true);
    },
  );

  test("the edit requirements owner reads the tag and lowers only on the recorded interactive request", () => {
    const text = directive("gather-edit-requirements");
    expect(text).toContain("Read the level recorded on the flow from its `metadata.tags`");
    expect(text).toContain("return it as `recorded_tier`, or `none`");
    expect(text).toContain("never ran the responsibilities its level skips");
    expect(text).toContain("those responsibilities run over the whole flow");
    expect(text).toContain("A flow without a level tag has an unknown history");
    expect(text).toContain(
      "Go below the recorded level only when the person explicitly asks for it in an interactive run: record the request in their words and the resulting level in `edit-requirements.md` before it takes effect",
    );
    expect(text).toContain("In `autonomous` mode never go below the recorded level.");
  });

  test("a raised edit plans over the whole flow", () => {
    expect(directive("create-edit-plan")).toContain(
      "the responsibilities the recorded level skipped run over the whole flow, not only the changed part",
    );
  });

  test("a simple edit is applied from the edit requirements, without an edit plan", () => {
    expect(directive("apply-workflow-changes")).toContain(
      "On the `simple` level no edit plan exists: apply the changes `{{workspace_path}}/edit-requirements.md` asks for directly.",
    );
  });

  test.each([
    ["create", "workflow-requirements.md", "structure design"],
    ["edit", "edit-requirements.md", "the raised level's audit decision and the edit plan"],
  ])("on %s, the light review reads %s and a raise continues into %s", (action, file, next) => {
    const text = new GraphTemplateProcessor().processDirective(
      directive("review-workflow-minimum"),
      {
        executionId: "wmf-tier-check",
        workflowId: wmf.id ?? "workflow-management-flow",
        userId: "tier-check",
        variables: {
          workspace_path: "./moira-ws/tier-check",
          workflow_artifact_path: "./moira-ws/tier-check/workflow.json",
          action_type: action,
        },
        nodeStates: {},
      },
    );
    expect(text).toContain(`then read \`./moira-ws/tier-check/${file}\``);
    expect(text).toContain(`the run then continues into ${next} from the current requirements`);
  });
});

describe("the person can ask for a simpler process where they are present", () => {
  const LOWER = { lowering_request: "Please keep it simple", escalation_reason: "" };
  const gates: Array<[string, Record<string, unknown>]> = [
    ["approve-structure", { structure_approved: "yes" }],
    ["present-edit-plan", { plan_approval: "yes" }],
    [
      "user-final-review",
      {
        work_approved: "no",
        final_feedback: "Drop the extra checks",
        progress_delivery_outcome: "Awaiting revision",
      },
    ],
  ];

  test.each(gates)("%s lowers only with the person's recorded request", (id, ordinary) => {
    expect(acceptsAnswer(id, ordinary)).toBe(true);
    expect(acceptsAnswer(id, { ...ordinary, ...LOWER, complexity_tier: "simple" })).toBe(true);
    expect(acceptsAnswer(id, { ...ordinary, ...LOWER, complexity_tier: "standard" })).toBe(true);
    // No level without the request, no request without a level, never up to complex, and a
    // lowering clears any earlier raise reason.
    expect(acceptsAnswer(id, { ...ordinary, complexity_tier: "simple" })).toBe(false);
    expect(acceptsAnswer(id, { ...ordinary, lowering_request: "Simpler please" })).toBe(false);
    expect(acceptsAnswer(id, { ...ordinary, ...LOWER, complexity_tier: "complex" })).toBe(false);
    expect(
      acceptsAnswer(id, {
        ...ordinary,
        ...LOWER,
        complexity_tier: "simple",
        escalation_reason: "It grew",
      }),
    ).toBe(false);
  });

  test("after a lowering, the final review names what ran before it and what the lower level skipped", () => {
    expect(directive("user-final-review")).toContain(
      "When the person lowered the level earlier in this run, say so, and name what ran before the lowering as well as what the lower level then skipped.",
    );
  });

  test("the final review lowers only together with a rejection, so the rebuild re-records the tag", () => {
    expect(
      acceptsAnswer("user-final-review", {
        work_approved: "yes",
        progress_delivery_outcome: "Accepted",
        ...LOWER,
        complexity_tier: "simple",
      }),
    ).toBe(false);
  });

  test.each(["approve-structure", "present-edit-plan", "user-final-review"])(
    "%s records the request in the person's words and never proposes lowering itself",
    (id) => {
      const text = directive(id);
      expect(text).toContain("If the person explicitly asks for a simpler process");
      expect(text).toContain("first record their request, in their words,");
      expect(text).toMatch(/and the resulting level in `\{\{workspace_path\}\}\//u);
      expect(text).toContain("Never propose a lower level yourself");
    },
  );

  test.each([
    ["approve-structure", "the design"],
    ["present-edit-plan", "the plan"],
  ])("%s keeps the person's feedback on %s when they also ask to lower", (id, subject) => {
    expect(directive(id)).toContain(
      `together with any feedback they gave on ${subject}, and the resulting level`,
    );
  });

  test.each(["audit-complete-workflow", "review-workflow-design", "fix-edit-plan"])(
    "after a raise, %s works on the workflow as it now stands",
    (id) => {
      expect(directive(id)).toMatch(/workflow as it now stands/u);
    },
  );
});

describe("the flow's own texts agree with its routes on every level", () => {
  const condition = (id: string): string =>
    (wmf.nodes.find((node) => node.id === id) as { completionCondition: string })
      .completionCondition;
  const render = (id: string, variables: Record<string, unknown>): string =>
    new GraphTemplateProcessor().processDirective(directive(id), {
      executionId: "wmf-tier-check",
      workflowId: wmf.id ?? "workflow-management-flow",
      userId: "tier-check",
      variables: { workspace_path: "./moira-ws/tier-check", ...variables },
      nodeStates: {},
    });

  test.each([
    ["audit-complete-workflow", "the workflow as it now stands"],
    ["review-workflow-quality", "escalate"],
    ["create-workflow-json", "exactly one `complexity:` tag"],
    ["create-workflow-json", "no unreachable node"],
    ["apply-workflow-changes", "exactly one `complexity:` tag"],
    ["apply-workflow-changes", "no unreachable node"],
    ["gather-workflow-requirements", "the agreed level and its reason"],
    ["gather-edit-requirements", "the agreed level and its reason"],
    ["approve-structure", "lowering request"],
    ["present-edit-plan", "lowering request"],
    ["user-final-review", "lowering request"],
    ["fix-light-review-findings", "not reproduced"],
  ])("the completion condition of %s names %s", (id, obligation) => {
    expect(condition(id)).toContain(obligation);
  });

  test("no completion condition calls a raised workflow the original or a simple build approved", () => {
    expect(condition("audit-complete-workflow")).not.toMatch(/complete original workflow/u);
    expect(condition("create-workflow-json")).not.toMatch(/^The approved workflow/u);
    expect(condition("apply-workflow-changes")).not.toMatch(/^The approved changes/u);
  });

  test("every input schema compiles under strict types, so validation logs no warning", () => {
    for (const node of wmf.nodes) {
      const schema = (node as { inputSchema?: Record<string, unknown> }).inputSchema;
      if (!schema) continue;
      const { globalInputs: _globals, ...jsonSchema } = schema;

      const ajv = new ((AjvModule as any).default ?? AjvModule)({
        allErrors: true,
        strictTypes: true,
      });
      registerWorkflowSchemaKeywords(ajv);
      expect({
        id: node.id,
        compiles: (() => {
          try {
            ajv.compile(jsonSchema);
            return true;
          } catch (error) {
            return String(error);
          }
        })(),
      }).toEqual({ id: node.id, compiles: true });
    }
  });

  test("the process view names design, review and their simple-level counterparts, never one unconditionally", () => {
    const progress = wmf.progress!;
    const block = (id: string) => progress.nodes.find((node) => node.id === id)!;
    expect(progress.goal).not.toMatch(/through reconciled sources, reviewed semantic design/u);
    expect(progress.goal).toContain("a design or edit plan when the level calls for one");
    expect(progress.goal).toContain("the light or full review the level calls for");
    expect(block("requirements").content?.next).toBe(
      "Design or plan, or on the simple level the build",
    );
    expect(block("review").content?.summary).toBe(
      "Review the complete resulting workflow: the full quality review, or on the simple level the light review",
    );
  });

  test("the description names what the flow materializes without a count", () => {
    expect(wmf.metadata.description).not.toMatch(/\b(nine|ten|eleven|\d+) canonical/u);
    expect(wmf.metadata.description).toContain("canonical thematic authoring references");
  });

  test.each(["user-final-review", "report-final-result"])(
    "on a standard edit, %s names the full antipattern audit only when it did not run",
    (id) => {
      const standardEdit = (answer: string) =>
        render(id, {
          action_type: "edit",
          complexity_tier: "standard",
          "ask-full-antipattern-audit": { full_antipattern_audit: answer },
        });
      expect(standardEdit("no")).toContain(
        "the full antipattern audit of the whole workflow did not run",
      );
      expect(standardEdit("yes")).not.toContain(
        "full antipattern audit of the whole workflow did not run",
      );
    },
  );

  test.each(["user-final-review", "report-final-result"])(
    "%s names any open point the light review carried to the person",
    (id) => {
      expect(directive(id)).toContain(
        "name every open point recorded in `{{workspace_path}}/workflow-light-review.md`",
      );
    },
  );

  test("after a repair that could not reproduce a finding, the light review weighs it and the dispute ends", () => {
    const afterRepair = (repair_outcome: string, light_repair_pending = "yes") =>
      render("review-workflow-minimum", {
        workflow_artifact_path: "./moira-ws/tier-check/workflow.json",
        action_type: "create",
        light_repair_pending,
        "fix-light-review-findings": { repair_outcome },
      });
    const disputed = afterRepair("not_reproduced");
    expect(disputed).not.toContain("check the changed workflow again");
    expect(disputed).toContain(
      "either withdraw the finding or restate it with exact reproduction steps",
    );
    expect(disputed).toContain(
      "when the same finding comes back not reproduced a second time, stop sending it to repair: record it as an open point",
    );
    expect(afterRepair("changed")).toContain("check the changed workflow again from the start");
    // A repair answer the light review already weighed stays in the run's context. After a rebuild
    // the light review reviews a new workflow, so an old dispute or change is not mentioned.
    for (const stale of ["not_reproduced", "changed"]) {
      const rebuilt = afterRepair(stale, "");
      expect(rebuilt).not.toContain("could not reproduce");
      expect(rebuilt).not.toContain("check the changed workflow again");
    }
  });

  test("a repair answer is pending for the light review exactly until the light review answers", () => {
    expect(
      acceptsAnswer("review-workflow-minimum", {
        light_review_outcome: "pass",
        progress_review_outcome: "Passed",
        light_repair_pending: "",
      }),
    ).toBe(true);
    expect(
      acceptsAnswer("fix-light-review-findings", {
        repair_outcome: "changed",
        progress_review_outcome: "Fixed",
        light_repair_pending: "yes",
      }),
    ).toBe(true);
    expect(
      acceptsAnswer("review-workflow-minimum", {
        light_review_outcome: "pass",
        progress_review_outcome: "Passed",
        light_repair_pending: "yes",
      }),
    ).toBe(false);
    expect(
      acceptsAnswer("fix-light-review-findings", {
        repair_outcome: "changed",
        progress_review_outcome: "Fixed",
        light_repair_pending: "",
      }),
    ).toBe(false);
  });

  test("the light repair leaves findings already recorded as open points alone", () => {
    expect(directive("fix-light-review-findings")).toContain(
      "Leave findings the light review recorded as open points for the person alone",
    );
  });

  test("the light repair reports a finding it cannot reproduce with its reason, never with a level", () => {
    const answer = {
      repair_outcome: "not_reproduced",
      progress_review_outcome: "Finding not reproduced",
    };
    expect(acceptsAnswer("fix-light-review-findings", answer)).toBe(false);
    const withReason = {
      ...answer,
      not_reproduced_reason: "The route ends at `end`; traced on the schema",
    };
    expect(acceptsAnswer("fix-light-review-findings", withReason)).toBe(true);
    expect(
      acceptsAnswer("fix-light-review-findings", { ...withReason, complexity_tier: "complex" }),
    ).toBe(false);
    expect(
      acceptsAnswer("fix-light-review-findings", { ...withReason, escalation_reason: "It grew" }),
    ).toBe(false);
  });
});
