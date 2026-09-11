import type { ProcessProjection } from "../model";
import { QUICK_TASK_AUTHORED } from "./authored";

/**
 * Quick Task projected into seven phases. All 23 authored nodes are claimed exactly once; the five
 * real cycles of the authored graph appear as cycle transitions. The run snapshot shows an
 * autonomous execution in the middle of its third plan step after the plan review looped twice.
 */
export const QUICK_TASK_PROJECTION: ProcessProjection = {
  slug: "quick-task",
  title: "Quick Task",
  goal: "Execute one bounded task through a reviewed plan, sequential execution, and independent final review.",
  authored: QUICK_TASK_AUTHORED,
  blocks: [
    {
      id: "scope",
      name: "Understand the task",
      description:
        "Capture the goal, the observable result, scope, constraints, authority, and whether the run is autonomous or interactive. Nothing is planned yet.",
      nodeIds: ["start", "get-task"],
      transitions: [{ to: "plan", label: "task contract written" }],
    },
    {
      id: "plan",
      name: "Draft the plan",
      description:
        "Write an ordered plan of 1–10 units, each with an action, an expected result, and a verification method. The plan is immutable once published.",
      nodeIds: ["create-plan"],
      transitions: [{ to: "plan-review", label: "plan published" }],
    },
    {
      id: "plan-review",
      name: "Independent plan review",
      description:
        "A reviewer who did not write the plan checks it against the task contract and records blocking findings. Findings send the plan back for repair until the review is clean.",
      nodeIds: ["plan-review", "check-plan-review-clean", "repair-plan"],
      transitions: [
        { to: "plan-approval", label: "no blocking findings" },
        {
          to: "plan-review",
          label: "review found issues",
          cycle: {
            cause:
              "The reviewer recorded at least one blocking finding, so a corrected plan iteration is created.",
            exit: "A review with zero blocking findings.",
          },
        },
      ],
    },
    {
      id: "plan-approval",
      name: "Plan approval",
      description:
        "In interactive mode the plan is shown to the user, who approves it or asks for changes. Autonomous runs skip the gate. A mid-run replan also re-enters here.",
      nodeIds: [
        "route-operating-mode-plan-approval",
        "present-plan",
        "check-plan-approved",
        "revise-plan",
        "teleport-replan",
      ],
      transitions: [
        { to: "execute", label: "approved, or autonomous" },
        {
          to: "plan-review",
          label: "user asked for changes",
          cycle: {
            cause:
              "The user rejected the plan or a replan was triggered during execution; a revised plan goes back through review.",
            exit: "The user approves, or the run is autonomous.",
          },
        },
      ],
    },
    {
      id: "execute",
      name: "Execute plan steps",
      description:
        "Run the approved units one at a time, recording one evidence entry per unit. The loop repeats until no unit remains.",
      nodeIds: ["check-steps-remaining", "execute-step", "close-completed-step"],
      transitions: [
        { to: "verify", label: "all units done" },
        {
          to: "execute",
          label: "next unit",
          cycle: {
            cause: "A unit was completed and units remain in the plan.",
            exit: "The plan cursor passes the last unit.",
          },
        },
      ],
    },
    {
      id: "verify",
      name: "Final review",
      description:
        "An independent reviewer checks the actual result against the task contract. Confirmed defects are fixed and the review runs again.",
      nodeIds: ["final-review", "check-review-clean", "fix-issues"],
      transitions: [
        { to: "deliver", label: "result accepted by review" },
        {
          to: "verify",
          label: "review found issues",
          cycle: {
            cause: "The final review recorded blocking findings, so the result is repaired.",
            exit: "A final review with zero findings.",
          },
        },
      ],
    },
    {
      id: "deliver",
      name: "Present the result",
      description:
        "Report the result truthfully. Interactive runs wait for the user to accept or request rework; autonomous runs present and end.",
      nodeIds: [
        "route-operating-mode-result-presentation",
        "present-autonomous-result",
        "present-to-user",
        "check-user-accepts",
        "rework",
        "end",
      ],
      transitions: [
        {
          to: "verify",
          label: "user requested rework",
          cycle: {
            cause: "The user did not accept the result, so it is reworked and reviewed again.",
            exit: "The user accepts, or the run is autonomous.",
          },
        },
      ],
    },
  ],
  run: {
    scope: { status: "done" },
    plan: { status: "done" },
    "plan-review": { status: "repeated", iterations: 2, note: "clean on the second pass" },
    "plan-approval": { status: "skipped", note: "autonomous mode" },
    execute: {
      status: "active",
      iterations: 2,
      currentNodeId: "execute-step",
      note: "unit 3 of 5",
    },
    verify: { status: "pending" },
    deliver: { status: "pending" },
  },
};
