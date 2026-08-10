/** Observable scenarios for the filesystem-only Robust Task v8. */

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

function ordinaryInputs(): Record<string, MockInput> {
  return {
    "initialize-workspace": { workspace_path: "./moira-ws/example-20260802-0700/" },
    "create-plan": { current_plan_file: "plans/001/plan.md", total_steps: 1 },
    "review-plan": { issues_count: 0 },
    "ask-plan-review-limit": { decision: "accept" },
    "fix-plan": { current_plan_file: "plans/002/plan.md", total_steps: 1 },
    "approve-plan": { decision: "yes" },
    "revise-plan": { current_plan_file: "plans/002/plan.md", total_steps: 1 },
    "execute-step": { evidence_file: "steps/1/plans/001/attempts/1/evidence.md" },
    "review-step": {
      verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
      accepted: "yes",
      plan_must_change: "no",
    },
    "ask-retry-decision": {
      decision: "finish_incomplete",
      decision_file: "steps/1/decisions/001.md",
    },
    "replan-from-verdict": { current_plan_file: "plans/002/plan.md", total_steps: 1 },
    "replan-from-decision": { current_plan_file: "plans/002/plan.md", total_steps: 1 },
    "teleport-replan": { current_plan_file: "plans/002/plan.md", total_steps: 1 },
    "verify-criteria": { review_file: "final/criteria/001-review.md", issues_count: 0 },
    "ask-criteria-review-limit": { decision: "accept_incomplete" },
    "fix-criteria-gaps": {},
    "final-review": { review_file: "final/reviews/001-review.md", issues_count: 0 },
    "ask-final-review-limit": { decision: "accept_incomplete" },
    "fix-final-review": {},
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
    expect: { status: "completed", reaches, maxSteps: 180 },
    ...options,
  };
}

const scenarios: TestScenario[] = [
  scenario("ordinary complete execution", {}, [
    "execute-step",
    "verify-criteria",
    "final-review",
    "end",
  ]),
  scenario(
    "plan review repairs a new immutable revision",
    {
      "review-plan": [{ issues_count: 1 }, { issues_count: 0 }],
      "fix-plan": { current_plan_file: "plans/002/plan.md", total_steps: 1 },
    },
    ["fix-plan", "increment-plan-review-round", "approve-plan", "end"],
  ),
  scenario(
    "bounded plan review asks the user before continuing",
    { "review-plan": { issues_count: 1 }, "ask-plan-review-limit": { decision: "accept" } },
    ["ask-plan-review-limit", "route-plan-review-limit", "approve-plan", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "plan rejection creates and reviews a new revision",
    {
      "approve-plan": [{ decision: "no" }, { decision: "yes" }],
      "revise-plan": { current_plan_file: "plans/002/plan.md", total_steps: 1 },
    },
    ["revise-plan", "review-plan", "approve-plan", "end"],
  ),
  scenario(
    "ordinary failed step retries and preserves the open cursor",
    {
      "execute-step": [
        { evidence_file: "steps/1/plans/001/attempts/1/evidence.md" },
        { evidence_file: "steps/1/plans/001/attempts/2/evidence.md" },
      ],
      "review-step": [
        {
          verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
          accepted: "no",
          plan_must_change: "no",
        },
        {
          verdict_file: "steps/1/plans/001/attempts/2/verdict.md",
          accepted: "yes",
          plan_must_change: "no",
        },
      ],
    },
    ["increment-step-retry", "check-step-retry-limit", "execute-step", "end"],
  ),
  scenario(
    "verifier-requested replan returns through review and approval",
    {
      "review-step": [
        {
          verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
          accepted: "no",
          plan_must_change: "yes",
        },
        {
          verdict_file: "steps/1/plans/002/attempts/1/verdict.md",
          accepted: "yes",
          plan_must_change: "no",
        },
      ],
      "execute-step": [
        { evidence_file: "steps/1/plans/001/attempts/1/evidence.md" },
        { evidence_file: "steps/1/plans/002/attempts/1/evidence.md" },
      ],
    },
    ["replan-from-verdict", "review-plan", "approve-plan", "end"],
  ),
  scenario(
    "retry exhaustion can retry after a durable user decision",
    {
      "execute-step": [
        { evidence_file: "steps/1/plans/001/attempts/1/evidence.md" },
        { evidence_file: "steps/1/plans/001/attempts/2/evidence.md" },
      ],
      "review-step": [
        {
          verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
          accepted: "no",
          plan_must_change: "no",
        },
        {
          verdict_file: "steps/1/plans/001/attempts/2/verdict.md",
          accepted: "yes",
          plan_must_change: "no",
        },
      ],
      "ask-retry-decision": { decision: "retry", decision_file: "steps/1/decisions/001.md" },
    },
    ["notify-escalation", "ask-retry-decision", "reset-step-retry", "end"],
    { initialVariables: { max_retries: 1 } },
  ),
  scenario(
    "retry exhaustion can replan the unfinished tail",
    {
      "execute-step": [
        { evidence_file: "steps/1/plans/001/attempts/1/evidence.md" },
        { evidence_file: "steps/1/plans/002/attempts/1/evidence.md" },
      ],
      "review-step": [
        {
          verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
          accepted: "no",
          plan_must_change: "no",
        },
        {
          verdict_file: "steps/1/plans/002/attempts/1/verdict.md",
          accepted: "yes",
          plan_must_change: "no",
        },
      ],
      "ask-retry-decision": { decision: "replan", decision_file: "steps/1/decisions/001.md" },
    },
    ["route-replan-choice", "replan-from-decision", "review-plan", "end"],
    { initialVariables: { max_retries: 1 } },
  ),
  scenario(
    "retry exhaustion can finish truthfully incomplete",
    {
      "review-step": {
        verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
        accepted: "no",
        plan_must_change: "no",
      },
      "ask-retry-decision": {
        decision: "finish_incomplete",
        decision_file: "steps/1/decisions/001.md",
      },
      "deliver-result": {
        delivery_file: "final/delivery.md",
        delivery_status: "incomplete",
        summary: "Step 1 and its active obligations remain incomplete by explicit user decision.",
      },
    },
    ["ask-retry-decision", "deliver-result", "end"],
    { initialVariables: { max_retries: 1 } },
  ),
  scenario(
    "criteria defects are repaired and rechecked",
    {
      "verify-criteria": [
        { review_file: "final/criteria/001-review.md", issues_count: 1 },
        { review_file: "final/criteria/002-review.md", issues_count: 0 },
      ],
    },
    ["fix-criteria-gaps", "increment-criteria-review-round", "verify-criteria", "end"],
  ),
  scenario(
    "criteria review bound permits explicit incomplete acceptance",
    {
      "verify-criteria": { review_file: "final/criteria/001-review.md", issues_count: 1 },
      "ask-criteria-review-limit": { decision: "accept_incomplete" },
      "deliver-result": {
        delivery_file: "final/delivery.md",
        delivery_status: "incomplete",
        summary: "The accepted criteria gap is disclosed.",
      },
    },
    ["ask-criteria-review-limit", "final-review", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "final review defects return through criteria verification",
    {
      "verify-criteria": [
        { review_file: "final/criteria/001-review.md", issues_count: 0 },
        { review_file: "final/criteria/002-review.md", issues_count: 0 },
      ],
      "final-review": [
        { review_file: "final/reviews/001-review.md", issues_count: 1 },
        { review_file: "final/reviews/002-review.md", issues_count: 0 },
      ],
    },
    ["fix-final-review", "increment-final-review-round", "verify-criteria", "end"],
  ),
  scenario(
    "final review bound permits explicit incomplete acceptance",
    {
      "final-review": { review_file: "final/reviews/001-review.md", issues_count: 1 },
      "ask-final-review-limit": { decision: "accept_incomplete" },
      "deliver-result": {
        delivery_file: "final/delivery.md",
        delivery_status: "incomplete",
        summary: "The accepted final-review findings are disclosed.",
      },
    },
    ["ask-final-review-limit", "deliver-result", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "each bounded quality loop can continue after explicit repair authorization",
    {
      "review-plan": [{ issues_count: 1 }, { issues_count: 0 }],
      "ask-plan-review-limit": { decision: "repair" },
      "verify-criteria": [
        { review_file: "final/criteria/001-review.md", issues_count: 1 },
        { review_file: "final/criteria/002-review.md", issues_count: 0 },
      ],
      "ask-criteria-review-limit": { decision: "repair" },
      "final-review": [
        { review_file: "final/reviews/001-review.md", issues_count: 1 },
        { review_file: "final/reviews/002-review.md", issues_count: 0 },
      ],
      "ask-final-review-limit": { decision: "repair" },
    },
    ["reset-plan-review-for-repair", "reset-criteria-for-repair", "reset-final-for-repair", "end"],
    { initialVariables: { max_review_rounds: 1 } },
  ),
  scenario(
    "teleport replan preserves completed work and returns through approval",
    {
      "execute-step": [
        { evidence_file: "steps/1/plans/001/attempts/1/evidence.md" },
        { evidence_file: "steps/1/plans/002/attempts/1/evidence.md" },
      ],
      "review-step": {
        verdict_file: "steps/1/plans/002/attempts/1/verdict.md",
        accepted: "yes",
        plan_must_change: "no",
      },
    },
    ["teleport-replan", "review-plan", "approve-plan", "end"],
    { teleportAfter: { afterNode: "execute-step", teleportTo: "teleport-replan" } },
  ),
];

describe("Robust Task filesystem-only contract", () => {
  const workflow = loadWorkflow();

  test("keeps only justified durable state and native routing", async () => {
    const validation = await new GraphValidator().validateUnified(workflow);
    expect(validation.valid).toBe(true);
    expect(validation.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(detectCycles(workflow).length).toBeGreaterThan(0);

    const serialized = JSON.stringify(workflow);
    for (const removed of [
      "nofile",
      "jsonFingerprint",
      "canAppend",
      "operation_state",
      "result_code",
      "fingerprint",
      "capacity_event",
      "takeover",
      "waive_requirement",
    ]) {
      expect(serialized).not.toContain(removed);
    }

    expect(node(workflow, "initialize-workspace").directive).toContain("process-id.txt");
    expect(node(workflow, "execute-step").directive).toContain("next unused numeric attempt");
    expect(node(workflow, "review-step").directive).toContain("independent peer review");
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
