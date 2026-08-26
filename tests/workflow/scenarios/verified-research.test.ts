/** Contract and route scenarios for moira/verified-research v3. */
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  GraphValidator,
  MaterializeHandler,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import {
  runScenario,
  type MockInput,
  type ScenarioResult,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

const entry = findSystemCatalogEntry("verified-research", "public")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;
const workspace = (executionId: string) => `./moira-ws/verified-research-${executionId}`;

function node(graph: WorkflowGraph, id: string): any {
  const found = graph.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function terminal(status: "complete" | "limited" | "blocked" | "aborted"): MockInput {
  return ({ executionId }) => ({
    artifact_path: `${workspace(executionId)}/final-report.md`,
    terminal_status: status,
  });
}

const readyCompletion = {
  completion_outcome: "ready",
  answer_summary: "The bounded answer is supported by the current evidence register.",
  limitation_summary: "Material uncertainty and applicability limits remain explicit.",
};

function inputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    intake: {
      intake_outcome: "actionable",
      research_question: "Which API rate-limiting approach fits a multi-region service?",
      research_use: "Choose a production architecture with explicit trade-offs.",
      research_scope: ["HTTP APIs", "multi-region consistency", "current primary sources"],
      operating_mode: "autonomous",
    },
    "clarify-question": {
      clarification_outcome: "ready",
      research_question: "Which API rate-limiting approach fits a multi-region service?",
      research_use: "Choose a production architecture with explicit trade-offs.",
      research_scope: ["HTTP APIs", "multi-region consistency"],
    },
    "materialize-workspace": {},
    "frame-research": { framing_outcome: "ready" },
    "research-evidence": { evidence_status: "ready" },
    "synthesize-answer": { synthesis_outcome: "ready" },
    "package-completion": readyCompletion,
    "validate-package": { validation_outcome: "pass" },
    "semantic-review": { review_outcome: "pass" },
    "repair-answer": {
      repair_outcome: "changed",
      changed_knowledge: "The answer now separates inference from sourced facts.",
    },
    "repair-evidence": {
      repair_outcome: "changed",
      changed_knowledge: "The source register now links every material claim to a reading.",
    },
    "reassess-contract": {
      reassessment_outcome: "corrected",
      changed_knowledge: "The criterion now has a discriminating observation.",
    },
    "corrected-contract-review": { contract_review_outcome: "pass" },
    "interactive-acceptance": { user_decision: "accept" },
    "finalize-result": terminal("complete"),
    "finalize-limited": terminal("limited"),
    "finalize-blocked": terminal("blocked"),
    "finalize-workspace-blocked": {
      terminal_reason: "The canonical workspace could not be materialized.",
      terminal_status: "blocked",
    },
    "finalize-aborted": terminal("aborted"),
    "revise-process": { revision_reason: "The evidence criterion cannot distinguish states." },
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
  return runScenario(workflow(), scenario, {
    engineSetup: (engine) => configureMaterialize(engine, materializeError),
  });
}

describe("verified-research", () => {
  test("publishes the bounded v3 identity and local artifact contract", async () => {
    const graph = workflow();
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(graph.id).toBe("1617b350-5e58-46a9-a783-fb9a69aec9bd");
    expect(graph.metadata.version).toBe("3.0.0");
    expect(graph.metadata.description).toContain("proportionate set");
    expect(graph.metadata.description).toContain("Completion is local");
    expect(graph.nodes.some((candidate) => candidate.type === "telegram-notification")).toBe(false);
    expect(graph.variableRegistry).not.toHaveProperty("answer_status");
  });

  test("keeps detailed bodies in one execution-correlated workspace", () => {
    const graph = workflow();
    expect(graph.variableRegistry?.workspace_path).toMatchObject({
      default: "./moira-ws/verified-research-{{executionId}}",
    });
    expect(
      node(graph, "materialize-workspace").files.map((file: { path: string }) => file.path),
    ).toEqual([
      "process-id.txt",
      "framing.md",
      "source-register.md",
      "readings.md",
      "alternative-views.md",
      "answer.md",
      "limitations.md",
      "package-validation.md",
      "semantic-review.md",
      "contract-review.md",
      "contract-review-findings.md",
      "repair-account.md",
      "final-report.md",
    ]);
    expect(node(graph, "finalize-result").inputSchema.xContextPathSuffixes).toEqual({
      baseContextProperty: "workspace_path",
      properties: { artifact_path: "/final-report.md" },
    });
  });

  test("uses one reviewed evidence class for usable routing and terminal truth", () => {
    const graph = workflow();
    expect(node(graph, "research-evidence").inputSchema.required).toContain("evidence_status");
    expect(node(graph, "research-evidence").inputSchema.properties).not.toHaveProperty(
      "research_outcome",
    );
    expect(node(graph, "route-evidence-usable").condition.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ left: { contextPath: "evidence_status" }, right: "ready" }),
        expect.objectContaining({ left: { contextPath: "evidence_status" }, right: "limited" }),
      ]),
    );
    expect(node(graph, "semantic-review").directive).toContain("exact canonical evidence_status");
    expect(node(graph, "route-final-answer-status").condition).toMatchObject({
      left: { contextPath: "evidence_status" },
      right: "ready",
    });
  });

  test.each([
    [
      "autonomous clarification",
      "intake",
      {
        intake_outcome: "clarify",
        clarification_request: "Which jurisdiction?",
        operating_mode: "autonomous",
      },
      {},
    ],
    ["actionable intake without question", "intake", { intake_outcome: "actionable" }, {}],
    [
      "usable evidence with blocker",
      "research-evidence",
      { evidence_status: "limited", terminal_reason: "contradictory" },
      {},
    ],
    [
      "blocked evidence with replan reason",
      "research-evidence",
      { evidence_status: "blocked", outcome_reason: "contradictory" },
      {},
    ],
    ["semantic repair without owner", "semantic-review", { review_outcome: "repair" }, {}],
    [
      "changed answer without knowledge",
      "repair-answer",
      { repair_outcome: "changed" },
      {
        "validate-package": { validation_outcome: "package_repair" },
      },
    ],
    [
      "package replan with stale summary",
      "package-completion",
      {
        completion_outcome: "replan",
        outcome_reason: "Invalid criterion.",
        answer_summary: "stale",
      },
      {},
    ],
    [
      "wrong complete terminal status",
      "finalize-result",
      ({ executionId }: { executionId: string }) => ({
        artifact_path: `${workspace(executionId)}/final-report.md`,
        terminal_status: "limited",
      }),
      {},
    ],
    [
      "wrong limited terminal status",
      "finalize-limited",
      ({ executionId }: { executionId: string }) => ({
        artifact_path: `${workspace(executionId)}/final-report.md`,
        terminal_status: "complete",
      }),
      { "research-evidence": { evidence_status: "limited" } },
    ],
    [
      "contract blocked without reason",
      "corrected-contract-review",
      { contract_review_outcome: "blocked" },
      { "frame-research": { framing_outcome: "replan", outcome_reason: "Invalid." } },
    ],
  ])("rejects a contradictory strict response: %s", async (_name, target, invalid, setup) => {
    const result = await run({
      name: String(_name),
      mockInputs: inputs({ ...(setup as Record<string, MockInput>), [String(target)]: invalid }),
      expect: { status: "failed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain(`Input validation failed for node '${String(target)}'`);
  });

  test("covers every ordinary node and branch with truthful terminal classes", async () => {
    const cases: Array<{
      name: string;
      overrides?: Record<string, MockInput>;
      materializeError?: boolean;
      teleportAfter?: TestScenario["teleportAfter"];
      reaches?: string[];
      avoids?: string[];
      contextContains?: Record<string, unknown>;
    }> = [
      { name: "autonomous complete", reaches: ["end"], avoids: ["interactive-acceptance"] },
      {
        name: "interactive clarification and acceptance",
        overrides: {
          intake: {
            intake_outcome: "clarify",
            clarification_request: "Which jurisdiction controls applicability?",
            operating_mode: "interactive",
          },
        },
        reaches: ["clarify-question", "interactive-acceptance", "end"],
      },
      {
        name: "interactive clarification remains blocked",
        overrides: {
          intake: {
            intake_outcome: "clarify",
            clarification_request: "Which jurisdiction?",
            operating_mode: "interactive",
          },
          "clarify-question": {
            clarification_outcome: "blocked",
            blocker_reason: "The required jurisdiction was not supplied.",
          },
        },
        reaches: ["end-intake-blocked"],
      },
      {
        name: "intake blocked",
        overrides: {
          intake: {
            intake_outcome: "blocked",
            blocker_reason: "No research question was supplied.",
            operating_mode: "autonomous",
          },
        },
        reaches: ["end-intake-blocked"],
      },
      { name: "materialize blocked", materializeError: true, reaches: ["end-workspace-blocked"] },
      {
        name: "framing replan then corrected",
        overrides: {
          "frame-research": [
            { framing_outcome: "replan", outcome_reason: "Criterion is ambiguous." },
            { framing_outcome: "ready" },
          ],
        },
        reaches: ["reassess-contract", "corrected-contract-review", "end"],
      },
      {
        name: "framing blocked",
        overrides: {
          "frame-research": {
            framing_outcome: "blocked",
            terminal_reason: "A required prerequisite is unavailable.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "limited evidence yields limited terminal",
        overrides: { "research-evidence": { evidence_status: "limited" } },
        reaches: ["finalize-limited", "end-limited"],
        contextContains: { terminal_status: "limited" },
      },
      {
        name: "evidence replan then ready",
        overrides: {
          "research-evidence": [
            { evidence_status: "replan", outcome_reason: "Method cannot distinguish states." },
            { evidence_status: "ready" },
          ],
        },
        reaches: ["reassess-contract", "corrected-contract-review", "end"],
      },
      {
        name: "evidence blocked",
        overrides: {
          "research-evidence": {
            evidence_status: "blocked",
            terminal_reason: "Required primary evidence is inaccessible.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "synthesis replan then ready",
        overrides: {
          "synthesize-answer": [
            { synthesis_outcome: "replan", outcome_reason: "Answer criterion is invalid." },
            { synthesis_outcome: "ready" },
          ],
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "synthesis blocked",
        overrides: {
          "synthesize-answer": {
            synthesis_outcome: "blocked",
            terminal_reason: "Evidence cannot support an honest answer.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "completion replan",
        overrides: {
          "package-completion": [
            { completion_outcome: "replan", outcome_reason: "Contract invalid." },
            readyCompletion,
          ],
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "completion blocked",
        overrides: {
          "package-completion": {
            completion_outcome: "blocked",
            terminal_reason: "Canonical package cannot be produced.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "deterministic package repair",
        overrides: {
          "package-completion": [readyCompletion, readyCompletion],
          "validate-package": [
            { validation_outcome: "package_repair" },
            { validation_outcome: "pass" },
          ],
        },
        reaches: ["repair-answer", "package-completion", "end"],
      },
      {
        name: "deterministic evidence repair",
        overrides: {
          "research-evidence": [{ evidence_status: "ready" }, { evidence_status: "ready" }],
          "synthesize-answer": [{ synthesis_outcome: "ready" }, { synthesis_outcome: "ready" }],
          "package-completion": [readyCompletion, readyCompletion],
          "validate-package": [
            { validation_outcome: "evidence_repair" },
            { validation_outcome: "pass" },
          ],
        },
        reaches: ["repair-evidence", "research-evidence", "end"],
      },
      {
        name: "validation replan",
        overrides: {
          "validate-package": [{ validation_outcome: "replan" }, { validation_outcome: "pass" }],
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "validation blocked",
        overrides: {
          "validate-package": {
            validation_outcome: "blocked",
            terminal_reason: "Required parser is unavailable.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "semantic answer repair",
        overrides: {
          "package-completion": [readyCompletion, readyCompletion],
          "validate-package": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
          "semantic-review": [
            { review_outcome: "repair", repair_owner: "answer" },
            { review_outcome: "pass" },
          ],
        },
        reaches: ["repair-answer", "end"],
      },
      {
        name: "semantic evidence repair",
        overrides: {
          "research-evidence": [{ evidence_status: "ready" }, { evidence_status: "ready" }],
          "synthesize-answer": [{ synthesis_outcome: "ready" }, { synthesis_outcome: "ready" }],
          "package-completion": [readyCompletion, readyCompletion],
          "validate-package": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
          "semantic-review": [
            { review_outcome: "repair", repair_owner: "evidence" },
            { review_outcome: "pass" },
          ],
        },
        reaches: ["repair-evidence", "research-evidence", "end"],
      },
      {
        name: "semantic replan",
        overrides: {
          "semantic-review": [{ review_outcome: "replan" }, { review_outcome: "pass" }],
        },
        reaches: ["reassess-contract", "corrected-contract-review", "end"],
      },
      {
        name: "semantic blocked",
        overrides: {
          "semantic-review": {
            review_outcome: "blocked",
            terminal_reason: "Independent reviewer unavailable.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "answer repair reassess",
        overrides: {
          "validate-package": [
            { validation_outcome: "package_repair" },
            { validation_outcome: "pass" },
          ],
          "repair-answer": { repair_outcome: "reassess" },
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "answer repair blocked",
        overrides: {
          "validate-package": { validation_outcome: "package_repair" },
          "repair-answer": { repair_outcome: "blocked", terminal_reason: "Repair unavailable." },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "evidence repair reassess",
        overrides: {
          "semantic-review": [
            { review_outcome: "repair", repair_owner: "evidence" },
            { review_outcome: "pass" },
          ],
          "repair-evidence": { repair_outcome: "reassess" },
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "evidence repair blocked",
        overrides: {
          "semantic-review": { review_outcome: "repair", repair_owner: "evidence" },
          "repair-evidence": {
            repair_outcome: "blocked",
            terminal_reason: "Evidence prerequisite unavailable.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "contract review repair then pass",
        overrides: {
          "frame-research": [
            { framing_outcome: "replan", outcome_reason: "Contract invalid." },
            { framing_outcome: "ready" },
          ],
          "corrected-contract-review": [
            { contract_review_outcome: "repair" },
            { contract_review_outcome: "pass" },
          ],
        },
        reaches: ["corrected-contract-review", "reassess-contract", "end"],
      },
      {
        name: "contract review replan then pass",
        overrides: {
          "frame-research": [
            { framing_outcome: "replan", outcome_reason: "Contract invalid." },
            { framing_outcome: "ready" },
          ],
          "corrected-contract-review": [
            { contract_review_outcome: "replan" },
            { contract_review_outcome: "pass" },
          ],
        },
        reaches: ["corrected-contract-review", "reassess-contract", "end"],
      },
      {
        name: "contract review blocked",
        overrides: {
          "frame-research": { framing_outcome: "replan", outcome_reason: "Contract invalid." },
          "corrected-contract-review": {
            contract_review_outcome: "blocked",
            terminal_reason: "Independent contract review unavailable.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "reassessment blocked",
        overrides: {
          "frame-research": { framing_outcome: "replan", outcome_reason: "Contract invalid." },
          "reassess-contract": {
            reassessment_outcome: "blocked",
            terminal_reason: "No valid evidence criterion exists.",
          },
        },
        reaches: ["end-blocked"],
      },
      ...(["framing", "evidence", "answer", "contract"] as const).map((owner) => ({
        name: `interactive rework to ${owner}`,
        overrides: {
          intake: {
            intake_outcome: "actionable",
            research_question: "Which rate-limiting design fits?",
            research_use: "Choose an architecture.",
            research_scope: ["HTTP APIs"],
            operating_mode: "interactive",
          },
          "frame-research": [{ framing_outcome: "ready" }, { framing_outcome: "ready" }],
          "research-evidence": [{ evidence_status: "ready" }, { evidence_status: "ready" }],
          "synthesize-answer": [{ synthesis_outcome: "ready" }, { synthesis_outcome: "ready" }],
          "package-completion": [readyCompletion, readyCompletion],
          "validate-package": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
          "semantic-review": [{ review_outcome: "pass" }, { review_outcome: "pass" }],
          "interactive-acceptance": [
            { user_decision: "rework", rework_owner: owner },
            { user_decision: "accept" },
          ],
        },
        reaches: ["interactive-acceptance", "end"],
      })),
      {
        name: "interactive abort",
        overrides: {
          intake: {
            intake_outcome: "actionable",
            research_question: "Which rate-limiting design fits?",
            research_use: "Choose an architecture.",
            research_scope: ["HTTP APIs"],
            operating_mode: "interactive",
          },
          "interactive-acceptance": { user_decision: "abort" },
        },
        reaches: ["end-aborted"],
      },
      {
        name: "guarded process revision",
        overrides: {
          "frame-research": [{ framing_outcome: "ready" }, { framing_outcome: "ready" }],
        },
        teleportAfter: { afterNode: "frame-research", teleportTo: "revise-process" },
        reaches: ["revise-process", "reassess-contract", "corrected-contract-review", "end"],
      },
    ];

    const results: ScenarioResult[] = [];
    for (const current of cases) {
      results.push(
        await run(
          {
            name: current.name,
            mockInputs: inputs(current.overrides),
            teleportAfter: current.teleportAfter,
            expect: {
              status: "completed",
              reaches: current.reaches,
              avoids: current.avoids,
              contextContains: current.contextContains,
            },
          },
          current.materializeError,
        ),
      );
    }
    expect(results.filter((result) => !result.passed)).toEqual([]);
    const coverage = calculateCoverage(workflow(), results, { includeGapAnalysis: true });
    expect(coverage.nodeCoverage).toBe(100);
    expect(coverage.branchCoverage).toBe(100);
  });
});
