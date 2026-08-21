/** Observable scenarios for the cause-aware Robust Task v9. */

import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { GraphValidator, detectCycles, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { calculateCoverage } from "../../helpers/coverage-calculator.js";
import { runScenario, type MockInput, type TestScenario } from "../../helpers/scenario-runner.js";

function loadWorkflow(): WorkflowGraph {
  return structuredClone(findSystemCatalogEntry("robust-task", "public")!.graph) as WorkflowGraph;
}

function node(workflow: WorkflowGraph, id: string): any {
  const result = workflow.nodes.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing workflow node: ${id}`);
  return result;
}

const plan = (revision: number) => ({
  current_plan_file: `plans/${String(revision).padStart(3, "0")}/plan.md`,
  total_steps: 1,
});

const stepEvidence = (planRevision: number, attempt: number) => ({
  evidence_file: `steps/1/plans/${String(planRevision).padStart(3, "0")}/attempts/${attempt}/evidence.md`,
});

const stepVerdict = (
  planRevision: number,
  attempt: number,
  review_outcome: "pass" | "repair" | "replan",
  repair_owner?: "result" | "evidence_projection",
) => ({
  verdict_file: `steps/1/plans/${String(planRevision).padStart(3, "0")}/attempts/${attempt}/verdict.md`,
  review_outcome,
  ...(repair_owner ? { repair_owner } : {}),
});

const finalReview = (
  revision: number,
  review_outcome: "pass" | "repair" | "replan",
  repair_owner?: "deliverable" | "evidence_projection",
) => ({
  review_file: `final/reviews/${String(revision).padStart(3, "0")}-review.md`,
  review_outcome,
  ...(repair_owner ? { repair_owner } : {}),
});

function ordinaryInputs(): Record<string, MockInput> {
  return {
    "initialize-workspace": {
      workspace_path: "./moira-ws/robust-task-example-20260821-2300/",
      operating_mode: "interactive",
    },
    "create-plan": plan(1),
    "review-plan": { review_outcome: "pass" },
    "ask-plan-review-limit": { decision: "finish_incomplete" },
    "fix-plan": { repair_outcome: "changed", ...plan(2) },
    "approve-plan": { decision: "yes" },
    "revise-plan": plan(2),
    "execute-step": stepEvidence(1, 1),
    "review-step": stepVerdict(1, 1, "pass"),
    "repair-step": { repair_outcome: "changed", ...stepEvidence(1, 2) },
    "ask-retry-decision": {
      decision: "finish_incomplete",
      decision_file: "steps/1/decisions/001.md",
    },
    "replan-from-verdict": plan(2),
    "replan-from-decision": plan(2),
    "replan-from-plan-review": plan(2),
    "replan-from-plan-reassess": plan(2),
    "replan-from-step-reassess": plan(2),
    "replan-from-final-review": plan(2),
    "replan-from-final-reassess": plan(2),
    "teleport-replan": plan(2),
    "final-review": finalReview(1, "pass"),
    "ask-final-review-limit": { decision: "accept_incomplete" },
    "fix-final-review": { repair_outcome: "changed" },
    "deliver-result": {
      delivery_file: "final/delivery.md",
      delivery_status: "complete",
      summary: "All active requirements are satisfied.",
    },
  };
}

function scenario(
  name: string,
  overrides: Record<string, MockInput>,
  reaches: string[],
  options: Pick<TestScenario, "initialVariables" | "teleportAfter"> = {},
): TestScenario {
  return {
    name,
    mockInputs: { ...ordinaryInputs(), ...overrides },
    expect: { status: "completed", reaches, maxSteps: 220 },
    ...options,
  };
}

const scenarios: TestScenario[] = [
  scenario(
    "autonomous run completes without the plan approval gate",
    {
      "initialize-workspace": {
        workspace_path: "./moira-ws/robust-task-example-20260821-2300/",
        operating_mode: "autonomous",
      },
    },
    ["route-operating-mode-plan-approval", "execute-step", "final-review", "end"],
  ),
  scenario("ordinary interactive execution completes", {}, [
    "notify-plan-ready",
    "approve-plan",
    "execute-step",
    "final-review",
    "end",
  ]),
  scenario(
    "plan repair creates a new immutable revision",
    {
      "review-plan": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "fix-plan": { repair_outcome: "changed", ...plan(2) },
    },
    ["fix-plan", "increment-plan-review-round", "review-plan", "end"],
  ),
  scenario(
    "plan repair reassessment replans from its exact cause",
    {
      "review-plan": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "fix-plan": { repair_outcome: "reassess", reassessment_file: "plans/001/repair.md" },
    },
    ["route-plan-repair-outcome", "replan-from-plan-reassess", "review-plan", "end"],
  ),
  scenario(
    "plan reviewer can request direct replan",
    { "review-plan": [{ review_outcome: "replan" }, { review_outcome: "pass" }] },
    ["route-plan-review-replan", "replan-from-plan-review", "review-plan", "end"],
  ),
  scenario(
    "plan review bound can authorize one changed repair",
    {
      "review-plan": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "ask-plan-review-limit": { decision: "repair" },
    },
    ["ask-plan-review-limit", "reset-plan-review-for-repair", "fix-plan", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "plan review bound can finish truthfully incomplete",
    {
      "review-plan": { review_outcome: "repair" },
      "ask-plan-review-limit": { decision: "finish_incomplete" },
      "deliver-result": {
        delivery_file: "final/delivery.md",
        delivery_status: "incomplete",
        summary: "The unresolved plan finding is disclosed.",
      },
    },
    ["ask-plan-review-limit", "deliver-result", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "interactive plan rejection creates and reviews a new revision",
    { "approve-plan": [{ decision: "no" }, { decision: "yes" }], "revise-plan": plan(2) },
    ["revise-plan", "review-plan", "approve-plan", "end"],
  ),
  scenario(
    "result repair consumes a retry only after a changed attempt",
    {
      "review-step": [stepVerdict(1, 1, "repair", "result"), stepVerdict(1, 2, "pass")],
      "repair-step": { repair_outcome: "changed", ...stepEvidence(1, 2) },
    },
    ["repair-step", "route-step-repair-budget", "increment-step-retry", "review-step", "end"],
  ),
  scenario(
    "evidence repair returns to review without consuming result retry",
    {
      "review-step": [
        stepVerdict(1, 1, "repair", "evidence_projection"),
        stepVerdict(1, 2, "pass"),
      ],
      "repair-step": { repair_outcome: "changed", ...stepEvidence(1, 2) },
    },
    ["route-step-repair-owner", "repair-step", "review-step", "end"],
  ),
  scenario(
    "step repair reassessment replans from its exact cause",
    {
      "execute-step": [stepEvidence(1, 1), stepEvidence(2, 1)],
      "review-step": [stepVerdict(1, 1, "repair", "result"), stepVerdict(2, 1, "pass")],
      "repair-step": {
        repair_outcome: "reassess",
        reassessment_file: "steps/1/plans/001/attempts/1/repair.md",
      },
    },
    ["route-step-repair-outcome", "replan-from-step-reassess", "review-plan", "end"],
  ),
  scenario(
    "step reviewer can request direct replan",
    {
      "execute-step": [stepEvidence(1, 1), stepEvidence(2, 1)],
      "review-step": [stepVerdict(1, 1, "replan"), stepVerdict(2, 1, "pass")],
    },
    ["route-verifier-replan", "replan-from-verdict", "review-plan", "end"],
  ),
  scenario(
    "retry exhaustion can authorize another changed repair",
    {
      "review-step": [
        stepVerdict(1, 1, "repair", "result"),
        stepVerdict(1, 2, "repair", "result"),
        stepVerdict(1, 3, "pass"),
      ],
      "repair-step": [
        { repair_outcome: "changed", ...stepEvidence(1, 2) },
        { repair_outcome: "changed", ...stepEvidence(1, 3) },
      ],
      "ask-retry-decision": { decision: "retry", decision_file: "steps/1/decisions/001.md" },
    },
    ["notify-escalation", "ask-retry-decision", "reset-step-retry", "repair-step", "end"],
    { initialVariables: { max_retries: 1 } },
  ),
  scenario(
    "retry exhaustion can replan the unfinished tail",
    {
      "execute-step": [stepEvidence(1, 1), stepEvidence(2, 1)],
      "review-step": [
        stepVerdict(1, 1, "repair", "result"),
        stepVerdict(1, 2, "repair", "result"),
        stepVerdict(2, 1, "pass"),
      ],
      "repair-step": { repair_outcome: "changed", ...stepEvidence(1, 2) },
      "ask-retry-decision": { decision: "replan", decision_file: "steps/1/decisions/001.md" },
    },
    ["route-replan-choice", "replan-from-decision", "review-plan", "end"],
    { initialVariables: { max_retries: 1 } },
  ),
  scenario(
    "retry exhaustion can finish truthfully incomplete",
    {
      "review-step": [stepVerdict(1, 1, "repair", "result"), stepVerdict(1, 2, "repair", "result")],
      "repair-step": { repair_outcome: "changed", ...stepEvidence(1, 2) },
      "ask-retry-decision": {
        decision: "finish_incomplete",
        decision_file: "steps/1/decisions/001.md",
      },
      "deliver-result": {
        delivery_file: "final/delivery.md",
        delivery_status: "incomplete",
        summary: "The open step remains incomplete by explicit decision.",
      },
    },
    ["ask-retry-decision", "deliver-result", "end"],
    { initialVariables: { max_retries: 1 } },
  ),
  scenario(
    "final review repair returns to the same reviewer",
    {
      "final-review": [finalReview(1, "repair", "deliverable"), finalReview(2, "pass")],
      "fix-final-review": { repair_outcome: "changed" },
    },
    ["fix-final-review", "increment-final-review-round", "final-review", "end"],
  ),
  scenario(
    "final repair reassessment replans from its exact cause",
    {
      "final-review": [finalReview(1, "repair", "deliverable"), finalReview(2, "pass")],
      "fix-final-review": {
        repair_outcome: "reassess",
        reassessment_file: "final/reviews/001-reassess.md",
      },
    },
    ["route-final-repair-outcome", "replan-from-final-reassess", "review-plan", "end"],
  ),
  scenario(
    "final reviewer can request direct replan",
    { "final-review": [finalReview(1, "replan"), finalReview(2, "pass")] },
    ["route-final-review-replan", "replan-from-final-review", "review-plan", "end"],
  ),
  scenario(
    "final review bound can authorize one changed repair",
    {
      "final-review": [finalReview(1, "repair", "deliverable"), finalReview(2, "pass")],
      "ask-final-review-limit": { decision: "repair" },
    },
    ["ask-final-review-limit", "reset-final-for-repair", "fix-final-review", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "final review bound can accept an explicitly incomplete result",
    {
      "final-review": finalReview(1, "repair", "deliverable"),
      "ask-final-review-limit": { decision: "accept_incomplete" },
      "deliver-result": {
        delivery_file: "final/delivery.md",
        delivery_status: "incomplete",
        summary: "The accepted final finding is disclosed.",
      },
    },
    ["ask-final-review-limit", "deliver-result", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "teleport replan preserves completed work and returns through review",
    {
      "execute-step": [stepEvidence(1, 1), stepEvidence(2, 1)],
      "review-step": stepVerdict(2, 1, "pass"),
    },
    ["teleport-replan", "review-plan", "approve-plan", "end"],
    { teleportAfter: { afterNode: "execute-step", teleportTo: "teleport-replan" } },
  ),
];

describe("Robust Task cause-aware contract", () => {
  const workflow = loadWorkflow();

  test("keeps durable recovery state and cause-owned routing", async () => {
    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.valid).toBe(true);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(detectCycles(workflow).length).toBeGreaterThan(0);

    const serialized = JSON.stringify(workflow);
    for (const removed of [
      "criteria_review_round",
      "verify-criteria",
      "jsonFingerprint",
      "operation_state",
      "fingerprint",
      "proof_token",
      "source_epoch",
    ]) {
      expect(serialized).not.toContain(removed);
    }

    expect(workflow.metadata.version).toBe("9.0.0");
    expect(node(workflow, "initialize-workspace").directive).toContain("process-id.txt");
    expect(workflow.variableRegistry?.operating_mode?.enum).toEqual(["autonomous", "interactive"]);
    expect(node(workflow, "route-operating-mode-plan-approval").connections).toEqual({
      true: "check-all-steps-done",
      false: "approve-plan",
    });
    expect(node(workflow, "notify-plan-ready").connections).toEqual({
      default: "route-operating-mode-plan-approval",
      error: "route-operating-mode-plan-approval",
    });
    expect(node(workflow, "review-plan").inputSchema.properties.review_outcome.enum).toEqual([
      "pass",
      "repair",
      "replan",
    ]);
    expect(node(workflow, "review-step").inputSchema.properties.repair_owner.enum).toEqual([
      "result",
      "evidence_projection",
    ]);
    expect(node(workflow, "repair-step").inputSchema.properties.repair_outcome.enum).toEqual([
      "changed",
      "reassess",
    ]);
    expect(node(workflow, "final-review").inputSchema.properties.repair_owner.enum).toEqual([
      "deliverable",
      "evidence_projection",
    ]);
    expect(node(workflow, "ask-retry-decision").inputSchema.properties.decision.enum).toEqual([
      "retry",
      "replan",
      "finish_incomplete",
    ]);
    expect(node(workflow, "end").finalOutput).toEqual([
      "workspace_path",
      "delivery_file",
      "delivery_status",
      "summary",
    ]);
  });

  test("keeps direct and reassessment replan sources structurally separate", () => {
    const pairs = [
      ["route-plan-review-replan", "replan-from-plan-review", "review"],
      ["route-plan-repair-outcome", "replan-from-plan-reassess", "reassessment"],
      ["route-verifier-replan", "replan-from-verdict", "verdict"],
      ["route-step-repair-outcome", "replan-from-step-reassess", "reassessment"],
      ["route-final-review-replan", "replan-from-final-review", "review"],
      ["route-final-repair-outcome", "replan-from-final-reassess", "reassessment"],
    ] as const;

    for (const [routeId, consumerId, requiredSource] of pairs) {
      expect(node(workflow, routeId).connections.true).toBe(consumerId);
      const contract = `${node(workflow, consumerId).directive} ${node(workflow, consumerId).completionCondition}`;
      expect(contract.toLowerCase()).toContain(requiredSource);
    }
    for (const directConsumer of [
      "replan-from-plan-review",
      "replan-from-verdict",
      "replan-from-final-review",
    ]) {
      expect(node(workflow, directConsumer).completionCondition.toLowerCase()).not.toContain(
        "reassessment",
      );
    }
    expect(node(workflow, "replan-from-verdict").completionCondition).toContain(
      "current verifier verdict cause",
    );
    expect(node(workflow, "replan-from-verdict").completionCondition).not.toContain(
      "repair-producer",
    );
  });

  test("representative routes cover every node and branch", async () => {
    const results = [];
    for (const route of scenarios) {
      const result = await runScenario(workflow, route);
      expect({
        scenario: route.name,
        error: result.error,
        failed: result.failedExpectations,
      }).toEqual({
        scenario: route.name,
        error: undefined,
        failed: undefined,
      });
      results.push(result);
    }

    const coverage = calculateCoverage(workflow, results);
    expect({
      nodeCoverage: coverage.nodeCoverage,
      branchCoverage: coverage.branchCoverage,
      unvisitedNodes: coverage.unvisitedNodes,
      uncoveredBranches: coverage.uncoveredBranches,
    }).toEqual({
      nodeCoverage: 100,
      branchCoverage: 100,
      unvisitedNodes: [],
      uncoveredBranches: [],
    });
  });

  test("scenario names are unique", () => {
    expect(new Set(scenarios.map(({ name }) => name)).size).toBe(scenarios.length);
  });
});
