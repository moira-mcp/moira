/**
 * Observable scenarios for the filesystem-first Software Development Flow v12.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import { GraphValidator, detectCycles, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { calculateCoverage, exportCoverageReport } from "../../helpers/coverage-calculator.js";
import { runScenario, type MockInput, type TestScenario } from "../../helpers/scenario-runner.js";

const COVERAGE_ARTIFACTS_DIR = path.join(process.cwd(), "test-results/artifacts/coverage");

function loadWorkflow(): WorkflowGraph {
  return structuredClone(
    findSystemCatalogEntry("software-development-flow", "public")!.graph,
  ) as WorkflowGraph;
}

function ordinaryInputs(): Record<string, MockInput> {
  return {
    "capture-task-and-context": { workspace_path: "./moira-ws/example" },
    "confirm-requirements": { requirements_approval: "yes" },
    "revise-requirements": {},
    "assess-project-health": { health_outcome: "pass" },
    "wait-for-health-state-change": { blocker_decision: "retry" },
    "create-plan": {},
    "review-plan": { issues_count: 0 },
    "repair-plan": {},
    "approve-plan": {
      plan_approval: "yes",
      current_step_index: 1,
      total_steps: 1,
      vcs_commits_authorized: false,
    },
    "revise-plan-after-rejection": { plan_revision: 2 },
    "implement-plan-unit": {},
    "validate-cheap": { issues_count: 0 },
    "repair-cheap-validation": { current_iteration: 2 },
    "review-test-adequacy": { issues_count: 0 },
    "repair-test-adequacy": { current_iteration: 2 },
    "review-architecture": { issues_count: 0, requires_replan: false },
    "repair-architecture": { current_iteration: 2 },
    "approve-current-unit-closure": { closure_decision: "approved" },
    "revise-plan-for-replan": { plan_revision: 2 },
    "validate-runtime": { validation_outcome: "not_applicable" },
    "repair-runtime": { current_iteration: 2 },
    "wait-for-runtime-state-change": { blocker_decision: "retry" },
    "validate-expensive": { validation_outcome: "not_applicable" },
    "repair-expensive": { current_iteration: 2 },
    "wait-for-expensive-state-change": { blocker_decision: "retry" },
    "review-plan-unit-with-user": { acceptance_decision: "skip" },
    "checkpoint-plan-unit": { checkpoint_outcome: "pass" },
    "repair-user-feedback": { resolution: "in_plan", current_iteration: 2 },
    "reconcile-documentation": { change_scope: "not_applicable" },
    "validate-documentation": { issues_count: 0 },
    "repair-documentation": {},
    "validate-feature-wide": { validation_outcome: "not_applicable" },
    "repair-feature-validation": { current_iteration: 2 },
    "wait-for-feature-state-change": { blocker_decision: "retry" },
    "review-final-semantics": { issues_count: 0 },
    "repair-final-semantics": { current_iteration: 2 },
    "validate-requirements-coverage": { gaps_count: 0 },
    "revise-plan-for-coverage": { plan_revision: 2 },
    "finalize-feature": { finalization_outcome: "pass" },
    "repair-finalization-repository": { current_iteration: 2 },
    "resolve-finalization-blocker": { blocker_decision: "retry" },
    "report-and-accept-feature": { feature_decision: "accepted" },
    "revise-plan-after-feedback": { plan_revision: 2 },
  };
}

function flow(
  name: string,
  overrides: Record<string, MockInput>,
  reaches: string[],
  avoids: string[] = [],
): TestScenario {
  return {
    name,
    mockInputs: { ...ordinaryInputs(), ...overrides },
    expect: { status: "completed", reaches, avoids, maxSteps: 220 },
  };
}

const scenarios: TestScenario[] = [
  flow(
    "ordinary code task without VCS side effects",
    {},
    ["validate-cheap", "review-test-adequacy", "review-architecture", "end"],
    ["finalize-feature", "end-aborted"],
  ),
  flow(
    "requirements rejection and plan repair remain durable",
    {
      "confirm-requirements": [
        { requirements_approval: "no", user_feedback: "Keep the API stable" },
        { requirements_approval: "yes" },
      ],
      "review-plan": [{ issues_count: 1 }, { issues_count: 0 }, { issues_count: 0 }],
      "approve-plan": [
        { plan_approval: "no", user_feedback: "Split the risky outcome" },
        {
          plan_approval: "yes",
          current_step_index: 1,
          total_steps: 1,
          vcs_commits_authorized: false,
        },
      ],
    },
    ["revise-requirements", "repair-plan", "revise-plan-after-rejection", "end"],
  ),
  flow(
    "repository baseline failure enters approved planning without pre-plan repair",
    { "assess-project-health": { health_outcome: "repository_failure" } },
    ["route-health-external", "create-plan", "end"],
  ),
  flow(
    "external baseline blocker retries only after a decision",
    {
      "assess-project-health": [{ health_outcome: "external_blocker" }, { health_outcome: "pass" }],
    },
    ["wait-for-health-state-change", "create-plan", "end"],
  ),
  flow(
    "external baseline blocker can abort truthfully",
    {
      "assess-project-health": { health_outcome: "external_blocker" },
      "wait-for-health-state-change": { blocker_decision: "abort" },
    },
    ["wait-for-health-state-change", "end-aborted"],
    ["create-plan", "validate-requirements-coverage"],
  ),
  flow(
    "cheap test and architecture repairs invalidate all later evidence",
    {
      "validate-cheap": [
        { issues_count: 1 },
        { issues_count: 0 },
        { issues_count: 0 },
        { issues_count: 0 },
      ],
      "repair-cheap-validation": { current_iteration: 2 },
      "review-test-adequacy": [{ issues_count: 1 }, { issues_count: 0 }, { issues_count: 0 }],
      "repair-test-adequacy": { current_iteration: 3 },
      "review-architecture": [
        { issues_count: 1, requires_replan: false },
        { issues_count: 0, requires_replan: false },
      ],
      "repair-architecture": { current_iteration: 4 },
    },
    ["repair-cheap-validation", "repair-test-adequacy", "repair-architecture", "end"],
  ),
  flow(
    "architecture replan requires approved closure and a new reviewed plan",
    {
      "review-architecture": [
        { issues_count: 1, requires_replan: true },
        { issues_count: 0, requires_replan: false },
      ],
      "approve-plan": [
        {
          plan_approval: "yes",
          current_step_index: 1,
          total_steps: 1,
          vcs_commits_authorized: false,
        },
        {
          plan_approval: "yes",
          current_step_index: 2,
          total_steps: 2,
          vcs_commits_authorized: false,
        },
      ],
    },
    ["approve-current-unit-closure", "revise-plan-for-replan", "review-plan", "end"],
  ),
  flow(
    "closure refusal cannot advance the approved cursor",
    {
      "review-architecture": [
        { issues_count: 1, requires_replan: true },
        { issues_count: 0, requires_replan: false },
      ],
      "approve-current-unit-closure": { closure_decision: "refused" },
    },
    ["approve-current-unit-closure", "repair-architecture", "end"],
    ["revise-plan-for-replan"],
  ),
  flow(
    "runtime repository failure repairs and runtime external blocker retries",
    {
      "validate-runtime": [
        { validation_outcome: "repository_failure" },
        { validation_outcome: "external_blocker" },
        { validation_outcome: "pass" },
      ],
      "repair-runtime": { current_iteration: 2 },
    },
    ["repair-runtime", "wait-for-runtime-state-change", "end"],
  ),
  flow(
    "runtime external blocker can abort",
    {
      "validate-runtime": { validation_outcome: "external_blocker" },
      "wait-for-runtime-state-change": { blocker_decision: "abort" },
    },
    ["wait-for-runtime-state-change", "end-aborted"],
    ["validate-expensive"],
  ),
  flow(
    "expensive repository failure repairs and external blocker retries",
    {
      "validate-expensive": [
        { validation_outcome: "repository_failure" },
        { validation_outcome: "external_blocker" },
        { validation_outcome: "pass" },
      ],
      "repair-expensive": { current_iteration: 2 },
    },
    ["repair-expensive", "wait-for-expensive-state-change", "end"],
  ),
  flow(
    "expensive external blocker can abort",
    {
      "validate-expensive": { validation_outcome: "external_blocker" },
      "wait-for-expensive-state-change": { blocker_decision: "abort" },
    },
    ["wait-for-expensive-state-change", "end-aborted"],
    ["review-plan-unit-with-user"],
  ),
  flow(
    "per-unit rejection can repair within the approved plan",
    {
      "review-plan-unit-with-user": [
        { acceptance_decision: "rejected", user_feedback: "The result is incorrect" },
        { acceptance_decision: "approved" },
      ],
      "repair-user-feedback": { resolution: "in_plan", current_iteration: 2 },
    },
    ["repair-user-feedback", "route-user-feedback-resolution", "end"],
  ),
  flow(
    "material per-unit feedback creates a reviewed plan revision",
    {
      "review-plan-unit-with-user": [
        { acceptance_decision: "rejected", user_feedback: "Add a new public contract" },
        { acceptance_decision: "skip" },
      ],
      "repair-user-feedback": { resolution: "replan", plan_revision: 2 },
      "approve-plan": [
        {
          plan_approval: "yes",
          current_step_index: 1,
          total_steps: 1,
          vcs_commits_authorized: false,
        },
        {
          plan_approval: "yes",
          current_step_index: 2,
          total_steps: 2,
          vcs_commits_authorized: false,
        },
      ],
    },
    ["route-user-feedback-resolution", "review-plan", "end"],
  ),
  flow(
    "multiple approved units advance without a report-only turn",
    {
      "approve-plan": {
        plan_approval: "yes",
        current_step_index: 1,
        total_steps: 2,
        vcs_commits_authorized: false,
      },
    },
    ["advance-plan-unit", "reconcile-documentation", "end"],
  ),
  flow(
    "documentation-only reconciliation has its own repair cone",
    {
      "reconcile-documentation": { change_scope: "documentation_affected" },
      "validate-documentation": [{ issues_count: 1 }, { issues_count: 0 }],
    },
    ["validate-documentation", "repair-documentation", "validate-feature-wide", "end"],
  ),
  flow(
    "executable documentation returns through code and semantic gates",
    {
      "reconcile-documentation": [
        { change_scope: "executable", current_iteration: 2 },
        { change_scope: "not_applicable" },
      ],
    },
    ["route-executable-documentation", "validate-cheap", "review-architecture", "end"],
  ),
  flow(
    "feature-wide and final semantic defects repair through stale gates",
    {
      "validate-feature-wide": [
        { validation_outcome: "repository_failure" },
        { validation_outcome: "pass" },
      ],
      "review-final-semantics": [{ issues_count: 1 }, { issues_count: 0 }],
      "repair-feature-validation": { current_iteration: 2 },
      "repair-final-semantics": { current_iteration: 3 },
    },
    ["repair-feature-validation", "repair-final-semantics", "end"],
  ),
  flow(
    "feature-wide external blocker retries or aborts without repository repair",
    {
      "validate-feature-wide": [
        { validation_outcome: "external_blocker" },
        { validation_outcome: "pass" },
      ],
    },
    ["wait-for-feature-state-change", "review-final-semantics", "end"],
  ),
  flow(
    "feature-wide external blocker can abort",
    {
      "validate-feature-wide": { validation_outcome: "external_blocker" },
      "wait-for-feature-state-change": { blocker_decision: "abort" },
    },
    ["wait-for-feature-state-change", "end-aborted"],
    ["review-final-semantics"],
  ),
  flow(
    "requirements gap creates a reviewed and approved plan revision",
    {
      "validate-requirements-coverage": [{ gaps_count: 1 }, { gaps_count: 0 }],
      "approve-plan": [
        {
          plan_approval: "yes",
          current_step_index: 1,
          total_steps: 1,
          vcs_commits_authorized: false,
        },
        {
          plan_approval: "yes",
          current_step_index: 2,
          total_steps: 2,
          vcs_commits_authorized: false,
        },
      ],
    },
    ["revise-plan-for-coverage", "review-plan", "end"],
  ),
  flow(
    "authorized finalization repairs repository failure before retry",
    {
      "approve-plan": {
        plan_approval: "yes",
        current_step_index: 1,
        total_steps: 1,
        vcs_commits_authorized: true,
      },
      "finalize-feature": [
        { finalization_outcome: "repository_failure" },
        { finalization_outcome: "pass" },
      ],
    },
    ["repair-finalization-repository", "validate-cheap", "finalize-feature", "end"],
  ),
  flow(
    "authorized finalization external blocker can retry skip or abort",
    {
      "approve-plan": {
        plan_approval: "yes",
        current_step_index: 1,
        total_steps: 1,
        vcs_commits_authorized: true,
      },
      "finalize-feature": { finalization_outcome: "external_blocker" },
      "resolve-finalization-blocker": { blocker_decision: "skip" },
    },
    ["resolve-finalization-blocker", "route-finalization-skip", "end"],
  ),
  flow(
    "authorized finalization external blocker retries after changed state",
    {
      "approve-plan": {
        plan_approval: "yes",
        current_step_index: 1,
        total_steps: 1,
        vcs_commits_authorized: true,
      },
      "finalize-feature": [
        { finalization_outcome: "external_blocker" },
        { finalization_outcome: "pass" },
      ],
      "resolve-finalization-blocker": { blocker_decision: "retry" },
    },
    ["route-finalization-retry", "finalize-feature", "end"],
  ),
  flow(
    "authorized finalization external blocker can abort",
    {
      "approve-plan": {
        plan_approval: "yes",
        current_step_index: 1,
        total_steps: 1,
        vcs_commits_authorized: true,
      },
      "finalize-feature": { finalization_outcome: "external_blocker" },
      "resolve-finalization-blocker": { blocker_decision: "abort" },
    },
    ["route-finalization-skip", "end-aborted"],
    ["end"],
  ),
  flow(
    "final user rejection returns to reviewed planning",
    {
      "report-and-accept-feature": [
        { feature_decision: "rejected", user_feedback: "One requirement remains" },
        { feature_decision: "accepted" },
      ],
      "approve-plan": [
        {
          plan_approval: "yes",
          current_step_index: 1,
          total_steps: 1,
          vcs_commits_authorized: false,
        },
        {
          plan_approval: "yes",
          current_step_index: 2,
          total_steps: 2,
          vcs_commits_authorized: false,
        },
      ],
    },
    ["revise-plan-after-feedback", "review-plan", "end"],
  ),
  flow(
    "authorized checkpoint repository failure repairs before cursor advance",
    {
      "approve-plan": {
        plan_approval: "yes",
        current_step_index: 1,
        total_steps: 1,
        vcs_commits_authorized: true,
      },
      "checkpoint-plan-unit": [
        { checkpoint_outcome: "repository_failure" },
        { checkpoint_outcome: "pass" },
      ],
      "repair-finalization-repository": { current_iteration: 2 },
    },
    [
      "checkpoint-plan-unit",
      "route-checkpoint-abort",
      "repair-finalization-repository",
      "validate-cheap",
      "end",
    ],
  ),
  flow(
    "authorized checkpoint aborts without cursor advance",
    {
      "approve-plan": {
        plan_approval: "yes",
        current_step_index: 1,
        total_steps: 2,
        vcs_commits_authorized: true,
      },
      "checkpoint-plan-unit": { checkpoint_outcome: "abort" },
    },
    ["checkpoint-plan-unit", "route-checkpoint-abort", "end-aborted"],
    ["route-plan-complete", "advance-plan-unit"],
  ),
];

describe("software-development-flow v12", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("has the minimal filesystem-first state and authority contract", async () => {
    const validation = await new GraphValidator().validateWorkflow(workflow);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(workflow.metadata.version).toBe("12.2.0");
    expect(detectCycles(workflow).length).toBeGreaterThan(0);
    expect(Object.keys(workflow.variableRegistry ?? {})).toEqual([
      "workspace_path",
      "plan_revision",
      "current_step_index",
      "total_steps",
      "current_iteration",
      "vcs_commits_authorized",
    ]);

    const start = workflow.nodes.find((node) => node.id === "start");
    expect(start).not.toHaveProperty("initialData");
    expect(workflow.nodes.find((node) => node.id === "route-vcs-authority")?.connections).toEqual({
      true: "finalize-feature",
      false: "end",
    });
    expect(
      workflow.nodes.find((node) => node.id === "route-plan-unit-user-review")?.connections,
    ).toEqual({ true: "repair-user-feedback", false: "route-checkpoint-authority" });
    expect(
      workflow.nodes.find((node) => node.id === "route-checkpoint-authority")?.connections,
    ).toEqual({
      true: "checkpoint-plan-unit",
      false: "route-plan-complete",
    });
    expect(
      workflow.nodes.find((node) => node.id === "route-feature-acceptance")?.connections,
    ).toEqual({
      true: "route-vcs-authority",
      false: "revise-plan-after-feedback",
    });
    expect(workflow.nodes.find((node) => node.id === "end")?.finalOutput).toEqual([
      "workspace_path",
    ]);

    const checkpoint = workflow.nodes.find((node) => node.id === "checkpoint-plan-unit");
    expect(checkpoint?.directive).toContain("only task-owned changes attributable to this unit");
    expect(checkpoint?.directive).toContain("without an empty revision");
    expect(checkpoint?.directive).toContain("explicitly skip this checkpoint, or abort");

    const runtime = workflow.nodes.find((node) => node.id === "validate-runtime");
    expect(runtime?.directive).toContain(
      "only when this exact approved plan unit explicitly requires",
    );
    expect(runtime?.directive).toContain("open the actual images");
    const unitReview = workflow.nodes.find((node) => node.id === "review-plan-unit-with-user");
    expect(unitReview?.directive).toContain("portable self-contained");
    expect(unitReview?.directive).toContain("skip is forbidden");

    const serialized = JSON.stringify(workflow);
    for (const removed of [
      "telegram-notification",
      "maxRetries",
      "retryMessage",
      "validation_attempt_count",
      "requirements_gaps_count",
      "coverage_report_path",
      "todo-list",
      "result_code",
      "issue_history",
      "findings_history",
    ]) {
      expect(serialized).not.toContain(removed);
    }
  });

  test("all representative routes complete and cover every node and branch", async () => {
    const results = await Promise.all(scenarios.map((item) => runScenario(workflow, item)));
    const failed = results.filter((result) => !result.passed);
    if (failed.length > 0) {
      throw new Error(
        JSON.stringify(
          failed.map((result) => ({
            scenario: result.scenario,
            error: result.error,
            failedExpectations: result.failedExpectations,
            visitedNodes: result.visitedNodes,
            loopDiagnostics: result.loopDiagnostics,
          })),
          null,
          2,
        ),
      );
    }

    const coverage = calculateCoverage(workflow, results, { includeGapAnalysis: true });
    fs.mkdirSync(COVERAGE_ARTIFACTS_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(COVERAGE_ARTIFACTS_DIR, "software-development-flow.md"),
      exportCoverageReport(coverage, "markdown"),
    );
    fs.writeFileSync(
      path.join(COVERAGE_ARTIFACTS_DIR, "software-development-flow.json"),
      exportCoverageReport(coverage, "json"),
    );

    expect(coverage.unvisitedNodes).toEqual([]);
    expect(coverage.uncoveredBranches).toEqual([]);
  });

  test("has unique scenario names", () => {
    const names = scenarios.map((item) => item.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
