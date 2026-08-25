/** Behavioral contracts for moira/deep-corpus-research v7.1.2. */
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  GraphValidator,
  MaterializeHandler,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import {
  runScenario,
  type MockInput,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

const entry = findSystemCatalogEntry("deep-corpus-research", "public")!;
const graph = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;

function node(id: string): any {
  const found = graph().nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

const changed = {
  repair_outcome: "changed",
  changed_knowledge: "The reproduced blocker is corrected by a new distinguishing observation.",
};

const completion = {
  completion_outcome: "ready",
  answer_summary: "The corpus supports the decision-facing synthesis.",
  limitation_summary: "Access and applicability limits remain explicit.",
  result_status: "complete",
};

function terminal(status: "complete" | "limited" | "blocked" | "aborted"): MockInput {
  return ({ executionId }) => ({
    artifact_path: `./moira-ws/deep-corpus-research-${executionId}/final-report.md`,
    terminal_status: status,
  });
}

function inputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    intake: {
      intake_outcome: "authorized",
      research_question: "Which architecture fits the constraints?",
      research_use: "Choose one architecture.",
      research_scope: ["Primary corpus"],
      operating_mode: "autonomous",
      expensive_run_consent: "explicitly_authorized",
    },
    "initialize-original-contract": { contract_outcome: "ready" },
    "frame-research": { corpus_status: "ready" },
    "frame-research-from-plan-review": { corpus_status: "ready" },
    "plan-research": { plan_outcome: "ready" },
    "review-plan": { plan_review_outcome: "pass" },
    "repair-plan": changed,
    "repair-plan-from-validation": changed,
    "repair-plan-from-semantic-review": changed,
    "research-evidence": { research_outcome: "ready", corpus_status: "ready" },
    "synthesize-answer": { synthesis_outcome: "ready" },
    "package-completion": completion,
    "validate-package": { validation_outcome: "pass" },
    "semantic-review": { review_outcome: "pass" },
    "repair-answer": changed,
    "repair-answer-from-semantic-review": changed,
    "repair-evidence": changed,
    "repair-evidence-from-semantic-review": changed,
    "reassess-contract": {
      reassessment_outcome: "corrected",
      changed_knowledge: "The corrected criterion now distinguishes the relevant states.",
      reentry_owner: "completion",
    },
    "corrected-contract-review": { contract_review_outcome: "pass" },
    "interactive-acceptance": { user_decision: "accept" },
    "finalize-result": terminal("complete"),
    "finalize-limited": terminal("limited"),
    "finalize-blocked": terminal("blocked"),
    "finalize-aborted": terminal("aborted"),
    "finalize-workspace-blocked": {
      terminal_reason: "Workspace unavailable.",
      terminal_status: "blocked",
    },
    "revise-process": { revision_request: "The evidence criterion cannot distinguish states." },
    ...overrides,
  };
}

function configureMaterialize(engine: GraphExecutionEngine, error = false): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, any> }).nodeHandlers;
  if (error) {
    handlers.set("materialize", {
      getNodeType: () => "materialize",
      execute: async (current: { id: string }) => ({
        nodeId: current.id,
        action: "continue",
        outputPath: "error",
        data: { error: "workspace unavailable" },
      }),
    });
    return;
  }
  handlers.set(
    "materialize",
    new MaterializeHandler(
      { createMaterializeToken: () => "scenario-token" },
      () => "https://moira.example",
    ),
  );
}

async function run(scenario: TestScenario, materializeError = false): Promise<ScenarioResult> {
  return runScenario(graph(), scenario, {
    engineSetup: (engine) => configureMaterialize(engine, materializeError),
  });
}

describe("deep-corpus-research", () => {
  test("publishes the expensive local-only corpus contract", async () => {
    const workflow = graph();
    expect(await new GraphValidator().validateWorkflow(workflow)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(entry.previousSlugs).toEqual(["robust-research-task"]);
    expect(workflow.metadata.version).toBe("7.1.4");
    expect(workflow.metadata.description).toContain("explicit originating-user consent");
    expect(workflow.metadata.description).toContain("never publishes, notifies, commits, deploys");
    expect(workflow.nodes.some((candidate) => candidate.type === "telegram-notification")).toBe(
      false,
    );
  });

  test("keeps the original contract immutable and repairs from exact reports", () => {
    expect(node("initialize-original-contract").directive).toContain("sole writer");
    expect(node("frame-research").directive).toContain("never rewrite");
    expect(graph().variableRegistry).not.toHaveProperty("repair_source");
    expect(node("plan-research").directive).toContain("Delegate one autonomous planning peer");
    expect(node("repair-plan").directive).toContain("plan-findings.md");
    expect(node("repair-plan-from-validation").directive).toContain("package-validation.md");
    expect(node("repair-plan-from-semantic-review").directive).toContain("semantic-review.md");
  });

  test.each([
    [
      "ready research cannot claim replan corpus",
      "research-evidence",
      { research_outcome: "ready", corpus_status: "replan" },
      {},
    ],
    ["research replan requires a cause", "research-evidence", { research_outcome: "replan" }, {}],
    [
      "research replan rejects the neutral sentinel",
      "research-evidence",
      { research_outcome: "replan", revision_request: "No active revision request." },
      {},
    ],
    [
      "plan corpus repair requires a cause",
      "review-plan",
      { plan_review_outcome: "corpus_repair" },
      {},
    ],
    ["semantic repair requires an owner", "semantic-review", { review_outcome: "repair" }, {}],
    [
      "interactive rework requires a concrete request",
      "interactive-acceptance",
      { user_decision: "rework", rework_owner: "corpus" },
      {
        intake: {
          intake_outcome: "authorized",
          research_question: "Question",
          research_use: "Decision",
          research_scope: ["Corpus"],
          operating_mode: "interactive",
          expensive_run_consent: "explicitly_authorized",
        },
      },
    ],
  ])("rejects contradictory output: %s", async (_name, target, invalid, setup) => {
    const result = await run({
      name: String(_name),
      mockInputs: inputs({ ...(setup as Record<string, MockInput>), [String(target)]: invalid }),
      expect: { status: "failed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain(`Input validation failed for node '${String(target)}'`);
  });

  test.each([
    [
      "plan validation",
      "repair-plan-from-validation",
      {
        "validate-package": [{ validation_outcome: "plan_repair" }, { validation_outcome: "pass" }],
      },
    ],
    [
      "plan semantic review",
      "repair-plan-from-semantic-review",
      {
        "validate-package": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
        "semantic-review": [
          { review_outcome: "repair", repair_owner: "plan" },
          { review_outcome: "pass" },
        ],
      },
    ],
    [
      "package semantic review",
      "repair-answer-from-semantic-review",
      {
        "validate-package": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
        "semantic-review": [
          { review_outcome: "repair", repair_owner: "package" },
          { review_outcome: "pass" },
        ],
      },
    ],
    [
      "evidence semantic review",
      "repair-evidence-from-semantic-review",
      {
        "validate-package": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
        "semantic-review": [
          { review_outcome: "repair", repair_owner: "evidence" },
          { review_outcome: "pass" },
        ],
      },
    ],
  ])("routes %s repair through its own producer result", async (_name, repairNode, setup) => {
    for (const [outcome, response, terminalNode] of [
      ["changed", changed, "end"],
      [
        "reassess",
        { repair_outcome: "reassess", revision_request: "The criterion is invalid." },
        "reassess-contract",
      ],
      [
        "blocked",
        { repair_outcome: "blocked", terminal_reason: "Repair prerequisite unavailable." },
        "end-blocked",
      ],
    ] as const) {
      const result = await run({
        name: `${String(_name)} ${outcome}`,
        mockInputs: inputs({
          ...(setup as Record<string, MockInput>),
          [String(repairNode)]: response,
        }),
        expect: { status: "completed", reaches: [String(repairNode), terminalNode] },
      });
      expect(result).toMatchObject({ passed: true });
    }
  });

  test("exercises complete, limited, corpus-repair, interactive-rework and teleport routes", async () => {
    const cases: TestScenario[] = [
      { name: "complete", mockInputs: inputs(), expect: { status: "completed", reaches: ["end"] } },
      {
        name: "limited",
        mockInputs: inputs({
          "frame-research": { corpus_status: "limited" },
          "research-evidence": { research_outcome: "ready", corpus_status: "limited" },
          "package-completion": { ...completion, result_status: "limited" },
        }),
        expect: { status: "completed", reaches: ["end-limited"] },
      },
      {
        name: "plan-review corpus repair",
        mockInputs: inputs({
          "review-plan": [
            {
              plan_review_outcome: "corpus_repair",
              revision_request: "The corpus omits primary material.",
            },
            { plan_review_outcome: "pass" },
          ],
        }),
        expect: { status: "completed", reaches: ["frame-research-from-plan-review", "end"] },
      },
      {
        name: "interactive rework",
        mockInputs: inputs({
          intake: {
            intake_outcome: "authorized",
            research_question: "Question",
            research_use: "Decision",
            research_scope: ["Corpus"],
            operating_mode: "interactive",
            expensive_run_consent: "explicitly_authorized",
          },
          "interactive-acceptance": [
            {
              user_decision: "rework",
              rework_owner: "research",
              revision_request: "Test another interpretation.",
            },
            { user_decision: "accept" },
          ],
        }),
        expect: { status: "completed", reaches: ["route-rework-research", "end"] },
      },
      {
        name: "process revision",
        mockInputs: inputs({
          "reassess-contract": {
            reassessment_outcome: "corrected",
            changed_knowledge: "The process correction changes the corpus contract.",
            reentry_owner: "corpus",
          },
        }),
        teleportAfter: { afterNode: "frame-research", teleportTo: "revise-process" },
        expect: { status: "completed", reaches: ["revise-process", "reassess-contract", "end"] },
      },
    ];

    for (const scenario of cases) {
      const result = await run(scenario);
      if (!result.passed) throw new Error(`${scenario.name}: ${JSON.stringify(result)}`);
    }
  });
});
