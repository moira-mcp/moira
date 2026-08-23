/** Contract and route scenarios for moira/software-development-flow-lite v2. */
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

const entry = findSystemCatalogEntry("software-development-flow-lite", "public")!;
const workflow = (): WorkflowGraph => structuredClone(entry.graph) as WorkflowGraph;
const workspace = (executionId: string) =>
  `./moira-ws/software-development-flow-lite-${executionId}`;

function node(graph: WorkflowGraph, id: string): any {
  const found = graph.nodes.find((candidate) => candidate.id === id);
  expect(found).toBeDefined();
  return found;
}

function terminal(
  status: "complete" | "handoff" | "blocked" | "aborted",
  suffix: "/final-report.md" | "/handoff.md",
  vcs: "committed" | "not_authorized" | "failed" | "not_applicable",
): MockInput {
  return ({ executionId }) => ({
    delivery_status: status,
    artifact_path: `${workspace(executionId)}${suffix}`,
    summary: `Truthful ${status} Lite result.`,
    vcs_status: vcs,
  });
}

function inputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    intake: {
      operating_mode: "autonomous",
      commit_authorized: false,
      task_summary: "Implement one bounded low-risk change with applicable tests and docs.",
      preliminary_outcome: "eligible",
    },
    "materialize-workspace": {},
    "plan-change": { planning_outcome: "eligible" },
    "review-plan": { design_review_outcome: "pass" },
    "repair-plan": {
      repair_outcome: "changed",
      changed_knowledge: "The reproduced plan defect is corrected.",
    },
    "present-plan": { decision: "approve" },
    "revise-plan": {},
    "reassess-contract": {
      reassessment_outcome: "eligible",
      changed_knowledge: "The invalid criterion now uses discriminating evidence.",
    },
    "implement-change": { implementation_outcome: "ready" },
    "producer-completion": { completion_outcome: "ready" },
    "validate-change": { validation_outcome: "pass" },
    "repair-product": {
      repair_outcome: "changed",
      changed_knowledge: "The product cause is corrected across its bounded class.",
    },
    "repair-verification": {
      repair_outcome: "changed",
      changed_knowledge: "The stale fixture now observes current behavior.",
    },
    "semantic-review": { review_outcome: "pass" },
    "present-result": { decision: "accept" },
    "rework-result": { rework_outcome: "product_changed" },
    "close-result": ({ executionId }) => ({
      closure_outcome: "complete",
      delivery_status: "complete",
      artifact_path: `${workspace(executionId)}/final-report.md`,
      summary: "The accepted bounded result remains local.",
      vcs_status: "not_authorized",
    }),
    "finalize-handoff": terminal("handoff", "/handoff.md", "not_applicable"),
    "finalize-blocked": terminal("blocked", "/final-report.md", "not_applicable"),
    "finalize-workspace-blocked": {
      delivery_status: "blocked",
      summary: "The workspace could not be materialized.",
      vcs_status: "not_applicable",
    },
    "finalize-aborted": terminal("aborted", "/final-report.md", "not_applicable"),
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

describe("software-development-flow-lite", () => {
  test("publishes the risk-based v2 identity and current selection contract", async () => {
    const graph = workflow();
    expect(await new GraphValidator().validateWorkflow(graph)).toMatchObject({
      valid: true,
      errors: [],
    });
    expect(entry.owner).toBe("system-moira");
    expect(entry.visibility).toBe("public");
    expect(graph.id).toBe("50c23256-c9d3-4d7e-94c6-763b295fc168");
    expect(graph.metadata.version).toBe("2.0.0");
    expect(graph.metadata.description).toContain("risk-based Lite eligibility");
    expect(graph.metadata.description).toContain("durable full-SDF handoff");
    expect(graph.metadata.description).toContain("No automatic notification");
    expect(graph.nodes.some((candidate) => candidate.type === "telegram-notification")).toBe(false);
    expect(graph.nodes.some((candidate) => candidate.type === "expression")).toBe(false);
    expect(
      graph.nodes.filter((candidate) => candidate.type === "agent-directive").length,
    ).toBeLessThan(26);
  });

  test("materializes one execution-correlated artifact contract", () => {
    const graph = workflow();
    expect(graph.variableRegistry?.workspace_path).toMatchObject({
      const: "./moira-ws/software-development-flow-lite-{{executionId}}",
      default: "./moira-ws/software-development-flow-lite-{{executionId}}",
    });
    expect(
      node(graph, "materialize-workspace").files.map((file: { path: string }) => file.path),
    ).toEqual([
      "process-id.txt",
      "task-contract.md",
      "plan.md",
      "plan-review.md",
      "implementation-evidence.md",
      "validation-evidence.md",
      "semantic-review.md",
      "repair-account.md",
      "handoff.md",
      "final-report.md",
    ]);
    expect(node(graph, "finalize-handoff").inputSchema.xContextPathSuffixes).toEqual({
      baseContextProperty: "workspace_path",
      properties: { artifact_path: "/handoff.md" },
    });
    expect(node(graph, "close-result").inputSchema.xContextPathSuffixes).toEqual({
      baseContextProperty: "workspace_path",
      properties: { artifact_path: "/final-report.md" },
    });
  });

  test("separates semantic judgment from route evidence and owns replan", () => {
    const graph = workflow();
    expect(node(graph, "validate-change").directive).toContain(
      "Mechanical green proves only measured properties",
    );
    expect(node(graph, "semantic-review").directive).toContain(
      "Structural/test green is not semantic completeness",
    );
    expect(node(graph, "semantic-review").directive).toContain("genuinely independent");
    expect(node(graph, "review-plan").completionCondition).toContain(
      "for blocked, a factual durable inability record exists",
    );
    expect(node(graph, "semantic-review").completionCondition).toContain(
      "for blocked, a factual durable inability record exists",
    );
    expect(node(graph, "review-plan").inputSchema.properties.design_review_outcome.enum).toEqual([
      "pass",
      "repair",
      "replan",
      "blocked",
    ]);
    expect(node(graph, "semantic-review").inputSchema.properties.review_outcome.enum).toEqual([
      "pass",
      "repair",
      "replan",
      "blocked",
    ]);
    expect(node(graph, "repair-product").directive).toContain(
      "repair-account.md when repair-verification returned product_required",
    );
    expect(node(graph, "repair-verification").directive).toContain(
      "overwrite repair-account.md with that newly exposed product cause",
    );
    expect(node(graph, "reassess-contract").directive).toContain(
      "changed wording alone is insufficient",
    );
    expect(node(graph, "teleport-revise-process").connections.success).toBe("reassess-contract");
    expect(node(graph, "repair-verification").inputSchema.properties.repair_outcome.enum).toEqual([
      "changed",
      "product_required",
      "reassess",
      "blocked",
    ]);
  });

  test.each([
    [
      "eligible intake with route-only reason",
      "intake",
      {
        preliminary_outcome: "eligible",
        outcome_reason: "contradictory",
        operating_mode: "autonomous",
        commit_authorized: false,
        task_summary: "task",
      },
    ],
    [
      "handoff intake without reason",
      "intake",
      {
        preliminary_outcome: "handoff",
        operating_mode: "autonomous",
        commit_authorized: false,
        task_summary: "task",
      },
    ],
    [
      "approved plan with revision feedback",
      "present-plan",
      { decision: "approve", feedback: "bad" },
    ],
    [
      "semantic pass with repair owner",
      "semantic-review",
      { review_outcome: "pass", repair_owner: "product" },
    ],
    [
      "accepted result with rework feedback",
      "present-result",
      { decision: "accept", feedback: "bad" },
    ],
    [
      "complete closure with blocked status",
      "close-result",
      ({ executionId }: { executionId: string }) => ({
        closure_outcome: "complete",
        delivery_status: "blocked",
        artifact_path: `${workspace(executionId)}/final-report.md`,
        summary: "bad",
        vcs_status: "not_authorized",
      }),
    ],
  ])("rejects a contradictory strict response: %s", async (name, target, invalid) => {
    const userGate = target === "present-plan" || target === "present-result";
    const result = await run({
      name: String(name),
      mockInputs: inputs({
        ...(userGate
          ? {
              intake: {
                operating_mode: "interactive",
                commit_authorized: false,
                task_summary: "Bounded low-risk change.",
                preliminary_outcome: "eligible",
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

  test("rejects a final artifact path from another execution", async () => {
    const result = await run({
      name: "foreign final path",
      mockInputs: inputs({
        "close-result": {
          closure_outcome: "complete",
          delivery_status: "complete",
          artifact_path: "./moira-ws/software-development-flow-lite-deadbeef/final-report.md",
          summary: "Looks valid but belongs to another execution.",
          vcs_status: "not_authorized",
        },
      }),
      expect: { status: "failed" },
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("must equal the current execution path");
  });

  test("covers every ordinary node and branch with distinct terminal classes", async () => {
    const cases: Array<{
      name: string;
      overrides?: Record<string, MockInput>;
      materializeError?: boolean;
      teleportAfter?: TestScenario["teleportAfter"];
      reaches?: string[];
      avoids?: string[];
    }> = [
      {
        name: "autonomous local complete",
        reaches: ["end"],
        avoids: ["present-plan", "present-result"],
      },
      {
        name: "interactive revise and rework then committed",
        overrides: {
          intake: {
            operating_mode: "interactive",
            commit_authorized: true,
            task_summary: "Bounded interactive change.",
            preliminary_outcome: "eligible",
          },
          "review-plan": [{ design_review_outcome: "pass" }, { design_review_outcome: "pass" }],
          "present-plan": [
            { decision: "revise", feedback: "Clarify docs." },
            { decision: "approve" },
          ],
          "semantic-review": [{ review_outcome: "pass" }, { review_outcome: "pass" }],
          "present-result": [
            { decision: "rework", feedback: "Clarify error behavior." },
            { decision: "accept" },
          ],
          "close-result": ({ executionId }) => ({
            closure_outcome: "complete",
            delivery_status: "complete",
            artifact_path: `${workspace(executionId)}/final-report.md`,
            summary: "Accepted and committed.",
            vcs_status: "committed",
          }),
        },
        reaches: ["revise-plan", "rework-result", "end"],
      },
      {
        name: "intake handoff",
        overrides: {
          intake: {
            operating_mode: "autonomous",
            commit_authorized: false,
            task_summary: "Small auth migration.",
            preliminary_outcome: "handoff",
            outcome_reason: "Full SDF required.",
          },
        },
        reaches: ["end-handoff"],
      },
      {
        name: "intake blocked",
        overrides: {
          intake: {
            operating_mode: "autonomous",
            commit_authorized: false,
            task_summary: "Unknown repository task.",
            preliminary_outcome: "blocked",
            outcome_reason: "Repository unavailable.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "materialize blocked",
        materializeError: true,
        reaches: ["finalize-workspace-blocked", "end-blocked"],
      },
      {
        name: "plan handoff",
        overrides: {
          "plan-change": {
            planning_outcome: "handoff",
            outcome_reason: "Multiple vertical units.",
          },
        },
        reaches: ["end-handoff"],
      },
      {
        name: "plan blocked",
        overrides: {
          "plan-change": { planning_outcome: "blocked", outcome_reason: "Missing prerequisite." },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "plan repair",
        overrides: {
          "review-plan": [{ design_review_outcome: "repair" }, { design_review_outcome: "pass" }],
        },
        reaches: ["repair-plan", "end"],
      },
      {
        name: "plan review blocked",
        overrides: {
          "review-plan": { design_review_outcome: "blocked" },
        },
        reaches: ["route-plan-review-blocked", "end-blocked"],
      },
      {
        name: "plan repair reassess",
        overrides: {
          "review-plan": [{ design_review_outcome: "repair" }, { design_review_outcome: "pass" }],
          "repair-plan": { repair_outcome: "reassess" },
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "plan replan handoff",
        overrides: {
          "review-plan": { design_review_outcome: "replan" },
          "reassess-contract": {
            reassessment_outcome: "handoff",
            outcome_reason: "Lite is ineligible.",
          },
        },
        reaches: ["end-handoff"],
      },
      {
        name: "plan replan blocked",
        overrides: {
          "review-plan": { design_review_outcome: "replan" },
          "reassess-contract": { reassessment_outcome: "blocked", outcome_reason: "No evidence." },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "interactive plan abort",
        overrides: {
          intake: {
            operating_mode: "interactive",
            commit_authorized: false,
            task_summary: "Bounded change.",
            preliminary_outcome: "eligible",
          },
          "present-plan": { decision: "abort" },
        },
        reaches: ["end-aborted"],
      },
      {
        name: "implementation handoff",
        overrides: {
          "implement-change": { implementation_outcome: "handoff", outcome_reason: "Work spread." },
        },
        reaches: ["end-handoff"],
      },
      {
        name: "implementation blocked",
        overrides: {
          "implement-change": {
            implementation_outcome: "blocked",
            outcome_reason: "Dependency unavailable.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "completion handoff",
        overrides: {
          "producer-completion": {
            completion_outcome: "handoff",
            outcome_reason: "Breaking contract found.",
          },
        },
        reaches: ["end-handoff"],
      },
      {
        name: "completion replan",
        overrides: {
          "producer-completion": [
            { completion_outcome: "replan", outcome_reason: "Criterion invalid." },
            { completion_outcome: "ready" },
          ],
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "completion blocked",
        overrides: {
          "producer-completion": {
            completion_outcome: "blocked",
            outcome_reason: "Build unavailable.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "validation product repair",
        overrides: {
          "producer-completion": [{ completion_outcome: "ready" }, { completion_outcome: "ready" }],
          "validate-change": [
            { validation_outcome: "product_repair", cause_summary: "Product defect." },
            { validation_outcome: "pass" },
          ],
        },
        reaches: ["repair-product", "end"],
      },
      {
        name: "validation evidence repair",
        overrides: {
          "validate-change": [
            { validation_outcome: "verification_repair", cause_summary: "Stale fixture." },
            { validation_outcome: "pass" },
          ],
        },
        reaches: ["repair-verification", "end"],
      },
      {
        name: "validation replan",
        overrides: {
          "validate-change": [
            { validation_outcome: "replan", cause_summary: "Evidence invalid." },
            { validation_outcome: "pass" },
          ],
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "validation blocked",
        overrides: {
          "validate-change": {
            validation_outcome: "blocked",
            cause_summary: "Environment unavailable.",
          },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "product repair reassess",
        overrides: {
          "validate-change": [
            { validation_outcome: "product_repair", cause_summary: "Mixed cause." },
            { validation_outcome: "pass" },
          ],
          "repair-product": { repair_outcome: "reassess" },
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "product repair blocked",
        overrides: {
          "validate-change": {
            validation_outcome: "product_repair",
            cause_summary: "Unauthorized mutation.",
          },
          "repair-product": { repair_outcome: "blocked", blocker_reason: "No authority." },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "verification exposes product",
        overrides: {
          "producer-completion": [{ completion_outcome: "ready" }, { completion_outcome: "ready" }],
          "validate-change": [
            { validation_outcome: "verification_repair", cause_summary: "New fixture." },
            { validation_outcome: "pass" },
          ],
          "repair-verification": {
            repair_outcome: "product_required",
            changed_knowledge: "Product defect reproduced.",
          },
        },
        reaches: ["repair-product", "producer-completion", "end"],
      },
      {
        name: "verification reassess",
        overrides: {
          "validate-change": [
            { validation_outcome: "verification_repair", cause_summary: "Invalid method." },
            { validation_outcome: "pass" },
          ],
          "repair-verification": { repair_outcome: "reassess" },
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "verification blocked",
        overrides: {
          "validate-change": {
            validation_outcome: "verification_repair",
            cause_summary: "Fixture unavailable.",
          },
          "repair-verification": { repair_outcome: "blocked", blocker_reason: "No replacement." },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "semantic product repair",
        overrides: {
          "producer-completion": [{ completion_outcome: "ready" }, { completion_outcome: "ready" }],
          "validate-change": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
          "semantic-review": [
            { review_outcome: "repair", repair_owner: "product" },
            { review_outcome: "pass" },
          ],
        },
        reaches: ["repair-product", "end"],
      },
      {
        name: "semantic evidence repair",
        overrides: {
          "validate-change": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
          "semantic-review": [
            { review_outcome: "repair", repair_owner: "verification" },
            { review_outcome: "pass" },
          ],
        },
        reaches: ["repair-verification", "end"],
      },
      {
        name: "semantic replan",
        overrides: {
          "review-plan": [{ design_review_outcome: "pass" }, { design_review_outcome: "pass" }],
          "validate-change": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
          "semantic-review": [{ review_outcome: "replan" }, { review_outcome: "pass" }],
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "semantic review blocked",
        overrides: {
          "semantic-review": { review_outcome: "blocked" },
        },
        reaches: ["route-semantic-blocked", "end-blocked"],
      },
      {
        name: "interactive result abort",
        overrides: {
          intake: {
            operating_mode: "interactive",
            commit_authorized: false,
            task_summary: "Bounded change.",
            preliminary_outcome: "eligible",
          },
          "present-result": { decision: "abort" },
        },
        reaches: ["end-aborted"],
      },
      {
        name: "result rework reassess",
        overrides: {
          intake: {
            operating_mode: "interactive",
            commit_authorized: false,
            task_summary: "Bounded change.",
            preliminary_outcome: "eligible",
          },
          "review-plan": [{ design_review_outcome: "pass" }, { design_review_outcome: "pass" }],
          "validate-change": [{ validation_outcome: "pass" }, { validation_outcome: "pass" }],
          "semantic-review": [{ review_outcome: "pass" }, { review_outcome: "pass" }],
          "present-result": [
            { decision: "rework", feedback: "Evidence contract is wrong." },
            { decision: "accept" },
          ],
          "rework-result": { rework_outcome: "reassess", outcome_reason: "Criterion changes." },
        },
        reaches: ["reassess-contract", "end"],
      },
      {
        name: "result rework handoff",
        overrides: {
          intake: {
            operating_mode: "interactive",
            commit_authorized: false,
            task_summary: "Bounded change.",
            preliminary_outcome: "eligible",
          },
          "present-result": { decision: "rework", feedback: "Add migration." },
          "rework-result": {
            rework_outcome: "handoff",
            outcome_reason: "Lite becomes ineligible.",
          },
        },
        reaches: ["end-handoff"],
      },
      {
        name: "result rework blocked",
        overrides: {
          intake: {
            operating_mode: "interactive",
            commit_authorized: false,
            task_summary: "Bounded change.",
            preliminary_outcome: "eligible",
          },
          "present-result": { decision: "rework", feedback: "Use unavailable access." },
          "rework-result": { rework_outcome: "blocked", outcome_reason: "Access unavailable." },
        },
        reaches: ["end-blocked"],
      },
      {
        name: "authorized commit failure",
        overrides: {
          intake: {
            operating_mode: "autonomous",
            commit_authorized: true,
            task_summary: "Committed bounded change.",
            preliminary_outcome: "eligible",
          },
          "close-result": ({ executionId }) => ({
            closure_outcome: "blocked",
            delivery_status: "blocked",
            artifact_path: `${workspace(executionId)}/final-report.md`,
            summary: "Accepted product remains local.",
            vcs_status: "failed",
          }),
        },
        reaches: ["end-blocked"],
      },
      {
        name: "guarded process revision",
        overrides: {
          "review-plan": [{ design_review_outcome: "pass" }, { design_review_outcome: "pass" }],
        },
        teleportAfter: { afterNode: "review-plan", teleportTo: "teleport-revise-process" },
        reaches: ["teleport-revise-process", "reassess-contract", "end"],
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
