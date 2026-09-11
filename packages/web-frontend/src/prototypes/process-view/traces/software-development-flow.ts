/**
 * Example runs of the Software Development Flow, simulated on the real annotated graph. Scripts
 * only say what the agent steps returned; every condition is evaluated by the workflow's own rule.
 */
import type { TraceScript } from "../trace";

const WS = "./moira-ws/sdf-demo";

const intake = (mode: "autonomous" | "interactive") => ({
  outputs: {
    workspace_path: WS,
    operating_mode: mode,
    visual_validation_preference: "disabled",
    progress_intake_outcome: `Task captured; ${mode} mode`,
  },
});

const cleanUnitSteps = {
  "prepare-plan-unit-implementation": () => ({
    outputs: { preparation_outcome: "ready", visual_mode: "disabled", approval_required: false },
  }),
  "implement-plan-unit": (i: number) => ({
    outputs: { progress_implementation_outcome: `unit implemented (pass ${i + 1})` },
  }),
  "complete-plan-unit": () => ({ outputs: { completion_outcome: "ready" } }),
  "validate-cheap": () => ({
    outputs: { issues_count: 0, progress_tests_outcome: "cheap checks pass" },
  }),
  "review-test-adequacy": () => ({ outputs: { review_outcome: "pass" } }),
  "review-architecture": () => ({ outputs: { review_outcome: "pass" } }),
  "validate-runtime": () => ({ outputs: { validation_outcome: "pass" } }),
  "validate-expensive": () => ({ outputs: { validation_outcome: "pass" } }),
  "update-unit-documentation": () => ({ outputs: { documentation_outcome: "ready" } }),
  "review-unit-completeness": () => ({
    outputs: { review_outcome: "pass", progress_review_outcome: "completeness review clean" },
  }),
  "checkpoint-plan-unit": () => ({ outputs: { progress_checkpoint_outcome: "unit checkpointed" } }),
};

const finishSteps = {
  "validate-feature-wide": () => ({ outputs: { validation_outcome: "pass" } }),
  "review-final-semantics": () => ({
    outputs: { review_outcome: "pass", gaps_count: 0, review_file: `${WS}/final-review.md` },
  }),
  "create-final-report": () => ({ outputs: { progress_finalize_outcome: "final report written" } }),
  "finalize-feature": () => ({ outputs: { finalization_outcome: "pass" } }),
};

export const SDF_TRACES: TraceScript[] = [
  {
    id: "clean",
    title: "Autonomous run, two units, everything clean, completed",
    description:
      "Requirements taken as given, health baseline fine, plan reviewed clean and activated without a gate, two units implemented and validated, no commits authorized, finished.",
    initial: {
      plan_revision: 1,
      current_step_index: 1,
      total_steps: 1,
      current_iteration: 1,
      previous_iteration: 0,
      product_review_iteration: 0,
      previous_plan_revision: 1,
      vcs_commits_authorized: false,
      operating_mode: "autonomous",
    },
    steps: {
      "capture-task-and-context": () => intake("autonomous"),
      "assess-project-health": () => ({ outputs: { health_outcome: "pass" } }),
      "create-plan": () => ({ outputs: { progress_plan_outcome: "plan r1: 2 units" } }),
      "review-plan": () => ({ outputs: { review_outcome: "pass" } }),
      "activate-reviewed-plan": () => ({
        outputs: { current_step_index: 1, total_steps: 2, vcs_commits_authorized: false },
      }),
      ...cleanUnitSteps,
      ...finishSteps,
    },
  },
  {
    id: "loops",
    title:
      "Interactive run with a repaired plan, gate-local repairs, a replan, now waiting on the user",
    description:
      "The plan review asked for a repair; the user approved plan 2. Unit 1 failed cheap validation once and its test-adequacy review found the plan wrong, so the run replanned and came back. Unit 2 is now waiting for the user's verdict.",
    initial: {
      plan_revision: 1,
      current_step_index: 1,
      total_steps: 1,
      current_iteration: 1,
      previous_iteration: 0,
      product_review_iteration: 0,
      previous_plan_revision: 1,
      vcs_commits_authorized: true,
      operating_mode: "interactive",
    },
    steps: {
      "capture-task-and-context": () => intake("interactive"),
      "confirm-requirements": () => ({
        waited: true,
        outputs: { requirements_approval: "yes", user_feedback: "" },
      }),
      "assess-project-health": () => ({ outputs: { health_outcome: "pass" } }),
      "create-plan": () => ({ outputs: { progress_plan_outcome: "plan r1: 2 units" } }),
      "review-plan": (i) => ({
        outputs: {
          review_outcome: i === 0 ? "repair" : "pass",
          progress_plan_outcome:
            i === 0 ? "review: repair requested" : `review clean (pass ${i + 1})`,
        },
      }),
      "repair-plan": () => ({ outputs: { repair_outcome: "changed" } }),
      "approve-plan": (i) => ({
        waited: true,
        outputs: { plan_approval: "yes", user_feedback: "" },
        note: i === 0 ? "user approved plan 2" : "user approved the revised plan",
      }),
      "activate-reviewed-plan": () => ({
        outputs: { current_step_index: 1, total_steps: 2, vcs_commits_authorized: true },
      }),
      "revise-plan-for-replan": () => ({
        outputs: { progress_plan_outcome: "plan revised after unit 1 exposed a plan defect" },
      }),
      "approve-current-unit-closure": () => ({
        waited: true,
        outputs: { closure_decision: "approved" },
        note: "user approved closing unit 1 early",
      }),
      ...cleanUnitSteps,
      "prepare-plan-unit-implementation": () => ({
        outputs: { preparation_outcome: "ready", visual_mode: "disabled", approval_required: true },
      }),
      "validate-cheap": (i) => ({
        outputs: {
          issues_count: i === 0 ? 2 : 0,
          progress_tests_outcome: i === 0 ? "2 lint failures" : "cheap checks pass",
        },
      }),
      "repair-cheap-validation": () => ({
        outputs: { repair_outcome: "changed", mutation_scope: "verification_only" },
      }),
      "review-test-adequacy": (i) => ({
        outputs: { review_outcome: i === 1 ? "replan" : "pass" },
      }),
      "review-plan-unit-with-user": (i) =>
        i === 0
          ? { waited: true, outputs: { acceptance_decision: "accepted", user_feedback: "" } }
          : { waited: true, note: "awaiting the user's verdict on unit 2" },
    },
  },
  {
    id: "stopped",
    title: "Run stopped at the health baseline: external blocker never cleared",
    description:
      "The baseline check hit an external blocker; the run waited, the user chose to abort, and the workflow stopped before any plan existed.",
    initial: {
      plan_revision: 1,
      current_step_index: 1,
      total_steps: 1,
      current_iteration: 1,
      previous_iteration: 0,
      product_review_iteration: 0,
      previous_plan_revision: 1,
      vcs_commits_authorized: false,
      operating_mode: "autonomous",
    },
    steps: {
      "capture-task-and-context": () => intake("autonomous"),
      "assess-project-health": () => ({
        outputs: {
          health_outcome: "external_blocker",
          progress_intake_outcome: "CI runner offline",
        },
      }),
      "wait-for-health-state-change": () => ({
        waited: true,
        outputs: { blocker_decision: "abort" },
        note: "user chose to abort",
      }),
    },
  },
];
