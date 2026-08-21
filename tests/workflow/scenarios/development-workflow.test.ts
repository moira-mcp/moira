/**
 * Observable scenarios for the filesystem-first Software Development Flow v12.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { findSystemCatalogEntry } from "@mcp-moira/shared";
import {
  GraphTemplateProcessor,
  GraphValidator,
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
    "review-plan": { issues_count: 0 },
    "repair-plan": {},
    "approve-plan": {
      plan_approval: "yes",
      current_step_index: 1,
      total_steps: 1,
      vcs_commits_authorized: false,
    },
    "revise-plan-after-rejection": {},
    "implement-plan-unit": {},
    "validate-cheap": { issues_count: 0 },
    "repair-cheap-validation": {},
    "review-test-adequacy": { issues_count: 0 },
    "repair-test-adequacy": { repair_reach: "spreading" },
    "review-architecture": { issues_count: 0, requires_replan: false },
    "review-unit-completeness": { issues_count: 0 },
    "repair-unit-completeness": { repair_reach: "spreading" },
    "repair-architecture": { repair_reach: "spreading" },
    "approve-current-unit-closure": { closure_decision: "approved" },
    "revise-plan-for-replan": {},
    "validate-runtime": { validation_outcome: "not_applicable" },
    "repair-runtime": {},
    "wait-for-runtime-state-change": { blocker_decision: "retry" },
    "validate-expensive": { validation_outcome: "not_applicable" },
    "repair-expensive": {},
    "wait-for-expensive-state-change": { blocker_decision: "retry" },
    "review-plan-unit-with-user": { acceptance_decision: "accepted" },
    "checkpoint-plan-unit": { checkpoint_outcome: "pass" },
    "repair-user-feedback": { resolution: "in_plan" },
    "reconcile-documentation": { change_scope: "not_applicable" },
    "validate-documentation": { issues_count: 0 },
    "repair-documentation": { repair_reach: "contained" },
    "validate-feature-wide": { validation_outcome: "not_applicable" },
    "repair-feature-validation": { repair_reach: "spreading" },
    "wait-for-feature-state-change": { blocker_decision: "retry" },
    "review-final-semantics": { issues_count: 0 },
    "repair-final-semantics": { repair_reach: "spreading" },
    "validate-requirements-coverage": { gaps_count: 0 },
    "revise-plan-for-coverage": {},
    "finalize-feature": { finalization_outcome: "pass" },
    "repair-finalization-repository": { repair_reach: "spreading" },
    "repair-checkpoint-repository": { repair_reach: "spreading" },
    "resolve-finalization-blocker": { blocker_decision: "retry" },
    "report-and-accept-feature": { feature_decision: "accepted" },
    "revise-plan-after-feedback": {},
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
      "review-unit-completeness": [{ issues_count: 1 }, { issues_count: 0 }, { issues_count: 0 }],
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
      "revise-plan-for-replan": {},
    },
    ["teleport-replan", "revise-plan-for-replan", "review-plan", "implement-plan-unit", "end"],
    [],
    { teleportAfter: { afterNode: "implement-plan-unit", teleportTo: "teleport-replan" } },
  ),
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
      "repair-cheap-validation": {},
      "review-test-adequacy": [{ issues_count: 1 }, { issues_count: 0 }, { issues_count: 0 }],
      "repair-test-adequacy": { repair_reach: "spreading" },
      "review-architecture": [
        { issues_count: 1, requires_replan: false },
        { issues_count: 0, requires_replan: false },
      ],
      "repair-architecture": { repair_reach: "spreading" },
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
      "review-test-adequacy": [{ issues_count: 1 }, { issues_count: 0 }, { issues_count: 0 }],
      "repair-test-adequacy": { repair_reach: "contained" },
    },
    ["repair-test-adequacy", "route-test-adequacy-reach", "review-test-adequacy", "end"],
  ),
  flow(
    "a contained architecture repair goes back to the architecture gate",
    {
      "review-architecture": [
        { issues_count: 1, requires_replan: false },
        { issues_count: 0, requires_replan: false },
      ],
      "repair-architecture": { repair_reach: "contained" },
    },
    ["repair-architecture", "route-architecture-reach", "review-architecture", "end"],
  ),
  flow(
    "a contained completeness repair goes back to the same reviewer",
    {
      "review-unit-completeness": [{ issues_count: 1 }, { issues_count: 0 }, { issues_count: 0 }],
      "repair-unit-completeness": { repair_reach: "contained" },
    },
    [
      "repair-unit-completeness",
      "route-unit-completeness-reach",
      "mark-current-evidence-iteration",
      "review-unit-completeness",
      "end",
    ],
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
      "repair-runtime": {},
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
      "repair-expensive": {},
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
      "validate-documentation": [{ issues_count: 1 }, { issues_count: 0 }],
    },
    ["validate-documentation", "repair-documentation", "validate-feature-wide", "end"],
  ),
  flow(
    "a documentation repair that reached executable artifacts returns through the code gates",
    {
      "reconcile-documentation": [
        { change_scope: "documentation_affected" },
        { change_scope: "not_applicable" },
      ],
      "validate-documentation": [{ issues_count: 1 }, { issues_count: 0 }],
      "repair-documentation": { repair_reach: "spreading" },
    },
    [
      "repair-documentation",
      "route-documentation-reach",
      "record-executable-documentation-change",
      "advance-evidence-iteration",
      "validate-cheap",
      "end",
    ],
  ),
  flow(
    "executable documentation returns through code and semantic gates",
    {
      "reconcile-documentation": [
        { change_scope: "executable" },
        { change_scope: "not_applicable" },
      ],
    },
    [
      "route-executable-documentation",
      "record-executable-documentation-change",
      "validate-cheap",
      "review-architecture",
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
      "review-final-semantics": [{ issues_count: 1 }, { issues_count: 0 }],
      "repair-feature-validation": { repair_reach: "spreading" },
      "repair-final-semantics": { repair_reach: "spreading" },
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
      "repair-checkpoint-repository": { repair_reach: "spreading" },
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
      "repair-checkpoint-repository": { repair_reach: "contained" },
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
      "repair-finalization-repository": { repair_reach: "contained" },
    },
    [
      "repair-finalization-repository",
      "route-finalization-repair-reach",
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
      "review-final-semantics": [{ issues_count: 1 }, { issues_count: 0 }],
      "repair-feature-validation": { repair_reach: "contained" },
      "repair-final-semantics": { repair_reach: "contained" },
    },
    [
      "route-feature-validation-reach",
      "validate-feature-wide",
      "route-final-semantics-reach",
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
    expect(workflow.metadata.version).toBe("12.10.3");
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
    ]);
    expect(workflow.variableRegistry?.operating_mode?.enum).toEqual(["autonomous", "interactive"]);

    // The standards are a document the run consults: the workspace owner renders them once and
    // writes them down, and every other reader — including a delegated reviewer — is given the path.
    const standardsVars = [
      "planning_standards",
      "engineering_standards",
      "test_standards",
      "documentation_standards",
      "review_standards",
    ];
    for (const name of standardsVars) {
      expect(String(workflow.variableRegistry?.[name]?.default ?? "")).toContain("*Why.*");
      const rendering = workflow.nodes.filter((node) =>
        JSON.stringify(node).includes(`{{${name}}}`),
      );
      expect(rendering.map((node) => node.id)).toEqual(["capture-task-and-context"]);
    }
    const owner = workflow.nodes.find((node) => node.id === "capture-task-and-context");
    expect(owner?.directive).toContain("./moira-ws/software-development-flow-{task-name}");
    for (const file of [
      "planning.md",
      "engineering.md",
      "tests.md",
      "documentation.md",
      "review.md",
    ]) {
      expect(owner?.directive).toContain(file);
    }

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
    ).toContain("tests are not a substitute for them");

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
      expect(gate.directive).toContain("{{workspace_path}}/step-{{current_step_index}}");
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
    ]) {
      expect(serialized).not.toContain(removed);
    }
  });

  test("every per-unit gate judges the unit against a baseline the run actually writes", () => {
    // The baseline is a line in the unit's first iteration report, and both entries into a unit set
    // current_iteration to 1, so the path the gates name always exists.
    const BASELINE = "{{workspace_path}}/step-{{current_step_index}}/unit-report.md";
    for (const id of [
      "validate-cheap",
      "review-test-adequacy",
      "review-architecture",
      "validate-runtime",
      "validate-expensive",
      "review-unit-completeness",
    ]) {
      const gate = workflow.nodes.find((node) => node.id === id) as { directive: string };
      expect(gate.directive).toContain(BASELINE);
    }
    const writer = workflow.nodes.find((node) => node.id === "implement-plan-unit") as {
      directive: string;
    };
    expect(writer.directive).toContain("Open it with the unit's baseline in one line");
    for (const id of ["initialize-implementation-iteration", "advance-plan-unit"]) {
      const node = workflow.nodes.find((item) => item.id === id) as { expressions: string[] };
      expect(node.expressions).toContain("current_iteration = 1");
    }

    // The engine owns the round counter: three expression nodes write it and no agent answers with
    // it, so a repair cannot report a number that disagrees with the directory it wrote.
    const writers = workflow.nodes.filter(
      (item) =>
        item.type === "expression" &&
        (item as { expressions: string[] }).expressions.some((expression) =>
          expression.startsWith("current_iteration ="),
        ),
    );
    expect(writers.map((item) => item.id)).toEqual([
      "initialize-implementation-iteration",
      "advance-plan-unit",
      "advance-evidence-iteration",
    ]);
    expect(
      (
        workflow.nodes.find((item) => item.id === "advance-evidence-iteration") as {
          expressions: string[];
        }
      ).expressions,
    ).toEqual([
      "previous_iteration = current_iteration",
      "current_iteration = current_iteration + 1",
    ]);
    for (const node of workflow.nodes) {
      expect(JSON.stringify(node.inputSchema ?? {})).not.toContain("current_iteration");
    }

    // Every repair that changes the repository names the round record it writes, with a path that
    // renders from values living on its own turn.
    const REPAIR_RECORD =
      "{{workspace_path}}/step-{{current_step_index}}/iteration-{{current_iteration}}/repair.md";
    const repairOwners = workflow.nodes.filter(
      (item) =>
        item.id.startsWith("repair-") &&
        item.id !== "repair-plan" &&
        item.id !== "repair-documentation",
    );
    expect(repairOwners.length).toBeGreaterThan(0);
    for (const owner of repairOwners) {
      expect((owner as { directive: string }).directive).toContain(REPAIR_RECORD);
    }
    const executableDocumentationOwner = workflow.nodes.find(
      (item) => item.id === "record-executable-documentation-change",
    ) as { directive: string; connections: Record<string, string> };
    expect(executableDocumentationOwner.directive).toContain(REPAIR_RECORD);
    expect(executableDocumentationOwner.connections).toEqual({
      success: "advance-evidence-iteration",
    });

    // The rules the gates lean on live once, in the standard the workspace owner writes down.
    const standard = String(workflow.variableRegistry?.review_standards?.default ?? "");
    expect(standard).toContain("not the round's increment");
    expect(standard).toContain("stated once and reused");
    expect(standard).toContain("Each round is judged on its own");
    expect(standard).toContain("could have touched");
  });

  test("the reach of a repair is stated by the repairer and routes without a default", () => {
    for (const [repair, containedTarget, spreadingTarget] of [
      ["repair-test-adequacy", "review-test-adequacy", "advance-evidence-iteration"],
      ["repair-architecture", "review-architecture", "advance-evidence-iteration"],
      ["repair-unit-completeness", "mark-current-evidence-iteration", "advance-evidence-iteration"],
      ["repair-documentation", "validate-documentation", "record-executable-documentation-change"],
      ["repair-feature-validation", "validate-feature-wide", "advance-evidence-iteration"],
      ["repair-final-semantics", "review-final-semantics", "advance-evidence-iteration"],
      ["repair-finalization-repository", "finalize-feature", "advance-evidence-iteration"],
      ["repair-checkpoint-repository", "checkpoint-plan-unit", "advance-evidence-iteration"],
    ]) {
      const owner = workflow.nodes.find((node) => node.id === repair) as {
        directive: string;
        inputSchema: { properties: Record<string, { enum?: string[] }>; required: string[] };
        connections: Record<string, string>;
      };
      expect(owner.inputSchema.properties.repair_reach?.enum).toEqual(["contained", "spreading"]);
      expect(owner.inputSchema.required).toContain("repair_reach");
      expect(owner.directive).toContain("state its reach as repair_reach");

      const route = workflow.nodes.find(
        (node) => node.id === owner.connections.success,
      ) as (typeof workflow.nodes)[number] & { connections: Record<string, string> };
      expect(route.type).toBe("condition");
      // Contained returns to the gate that raised the finding and stays inside its round; anything
      // else opens the next round and takes the full chain.
      expect(route.connections).toEqual({ true: containedTarget, false: spreadingTarget });
    }

    // No reviewer classifies reach: the repairer describes what it actually changed, after the fact.
    for (const id of [
      "review-test-adequacy",
      "review-architecture",
      "review-unit-completeness",
      "validate-documentation",
      "review-final-semantics",
      "validate-feature-wide",
    ]) {
      expect(JSON.stringify(workflow.nodes.find((node) => node.id === id))).not.toContain(
        "repair_reach",
      );
    }

    // Each gate says what its own `contained` protects, so a broad gate cannot accept an
    // unfalsifiable answer: the short route would then become the default one.
    const insideOfItsOwnGate: Array<[string, string]> = [
      ["repair-feature-validation", "no change to what a test asserts"],
      ["repair-final-semantics", "the intent of every test exactly as they were"],
      ["repair-finalization-repository", "the commit scope, the pre-commit and hook machinery"],
      ["repair-checkpoint-repository", "left the verified content of the unit as it was"],
    ];
    for (const [id, phrase] of insideOfItsOwnGate) {
      expect(
        (workflow.nodes.find((node) => node.id === id) as { directive: string }).directive,
      ).toContain(phrase);
    }

    // Each of the two VCS repair owners reads one report and answers to one gate, so neither needs a
    // protocol for choosing between two sources.
    expect(JSON.stringify(workflow.nodes)).not.toContain("Exactly one source must match");
  });

  test("a finding is about the delivered work and the run's own records are corrected in place", () => {
    const standard = String(workflow.variableRegistry?.review_standards?.default ?? "");
    expect(standard).toContain(
      "A finding is about the delivered work, not about the run's bookkeeping",
    );
    // The rule is a decidable question, not a list of directories.
    expect(standard).toContain("whether editing the record alone makes its statement true");
    // A record claiming work that was never done stays a finding: the bar does not move.
    expect(standard).toContain("hides work that was never done");
    // The reviewer's own boundary keeps it independent of what it judges.
    expect(standard).toContain("corrects records and never touches the repository");
    // The rule that forbids a reviewer to repair now points at its single exception instead of
    // contradicting it.
    expect(standard).toContain("The reviewer diagnoses the work");

    const delegation = workflow.nodes.find((node) => node.id === "review-unit-completeness") as {
      directive: string;
    };
    expect(delegation.directive).toContain("The reviewer repairs nothing in the repository either");
    expect(delegation.directive).toContain("instead of counting it as a finding");
  });

  test("review stays on its subject while repair closes the defect class within task scope", () => {
    const review = workflow.nodes.find((node) => node.id === "review-unit-completeness") as {
      directive: string;
      completionCondition: string;
    };
    const repair = workflow.nodes.find((node) => node.id === "repair-unit-completeness") as {
      directive: string;
      completionCondition: string;
    };

    // The independent reviewer judges the current unit and uses the rest of the system only as
    // contract context; finding one problem does not turn the review into a product-wide audit.
    expect(review.directive).toContain("Scope the review strictly to this approved unit");
    expect(review.directive).toContain("they are not additional review subjects");
    expect(review.directive).toContain("Do not turn that diagnosis into a review of other plan units");
    expect(review.completionCondition).toContain("covers only the current unit");

    // Repair is observably class-wide rather than a point fix: it inventories all occurrences and
    // requires evidence capable of distinguishing those two states.
    expect(repair.directive).toContain("Before changing files, treat every finding as a possible defect class");
    expect(repair.directive).toContain("every materially analogous occurrence within the original task scope");
    expect(repair.directive).toContain("Repair every confirmed in-scope occurrence consistently");
    expect(repair.directive).toContain("closure of the whole class from repair of one occurrence");
    expect(repair.completionCondition).toContain("class-wide regression evidence");

    // Scope and planning are separate decisions: nobody silently widens the task, but evidence that
    // the approved plan cannot meet an original requirement still requires replanning.
    expect(review.directive).toContain("the scope boundary does not protect a bad plan");
    expect(repair.directive).toContain("staying within scope does not mean preserving a bad plan");
    expect(repair.directive).toContain("beyond the original task boundary");
  });

  test("semantic reviewers use current mechanical evidence and keep explicit scope boundaries", () => {
    const reviewerIds = [
      "review-plan",
      "review-test-adequacy",
      "review-architecture",
      "review-unit-completeness",
      "validate-documentation",
      "review-final-semantics",
    ];
    for (const id of reviewerIds) {
      const node = workflow.nodes.find((candidate) => candidate.id === id) as {
        directive: string;
      };
      expect(node.directive).toMatch(/Do not run linters, type checks, test suites, builds/);
      expect(node.directive).toContain("original task");
    }

    const planReview = workflow.nodes.find((node) => node.id === "review-plan") as {
      directive: string;
    };
    expect(planReview.directive).toContain("This boundary does not protect an inadequate plan");
    expect(planReview.directive).toContain("require the plan to change within the original task");

    const architectureReview = workflow.nodes.find((node) => node.id === "review-architecture") as {
      directive: string;
    };
    expect(architectureReview.directive).toContain("Set requires_replan when evidence shows");
    expect(architectureReview.directive).toContain("route back to planning");
    expect(architectureReview.directive).toContain("explicitly for the user");
  });

  test("documentation is reconciled again only when its subject moved", () => {
    const reconcile = workflow.nodes.find((node) => node.id === "reconcile-documentation") as {
      directive: string;
      completionCondition: string;
      inputSchema: { properties: { change_scope: { enum: string[] } } };
    };
    // No new value that would route where an existing one already routes.
    expect(reconcile.inputSchema.properties.change_scope.enum).toEqual([
      "not_applicable",
      "documentation_affected",
      "executable",
    ]);
    // The subject is documentation together with the behaviour it describes: a re-entry always
    // follows a repository change, so a signal watching the documents alone would skip the gate.
    expect(reconcile.directive).toContain(
      "the repository behavior that documentation describes, is in a state no current independent review covers",
    );
    expect(reconcile.directive).toContain(
      "neither the documentation nor the repository behavior it describes has changed since that review",
    );
    expect(reconcile.directive).toContain("never from memory of an earlier pass");
    expect(reconcile.completionCondition).toContain("names which of its two reasons holds");
  });

  test("the unit's account has one address and every owner that changes the unit keeps it current", () => {
    const ACCOUNT = "{{workspace_path}}/step-{{current_step_index}}/unit-report.md";
    const writer = workflow.nodes.find((node) => node.id === "implement-plan-unit") as {
      directive: string;
    };
    expect(writer.directive).toContain(`Write the unit's account to ${ACCOUNT}`);

    // The account is the unit's, not the first round's: nothing addresses a per-round implementation
    // report any more, so no reader can be handed a description frozen at iteration 1.
    expect(JSON.stringify(workflow.nodes)).not.toContain("implementation.md");

    // Whoever last changed the unit owns the account, and says so in the same turn it records its
    // round — the round record itself stays where it was.
    const unitRepairs = workflow.nodes.filter(
      (item) =>
        item.id.startsWith("repair-") &&
        item.id !== "repair-plan" &&
        item.id !== "repair-documentation",
    );
    expect(unitRepairs).toHaveLength(11);
    for (const owner of unitRepairs) {
      expect((owner as { directive: string }).directive).toContain(
        `bring the unit's account at ${ACCOUNT}`,
      );
    }
    const executableDocumentationOwner = workflow.nodes.find(
      (item) => item.id === "record-executable-documentation-change",
    ) as { directive: string };
    expect(executableDocumentationOwner.directive).toContain(`durable unit account at ${ACCOUNT}`);

    // What a report may assert lives once, in the standard every owner and reviewer is handed.
    const standard = String(workflow.variableRegistry?.review_standards?.default ?? "");
    expect(standard).toContain(
      "A report states what the work delivers, not how much of it there was",
    );
    expect(standard).toContain("files touched, lines added or removed, share of comment");
    expect(standard).toContain(
      "The account of the work is kept current by whoever last changed the work",
    );
  });

  test("the engine advances the plan revision and the directives name both revision paths", async () => {
    // No responsibility answers with a number the registry already owns.
    for (const node of workflow.nodes) {
      expect((node.inputSchema as { globalInputs?: string[] })?.globalInputs ?? []).not.toContain(
        "plan_revision",
      );
    }

    const advancers = workflow.nodes.filter(
      (item) =>
        item.type === "expression" &&
        JSON.stringify((item as { expressions: string[] }).expressions).includes(
          "plan_revision = plan_revision + 1",
        ),
    );
    expect(advancers.map((item) => item.id)).toEqual([
      "advance-plan-revision-after-rejection",
      "advance-plan-revision-for-replan",
      "advance-plan-revision-for-coverage",
      "advance-plan-revision-after-feedback",
    ]);
    for (const advancer of advancers) {
      // The previous number survives the increment, so the revision owner can name its source.
      expect((advancer as { expressions: string[] }).expressions[0]).toBe(
        "previous_plan_revision = plan_revision",
      );
      const owner = workflow.nodes.find(
        (node) =>
          node.id === (advancer as { connections: Record<string, string> }).connections.default,
      ) as { directive: string };
      expect(owner.directive).toContain("{{workspace_path}}/plans/{{plan_revision}}/plan.md");
      expect(owner.directive).toContain(
        "{{workspace_path}}/plans/{{previous_plan_revision}}/plan.md",
      );
    }

    // Behavioural: a rejected plan reaches revision 2 without any agent reporting the number.
    const result = await runScenario(workflow, {
      name: "plan rejection advances the revision",
      mockInputs: {
        ...ordinaryInputs(),
        "approve-plan": [
          { plan_approval: "no", user_feedback: "Split the unit" },
          {
            plan_approval: "yes",
            current_step_index: 1,
            total_steps: 1,
            vcs_commits_authorized: false,
          },
        ],
      },
      expect: { status: "completed", maxSteps: 220 },
    });
    expect(result.passed).toBe(true);
    expect(result.finalContext.plan_revision).toBe(2);
    expect(result.finalContext.previous_plan_revision).toBe(1);
  });

  test("the engine advances the round on every re-entry into the chain", async () => {
    // Two repository repairs, so the unit reaches its third round. The counter is observed in the
    // final context rather than read off a directive: a flow that left the arithmetic to the agent
    // would end this run on iteration 1.
    const result = await runScenario(workflow, {
      name: "two cheap repairs reach the third round",
      mockInputs: {
        ...ordinaryInputs(),
        "validate-cheap": [
          { issues_count: 1 },
          { issues_count: 1 },
          { issues_count: 0 },
          { issues_count: 0 },
        ],
      },
      expect: { status: "completed", maxSteps: 220 },
    });
    expect(result.passed).toBe(true);
    expect(result.finalContext.current_iteration).toBe(3);
    const distinct = result.visitedNodes.filter((id, index, all) => id !== all[index - 1]);
    expect(distinct.filter((id) => id === "advance-evidence-iteration")).toHaveLength(2);
  });

  test("a contained completeness repair in a later round hands that exact repair record back", async () => {
    const result = await runScenario(workflow, {
      name: "later-round contained completeness repair",
      mockInputs: {
        ...ordinaryInputs(),
        "validate-cheap": [{ issues_count: 1 }, { issues_count: 0 }, { issues_count: 0 }],
        "review-unit-completeness": [{ issues_count: 1 }, { issues_count: 0 }, { issues_count: 0 }],
        "repair-unit-completeness": { repair_reach: "contained" },
      },
      expect: { status: "completed", maxSteps: 220 },
    });
    expect(result.passed).toBe(true);
    expect(result.finalContext.current_iteration).toBe(2);
    expect(result.finalContext.previous_iteration).toBe(2);

    const distinct = result.visitedNodes.filter((id, index, all) => id !== all[index - 1]);
    const repairAt = distinct.indexOf("repair-unit-completeness");
    expect(distinct.slice(repairAt, repairAt + 4)).toEqual([
      "repair-unit-completeness",
      "route-unit-completeness-reach",
      "mark-current-evidence-iteration",
      "review-unit-completeness",
    ]);

    const review = workflow.nodes.find((node) => node.id === "review-unit-completeness") as {
      directive: string;
    };
    const rendered = new GraphTemplateProcessor().processDirective(review.directive, {
      variables: result.finalContext,
      nodeStates: {},
      executionId: "later-round-contained-review",
      workflowId: workflow.id,
      userId: "workflow-test-user",
    });
    expect(rendered).toContain("./moira-ws/example/step-1/iteration-2/repair.md");
    expect(rendered).not.toContain("./moira-ws/example/step-1/iteration-1/repair.md");
  });

  test("both executable documentation paths record the closed round before code gates", async () => {
    const route = (visitedNodes: string[]): string[] =>
      visitedNodes.filter((id, index, all) => id !== all[index - 1]);
    const executable = await runScenario(workflow, {
      name: "initial executable documentation record",
      mockInputs: {
        ...ordinaryInputs(),
        "reconcile-documentation": [
          { change_scope: "executable" },
          { change_scope: "not_applicable" },
        ],
      },
      expect: { status: "completed", maxSteps: 220 },
    });
    expect(executable.passed).toBe(true);
    expect(executable.finalContext).toMatchObject({ current_iteration: 2, previous_iteration: 1 });
    const executableRoute = route(executable.visitedNodes);
    const executableRouteAt = executableRoute.indexOf("route-executable-documentation");
    expect(executableRoute.slice(executableRouteAt, executableRouteAt + 4)).toEqual([
      "route-executable-documentation",
      "record-executable-documentation-change",
      "advance-evidence-iteration",
      "validate-cheap",
    ]);

    const spreadingRepair = await runScenario(workflow, {
      name: "spreading documentation repair record",
      mockInputs: {
        ...ordinaryInputs(),
        "reconcile-documentation": [
          { change_scope: "documentation_affected" },
          { change_scope: "not_applicable" },
        ],
        "validate-documentation": [{ issues_count: 1 }, { issues_count: 0 }],
        "repair-documentation": { repair_reach: "spreading" },
      },
      expect: { status: "completed", maxSteps: 220 },
    });
    expect(spreadingRepair.passed).toBe(true);
    expect(spreadingRepair.finalContext).toMatchObject({
      current_iteration: 2,
      previous_iteration: 1,
    });
    const spreadingRoute = route(spreadingRepair.visitedNodes);
    const spreadingRouteAt = spreadingRoute.indexOf("repair-documentation");
    expect(spreadingRoute.slice(spreadingRouteAt, spreadingRouteAt + 5)).toEqual([
      "repair-documentation",
      "route-documentation-reach",
      "record-executable-documentation-change",
      "advance-evidence-iteration",
      "validate-cheap",
    ]);

    const recordOwner = workflow.nodes.find(
      (node) => node.id === "record-executable-documentation-change",
    ) as { directive: string };
    const validateCheap = workflow.nodes.find((node) => node.id === "validate-cheap") as {
      directive: string;
    };
    const processor = new GraphTemplateProcessor();
    const sharedContext = {
      workspace_path: "./moira-ws/example",
      current_step_index: 1,
    };
    const writerDirective = processor.processDirective(recordOwner.directive, {
      variables: { ...sharedContext, current_iteration: 1, previous_iteration: 1 },
      nodeStates: {},
      executionId: "documentation-record-writer",
      workflowId: workflow.id,
      userId: "workflow-test-user",
    });
    const nextGateDirective = processor.processDirective(validateCheap.directive, {
      variables: { ...sharedContext, current_iteration: 2, previous_iteration: 1 },
      nodeStates: {},
      executionId: "documentation-record-reader",
      workflowId: workflow.id,
      userId: "workflow-test-user",
    });
    const exactRepairRecord = "./moira-ws/example/step-1/iteration-1/repair.md";
    const exactUnitAccount = "./moira-ws/example/step-1/unit-report.md";
    expect(writerDirective).toContain(exactRepairRecord);
    expect(writerDirective).toContain(exactUnitAccount);
    expect(writerDirective).toContain("the validation evidence it invalidated");
    expect(nextGateDirective).toContain(exactRepairRecord);
    expect(nextGateDirective).toContain(exactUnitAccount);
  });

  test("a contained repair skips the validation chain a spreading one runs", async () => {
    const contained = await runScenario(workflow, {
      name: "contained test-adequacy repair",
      mockInputs: {
        ...ordinaryInputs(),
        "review-test-adequacy": [{ issues_count: 1 }, { issues_count: 0 }, { issues_count: 0 }],
        "repair-test-adequacy": { repair_reach: "contained" },
      },
      expect: { status: "completed", maxSteps: 220 },
    });
    expect(contained.passed).toBe(true);
    // A paused node is recorded on the pause and again on the resume; the route is the distinct path.
    const route = (result: { visitedNodes: string[] }): string[] =>
      result.visitedNodes.filter((id, index, all) => id !== all[index - 1]);
    const containedRoute = route(contained);
    const repairAt = containedRoute.indexOf("repair-test-adequacy");
    expect(containedRoute.slice(repairAt, repairAt + 3)).toEqual([
      "repair-test-adequacy",
      "route-test-adequacy-reach",
      "review-test-adequacy",
    ]);
    expect(containedRoute.filter((id) => id === "validate-cheap")).toHaveLength(1);

    const spreading = await runScenario(workflow, {
      name: "spreading test-adequacy repair",
      mockInputs: {
        ...ordinaryInputs(),
        "review-test-adequacy": [{ issues_count: 1 }, { issues_count: 0 }, { issues_count: 0 }],
        "repair-test-adequacy": { repair_reach: "spreading" },
      },
      expect: { status: "completed", maxSteps: 220 },
    });
    expect(spreading.passed).toBe(true);
    expect(route(spreading).filter((id) => id === "validate-cheap")).toHaveLength(2);
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
