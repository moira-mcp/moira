/**
 * Observable scenarios for Software Development Flow v15.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphExecutionEngine,
  GraphValidator,
  MaterializeHandler,
  detectCycles,
  projectExecutionProgress,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { calculateCoverage, exportCoverageReport } from "../../helpers/coverage-calculator.js";
import {
  runScenario as runScenarioBase,
  type MockInput,
  type MockInputContext,
  type TestScenario,
} from "../../helpers/scenario-runner.js";

const COVERAGE_ARTIFACTS_DIR = path.join(process.cwd(), "test-results/artifacts/coverage");
const exclusiveResponseShape =
  /(?:^|[\n.!?]\s+)Return only\b|(?:^|[\n.!?]\s+)Return [^.\n]+ only\.(?:\s|$)/i;

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
      visual_validation_preference: "disabled",
    },
    "confirm-requirements": { requirements_approval: "yes" },
    "revise-requirements": {},
    "assess-project-health": { health_outcome: "pass" },
    "wait-for-health-state-change": { blocker_decision: "retry" },
    "create-plan": {},
    "review-plan": { review_outcome: "pass" },
    "repair-plan": { repair_outcome: "changed" },
    "approve-plan": { plan_approval: "yes" },
    "activate-reviewed-plan": {
      current_step_index: 1,
      total_steps: 1,
      vcs_commits_authorized: false,
    },
    "revise-plan-after-rejection": {},
    "prepare-plan-unit-implementation": {
      preparation_outcome: "ready",
      visual_mode: "disabled",
      approval_required: true,
    },
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
    "create-and-upload-step-report": { report_url: "https://report.example/unit.html" },
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
    "create-final-report": {},
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

function progressOutputsFor(workflow: WorkflowGraph, nodeId: string): Record<string, string> {
  const node = workflow.nodes.find((candidate) => candidate.id === nodeId);
  const globals = node?.inputSchema?.globalInputs ?? [];
  return Object.fromEntries(
    globals
      .filter((name) => name.startsWith("progress_"))
      .map((name) => {
        if (nodeId === "activate-reviewed-plan" && name === "progress_plan_outcome") {
          return [name, "Plan r1: 1 executable unit — implement and verify the requested change"];
        }
        if (nodeId === "review-unit-completeness" && name === "progress_checkpoint_outcome") {
          return [name, "Checkpoint is not applicable without local commit authority"];
        }
        return [name, `${node?.progressNodeId ?? "workflow"}: ${nodeId} completed`];
      }),
  );
}

function addProgressOutputs(workflow: WorkflowGraph, nodeId: string, input: MockInput): MockInput {
  if (Array.isArray(input)) {
    return input.map((item) => ({ ...progressOutputsFor(workflow, nodeId), ...item }));
  }
  if (typeof input === "function") {
    return (context: MockInputContext) => ({
      ...progressOutputsFor(workflow, nodeId),
      ...input(context),
    });
  }
  return { ...progressOutputsFor(workflow, nodeId), ...input };
}

async function runScenario(
  workflow: WorkflowGraph,
  scenario: TestScenario,
  options?: Parameters<typeof runScenarioBase>[2],
): ReturnType<typeof runScenarioBase> {
  return runScenarioBase(
    workflow,
    {
      ...scenario,
      mockInputs: Object.fromEntries(
        Object.entries(scenario.mockInputs).map(([nodeId, input]) => [
          nodeId,
          addProgressOutputs(workflow, nodeId, input),
        ]),
      ),
    },
    options,
  );
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
      visual_validation_preference: "disabled",
    },
    "prepare-plan-unit-implementation": {
      preparation_outcome: "ready",
      visual_mode: "disabled",
      approval_required: false,
    },
    ...overrides,
  };
}

const approvedPlan: MockInput = {
  plan_approval: "yes",
};

const activatedPlan: MockInput = {
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
      "route-plan-activation-mode",
      "activate-reviewed-plan",
      "create-final-report",
      "end",
    ],
    [
      "confirm-requirements",
      "revise-requirements",
      "approve-plan",
      "review-plan-unit-with-user",
      "report-and-accept-feature",
    ],
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
      "activate-reviewed-plan": [activatedPlan, activatedPlan],
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
    "html report reuses visual evidence and notifies without unit approval",
    {
      "prepare-plan-unit-implementation": {
        preparation_outcome: "ready",
        visual_mode: "html_report",
        approval_required: false,
      },
    },
    [
      "validate-runtime",
      "route-unit-html-report",
      "create-and-upload-step-report",
      "notify-report-ready",
      "route-unit-approval-required",
      "create-final-report",
      "end",
    ],
    ["notify-unit-approval", "review-plan-unit-with-user"],
  ),
  flow(
    "screenshot validation runs without an HTML report or unit approval",
    {
      "prepare-plan-unit-implementation": {
        preparation_outcome: "ready",
        visual_mode: "screenshots",
        approval_required: false,
      },
    },
    [
      "validate-runtime",
      "route-unit-html-report",
      "route-unit-approval-required",
      "create-final-report",
      "end",
    ],
    [
      "create-and-upload-step-report",
      "notify-report-ready",
      "notify-unit-approval",
      "review-plan-unit-with-user",
    ],
  ),
  flow(
    "preparation replans before implementation or validation",
    {
      "prepare-plan-unit-implementation": [
        { preparation_outcome: "replan" },
        {
          preparation_outcome: "ready",
          visual_mode: "disabled",
          approval_required: true,
        },
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
        approvedPlan,
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
      "activate-reviewed-plan": [
        activatedPlan,
        { ...activatedPlan, current_step_index: 2, total_steps: 2 },
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
      "activate-reviewed-plan": [
        activatedPlan,
        { ...activatedPlan, current_step_index: 2, total_steps: 2 },
      ],
    },
    ["route-user-feedback-resolution", "review-plan", "end"],
  ),
  flow(
    "multiple approved units advance without a report-only turn",
    {
      "activate-reviewed-plan": { ...activatedPlan, total_steps: 2 },
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
      "activate-reviewed-plan": [
        activatedPlan,
        { ...activatedPlan, current_step_index: 2, total_steps: 2 },
      ],
    },
    ["revise-plan-for-coverage", "review-plan", "end"],
  ),
  flow(
    "authorized finalization repairs repository failure before retry",
    {
      "activate-reviewed-plan": { ...activatedPlan, vcs_commits_authorized: true },
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
      "activate-reviewed-plan": { ...activatedPlan, vcs_commits_authorized: true },
      "finalize-feature": { finalization_outcome: "external_blocker" },
      "resolve-finalization-blocker": { blocker_decision: "skip" },
    },
    ["resolve-finalization-blocker", "route-finalization-skip", "end"],
  ),
  flow(
    "authorized finalization external blocker retries after changed state",
    {
      "activate-reviewed-plan": { ...activatedPlan, vcs_commits_authorized: true },
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
      "activate-reviewed-plan": { ...activatedPlan, vcs_commits_authorized: true },
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
      "activate-reviewed-plan": [
        activatedPlan,
        { ...activatedPlan, current_step_index: 2, total_steps: 2 },
      ],
    },
    ["revise-plan-after-feedback", "review-plan", "end"],
  ),
  flow(
    "authorized checkpoint repository failure repairs before cursor advance",
    {
      "activate-reviewed-plan": { ...activatedPlan, vcs_commits_authorized: true },
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
      "activate-reviewed-plan": { ...activatedPlan, vcs_commits_authorized: true },
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
      "activate-reviewed-plan": { ...activatedPlan, vcs_commits_authorized: true },
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
      "activate-reviewed-plan": {
        ...activatedPlan,
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
      "activate-reviewed-plan": [
        { ...activatedPlan, vcs_commits_authorized: true },
        { ...activatedPlan, vcs_commits_authorized: true },
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
      "activate-reviewed-plan": [
        { ...activatedPlan, vcs_commits_authorized: true },
        { ...activatedPlan, vcs_commits_authorized: true },
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

describe("software-development-flow v15.4.2", () => {
  let workflow: WorkflowGraph;

  beforeAll(() => {
    workflow = loadWorkflow();
  });

  test("has the minimal filesystem-first state and authority contract", async () => {
    const validation = await new GraphValidator().validateWorkflow(workflow);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
    expect(workflow.metadata.version).toBe("15.4.2");
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
      "visual_validation_preference",
      "progress_intake_outcome",
      "progress_plan_outcome",
      "progress_implementation_outcome",
      "progress_tests_outcome",
      "progress_review_outcome",
      "progress_checkpoint_outcome",
      "progress_finalize_outcome",
    ]);
    expect(workflow.variableRegistry?.operating_mode?.enum).toEqual(["autonomous", "interactive"]);
    expect(workflow.variableRegistry?.visual_validation_preference?.enum).toEqual([
      "disabled",
      "screenshots",
      "html_report",
    ]);
    expect(workflow.progress).toEqual({
      title: "Software Development · plan r{{plan_revision}}",
      goal: "Deliver one complete repository change with its tests, permanent documentation, review, and truthful local closure.",
      facts: [{ label: "Plan", value: "r{{plan_revision}}", tone: "neutral" }],
      nodes: [
        expect.objectContaining({
          id: "intake",
          label: "Intake",
          content: expect.objectContaining({ outcome: "{{progress_intake_outcome}}" }),
          connections: { default: "plan" },
        }),
        expect.objectContaining({
          id: "plan",
          label: "Plan",
          content: expect.objectContaining({ outcome: "{{progress_plan_outcome}}" }),
          connections: { default: "implement" },
        }),
        expect.objectContaining({
          id: "implement",
          label: "Implement",
          content: expect.objectContaining({ outcome: "{{progress_implementation_outcome}}" }),
          connections: { default: "tests" },
        }),
        expect.objectContaining({
          id: "tests",
          label: "Tests",
          content: expect.objectContaining({ outcome: "{{progress_tests_outcome}}" }),
          connections: { default: "review" },
        }),
        expect.objectContaining({
          id: "review",
          label: "Review",
          content: expect.objectContaining({ outcome: "{{progress_review_outcome}}" }),
          connections: { default: "checkpoint" },
        }),
        expect.objectContaining({
          id: "checkpoint",
          label: "Checkpoint",
          content: expect.objectContaining({ outcome: "{{progress_checkpoint_outcome}}" }),
          connections: { default: "implement" },
        }),
        expect.objectContaining({
          id: "finalize",
          label: "Finalize",
          content: expect.objectContaining({ outcome: "{{progress_finalize_outcome}}" }),
        }),
      ],
    });
    const visibleWaitingTypes = new Set([
      "agent-directive",
      "teleport",
      "lock",
      "materialize",
      "subgraph",
    ]);
    const visibleWaitingNodes = workflow.nodes.filter((node) => visibleWaitingTypes.has(node.type));
    expect(visibleWaitingNodes).toHaveLength(54);
    expect(visibleWaitingNodes.filter((node) => !node.progressNodeId)).toEqual([]);
    expect(visibleWaitingNodes.filter((node) => !node.progressActiveContent)).toEqual([]);
    const stageOutcome = {
      intake: "progress_intake_outcome",
      plan: "progress_plan_outcome",
      implement: "progress_implementation_outcome",
      tests: "progress_tests_outcome",
      review: "progress_review_outcome",
      checkpoint: "progress_checkpoint_outcome",
      finalize: "progress_finalize_outcome",
    } as const;
    for (const node of visibleWaitingNodes.filter(
      (candidate) => candidate.type === "agent-directive" || candidate.type === "teleport",
    )) {
      const expectedOutcome = stageOutcome[node.progressNodeId as keyof typeof stageOutcome];
      expect(node.inputSchema?.globalInputs).toContain(expectedOutcome);
      expect(node.inputSchema?.required).toContain(expectedOutcome);
    }
    expect(
      workflow.nodes.find((node) => node.id === "review-unit-completeness")?.inputSchema
        ?.globalInputs,
    ).toContain("progress_checkpoint_outcome");
    expect(
      workflow.nodes
        .filter((node) => node.type === "telegram-notification" && node.attachProgressImage)
        .map((node) => [node.id, node.progressNodeId]),
    ).toEqual([
      ["notify-plan-approval", "plan"],
      ["notify-report-ready", "review"],
      ["notify-unit-approval", "review"],
      ["notify-workflow-complete", "finalize"],
      ["notify-final-approval", "finalize"],
    ]);
    expect(workflow.nodes.find((node) => node.id === "notify-workflow-stopped")).not.toHaveProperty(
      "attachProgressImage",
    );

    const approval = workflow.nodes.find((node) => node.id === "approve-plan") as {
      inputSchema: { globalInputs?: string[]; properties: Record<string, unknown> };
    };
    expect(approval.inputSchema.globalInputs).toEqual(["progress_plan_outcome"]);
    expect(Object.keys(approval.inputSchema.properties)).toEqual([
      "plan_approval",
      "user_feedback",
    ]);
    const activation = workflow.nodes.find((node) => node.id === "activate-reviewed-plan") as {
      inputSchema: { globalInputs: string[] };
    };
    expect(activation.inputSchema.globalInputs).toEqual([
      "current_step_index",
      "total_steps",
      "vcs_commits_authorized",
      "progress_plan_outcome",
    ]);
    expect(
      (workflow.nodes.find((node) => node.id === "activate-reviewed-plan") as { directive: string })
        .directive,
    ).toContain("exact executable unit count returned in total_steps");
    expect(
      workflow.nodes.find((node) => node.id === "route-plan-activation-mode")?.connections,
    ).toEqual({
      true: "notify-plan-approval",
      false: "activate-reviewed-plan",
    });

    const preparation = workflow.nodes.find(
      (node) => node.id === "prepare-plan-unit-implementation",
    ) as {
      inputSchema: {
        properties: {
          visual_mode: { enum: string[] };
          approval_required: { type: string };
        };
      };
    };
    expect(preparation.inputSchema.properties.visual_mode.enum).toEqual([
      "disabled",
      "screenshots",
      "html_report",
    ]);
    expect(preparation.inputSchema.properties.approval_required.type).toBe("boolean");

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
    expect(teleportSchema.required).toEqual(["replan_rationale", "progress_plan_outcome"]);
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

    // A plan unit fixes the outcome and its acceptance, never the deliverable. The rule lives in the
    // planning standard, which is where every plan writer is pointed; the prose case is stated
    // explicitly because the file-and-symbol wording above only catches the code one.
    const planning = String(workflow.variableRegistry?.planning_standards?.default ?? "");
    expect(planning).toContain("## A unit does not carry the deliverable");
    expect(planning).toContain("work an intelligent executor still has to do remains");
    expect(planning).toContain("satisfy by copying text out of the plan");
    // The reason is its own obligation: the pre-existing "*Why.* appears somewhere" check cannot
    // fail here, because the standard already carries nine of them.
    expect(planning).toContain("nothing has independently judged the work");
    // Each gate carries it too, bound to what that node may write. Only create-plan owns the whole
    // revision: a breadth-first walk from the three execution nodes never reaches it. The other
    // five do — repair-plan among them, despite its single incoming edge, because any revision goes
    // back through review-plan and a blocking finding routes into it — so they answer only for the
    // units they shape, since closed units stay as executed.
    const gate = (nodeId: string) =>
      (workflow.nodes.find((node) => node.id === nodeId) as { completionCondition: string })
        .completionCondition;
    // Closed work stays closed, and stays where it was closed: the unit account lives at
    // step-<index>/, addressed by index and outside plan revisions, so a revision that keeps a
    // closed unit's text but shifts its index makes the executor overwrite someone else's account.
    // repair-plan carries it in both halves because it edits the revision in place; the four
    // revise-* nodes already say it in their directives, so only their gates were missing it.
    const repairPlan = workflow.nodes.find((node) => node.id === "repair-plan") as {
      directive: string;
      completionCondition: string;
    };
    expect(repairPlan.directive).toContain(
      "Closed units stay as they were closed and keep the index they were closed at",
    );
    // Forbidding the repair of a closed unit would loop forever without a way out: this flow has no
    // review-round limit at all, so the exit is the node's own, and it must cover a finding that
    // reproduces but may no longer be fixed.
    expect(repairPlan.directive).toContain(
      "the finding cannot be corrected without touching a closed unit, that is a cause above repair",
    );
    for (const [nodeId, directiveClause] of [
      ["revise-plan-after-rejection", "carry forward unaffected requirements and completed work"],
      ["revise-plan-for-replan", "keep the index they were closed at"],
      ["revise-plan-for-coverage", "Preserve prior revisions and completed work"],
      ["revise-plan-after-feedback", "Preserve prior revisions and completed work"],
    ] as const) {
      expect(
        (workflow.nodes.find((node) => node.id === nodeId) as { directive: string }).directive,
      ).toContain(directiveClause);
    }
    // One wording for one obligation: the gates differ in what else they carry, but the closed-work
    // clause reads the same everywhere, so a gate that drifts is visible.
    for (const [nodeId, gateClause] of [
      ["repair-plan", "the index they were closed at"],
      ["revise-plan-after-rejection", "the index they were closed at"],
      ["revise-plan-for-replan", "the index they were closed at"],
      ["revise-plan-for-coverage", "the index they were closed at"],
      ["revise-plan-after-feedback", "the index they were closed at"],
    ] as const) {
      expect(gate(nodeId)).toContain(gateClause);
    }
    // Upstream owns the rest of each gate; the new clause is appended to it rather than replacing
    // it, so the gate still states the outcome it was written for.
    expect(gate("revise-plan-after-rejection")).toContain("rejection feedback");
    expect(gate("revise-plan-for-coverage")).toContain("every final coverage gap");
    expect(gate("revise-plan-after-feedback")).toContain("final rejection feedback");

    expect(gate("create-plan")).toContain("every unit has valid visualMode and userApproval");
    expect(gate("create-plan")).toContain(
      "push, PR, publication, release, and deployment are excluded from units",
    );
    for (const nodeId of [
      "repair-plan",
      "revise-plan-after-rejection",
      "revise-plan-for-replan",
      "revise-plan-for-coverage",
      "revise-plan-after-feedback",
    ]) {
      expect(gate(nodeId)).toContain(
        "every unit it shapes fixes what must become true, the evidence that would accept it, and what it depends on rather than carrying the deliverable",
      );
    }
    const owner = workflow.nodes.find((node) => node.id === "capture-task-and-context");
    expect(owner?.directive).toContain("./moira-ws/software-development-flow-{task-name}");
    expect(owner?.directive).toContain('session({ action: "add-reminder"');
    expect(owner?.directive).toContain("standalone and child executions alike");
    expect(owner?.directive).toContain("preserve it in canonical requirements");
    expect(owner?.directive).toContain("neither performs nor authorizes the effect");
    expect(owner?.completionCondition).toContain("active execution reminder");
    expect(owner?.connections).toEqual({ success: "materialize-development-standards" });
    expect(gate("create-plan")).toContain("active execution reminder");
    expect(
      (workflow.nodes.find((node) => node.id === "create-plan") as { directive: string }).directive,
    ).toContain("Do not copy reminder items into the development plan");
    expect(workflow.runtimePolicy?.externalVariableWrites).toBeUndefined();

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
      false: "notify-workflow-complete",
    });
    expect(
      workflow.nodes.find((node) => node.id === "route-plan-unit-user-review")?.connections,
    ).toEqual({ true: "repair-user-feedback", false: "route-checkpoint-authority" });
    expect(
      workflow.nodes.find((node) => node.id === "route-unit-html-report")?.connections,
    ).toEqual({
      true: "create-and-upload-step-report",
      false: "route-unit-approval-required",
    });
    expect(
      workflow.nodes.find((node) => node.id === "route-unit-approval-required")?.connections,
    ).toEqual({ true: "notify-unit-approval", false: "route-checkpoint-authority" });
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
    expect(
      workflow.nodes.find((node) => node.id === "notify-workflow-complete")?.connections,
    ).toEqual({
      default: "end",
    });
    expect(
      workflow.nodes.find((node) => node.id === "notify-workflow-stopped")?.connections,
    ).toEqual({
      default: "end-aborted",
    });
    expect(workflow.nodes.filter((node) => node.type === "lock")).toEqual([]);

    const checkpoint = workflow.nodes.find((node) => node.id === "checkpoint-plan-unit");
    expect(checkpoint?.directive).toContain("only task-owned changes attributable to this unit");
    expect(checkpoint?.directive).toContain("without an empty revision");
    expect(checkpoint?.directive).toContain("explicitly skip this checkpoint, or abort");

    const runtime = workflow.nodes.find((node) => node.id === "validate-runtime");
    expect(runtime?.directive).toContain("Use the current visual_mode");
    expect(runtime?.directive).toContain("does not add a second capture pass");
    expect(runtime?.directive).toContain("open the actual images");
    const unitReview = workflow.nodes.find((node) => node.id === "review-plan-unit-with-user");
    expect(unitReview?.directive).toContain("do not decide materiality again");
    expect(unitReview?.directive).toContain("Do not create or upload reports");
    const reportProducer = workflow.nodes.find(
      (node) => node.id === "create-and-upload-step-report",
    );
    expect(reportProducer?.directive).toContain("Reuse the exact screenshots already captured");
    expect(reportProducer?.directive).toContain("do not run capture tooling");
    expect(reportProducer?.directive).toContain("do not submit success");
    const finalSemanticReview = workflow.nodes.find((node) => node.id === "review-final-semantics");
    expect(finalSemanticReview?.directive).toContain(
      "every current html_report obligation has current inspected evidence and a successfully uploaded current report",
    );
    expect(finalSemanticReview?.directive).toContain(
      "user acceptance required only when that exact unit's current plan policy required it",
    );
    const finalReport = workflow.nodes.find((node) => node.id === "create-final-report");
    expect(finalReport?.directive).toContain("every current successfully uploaded visual report");
    expect(finalReport?.directive).toContain(
      "interactive acceptance outcomes where the current plan required them",
    );
    expect(`${finalSemanticReview?.directive} ${finalReport?.directive}`).not.toContain(
      "accepted visual report",
    );
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

  test("binds current-unit work to the active plan revision", () => {
    const currentPlanPath = "{{workspace_path}}/plans/{{plan_revision}}/plan.md";
    const previousPlanPath = "{{workspace_path}}/plans/{{previous_plan_revision}}/plan.md";
    const currentPlanConsumers = [
      "validate-cheap",
      "repair-cheap-validation",
      "review-test-adequacy",
      "repair-test-adequacy",
      "review-architecture",
      "repair-architecture",
      "approve-current-unit-closure",
      "validate-runtime",
      "repair-runtime",
      "validate-expensive",
      "repair-expensive",
      "review-plan-unit-with-user",
      "repair-user-feedback",
      "complete-plan-unit",
      "repair-unit-completeness",
      "checkpoint-plan-unit",
      "repair-checkpoint-repository",
      "create-and-upload-step-report",
      "teleport-replan",
    ];

    for (const nodeId of currentPlanConsumers) {
      const directive = (
        workflow.nodes.find((node) => node.id === nodeId) as {
          directive: string;
        }
      ).directive;
      expect(directive).toContain(currentPlanPath);
      expect(directive).not.toContain(previousPlanPath);
    }

    // Revision writers are the deliberate exception: they preserve the historical source while
    // producing the already-advanced current revision. Ordinary unit work must never copy this
    // contract, because it would silently execute stale acceptance criteria after a replan.
    for (const nodeId of [
      "revise-plan-after-rejection",
      "revise-plan-for-replan",
      "revise-plan-for-coverage",
      "revise-plan-after-feedback",
      "revise-plan-for-teleport",
    ]) {
      const directive = (
        workflow.nodes.find((node) => node.id === nodeId) as {
          directive: string;
        }
      ).directive;
      expect(directive).toContain(previousPlanPath);
      expect(directive).toContain(currentPlanPath);
    }

    const progressResponseNodes = workflow.nodes.filter(
      (node) =>
        (node.type === "agent-directive" || node.type === "teleport") &&
        node.inputSchema?.required?.some((field) => field.startsWith("progress_")),
    );
    expect(progressResponseNodes).toHaveLength(53);
    for (const node of progressResponseNodes) {
      expect(node.directive).not.toMatch(exclusiveResponseShape);
    }

    for (const [nodeId, functionalOutput, progressOutput] of [
      ["validate-cheap", "issues_count", "progress_tests_outcome"],
      ["review-test-adequacy", "review_outcome", "progress_tests_outcome"],
      ["review-architecture", "review_outcome", "progress_review_outcome"],
      ["teleport-replan", "replan_rationale", "progress_plan_outcome"],
      ["complete-plan-unit", "completion_outcome", "progress_implementation_outcome"],
    ] as const) {
      const node = workflow.nodes.find((candidate) => candidate.id === nodeId) as {
        directive: string;
        inputSchema: { required: string[] };
      };
      expect(node.directive).toContain("same response as the required progress output");
      expect(node.inputSchema.required).toEqual(
        expect.arrayContaining([functionalOutput, progressOutput]),
      );
    }
  });

  test("projects truthful progress across unit loops, replan, finalization and completion", () => {
    const projectionAt = (
      currentNodeId: string | null,
      status: "running" | "completed" = "running",
      variables: Record<string, unknown> = {},
      waitingForInputNodeId: string | null = currentNodeId,
    ) =>
      projectExecutionProgress(workflow, {
        id: "progress-scenario",
        workflowId: workflow.id ?? "software-development-flow",
        userId: "scenario-user",
        status,
        currentNodeId,
        waitingForInputNodeId,
        revision: 7,
        globalContext: {
          variables: {
            plan_revision: 3,
            current_step_index: 2,
            total_steps: 5,
            current_iteration: 4,
            progress_intake_outcome: "Task and repository context accepted",
            progress_plan_outcome:
              "Plan r3: 5 executable units — API, UI, integration, documentation, release checks",
            progress_implementation_outcome: "Unit 2 implementation complete",
            progress_tests_outcome: "Unit 2 focused checks and test review passed",
            progress_review_outcome: "Unit 2 independent review passed",
            progress_checkpoint_outcome: "Checkpoint is not applicable without local authority",
            progress_finalize_outcome: "Final reconciliation pending",
            ...variables,
          },
          nodeStates: {},
          executionId: "progress-scenario",
          workflowId: workflow.id ?? "software-development-flow",
          currentNodeId,
        },
      } as unknown as Parameters<typeof projectExecutionProgress>[1]);

    const cases = [
      ["capture-task-and-context", "intake", "Capture task and repository context"],
      ["materialize-development-standards", "intake", "Prepare development standards"],
      ["confirm-requirements", "intake", "Confirm requirements"],
      ["revise-requirements", "intake", "Revise requirements"],
      ["assess-project-health", "intake", "Assess project health"],
      ["wait-for-health-state-change", "intake", "Resolve project-health blocker"],
      ["create-plan", "plan", "Plan r3"],
      ["review-plan", "plan", "Review plan r3"],
      ["repair-plan", "plan", "Repair plan r3"],
      ["approve-plan", "plan", "Approve plan r3"],
      ["revise-plan-after-rejection", "plan", "Revise plan r3"],
      ["activate-reviewed-plan", "plan", "Activate plan r3"],
      ["prepare-plan-unit-implementation", "implement", "Prepare · 2/5"],
      ["implement-plan-unit", "implement", "Implement · 2/5"],
      ["complete-plan-unit", "implement", "Complete unit · 2/5"],
      ["validate-cheap", "tests", "2/5 i4 · Checks"],
      ["repair-cheap-validation", "tests", "Repair validation · 2/5 · i4"],
      ["review-test-adequacy", "tests", "Review tests · 2/5 · i4"],
      ["repair-test-adequacy", "tests", "Repair tests · 2/5 · i4"],
      ["review-architecture", "review", "2/5 i4 · Arch review"],
      ["repair-architecture", "review", "Repair architecture · 2/5 · i4"],
      ["validate-runtime", "review", "Runtime validation · 2/5 · i4"],
      ["wait-for-runtime-state-change", "review", "Runtime blocker · 2/5"],
      ["repair-runtime", "review", "Repair runtime · 2/5 · i4"],
      ["validate-expensive", "review", "Broad validation · 2/5 · i4"],
      ["wait-for-expensive-state-change", "review", "Validation blocker · 2/5"],
      ["repair-expensive", "review", "Repair broad checks · 2/5 · i4"],
      ["review-unit-completeness", "review", "Independent review · 2/5 · i4"],
      ["repair-unit-completeness", "review", "Repair completeness · 2/5 · i4"],
      ["checkpoint-plan-unit", "checkpoint", "Checkpoint · 2/5"],
      ["repair-checkpoint-repository", "checkpoint", "Repair checkpoint · 2/5"],
      ["approve-current-unit-closure", "plan", "Replan decision · r3"],
      ["revise-plan-for-replan", "plan", "Replan r3"],
      ["teleport-replan", "plan", "Replan · r3"],
      ["revise-plan-for-teleport", "plan", "Replan · r3"],
      ["review-plan-unit-with-user", "review", "Unit review · 2/5"],
      ["create-and-upload-step-report", "review", "Visual report · 2/5"],
      ["resolve-finalization-blocker", "finalize", "Finalization blocker"],
      ["reconcile-documentation", "finalize", "Reconcile documentation"],
      ["validate-documentation", "finalize", "Independent documentation review"],
      ["repair-documentation", "finalize", "Repair documentation"],
      ["validate-feature-wide", "finalize", "Feature validation"],
      ["repair-feature-validation", "finalize", "Repair feature validation"],
      ["wait-for-feature-state-change", "finalize", "Feature blocker"],
      ["review-final-semantics", "finalize", "Independent final review"],
      ["repair-final-semantics", "finalize", "Repair final evidence"],
      ["validate-requirements-coverage", "finalize", "Requirements coverage"],
      ["revise-plan-for-coverage", "plan", "Coverage replan · r3"],
      ["report-and-accept-feature", "finalize", "Final result review"],
      ["revise-plan-after-feedback", "plan", "Feedback replan · r3"],
      ["finalize-feature", "finalize", "Finalize repository"],
      ["create-final-report", "finalize", "Create final report"],
      ["repair-finalization-repository", "finalize", "Repair finalization"],
      ["repair-user-feedback", "implement", "2/5 i4 · Feedback fix"],
    ] as const;
    expect(cases.map(([nodeId]) => nodeId).sort()).toEqual(
      workflow.nodes
        .filter((node) => node.progressActiveLabel)
        .map((node) => node.id)
        .sort(),
    );
    for (const [primaryNodeId, activeNodeId, activeLabel] of cases) {
      const projected = projectionAt(primaryNodeId);
      expect(projected?.activeNodeId).toBe(activeNodeId);
      expect(projected?.title).toBe("Software Development · plan r3");
      expect(projected?.goal).toContain("one complete repository change");
      expect(projected?.facts).toEqual([{ label: "Plan", value: "r3", tone: "neutral" }]);
      expect(projected?.nodes.find((node) => node.id === activeNodeId)?.label).toBe(activeLabel);
      expect(
        projected?.nodes.find((node) => node.id === activeNodeId)?.content.outcome,
      ).toBeTruthy();
      expect(
        projected?.nodes.filter((node) => node.id !== activeNodeId).map((node) => node.label),
      ).toEqual(
        workflow
          .progress!.nodes.filter((node) => node.id !== activeNodeId)
          .map((node) => node.label),
      );
      expect(projected?.nodes.find((node) => node.id === activeNodeId)?.focusNodeId).toBe(
        primaryNodeId,
      );
    }

    expect(
      projectionAt("checkpoint-plan-unit")?.nodes.find((node) => node.id === "checkpoint")
        ?.connections,
    ).toEqual({ default: "implement" });
    expect(projectionAt("reconcile-documentation")?.nodes.at(-1)?.state).toBe("current");
    const nextUnit = projectionAt("validate-cheap", "running", {
      current_step_index: 3,
      current_iteration: 1,
    });
    expect(nextUnit?.nodes.find((node) => node.id === "tests")?.label).toBe("3/5 i1 · Checks");
    expect(nextUnit?.nodes.find((node) => node.id === "implement")?.label).toBe("Implement");
    expect(nextUnit?.nodes.find((node) => node.id === "review")?.content.outcome).toBeNull();
    expect(
      projectionAt("prepare-plan-unit-implementation")?.nodes.find((node) => node.id === "plan")
        ?.content.outcome,
    ).toContain("5 executable units");

    expect(projectionAt(null, "completed", {}, null)?.nodes.map((node) => node.state)).toEqual(
      Array(7).fill("completed"),
    );
    expect(
      projectionAt(null, "completed", {}, "create-final-report")?.nodes.map((node) => node.state),
    ).toEqual(Array(7).fill("completed"));
    expect(
      projectionAt(null, "completed", {}, "review-architecture")?.nodes.map((node) => node.state),
    ).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "pending",
      "pending",
    ]);
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
    expect(closure.directive).toContain(
      "Exactly one applicable source must state the current `replan` disposition",
    );
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
          "activate-reviewed-plan": { ...activatedPlan, total_steps: 2 },
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
          "route-unit-html-report",
          "route-unit-approval-required",
          "notify-unit-approval",
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
