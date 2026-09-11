import type { ProcessProjection } from "../model";
import { SDF_AUTHORED } from "./authored";

/**
 * Software Development Flow projected coarsely into fifteen blocks — the density stress case.
 * All 130 authored nodes are claimed exactly once. Unit validation deliberately stays one block
 * of 27 nodes: the question the stress case asks is whether a large block remains readable, not
 * whether it can be split further. The run snapshot shows a run paused on user review of a unit.
 */
export const SDF_PROJECTION: ProcessProjection = {
  slug: "software-development-flow",
  title: "Software Development Flow",
  goal: "Implement a repository change through a reviewed plan, per-unit validation gates, independent reviews, and a truthful final report.",
  authored: SDF_AUTHORED,
  blocks: [
    {
      id: "intake",
      name: "Intake",
      description:
        "Capture the task, its authority, and the project context; materialize the development standards; confirm requirements with the user when the run is interactive.",
      nodeIds: [
        "start",
        "capture-task-and-context",
        "materialize-development-standards",
        "route-operating-mode-requirements",
        "confirm-requirements",
        "route-requirements-approval",
        "revise-requirements",
      ],
      transitions: [
        { to: "health", label: "requirements confirmed, or autonomous" },
        {
          to: "intake",
          label: "user revised requirements",
          cycle: {
            cause:
              "The user rejected the requirements as captured, so they are revised and confirmed again.",
            exit: "The user approves, or the run is autonomous.",
          },
        },
      ],
    },
    {
      id: "health",
      name: "Project health",
      description:
        "Run the smallest baseline checks that establish the repository's starting state, so later failures can be attributed to this change rather than inherited.",
      nodeIds: [
        "assess-project-health",
        "route-health-external",
        "wait-for-health-state-change",
        "route-health-retry",
      ],
      transitions: [
        { to: "plan", label: "baseline established" },
        {
          to: "health",
          label: "external blocker cleared",
          cycle: {
            cause:
              "The baseline failed on something outside the repository; the run waited for it to change.",
            exit: "The external state changed and the check is re-run, or the run stops.",
          },
        },
        { to: "stopped", label: "blocker did not clear" },
      ],
    },
    {
      id: "plan",
      name: "Plan and plan review",
      description:
        "Write the outcome-oriented unit plan and have it independently reviewed. Blocking findings send it back for repair; a plan-level defect returns to replanning.",
      nodeIds: [
        "create-plan",
        "review-plan",
        "route-plan-review-replan",
        "route-plan-review",
        "repair-plan",
        "route-plan-repair-outcome",
      ],
      transitions: [
        { to: "plan-approval", label: "review clean" },
        {
          to: "plan",
          label: "review found issues",
          cycle: {
            cause:
              "The independent reviewer recorded blocking findings, so the plan is repaired and reviewed again.",
            exit: "A review with zero blocking findings.",
          },
        },
        { to: "replan", label: "plan itself is wrong" },
      ],
    },
    {
      id: "plan-approval",
      name: "Plan approval and activation",
      description:
        "Interactive runs show the plan to the user and wait; a rejection produces a revised plan that goes back through review. Autonomous runs activate the reviewed plan directly.",
      nodeIds: [
        "route-plan-activation-mode",
        "notify-plan-approval",
        "approve-plan",
        "route-plan-approval",
        "advance-plan-revision-after-rejection",
        "revise-plan-after-rejection",
        "activate-reviewed-plan",
      ],
      transitions: [
        { to: "implement", label: "plan activated" },
        {
          to: "plan",
          label: "user rejected the plan",
          cycle: {
            cause: "The user asked for changes, so a new plan revision is written and reviewed.",
            exit: "The user approves, or the run is autonomous.",
          },
        },
      ],
    },
    {
      id: "implement",
      name: "Implement a unit",
      description:
        "Prepare the current unit against the repository as it stands, implement it, and write its truthful account. Repairs from later gates re-enter here.",
      nodeIds: [
        "initialize-implementation-iteration",
        "prepare-plan-unit-implementation",
        "route-implementation-preparation",
        "implement-plan-unit",
        "complete-plan-unit",
        "route-plan-unit-completion",
        "advance-evidence-iteration",
        "mark-verification-only-iteration",
        "mark-current-evidence-iteration",
      ],
      transitions: [
        { to: "unit-validation", label: "unit implemented" },
        { to: "replan", label: "preparation found the plan invalid" },
      ],
    },
    {
      id: "unit-validation",
      name: "Unit validation gates",
      description:
        "Deterministic checks, test adequacy, architecture review, and runtime validation, each with its own bounded repair loop. Any repair that reaches product behavior invalidates the evidence after it and returns to implementation.",
      nodeIds: [
        "validate-cheap",
        "route-cheap-validation",
        "repair-cheap-validation",
        "route-cheap-repair-replan",
        "route-cheap-repair-scope",
        "review-test-adequacy",
        "route-test-adequacy-replan",
        "route-test-adequacy",
        "repair-test-adequacy",
        "route-test-repair-outcome",
        "route-test-adequacy-reach",
        "route-current-verification-only",
        "review-architecture",
        "route-architecture-replan",
        "route-architecture-review",
        "repair-architecture",
        "route-architecture-repair-outcome",
        "route-architecture-reach",
        "mark-product-review-current",
        "validate-runtime",
        "route-runtime-external",
        "route-runtime-repository",
        "repair-runtime",
        "wait-for-runtime-state-change",
        "route-runtime-retry",
        "route-runtime-repair-replan",
        "route-runtime-repair-scope",
      ],
      transitions: [
        { to: "broad-validation", label: "all gates green" },
        {
          to: "implement",
          label: "product repair",
          cycle: {
            cause:
              "A gate found a defect whose repair reaches product code, so the unit is re-implemented and re-validated.",
            exit: "Every gate passes without a product change.",
          },
        },
        { to: "replan", label: "upstream cause" },
        { to: "stopped", label: "external blocker did not clear" },
      ],
    },
    {
      id: "broad-validation",
      name: "Broad validation and documentation",
      description:
        "Expensive suites, integration and packaging evidence, then permanent documentation updated from the actual diff once behavior has converged.",
      nodeIds: [
        "validate-expensive",
        "route-expensive-external",
        "route-expensive-repository",
        "repair-expensive",
        "wait-for-expensive-state-change",
        "route-expensive-retry",
        "route-expensive-repair-replan",
        "route-expensive-repair-scope",
        "update-unit-documentation",
        "route-unit-documentation-replan",
        "route-unit-documentation-product-repair",
      ],
      transitions: [
        { to: "completeness", label: "evidence and docs current" },
        {
          to: "implement",
          label: "documentation exposed a product defect",
          cycle: {
            cause:
              "Writing the documentation revealed behavior that must change before the docs can be true.",
            exit: "Documentation describes the current behavior truthfully.",
          },
        },
        { to: "replan", label: "upstream cause" },
        { to: "stopped", label: "external blocker did not clear" },
      ],
    },
    {
      id: "completeness",
      name: "Independent completeness review",
      description:
        "A reviewer who did not write the unit judges it against its contract — code, tests, documentation, evidence. Gate-local corrections repair in place; product defects return to implementation.",
      nodeIds: [
        "review-unit-completeness",
        "route-unit-completeness",
        "repair-unit-completeness",
        "route-completeness-review-replan",
        "route-completeness-repair-outcome",
        "route-completeness-repair-gate-local",
        "route-unit-completeness-reach",
      ],
      transitions: [
        { to: "user-review", label: "zero findings" },
        {
          to: "implement",
          label: "product defect found",
          cycle: {
            cause: "The completeness review found a defect that only a product change can resolve.",
            exit: "A completeness review with zero findings.",
          },
        },
        { to: "replan", label: "upstream cause" },
      ],
    },
    {
      id: "user-review",
      name: "Unit review with the user",
      description:
        "Interactive runs produce a step report and wait for the user's verdict on the unit. Feedback either repairs the unit or triggers a replan.",
      nodeIds: [
        "route-unit-html-report",
        "create-and-upload-step-report",
        "notify-report-ready",
        "route-unit-approval-required",
        "notify-unit-approval",
        "review-plan-unit-with-user",
        "route-plan-unit-user-review",
        "repair-user-feedback",
        "route-user-feedback-resolution",
      ],
      transitions: [
        { to: "checkpoint", label: "accepted, or autonomous" },
        {
          to: "implement",
          label: "user feedback needs repair",
          cycle: {
            cause: "The user asked for changes to the unit.",
            exit: "The user accepts the unit.",
          },
        },
        { to: "replan", label: "feedback invalidates the plan" },
      ],
    },
    {
      id: "checkpoint",
      name: "Checkpoint and advance",
      description:
        "Commit a local checkpoint when the run holds that authority, then move the plan cursor to the next unit or finish the plan.",
      nodeIds: [
        "route-checkpoint-authority",
        "checkpoint-plan-unit",
        "route-plan-complete",
        "advance-plan-unit",
      ],
      transitions: [
        { to: "feature-validation", label: "last unit closed" },
        {
          to: "implement",
          label: "next unit",
          cycle: {
            cause: "A unit was closed and units remain in the plan.",
            exit: "The plan cursor passes the last unit.",
          },
        },
      ],
    },
    {
      id: "feature-validation",
      name: "Feature-wide validation",
      description:
        "Once every unit is closed, run the broad build, test, and packaging evidence the whole change requires.",
      nodeIds: [
        "validate-feature-wide",
        "route-feature-external",
        "route-feature-repository",
        "repair-feature-validation",
        "wait-for-feature-state-change",
        "route-feature-retry",
        "route-feature-repair-replan",
      ],
      transitions: [
        { to: "final-review", label: "feature evidence green" },
        { to: "replan", label: "repository failure needs a plan change" },
        { to: "stopped", label: "external blocker did not clear" },
      ],
    },
    {
      id: "final-review",
      name: "Final review and report",
      description:
        "An independent semantic review of the complete diff against every requirement, a truthful final report, and — interactively — the user's acceptance of the feature.",
      nodeIds: [
        "review-final-semantics",
        "route-final-review-replan",
        "route-final-semantic-review",
        "repair-final-semantics",
        "route-final-repair-replan",
        "create-final-report",
        "route-final-acceptance-mode",
        "notify-final-approval",
        "report-and-accept-feature",
        "route-feature-acceptance",
        "advance-plan-revision-after-feedback",
        "revise-plan-after-feedback",
      ],
      transitions: [
        { to: "finalize", label: "accepted, or autonomous" },
        {
          to: "feature-validation",
          label: "gate-local repair",
          cycle: {
            cause:
              "The final review found a non-executable correction, so feature validation is re-established after it.",
            exit: "A final review with zero gaps.",
          },
        },
        {
          to: "plan",
          label: "user feedback reopens the plan",
          cycle: {
            cause: "The user did not accept the feature; a revised plan goes back through review.",
            exit: "The user accepts the feature.",
          },
        },
        { to: "replan", label: "executable defect found" },
      ],
    },
    {
      id: "replan",
      name: "Replan",
      description:
        "Entered when the plan no longer fits reality — from a teleport, from a review that found an upstream cause, or from closing the current unit early. A new complete plan revision is created and reviewed.",
      nodeIds: [
        "teleport-replan",
        "advance-plan-revision-for-teleport",
        "revise-plan-for-teleport",
        "advance-plan-revision-for-replan",
        "revise-plan-for-replan",
        "approve-current-unit-closure",
        "route-current-unit-closure",
      ],
      transitions: [
        {
          to: "plan",
          label: "revised plan goes to review",
          cycle: {
            cause: "New facts, missed scope, or an upstream defect invalidated the remaining plan.",
            exit: "The revised plan passes review and is activated.",
          },
        },
        { to: "stopped", label: "closure not approved" },
      ],
    },
    {
      id: "finalize",
      name: "Finalize",
      description:
        "When the run holds commit authority, finalize the feature in version control with bounded retries; then notify completion.",
      nodeIds: [
        "route-vcs-authority",
        "finalize-feature",
        "route-finalization-success",
        "route-finalization-repository",
        "repair-finalization-repository",
        "route-finalization-repair-replan",
        "resolve-finalization-blocker",
        "route-finalization-retry",
        "route-finalization-skip",
        "notify-workflow-complete",
        "end",
      ],
      transitions: [{ to: "stopped", label: "finalization could not complete" }],
    },
    {
      id: "stopped",
      name: "Stopped",
      description:
        "The run ends without a delivered result, telling the user why. Reached only from an unresolved blocker or an unapproved closure.",
      nodeIds: ["notify-workflow-stopped", "end-aborted"],
      transitions: [],
    },
  ],
  run: {
    intake: { status: "done" },
    health: { status: "done" },
    plan: { status: "repeated", iterations: 2, note: "clean on the second pass" },
    "plan-approval": { status: "skipped", note: "autonomous mode" },
    replan: { status: "pending" },
    implement: { status: "repeated", iterations: 3, note: "unit 2 of 2 re-implemented once" },
    "unit-validation": { status: "repeated", iterations: 2 },
    "broad-validation": { status: "done" },
    completeness: { status: "repeated", iterations: 2, note: "one gate-local repair" },
    "user-review": {
      status: "waiting",
      currentNodeId: "review-plan-unit-with-user",
      note: "awaiting the user's verdict on unit 2",
    },
    checkpoint: { status: "done", iterations: 1 },
    "feature-validation": { status: "pending" },
    "final-review": { status: "pending" },
    finalize: { status: "pending" },
    stopped: { status: "pending" },
  },
};
