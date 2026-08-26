/** Contract and route scenarios for moira/startup-idea-validation v2. */
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

const entry = findSystemCatalogEntry("startup-idea-validation", "public")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;
const workspace = (executionId: string) => `./moira-ws/startup-idea-validation-${executionId}`;

function node(graph: WorkflowGraph, id: string): any {
  const found = graph.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function terminal(
  status: "complete" | "blocked" | "aborted",
  publication = "declined",
  notification = "declined",
): MockInput {
  return ({ executionId }) => ({
    delivery_status: status,
    artifact_path: `${workspace(executionId)}/final-report.md`,
    summary: `Truthful ${status} startup validation result.`,
    ...(status === "complete"
      ? {
          publication_status: publication,
          notification_status: notification,
        }
      : {}),
  });
}

const readyCompletion = {
  completion_outcome: "ready",
  recommendation_summary: "Run the named evidence-reducing experiment.",
  limitations_summary: "Material uncertainty remains explicit.",
};

function inputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    intake: {
      intake_outcome: "actionable",
      operating_mode: "autonomous",
      publication_authority: "declined",
      notification_authority: "declined",
    },
    "materialize-workspace": {},
    "clarify-idea": { decision: "update", feedback: "Target regulated EU clinics." },
    "revise-intake": {},
    "frame-idea": { framing_outcome: "ready" },
    "research-evidence": { research_outcome: "ready" },
    "analyze-feasibility": {},
    "synthesize-package": {},
    "package-completion": readyCompletion,
    "validate-package": { validation_outcome: "pass" },
    "repair-package": {
      repair_outcome: "changed",
      changed_knowledge: "The offline report now embeds every required asset.",
    },
    "semantic-review": { review_outcome: "pass" },
    "repair-evidence": {
      repair_outcome: "changed",
      changed_knowledge: "Current demand evidence now has resolvable sources.",
    },
    "reassess-contract": {
      reassessment_outcome: "eligible",
      changed_knowledge: "The evidence criterion now has a discriminating observation.",
    },
    "review-corrected-contract": { contract_review_outcome: "pass" },
    "present-result": { decision: "accept" },
    "rework-result": { rework_owner: "presentation" },
    "ask-publication": { decision: "local" },
    "publish-artifact": {
      publication_status: "succeeded",
      public_url: "https://example.static.moira-mcp.com/",
    },
    "ask-notification": { decision: "skip" },
    "send-notification": { notification_status: "sent" },
    "finalize-result": terminal("complete"),
    "finalize-blocked": terminal("blocked"),
    "finalize-workspace-blocked": {
      delivery_status: "blocked",
      summary: "Workspace materialization failed.",
    },
    "finalize-aborted": terminal("aborted"),
    "teleport-revise-process": {},
    ...overrides,
  };
}

function configureMaterialize(engine: GraphExecutionEngine, error = false): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, any> }).nodeHandlers;
  if (!error) {
    handlers.set(
      "materialize",
      new MaterializeHandler(
        { createMaterializeToken: () => "scenario-token" },
        () => "https://moira.example",
      ),
    );
  } else {
    handlers.set("materialize", {
      getNodeType: () => "materialize",
      execute: async (current: { id: string }) => ({
        nodeId: current.id,
        action: "continue",
        outputPath: "error",
        data: { error: "workspace unavailable" },
      }),
    });
  }
}

async function run(scenario: TestScenario, materializeError = false): Promise<ScenarioResult> {
  return runScenario(workflow(), scenario, {
    engineSetup: (engine) => configureMaterialize(engine, materializeError),
  });
}

describe("startup-idea-validation", () => {
  test("publishes the evidence-led v2 identity and artifact contract", async () => {
    const graph = workflow();
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(graph.id).toBe("d2164606-fbda-4b33-b6dc-572571a2dd14");
    expect(graph.metadata.version).toBe("2.0.0");
    expect(graph.metadata.description).toContain("self-contained offline HTML");
    expect(graph.metadata.description).toContain("separately authorized optional effects");
    expect(graph.nodes.some((candidate) => candidate.type === "telegram-notification")).toBe(false);
    expect(
      graph.nodes.filter((candidate) => candidate.type === "agent-directive").length,
    ).toBeLessThan(27);
  });

  test("keeps detailed bodies in one execution-correlated workspace", () => {
    const graph = workflow();
    expect(graph.variableRegistry?.workspace_path).toMatchObject({
      const: "./moira-ws/startup-idea-validation-{{executionId}}",
      default: "./moira-ws/startup-idea-validation-{{executionId}}",
    });
    expect(
      node(graph, "materialize-workspace").files.map((file: { path: string }) => file.path),
    ).toEqual([
      "process-id.txt",
      "idea-framing.md",
      "source-register.md",
      "evidence-research.md",
      "feasibility-options.md",
      "decision.md",
      "report.html",
      "package-validation.md",
      "contract-review.md",
      "semantic-review.md",
      "repair-account.md",
      "final-report.md",
    ]);
    expect(node(graph, "finalize-result").inputSchema.xContextPathSuffixes).toEqual({
      baseContextProperty: "workspace_path",
      properties: { artifact_path: "/final-report.md" },
    });
    expect(node(graph, "intake").directive).toContain("{{startup_idea}}");
  });

  test("separates mechanical evidence, semantic judgment, repair, and authority", () => {
    const graph = workflow();
    expect(node(graph, "validate-package").directive).toContain(
      "Mechanical green proves only measured properties",
    );
    expect(node(graph, "semantic-review").directive).toContain("genuinely independent");
    expect(node(graph, "review-corrected-contract").directive).toContain(
      "genuinely independent review",
    );
    expect(node(graph, "repair-evidence").connections.success).toBe(
      "route-evidence-repair-changed",
    );
    expect(node(graph, "route-evidence-repair-changed").connections.true).toBe("research-evidence");
    expect(node(graph, "publish-artifact").directive).toContain("resolved publication authority");
    expect(node(graph, "send-notification").directive).toContain(
      "authorized completion notification",
    );
  });

  test.each([
    [
      "clarify without reason",
      "intake",
      {
        intake_outcome: "clarify",
        operating_mode: "interactive",
        publication_authority: "declined",
        notification_authority: "declined",
      },
    ],
    ["clarification update without feedback", "clarify-idea", { decision: "update" }],
    ["semantic repair without owner", "semantic-review", { review_outcome: "repair" }],
    [
      "package replan with stale summary",
      "package-completion",
      {
        completion_outcome: "replan",
        outcome_reason: "Contract invalid.",
        recommendation_summary: "stale",
      },
    ],
    [
      "package reassess with changed knowledge",
      "repair-package",
      { repair_outcome: "reassess", changed_knowledge: "contradictory" },
    ],
    [
      "evidence blocked with changed knowledge",
      "repair-evidence",
      {
        repair_outcome: "blocked",
        blocker_reason: "Source unavailable.",
        changed_knowledge: "contradictory",
      },
    ],
    [
      "eligible reassessment with failure reason",
      "reassess-contract",
      {
        reassessment_outcome: "eligible",
        changed_knowledge: "Criterion corrected.",
        outcome_reason: "contradictory",
      },
    ],
    ["publication success without URL", "publish-artifact", { publication_status: "succeeded" }],
    [
      "publication failure with URL",
      "publish-artifact",
      {
        publication_status: "failed",
        public_url: "https://wrong.example/",
        failure_reason: "Upload failed.",
      },
    ],
  ])("rejects a contradictory strict response: %s", async (_name, target, invalid) => {
    const interactive = target === "clarify-idea";
    const published = target === "publish-artifact";
    const packageRepair = target === "repair-package";
    const evidenceRepair = target === "repair-evidence";
    const reassessment = target === "reassess-contract";
    const result = await run({
      name: String(_name),
      mockInputs: inputs({
        ...(interactive
          ? {
              intake: {
                intake_outcome: "clarify",
                outcome_reason: "Geography changes the analysis.",
                operating_mode: "interactive",
                publication_authority: "declined",
                notification_authority: "declined",
              },
            }
          : {}),
        ...(published
          ? {
              intake: {
                intake_outcome: "actionable",
                operating_mode: "autonomous",
                publication_authority: "authorized",
                notification_authority: "declined",
              },
            }
          : {}),
        ...(packageRepair
          ? {
              "validate-package": {
                validation_outcome: "package_repair",
                cause_summary: "Package defect.",
              },
            }
          : {}),
        ...(evidenceRepair
          ? {
              "semantic-review": { review_outcome: "repair", repair_owner: "evidence" },
            }
          : {}),
        ...(reassessment
          ? {
              "frame-idea": {
                framing_outcome: "replan",
                outcome_reason: "Contract invalid.",
              },
            }
          : {}),
        [String(target)]: invalid as MockInput,
      }),
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
      { name: "autonomous local complete", reaches: ["end"], avoids: ["present-result"] },
      {
        name: "interactive clarification and local choices",
        overrides: {
          intake: {
            intake_outcome: "clarify",
            outcome_reason: "Regulatory geography is material.",
            operating_mode: "interactive",
            publication_authority: "undecided",
            notification_authority: "undecided",
          },
        },
        reaches: [
          "clarify-idea",
          "revise-intake",
          "present-result",
          "ask-publication",
          "ask-notification",
          "end",
        ],
      },
      {
        name: "interactive clarification abort",
        overrides: {
          intake: {
            intake_outcome: "clarify",
            outcome_reason: "Target user is missing.",
            operating_mode: "interactive",
            publication_authority: "declined",
            notification_authority: "declined",
          },
          "clarify-idea": { decision: "abort" },
        },
        reaches: ["end-aborted"],
      },
      {
        name: "autonomous clarification blocks",
        overrides: {
          intake: {
            intake_outcome: "clarify",
            outcome_reason: "Target jurisdiction is required.",
            operating_mode: "autonomous",
            publication_authority: "declined",
            notification_authority: "declined",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "intake blocked",
        overrides: {
          intake: {
            intake_outcome: "blocked",
            outcome_reason: "No startup idea was supplied.",
            operating_mode: "autonomous",
            publication_authority: "declined",
            notification_authority: "declined",
          },
        },
        reaches: ["end-blocked"],
      },
      { name: "materialize blocked", materializeError: true, reaches: ["end-workspace-blocked"] },
      {
        name: "framing replan and corrected contract",
        overrides: {
          "frame-idea": [
            { framing_outcome: "replan", outcome_reason: "Criterion is ambiguous." },
            { framing_outcome: "ready" },
          ],
        },
        reaches: ["reassess-contract", "review-corrected-contract", "end"],
      },
      {
        name: "framing blocked",
        overrides: {
          "frame-idea": { framing_outcome: "blocked", outcome_reason: "Prerequisite unavailable." },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "limited evidence still yields bounded package",
        overrides: {
          "research-evidence": {
            research_outcome: "limited",
            outcome_reason: "No current pricing evidence.",
          },
        },
        reaches: ["analyze-feasibility", "end"],
      },
      {
        name: "research replan",
        overrides: {
          "research-evidence": [
            { research_outcome: "replan", outcome_reason: "Source criterion invalid." },
            { research_outcome: "ready" },
          ],
        },
        reaches: ["reassess-contract", "review-corrected-contract", "end"],
      },
      {
        name: "research blocked",
        overrides: {
          "research-evidence": {
            research_outcome: "blocked",
            outcome_reason: "Required corpus unavailable.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "completion replan",
        overrides: {
          "package-completion": [
            { completion_outcome: "replan", outcome_reason: "Decision contract is invalid." },
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
            outcome_reason: "HTML cannot be created.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "deterministic package repair",
        overrides: {
          "package-completion": [readyCompletion, readyCompletion],
          "validate-package": [
            { validation_outcome: "package_repair", cause_summary: "External CSS remains." },
            { validation_outcome: "pass" },
          ],
        },
        reaches: ["repair-package", "package-completion", "end"],
      },
      {
        name: "validation replan",
        overrides: {
          "validate-package": [
            { validation_outcome: "replan", cause_summary: "Criterion cannot distinguish states." },
            { validation_outcome: "pass" },
          ],
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "validation blocked",
        overrides: {
          "validate-package": {
            validation_outcome: "blocked",
            cause_summary: "Parser unavailable.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "package repair reassess",
        overrides: {
          "validate-package": [
            { validation_outcome: "package_repair", cause_summary: "Mixed cause." },
            { validation_outcome: "pass" },
          ],
          "repair-package": { repair_outcome: "reassess" },
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "package repair blocked",
        overrides: {
          "validate-package": {
            validation_outcome: "package_repair",
            cause_summary: "Irreducible defect.",
          },
          "repair-package": { repair_outcome: "blocked", blocker_reason: "No authorized repair." },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "semantic package repair",
        overrides: {
          "package-completion": [readyCompletion, readyCompletion],
          "validate-package": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
          "semantic-review": [
            { review_outcome: "repair", repair_owner: "package" },
            { review_outcome: "pass" },
          ],
        },
        reaches: ["repair-package", "end"],
      },
      {
        name: "semantic evidence repair",
        overrides: {
          "research-evidence": [{ research_outcome: "ready" }, { research_outcome: "ready" }],
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
        reaches: ["reassess-contract", "review-corrected-contract", "end"],
      },
      {
        name: "semantic blocked",
        overrides: { "semantic-review": { review_outcome: "blocked" } },
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
          "repair-evidence": { repair_outcome: "blocked", blocker_reason: "Source unavailable." },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "contract review blocked",
        overrides: {
          "frame-idea": { framing_outcome: "replan", outcome_reason: "Contract invalid." },
          "review-corrected-contract": { contract_review_outcome: "blocked" },
        },
        reaches: ["review-corrected-contract", "end-blocked"],
      },
      {
        name: "contract review repair then pass",
        overrides: {
          "frame-idea": [
            { framing_outcome: "replan", outcome_reason: "Contract invalid." },
            { framing_outcome: "ready" },
          ],
          "review-corrected-contract": [
            { contract_review_outcome: "repair" },
            { contract_review_outcome: "pass" },
          ],
        },
        reaches: ["review-corrected-contract", "reassess-contract", "end"],
      },
      {
        name: "contract review replan then pass",
        overrides: {
          "frame-idea": [
            { framing_outcome: "replan", outcome_reason: "Contract invalid." },
            { framing_outcome: "ready" },
          ],
          "review-corrected-contract": [
            { contract_review_outcome: "replan" },
            { contract_review_outcome: "pass" },
          ],
        },
        reaches: ["review-corrected-contract", "reassess-contract", "end"],
      },
      {
        name: "reassessment blocked",
        overrides: {
          "frame-idea": { framing_outcome: "replan", outcome_reason: "Contract invalid." },
          "reassess-contract": {
            reassessment_outcome: "blocked",
            outcome_reason: "No valid criterion.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "reassessment aborted",
        overrides: {
          "frame-idea": { framing_outcome: "replan", outcome_reason: "User stopped." },
          "reassess-contract": {
            reassessment_outcome: "aborted",
            outcome_reason: "Explicit stop.",
          },
        },
        reaches: ["end-aborted"],
      },
      ...(["framing", "evidence", "analysis", "presentation", "reassess", "blocked"] as const).map(
        (owner) => ({
          name: `interactive rework to ${owner}`,
          overrides: {
            intake: {
              intake_outcome: "actionable",
              operating_mode: "interactive",
              publication_authority: "declined",
              notification_authority: "declined",
            },
            "present-result": [
              { decision: "rework", feedback: "Correct the accepted package." },
              { decision: "accept" },
            ],
            "rework-result": {
              rework_owner: owner,
              ...(owner === "reassess" || owner === "blocked"
                ? { outcome_reason: "Feedback changes the contract or cannot be applied." }
                : {}),
            },
          },
          reaches: [owner === "blocked" ? "end-blocked" : "rework-result"],
        }),
      ),
      {
        name: "interactive result abort",
        overrides: {
          intake: {
            intake_outcome: "actionable",
            operating_mode: "interactive",
            publication_authority: "declined",
            notification_authority: "declined",
          },
          "present-result": { decision: "abort" },
        },
        reaches: ["end-aborted"],
      },
      {
        name: "authorized publication and notification",
        overrides: {
          intake: {
            intake_outcome: "actionable",
            operating_mode: "autonomous",
            publication_authority: "authorized",
            notification_authority: "authorized",
          },
          "finalize-result": terminal("complete", "succeeded", "sent"),
        },
        reaches: ["publish-artifact", "send-notification", "end"],
        contextContains: { publication_status: "succeeded", notification_status: "sent" },
      },
      {
        name: "publication failure preserves local completion",
        overrides: {
          intake: {
            intake_outcome: "actionable",
            operating_mode: "autonomous",
            publication_authority: "authorized",
            notification_authority: "declined",
          },
          "publish-artifact": {
            publication_status: "failed",
            failure_reason: "Artifact service unavailable.",
          },
          "finalize-result": terminal("complete", "failed", "declined"),
        },
        reaches: ["publish-artifact", "end"],
        contextContains: { publication_status: "failed", notification_status: "declined" },
      },
      {
        name: "interactive publication and notification approval",
        overrides: {
          intake: {
            intake_outcome: "actionable",
            operating_mode: "interactive",
            publication_authority: "undecided",
            notification_authority: "undecided",
          },
          "ask-publication": { decision: "publish" },
          "ask-notification": { decision: "send" },
          "finalize-result": terminal("complete", "succeeded", "sent"),
        },
        reaches: [
          "ask-publication",
          "publish-artifact",
          "ask-notification",
          "send-notification",
          "end",
        ],
        contextContains: { publication_status: "succeeded", notification_status: "sent" },
      },
      {
        name: "notification failure preserves local completion",
        overrides: {
          intake: {
            intake_outcome: "actionable",
            operating_mode: "autonomous",
            publication_authority: "declined",
            notification_authority: "authorized",
          },
          "send-notification": { notification_status: "failed" },
          "finalize-result": terminal("complete", "declined", "failed"),
        },
        reaches: ["send-notification", "end"],
        contextContains: { publication_status: "declined", notification_status: "failed" },
      },
      {
        name: "autonomous undecided effects are not requested",
        overrides: {
          intake: {
            intake_outcome: "actionable",
            operating_mode: "autonomous",
            publication_authority: "undecided",
            notification_authority: "undecided",
          },
          "finalize-result": terminal("complete", "not_requested", "not_requested"),
        },
        reaches: ["end"],
        avoids: ["ask-publication", "publish-artifact", "ask-notification", "send-notification"],
        contextContains: {
          publication_status: "not_requested",
          notification_status: "not_requested",
        },
      },
      {
        name: "guarded process revision",
        overrides: {
          "frame-idea": [{ framing_outcome: "ready" }, { framing_outcome: "ready" }],
        },
        teleportAfter: { afterNode: "frame-idea", teleportTo: "teleport-revise-process" },
        reaches: [
          "teleport-revise-process",
          "reassess-contract",
          "review-corrected-contract",
          "end",
        ],
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
