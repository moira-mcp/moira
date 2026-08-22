/**
 * Observable scenarios for Software Development Flow v14.1.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  GraphValidator,
  MaterializeHandler,
  detectCycles,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { calculateCoverage, exportCoverageReport } from "../../helpers/coverage-calculator.js";
import { runScenario, type MockInput, type TestScenario } from "../../helpers/scenario-runner.js";

const COVERAGE_ARTIFACTS_DIR = path.join(process.cwd(), "test-results/artifacts/coverage");

function loadWorkflow(): WorkflowGraph {
  return structuredClone(
    findSystemCatalogEntry("software-development-flow", "public")!.graph,
  ) as WorkflowGraph;
}

function useScenarioMaterializeGrant(engine: GraphExecutionEngine): void {
  const handlers = (engine as unknown as { nodeHandlers: Map<string, MaterializeHandler> })
    .nodeHandlers;
  handlers.set(
    "materialize",
    new MaterializeHandler(
      { createMaterializeToken: () => "software-development-scenario-token" },
      () => "https://moira.example",
    ),
  );
}

function ordinaryInputs(): Record<string, MockInput> {
  return {
    "capture-task-and-context": {
      workspace_path: "./moira-ws/example",
      operating_mode: "interactive",
    },
    "confirm-requirements": { requirements_approval: "yes" },
    "revise-requirements": {},
    "assess-project-health": { health_outcome: "pass" },
    "wait-for-health-state-change": { blocker_decision: "retry" },
    "create-plan": {},
    "review-plan": { review_outcome: "pass" },
    "repair-plan": { repair_outcome: "changed" },
    "approve-plan": {
      plan_approval: "yes",
      current_step_index: 1,
      total_steps: 1,
      vcs_commits_authorized: false,
    },
    "revise-plan-after-rejection": {},
    "prepare-plan-unit-implementation": { preparation_outcome: "ready" },
    "implement-plan-unit": {},
    "complete-plan-unit": { completion_outcome: "ready" },
    "validate-cheap": { issues_count: 0 },
    "repair-cheap-validation": { repair_outcome: "changed", mutation_scope: "product" },
    "review-test-adequacy": { review_outcome: "pass" },
    "repair-test-adequacy": { repair_outcome: "changed", mutation_scope: "product" },
    "review-architecture": { review_outcome: "pass" },
    "review-unit-completeness": { review_outcome: "pass" },
    "repair-unit-completeness": { repair_outcome: "changed", mutation_scope: "product" },
    "repair-architecture": { repair_outcome: "changed", mutation_scope: "product" },
    "approve-current-unit-closure": { closure_decision: "approved" },
    "revise-plan-for-replan": {},
    "revise-plan-for-teleport": {},
    "validate-runtime": { validation_outcome: "not_applicable" },
    "repair-runtime": { repair_outcome: "changed", mutation_scope: "product" },
    "wait-for-runtime-state-change": { blocker_decision: "retry" },
    "validate-expensive": { validation_outcome: "not_applicable" },
    "repair-expensive": { repair_outcome: "changed", mutation_scope: "product" },
    "wait-for-expensive-state-change": { blocker_decision: "retry" },
    "review-plan-unit-with-user": { acceptance_decision: "accepted" },
    "checkpoint-plan-unit": { checkpoint_outcome: "pass" },
    "repair-user-feedback": { resolution: "in_plan" },
    "reconcile-documentation": { change_scope: "not_applicable" },
    "validate-documentation": { review_outcome: "pass" },
    "repair-documentation": { repair_outcome: "gate_local" },
    "validate-feature-wide": { validation_outcome: "not_applicable" },
    "repair-feature-validation": { repair_outcome: "gate_local" },
    "wait-for-feature-state-change": { blocker_decision: "retry" },
    "review-final-semantics": { review_outcome: "pass" },
    "repair-final-semantics": { repair_outcome: "gate_local" },
    "validate-requirements-coverage": { gaps_count: 0 },
    "revise-plan-for-coverage": {},
    "finalize-feature": { finalization_outcome: "pass" },
    "repair-finalization-repository": { repair_outcome: "gate_local" },
    "repair-checkpoint-repository": { repair_outcome: "changed", mutation_scope: "product" },
    "resolve-finalization-blocker": { blocker_decision: "retry" },
    "report-and-accept-feature": { feature_decision: "accepted" },
    "revise-plan-after-feedback": {},
    "teleport-replan": {
      replan_rationale:
        "Repository facts invalidate the approved plan; preserve completed outcomes",
    },
  };
}

function flow(
  name: string,
  overrides: Record<string, MockInput>,
  reaches: string[],
  avoids: string[] = [],
  options: Pick<TestScenario, "teleportAfter"> = {},
): TestScenario {
  return {
    name,
    mockInputs: { ...ordinaryInputs(), ...overrides },
    expect: { status: "completed", reaches, avoids, maxSteps: 220 },
    ...options,
  };
}

/** Same run with the mode that routes around the requirements gate. */
function autonomousInputs(overrides: Record<string, MockInput> = {}): Record<string, MockInput> {
  return {
    "capture-task-and-context": {
      workspace_path: "./moira-ws/example",
      operating_mode: "autonomous",
    },
    ...overrides,
  };
}

const approvedPlan: MockInput = {
  plan_approval: "yes",
  current_step_index: 1,
  total_steps: 1,
  vcs_commits_authorized: false,
};

const scenarios: TestScenario[] = [
  flow(
    "autonomous run reaches the final report without a requirements gate",
    autonomousInputs(),
    [
      "route-operating-mode-requirements",
      "assess-project-health",
      "approve-plan",
      "review-plan-unit-with-user",
      "report-and-accept-feature",
      "end",
    ],
    ["confirm-requirements", "revise-requirements"],
  ),
  flow(
    "delegated completeness review sends an incomplete unit back through the cheap gate",
    {
      "review-unit-completeness": [
        { review_outcome: "repair" },
        { review_outcome: "pass" },
        { review_outcome: "pass" },
      ],
    },
    ["review-unit-completeness", "repair-unit-completeness", "validate-cheap", "end"],
  ),
  flow(
    "teleport replan rebuilds the plan and returns to implementation",
    {
      "approve-plan": [
        {
          plan_approval: "yes",
          current_step_index: 1,
          total_steps: 1,
          vcs_commits_authorized: false,
        },
        {
          plan_approval: "yes",
          current_step_index: 1,
          total_steps: 1,
          vcs_commits_authorized: false,
        },
      ],
      "teleport-replan": {
        replan_rationale: "R".repeat(8000),
      },
    },
    [
      "teleport-replan",
      "advance-plan-revision-for-teleport",
      "revise-plan-for-teleport",
      "review-plan",
      "implement-plan-unit",
      "end",
    ],
    ["revise-plan-for-replan"],
    { teleportAfter: { afterNode: "implement-plan-unit", teleportTo: "teleport-replan" } },
  ),
  flow(
    "ordinary code task without VCS side effects",
    {},
    [
      "prepare-plan-unit-implementation",
      "implement-plan-unit",
      "complete-plan-unit",
      "validate-cheap",
      "review-test-adequacy",
      "review-architecture",
      "end",
    ],
    ["finalize-feature", "end-aborted"],
  ),
  flow(
    "preparation replans before implementation or validation",
    {
      "prepare-plan-unit-implementation": [
        { preparation_outcome: "replan" },
        { preparation_outcome: "ready" },
      ],
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-implementation-preparation", "approve-current-unit-closure", "review-plan", "end"],
  ),
  flow(
    "producer completion can replan before cheap validation",
    {
      "complete-plan-unit": [{ completion_outcome: "replan" }, { completion_outcome: "ready" }],
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-plan-unit-completion", "approve-current-unit-closure", "review-plan", "end"],
  ),
  flow("producer completion creates a correction opportunity before cheap validation", {}, [
    "implement-plan-unit",
    "complete-plan-unit",
    "validate-cheap",
    "end",
  ]),
  flow(
    "requirements rejection and plan repair remain durable",
    {
      "confirm-requirements": [
        { requirements_approval: "no", user_feedback: "Keep the API stable" },
        { requirements_approval: "yes" },
      ],
      "review-plan": [
        { review_outcome: "repair" },
        { review_outcome: "pass" },
        { review_outcome: "pass" },
      ],
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
      "repair-cheap-validation": { repair_outcome: "changed", mutation_scope: "product" },
      "review-test-adequacy": [
        { review_outcome: "repair" },
        { review_outcome: "pass" },
        { review_outcome: "pass" },
      ],
      "repair-test-adequacy": { repair_outcome: "changed", mutation_scope: "product" },
      "review-architecture": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "repair-architecture": { repair_outcome: "changed", mutation_scope: "product" },
    },
    [
      "repair-cheap-validation",
      "repair-test-adequacy",
      "route-test-adequacy-reach",
      "repair-architecture",
      "route-architecture-reach",
      "end",
    ],
  ),
  flow(
    "a contained test repair goes back to the gate that raised it",
    {
      "review-test-adequacy": [
        { review_outcome: "repair" },
        { review_outcome: "pass" },
        { review_outcome: "pass" },
      ],
      "repair-test-adequacy": { repair_outcome: "changed", mutation_scope: "verification_only" },
    },
    ["repair-test-adequacy", "route-test-adequacy-reach", "review-test-adequacy", "end"],
  ),
  flow(
    "a contained architecture repair goes back to the architecture gate",
    {
      "review-architecture": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "repair-architecture": { repair_outcome: "changed", mutation_scope: "gate_local" },
    },
    ["repair-architecture", "route-architecture-reach", "review-architecture", "end"],
  ),
  flow(
    "a contained completeness repair goes back to the same reviewer",
    {
      "review-unit-completeness": [
        { review_outcome: "repair" },
        { review_outcome: "pass" },
        { review_outcome: "pass" },
      ],
      "repair-unit-completeness": { repair_outcome: "changed", mutation_scope: "gate_local" },
    },
    [
      "repair-unit-completeness",
      "mark-current-evidence-iteration",
      "review-unit-completeness",
      "end",
    ],
  ),
  flow(
    "architecture replan requires approved closure and a new reviewed plan",
    {
      "review-architecture": [{ review_outcome: "replan" }, { review_outcome: "pass" }],
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
      "review-architecture": [{ review_outcome: "replan" }, { review_outcome: "pass" }],
      "approve-current-unit-closure": { closure_decision: "refused" },
    },
    ["approve-current-unit-closure", "end-aborted"],
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
      "repair-runtime": { repair_outcome: "changed", mutation_scope: "product" },
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
      "repair-expensive": { repair_outcome: "changed", mutation_scope: "product" },
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
        { acceptance_decision: "accepted" },
      ],
      "repair-user-feedback": { resolution: "in_plan" },
    },
    ["repair-user-feedback", "route-user-feedback-resolution", "end"],
  ),
  flow(
    "material per-unit feedback creates a reviewed plan revision",
    {
      "review-plan-unit-with-user": [
        { acceptance_decision: "rejected", user_feedback: "Add a new public contract" },
        { acceptance_decision: "accepted" },
      ],
      "repair-user-feedback": { resolution: "replan" },
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
      "validate-documentation": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
    },
    ["validate-documentation", "repair-documentation", "validate-feature-wide", "end"],
  ),
  flow(
    "a documentation repair that discovers executable work returns to planning",
    {
      "reconcile-documentation": [
        { change_scope: "documentation_affected" },
        { change_scope: "not_applicable" },
      ],
      "validate-documentation": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "repair-documentation": { repair_outcome: "replan" },
    },
    [
      "repair-documentation",
      "route-documentation-repair-replan",
      "advance-plan-revision-for-replan",
      "revise-plan-for-replan",
      "end",
    ],
  ),
  flow(
    "executable documentation requires a reviewed plan revision",
    {
      "reconcile-documentation": [
        { change_scope: "requires_replan" },
        { change_scope: "not_applicable" },
      ],
    },
    [
      "route-executable-documentation",
      "advance-plan-revision-for-replan",
      "revise-plan-for-replan",
      "end",
    ],
  ),
  flow(
    "feature-wide and final semantic defects repair through stale gates",
    {
      "validate-feature-wide": [
        { validation_outcome: "repository_failure" },
        { validation_outcome: "pass" },
      ],
      "review-final-semantics": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "repair-feature-validation": { repair_outcome: "replan" },
      "repair-final-semantics": { repair_outcome: "replan" },
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
      "repair-checkpoint-repository": { repair_outcome: "changed", mutation_scope: "product" },
    },
    [
      "checkpoint-plan-unit",
      "route-checkpoint-abort",
      "repair-checkpoint-repository",
      "validate-cheap",
      "end",
    ],
  ),
  flow(
    "a contained checkpoint repair returns to the checkpoint instead of the whole chain",
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
      "repair-checkpoint-repository": {
        repair_outcome: "changed",
        mutation_scope: "verification_only",
      },
    },
    [
      "repair-checkpoint-repository",
      "route-checkpoint-repair-reach",
      "checkpoint-plan-unit",
      "end",
    ],
  ),
  flow(
    "a contained finalization repair returns to reconciliation instead of the whole chain",
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
      "repair-finalization-repository": { repair_outcome: "gate_local" },
    },
    [
      "repair-finalization-repository",
      "route-finalization-repair-replan",
      "finalize-feature",
      "end",
    ],
    ["advance-evidence-iteration"],
  ),
  flow(
    "contained feature-wide and final-semantic repairs return to their own gates",
    {
      "validate-feature-wide": [
        { validation_outcome: "repository_failure" },
        { validation_outcome: "pass" },
      ],
      "review-final-semantics": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "repair-feature-validation": { repair_outcome: "gate_local" },
      "repair-final-semantics": { repair_outcome: "gate_local" },
    },
    [
      "route-feature-repair-replan",
      "validate-feature-wide",
      "route-final-repair-replan",
      "review-final-semantics",
      "end",
    ],
    ["advance-evidence-iteration"],
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
  flow(
    "plan reviewer can reject an invalid criterion before implementation",
    {
      "review-plan": [{ review_outcome: "replan" }, { review_outcome: "pass" }],
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-plan-review-replan", "advance-plan-revision-for-replan", "end"],
  ),
  flow(
    "plan repair can discover that replanning is required",
    {
      "review-plan": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "repair-plan": { repair_outcome: "replan" },
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-plan-repair-outcome", "advance-plan-revision-for-replan", "end"],
  ),
  flow(
    "cheap verification-only repair restarts verification without a new product iteration",
    {
      "validate-cheap": [{ issues_count: 1 }, { issues_count: 0 }, { issues_count: 0 }],
      "repair-cheap-validation": {
        repair_outcome: "changed",
        mutation_scope: "verification_only",
      },
    },
    ["route-cheap-repair-scope", "mark-verification-only-iteration", "review-architecture", "end"],
  ),
  flow(
    "cheap repair can require replanning",
    {
      "validate-cheap": [{ issues_count: 1 }, { issues_count: 0 }],
      "repair-cheap-validation": { repair_outcome: "replan" },
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-cheap-repair-replan", "approve-current-unit-closure", "end"],
  ),
  flow(
    "test reviewer can reject an undecidable criterion",
    {
      "review-test-adequacy": [{ review_outcome: "replan" }, { review_outcome: "pass" }],
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-test-adequacy-replan", "approve-current-unit-closure", "end"],
  ),
  flow(
    "test repair can require replanning instead of adding a meta-validator",
    {
      "review-test-adequacy": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "repair-test-adequacy": { repair_outcome: "replan" },
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-test-repair-outcome", "approve-current-unit-closure", "end"],
  ),
  flow(
    "architecture repair can require replanning",
    {
      "review-architecture": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "repair-architecture": { repair_outcome: "replan" },
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-architecture-repair-outcome", "approve-current-unit-closure", "end"],
  ),
  flow(
    "runtime verification-only repair reruns downstream gates without architecture",
    {
      "validate-runtime": [
        { validation_outcome: "repository_failure" },
        { validation_outcome: "pass" },
        { validation_outcome: "pass" },
      ],
      "repair-runtime": { repair_outcome: "changed", mutation_scope: "verification_only" },
    },
    ["route-runtime-repair-scope", "mark-verification-only-iteration", "validate-expensive", "end"],
  ),
  flow(
    "runtime repair can require replanning",
    {
      "validate-runtime": [
        { validation_outcome: "repository_failure" },
        { validation_outcome: "pass" },
      ],
      "repair-runtime": { repair_outcome: "replan" },
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-runtime-repair-replan", "approve-current-unit-closure", "end"],
  ),
  flow(
    "expensive verification-only repair reruns runtime and expensive validation",
    {
      "validate-expensive": [
        { validation_outcome: "repository_failure" },
        { validation_outcome: "pass" },
        { validation_outcome: "pass" },
      ],
      "repair-expensive": { repair_outcome: "changed", mutation_scope: "verification_only" },
    },
    ["route-expensive-repair-scope", "mark-verification-only-iteration", "validate-runtime", "end"],
  ),
  flow(
    "expensive repair can require replanning",
    {
      "validate-expensive": [
        { validation_outcome: "repository_failure" },
        { validation_outcome: "pass" },
      ],
      "repair-expensive": { repair_outcome: "replan" },
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-expensive-repair-replan", "approve-current-unit-closure", "end"],
  ),
  flow(
    "completeness reviewer can require replanning",
    {
      "review-unit-completeness": [{ review_outcome: "replan" }, { review_outcome: "pass" }],
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-completeness-review-replan", "approve-current-unit-closure", "end"],
  ),
  flow(
    "completeness verification repair reruns the validation chain",
    {
      "review-unit-completeness": [
        { review_outcome: "repair" },
        { review_outcome: "pass" },
        { review_outcome: "pass" },
      ],
      "repair-unit-completeness": {
        repair_outcome: "changed",
        mutation_scope: "verification_only",
      },
    },
    [
      "route-unit-completeness-reach",
      "mark-verification-only-iteration",
      "validate-runtime",
      "end",
    ],
  ),
  flow(
    "completeness repair can require replanning",
    {
      "review-unit-completeness": [{ review_outcome: "repair" }, { review_outcome: "pass" }],
      "repair-unit-completeness": { repair_outcome: "replan" },
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-completeness-repair-outcome", "approve-current-unit-closure", "end"],
  ),
  flow(
    "documentation reviewer can require replanning",
    {
      "reconcile-documentation": [
        { change_scope: "documentation_affected" },
        { change_scope: "not_applicable" },
      ],
      "validate-documentation": { review_outcome: "replan" },
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-documentation-review-replan", "advance-plan-revision-for-replan", "end"],
  ),
  flow(
    "final semantic reviewer can require replanning",
    {
      "review-final-semantics": [{ review_outcome: "replan" }, { review_outcome: "pass" }],
      "approve-plan": [approvedPlan, approvedPlan],
    },
    ["route-final-review-replan", "advance-plan-revision-for-replan", "end"],
  ),
  flow(
    "checkpoint repair can require replanning",
    {
      "approve-plan": [
        { ...approvedPlan, vcs_commits_authorized: true },
        { ...approvedPlan, vcs_commits_authorized: true },
      ],
      "checkpoint-plan-unit": [
        { checkpoint_outcome: "repository_failure" },
        { checkpoint_outcome: "pass" },
      ],
      "repair-checkpoint-repository": { repair_outcome: "replan" },
    },
    ["route-checkpoint-repair-replan", "approve-current-unit-closure", "end"],
  ),
  flow(
    "finalization repair can require replanning",
    {
      "approve-plan": [
        { ...approvedPlan, vcs_commits_authorized: true },
        { ...approvedPlan, vcs_commits_authorized: true },
      ],
      "finalize-feature": [
        { finalization_outcome: "repository_failure" },
        { finalization_outcome: "pass" },
      ],
      "repair-finalization-repository": { repair_outcome: "replan" },
    },
    ["route-finalization-repair-replan", "advance-plan-revision-for-replan", "end"],
  ),
];

describe("software-development-flow v14.1", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("has the minimal filesystem-first state and authority contract", async () => {
    const validation = await new GraphValidator().validateWorkflow(workflow);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(workflow.metadata.version).toBe("14.1.1");
    expect(detectCycles(workflow).length).toBeGreaterThan(0);
    expect(Object.keys(workflow.variableRegistry ?? {})).toEqual([
      "workspace_path",
      "plan_revision",
      "current_step_index",
      "total_steps",
      "current_iteration",
      "vcs_commits_authorized",
      "operating_mode",
      "planning_standards",
      "engineering_standards",
      "test_standards",
      "documentation_standards",
      "review_standards",
      "previous_plan_revision",
      "previous_iteration",
      "product_review_iteration",
    ]);
    expect(workflow.variableRegistry?.operating_mode?.enum).toEqual(["autonomous", "interactive"]);

    const sharedReplan = workflow.nodes.find((node) => node.id === "revise-plan-for-replan");
    const teleportReplan = workflow.nodes.find((node) => node.id === "revise-plan-for-teleport");
    expect(sharedReplan?.directive).not.toContain("{{teleport-replan.replan_rationale}}");
    expect(teleportReplan?.directive).toContain("{{teleport-replan.replan_rationale}}");
    expect(workflow.nodes.find((node) => node.id === "teleport-replan")?.connections).toEqual({
      success: "advance-plan-revision-for-teleport",
    });
    const teleportSchema = workflow.nodes.find((node) => node.id === "teleport-replan")
      ?.inputSchema as {
      additionalProperties: boolean;
      required: string[];
      properties: { replan_rationale: { type: string; minLength: number; maxLength: number } };
    };
    expect(teleportSchema.additionalProperties).toBe(false);
    expect(teleportSchema.required).toEqual(["replan_rationale"]);
    expect(teleportSchema.properties.replan_rationale).toEqual({
      type: "string",
      minLength: 1,
      maxLength: 8000,
    });

    const completion = workflow.nodes.find((node) => node.id === "complete-plan-unit");
    expect(completion?.directive).toContain(
      "Directly finish every reproducible foreseeable in-scope omission",
    );
    expect(completion?.directive).toContain("Do not emit a findings-only handoff");

    // The engine materializes standards once, and every reader receives the canonical path.
    const standardsVars = [
      "planning_standards",
      "engineering_standards",
      "test_standards",
      "documentation_standards",
      "review_standards",
    ];
    for (const name of standardsVars) {
      expect(String(workflow.variableRegistry?.[name]?.default ?? "")).toContain("*Why.*");
      expect(JSON.stringify(workflow.nodes)).not.toContain(`{{${name}}}`);
    }
    const materializer = workflow.nodes.find(
      (node) => node.id === "materialize-development-standards",
    ) as {
      files: Array<{ path: string; from: string }>;
    };
    expect(materializer.files.map(({ path, from }) => ({ path, from }))).toEqual([
      { path: "standards/planning.md", from: "planning_standards" },
      { path: "standards/engineering.md", from: "engineering_standards" },
      { path: "standards/tests.md", from: "test_standards" },
      { path: "standards/documentation.md", from: "documentation_standards" },
      { path: "standards/review.md", from: "review_standards" },
    ]);
    const owner = workflow.nodes.find((node) => node.id === "capture-task-and-context");
    expect(owner?.directive).toContain("./moira-ws/software-development-flow-{task-name}");
    expect(owner?.connections).toEqual({ success: "materialize-development-standards" });

    // The reviewer contract has one home: the finding format no longer repeats across directives.
    expect(JSON.stringify(workflow)).not.toContain("do not stop after the first");
    for (const id of [
      "review-plan",
      "review-architecture",
      "review-test-adequacy",
      "validate-documentation",
      "review-final-semantics",
      "review-unit-completeness",
    ]) {
      expect(
        (workflow.nodes.find((node) => node.id === id) as { directive: string }).directive,
      ).toContain("standards/review.md");
    }
    expect(
      (workflow.nodes.find((node) => node.id === "validate-cheap") as { directive: string })
        .directive,
    ).toContain("tests are not substitutes for them");

    // Exactly one delegated review per plan unit: the per-unit gates judge locally, and only the
    // completeness review obtains independence.
    for (const id of ["review-test-adequacy", "review-architecture"]) {
      const gate = workflow.nodes.find((node) => node.id === id) as {
        directive: string;
        completionCondition: string;
      };
      expect(gate.directive).toContain("do not delegate it");
      expect(gate.completionCondition).not.toContain("Independent");
      expect(`${gate.directive} ${gate.completionCondition}`).not.toContain("fallback");
      // Still a gate: report path and routing count survive.
      expect(gate.directive).toContain(
        "{{workspace_path}}/plans/{{plan_revision}}/step-{{current_step_index}}",
      );
    }
    expect(
      (
        workflow.nodes.find((node) => node.id === "review-unit-completeness") as {
          directive: string;
        }
      ).directive,
    ).toContain("Delegate the completeness review");

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
      false: "advance-plan-revision-after-feedback",
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
    expect(unitReview?.directive).toContain("never concluded without presenting it");
    // Both answers route somewhere observable, so a unit is never concluded with a value that means
    // nothing to the engine.
    expect(
      (unitReview?.inputSchema as { properties: { acceptance_decision: { enum: string[] } } })
        .properties.acceptance_decision.enum,
    ).toEqual(["accepted", "rejected"]);

    const serialized = JSON.stringify(workflow);
    for (const removed of [
      "approval.md",
      "acceptance.md",
      "updated implementation report",
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
      "repair_reach",
      "verification_resume_stage",
      "record-executable-documentation-change",
      "proof_token",
      "pending_stage",
    ]) {
      expect(serialized).not.toContain(removed);
    }
  });

  test("requires distinguishing evidence and stops recursive meta-validation", () => {
    const planning = String(workflow.variableRegistry?.planning_standards?.default ?? "");
    const tests = String(workflow.variableRegistry?.test_standards?.default ?? "");
    const engineering = String(workflow.variableRegistry?.engineering_standards?.default ?? "");
    const review = String(workflow.variableRegistry?.review_standards?.default ?? "");

    expect(planning).toContain("plausible wrong state");
    expect(planning).toContain("observation that reliably differs");
    expect(planning).toContain("semantic completeness through primary-source judgment");
    expect(planning).toContain("Validation remains subordinate unless it is the requested result");
    expect(tests).toContain("helper, harness, adapter, guard, proxy, or metatest");
    expect(tests).toContain("does not prove semantic completeness or business provenance");
    expect(engineering).toContain("Supporting validation does not become a second product");
    expect(engineering).toContain("proving that another check or report used the intended path");
    expect(review).toContain("A repeated root requires changed knowledge");
    expect(review).toContain("Validation-only drift stops before another mutation");
    expect(review).toContain("Class-wide means bounded real manifestations");
  });

  test.each([
    ["missing", {}],
    ["empty", { replan_rationale: "" }],
    ["over maximum", { replan_rationale: "R".repeat(8001) }],
  ])("rejects %s teleport replan rationale at the actual input boundary", async (_, input) => {
    const result = await runScenario(
      workflow,
      {
        name: "invalid teleport rationale",
        mockInputs: { ...ordinaryInputs(), "teleport-replan": input },
        expect: { status: "completed", maxSteps: 220 },
        teleportAfter: { afterNode: "implement-plan-unit", teleportTo: "teleport-replan" },
      },
      { engineSetup: useScenarioMaterializeGrant },
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Input validation failed for node 'teleport-replan'");
    expect(result.visitedNodes).not.toContain("revise-plan-for-teleport");
  });

  test("classifies causes and exposes replan before mutation", () => {
    const review = String(workflow.variableRegistry?.review_standards?.default ?? "");
    for (const cause of [
      "product defect",
      "test or validation defect",
      "insufficient existing evidence",
      "documentation or process projection",
      "invalid or undemonstrable criterion",
    ]) {
      expect(review).toContain(cause);
    }

    for (const id of [
      "review-plan",
      "review-test-adequacy",
      "review-architecture",
      "review-unit-completeness",
      "validate-documentation",
      "review-final-semantics",
    ]) {
      const node = workflow.nodes.find((candidate) => candidate.id === id) as {
        inputSchema: { properties: { review_outcome: { enum: string[] } } };
      };
      expect(node.inputSchema.properties.review_outcome.enum).toEqual(["pass", "repair", "replan"]);
    }

    for (const id of [
      "repair-cheap-validation",
      "repair-test-adequacy",
      "repair-runtime",
      "repair-expensive",
      "repair-checkpoint-repository",
    ]) {
      const node = workflow.nodes.find((candidate) => candidate.id === id) as {
        inputSchema: { properties: Record<string, { enum: string[] }> };
      };
      expect(node.inputSchema.properties.repair_outcome.enum).toEqual(["changed", "replan"]);
      expect(node.inputSchema.properties.mutation_scope.enum).toEqual([
        "verification_only",
        "product",
      ]);
    }

    const closure = workflow.nodes.find((node) => node.id === "approve-current-unit-closure") as {
      directive: string;
    };
    expect(closure.directive).toContain(
      "mixed earliest causes cross paired repair responsibilities",
    );
    expect(closure.directive).toContain("In `autonomous` mode do not ask the user");
    expect(closure.directive).toContain("return `closure_decision=approved` whenever");
    expect(closure.directive).toContain("approved unit outcome may remain sound");
    expect(closure.directive).toContain(
      "do not refuse closure merely because that outcome can still be delivered",
    );
    expect(closure.directive).toContain("exactly one must state the current `replan` disposition");
    expect(closure.directive).toContain(
      "`closure_decision=refused` remains the user's explicit refusal",
    );
  });

  test("uses one product-review cursor instead of a validation resume stack", () => {
    const initialize = workflow.nodes.find(
      (node) => node.id === "initialize-implementation-iteration",
    ) as { expressions: string[] };
    const advanceUnit = workflow.nodes.find((node) => node.id === "advance-plan-unit") as {
      expressions: string[];
    };
    const markCurrent = workflow.nodes.find(
      (node) => node.id === "mark-product-review-current",
    ) as { expressions: string[] };

    expect(initialize.expressions).toContain("product_review_iteration = 0");
    expect(advanceUnit.expressions).toContain("product_review_iteration = 0");
    expect(markCurrent.expressions).toEqual(["product_review_iteration = current_iteration"]);
    expect(
      workflow.nodes.find((node) => node.id === "route-current-verification-only")?.connections,
    ).toEqual({ true: "validate-runtime", false: "review-architecture" });
    expect(
      workflow.nodes.find((node) => node.id === "mark-verification-only-iteration")?.connections,
    ).toEqual({ default: "validate-cheap" });
  });

  test("a verification-only repair after architecture reruns downstream gates but skips architecture", async () => {
    const result = await runScenario(
      workflow,
      {
        name: "runtime verification repair keeps current architecture evidence",
        mockInputs: {
          ...ordinaryInputs(),
          "validate-runtime": [
            { validation_outcome: "repository_failure" },
            { validation_outcome: "pass" },
            { validation_outcome: "pass" },
          ],
          "repair-runtime": { repair_outcome: "changed", mutation_scope: "verification_only" },
        },
        expect: { status: "completed", maxSteps: 220 },
      },
      { engineSetup: useScenarioMaterializeGrant },
    );
    expect(result.passed).toBe(true);
    const route = result.visitedNodes.filter((id, index, all) => id !== all[index - 1]);
    const suffix = route.slice(route.indexOf("repair-runtime"));
    expect(suffix).toContain("validate-cheap");
    expect(suffix).toContain("review-test-adequacy");
    expect(suffix).not.toContain("review-architecture");
    expect(suffix).toContain("validate-runtime");
    expect(suffix).toContain("validate-expensive");
  });

  test("a product repair advances the iteration and makes architecture stale", async () => {
    const result = await runScenario(
      workflow,
      {
        name: "runtime product repair invalidates architecture evidence",
        mockInputs: {
          ...ordinaryInputs(),
          "validate-runtime": [
            { validation_outcome: "repository_failure" },
            { validation_outcome: "pass" },
          ],
          "repair-runtime": { repair_outcome: "changed", mutation_scope: "product" },
        },
        expect: { status: "completed", maxSteps: 220 },
      },
      { engineSetup: useScenarioMaterializeGrant },
    );
    expect(result.passed).toBe(true);
    expect(result.finalContext.current_iteration).toBe(2);
    const route = result.visitedNodes.filter((id, index, all) => id !== all[index - 1]);
    expect(route.slice(route.indexOf("repair-runtime"))).toContain("review-architecture");
  });

  test("a new plan unit cannot inherit architecture currency from the previous unit", async () => {
    const result = await runScenario(
      workflow,
      {
        name: "second unit gets a fresh architecture review",
        mockInputs: {
          ...ordinaryInputs(),
          "approve-plan": { ...approvedPlan, total_steps: 2 },
        },
        expect: { status: "completed", maxSteps: 220 },
      },
      { engineSetup: useScenarioMaterializeGrant },
    );
    expect(result.passed).toBe(true);
    const route = result.visitedNodes.filter((id, index, all) => id !== all[index - 1]);
    expect(route.filter((id) => id === "review-architecture")).toHaveLength(2);
    expect(result.finalContext).toMatchObject({
      current_step_index: 2,
      product_review_iteration: 1,
    });
  });

  test("all representative routes complete and cover every node and branch", async () => {
    const results = await Promise.all(
      scenarios.map((item) =>
        runScenario(workflow, item, { engineSetup: useScenarioMaterializeGrant }),
      ),
    );
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

    const routeFor = (scenarioName: string): string[] => {
      const result = results.find((candidate) => candidate.scenario === scenarioName);
      expect(result).toBeDefined();
      return result!.visitedNodes.filter((id, index, all) => id !== all[index - 1]);
    };
    const expectOrdered = (route: string[], nodes: readonly string[], after = -1): number => {
      let cursor = after;
      for (const nodeId of nodes) {
        const next = route.indexOf(nodeId, cursor + 1);
        expect(next).toBeGreaterThan(cursor);
        cursor = next;
      }
      return cursor;
    };
    const positions = (route: string[], nodeId: string): number[] =>
      route.flatMap((candidate, index) => (candidate === nodeId ? [index] : []));

    const ordinary = routeFor("ordinary code task without VCS side effects");
    expectOrdered(ordinary, [
      "prepare-plan-unit-implementation",
      "implement-plan-unit",
      "complete-plan-unit",
      "validate-cheap",
    ]);

    const multipleUnits = routeFor("multiple approved units advance without a report-only turn");
    const unitPreparation = positions(multipleUnits, "prepare-plan-unit-implementation");
    const unitImplementation = positions(multipleUnits, "implement-plan-unit");
    const unitCompletion = positions(multipleUnits, "complete-plan-unit");
    const unitCheapValidation = positions(multipleUnits, "validate-cheap");
    for (const occurrences of [
      unitPreparation,
      unitImplementation,
      unitCompletion,
      unitCheapValidation,
    ]) {
      expect(occurrences).toHaveLength(2);
    }
    for (let unit = 0; unit < 2; unit++) {
      expect(unitPreparation[unit]).toBeLessThan(unitImplementation[unit]);
      expect(unitImplementation[unit]).toBeLessThan(unitCompletion[unit]);
      expect(unitCompletion[unit]).toBeLessThan(unitCheapValidation[unit]);
    }
    expect(unitCheapValidation[0]).toBeLessThan(unitPreparation[1]);

    const preparationReplan = routeFor("preparation replans before implementation or validation");
    const firstPreparation = preparationReplan.indexOf("prepare-plan-unit-implementation");
    const preparationClosure = preparationReplan.indexOf("approve-current-unit-closure");
    expect(firstPreparation).toBeGreaterThanOrEqual(0);
    expect(preparationClosure).toBeGreaterThan(firstPreparation);
    const prematurePreparationSuffix = preparationReplan.slice(
      firstPreparation,
      preparationClosure,
    );
    for (const forbiddenNode of ["implement-plan-unit", "complete-plan-unit", "validate-cheap"]) {
      expect(prematurePreparationSuffix).not.toContain(forbiddenNode);
    }
    const preparationReview = preparationReplan.indexOf("review-plan", preparationClosure + 1);
    expectOrdered(
      preparationReplan,
      [
        "prepare-plan-unit-implementation",
        "implement-plan-unit",
        "complete-plan-unit",
        "validate-cheap",
      ],
      preparationReview,
    );

    const completionReplan = routeFor("producer completion can replan before cheap validation");
    const firstCompletion = completionReplan.indexOf("complete-plan-unit");
    const completionClosure = completionReplan.indexOf("approve-current-unit-closure");
    expect(firstCompletion).toBeGreaterThanOrEqual(0);
    expect(completionClosure).toBeGreaterThan(firstCompletion);
    expect(completionReplan.slice(firstCompletion, completionClosure)).not.toContain(
      "validate-cheap",
    );
    const completionReview = completionReplan.indexOf("review-plan", completionClosure + 1);
    expectOrdered(
      completionReplan,
      [
        "prepare-plan-unit-implementation",
        "implement-plan-unit",
        "complete-plan-unit",
        "validate-cheap",
      ],
      completionReview,
    );

    const productRepairOrigins = [
      [
        "cheap test and architecture repairs invalidate all later evidence",
        "repair-cheap-validation",
      ],
      ["cheap test and architecture repairs invalidate all later evidence", "repair-test-adequacy"],
      ["cheap test and architecture repairs invalidate all later evidence", "repair-architecture"],
      [
        "delegated completeness review sends an incomplete unit back through the cheap gate",
        "repair-unit-completeness",
      ],
      ["runtime repository failure repairs and runtime external blocker retries", "repair-runtime"],
      ["expensive repository failure repairs and external blocker retries", "repair-expensive"],
      ["per-unit rejection can repair within the approved plan", "repair-user-feedback"],
      [
        "authorized checkpoint repository failure repairs before cursor advance",
        "repair-checkpoint-repository",
      ],
    ] as const;
    for (const [scenarioName, repairNode] of productRepairOrigins) {
      const route = routeFor(scenarioName);
      const repairIndex = route.indexOf(repairNode);
      const completionIndex = route.indexOf("complete-plan-unit", repairIndex + 1);
      const cheapValidationIndex = route.indexOf("validate-cheap", repairIndex + 1);
      expect(repairIndex).toBeGreaterThanOrEqual(0);
      expect(completionIndex).toBeGreaterThan(repairIndex);
      expect(cheapValidationIndex).toBeGreaterThan(completionIndex);
    }

    const verificationTailWithArchitecture = [
      "mark-verification-only-iteration",
      "validate-cheap",
      "route-cheap-validation",
      "review-test-adequacy",
      "route-test-adequacy-replan",
      "route-test-adequacy",
      "route-current-verification-only",
      "review-architecture",
      "route-architecture-replan",
      "route-architecture-review",
      "mark-product-review-current",
      "validate-runtime",
      "route-runtime-external",
      "route-runtime-repository",
      "validate-expensive",
      "route-expensive-external",
      "route-expensive-repository",
      "review-unit-completeness",
    ] as const;
    const verificationTailWithoutArchitecture = [
      "mark-verification-only-iteration",
      "validate-cheap",
      "route-cheap-validation",
      "review-test-adequacy",
      "route-test-adequacy-replan",
      "route-test-adequacy",
      "route-current-verification-only",
      "validate-runtime",
      "route-runtime-external",
      "route-runtime-repository",
      "validate-expensive",
      "route-expensive-external",
      "route-expensive-repository",
      "review-unit-completeness",
    ] as const;
    const boundedRepairSegments = [
      [
        "a contained test repair goes back to the gate that raised it",
        [
          "repair-test-adequacy",
          "route-test-repair-outcome",
          "route-test-adequacy-reach",
          ...verificationTailWithArchitecture,
        ],
      ],
      [
        "a contained architecture repair goes back to the architecture gate",
        [
          "repair-architecture",
          "route-architecture-repair-outcome",
          "route-architecture-reach",
          "review-architecture",
        ],
      ],
      [
        "a contained completeness repair goes back to the same reviewer",
        [
          "repair-unit-completeness",
          "route-completeness-repair-outcome",
          "route-completeness-repair-gate-local",
          "mark-current-evidence-iteration",
          "review-unit-completeness",
        ],
      ],
      [
        "cheap verification-only repair restarts verification without a new product iteration",
        [
          "repair-cheap-validation",
          "route-cheap-repair-replan",
          "route-cheap-repair-scope",
          ...verificationTailWithArchitecture,
        ],
      ],
      [
        "runtime verification-only repair reruns downstream gates without architecture",
        [
          "repair-runtime",
          "route-runtime-repair-replan",
          "route-runtime-repair-scope",
          ...verificationTailWithoutArchitecture,
        ],
      ],
      [
        "expensive verification-only repair reruns runtime and expensive validation",
        [
          "repair-expensive",
          "route-expensive-repair-replan",
          "route-expensive-repair-scope",
          ...verificationTailWithoutArchitecture,
        ],
      ],
      [
        "completeness verification repair reruns the validation chain",
        [
          "repair-unit-completeness",
          "route-completeness-repair-outcome",
          "route-completeness-repair-gate-local",
          "route-unit-completeness-reach",
          ...verificationTailWithoutArchitecture,
        ],
      ],
      [
        "a contained checkpoint repair returns to the checkpoint instead of the whole chain",
        [
          "repair-checkpoint-repository",
          "route-checkpoint-repair-replan",
          "route-checkpoint-repair-reach",
          ...verificationTailWithoutArchitecture,
          "route-completeness-review-replan",
          "route-unit-completeness",
          "review-plan-unit-with-user",
          "route-plan-unit-user-review",
          "route-checkpoint-authority",
          "checkpoint-plan-unit",
        ],
      ],
    ] as const;
    for (const [scenarioName, expectedCone] of boundedRepairSegments) {
      const route = routeFor(scenarioName);
      const repairIndex = route.indexOf(expectedCone[0]);
      expect(repairIndex).toBeGreaterThanOrEqual(0);
      const boundaryIndex = route.indexOf(expectedCone[expectedCone.length - 1], repairIndex + 1);
      expect(boundaryIndex).toBeGreaterThan(repairIndex);
      expect(route.slice(repairIndex, boundaryIndex + 1)).toEqual(expectedCone);
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
