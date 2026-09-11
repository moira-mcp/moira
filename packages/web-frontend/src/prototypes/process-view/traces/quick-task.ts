/**
 * Example runs of Quick Task, simulated on the real annotated graph. Each script only says what
 * the agent steps returned; routing is evaluated from the workflow's own conditions.
 */
import type { TraceScript } from "../trace";

const scope = (mode: "autonomous" | "interactive") => ({
  outputs: {
    task_file: "./moira-ws/quick-task-demo/task.md",
    execution_file: "./moira-ws/quick-task-demo/execution.md",
    operating_mode: mode,
    progress_scope_outcome: `Task contract captured; ${mode} mode`,
  },
});

export const QUICK_TASK_TRACES: TraceScript[] = [
  {
    id: "review-loop",
    title: "Autonomous run, plan repaired once, executing unit 3 of 5",
    description:
      "The plan review found one blocking issue, so the plan was repaired and reviewed again. Autonomous mode skipped the approval gate. The run is now on its third of five units.",
    initial: { current_step: 0, total_steps: 0, operating_mode: "autonomous" },
    steps: {
      "get-task": () => scope("autonomous"),
      "create-plan": () => ({
        outputs: {
          current_plan_file: "./moira-ws/quick-task-demo/plans/1/plan.md",
          total_steps: 5,
          progress_plan_outcome: "5 units: fixture, derivation, traces, route view, assessment",
        },
      }),
      "plan-review": (i) => ({
        outputs: {
          review_file: `./moira-ws/quick-task-demo/plans/${i + 1}/review.md`,
          issues_count: i === 0 ? 1 : 0,
          progress_plan_outcome: i === 0 ? "review: 1 blocking finding" : "review clean on pass 2",
        },
      }),
      "repair-plan": () => ({
        outputs: {
          current_plan_file: "./moira-ws/quick-task-demo/plans/2/plan.md",
          progress_plan_outcome: "plan 2 corrects the finding",
        },
      }),
      "execute-step": (i) =>
        i < 2
          ? {
              outputs: { progress_execution_outcome: `unit ${i + 1} done` },
              note: `unit ${i + 1} of 5`,
            }
          : { stop: true, note: "unit 3 of 5" },
    },
  },
  {
    id: "clean",
    title: "Autonomous run, everything clean, completed",
    description:
      "Three units, a clean plan review, a clean final review, and the result presented autonomously. The shortest path through the process.",
    initial: { current_step: 0, total_steps: 0, operating_mode: "autonomous" },
    steps: {
      "get-task": () => scope("autonomous"),
      "create-plan": () => ({
        outputs: {
          current_plan_file: "./moira-ws/quick-task-demo/plans/1/plan.md",
          total_steps: 3,
          progress_plan_outcome: "3 units",
        },
      }),
      "plan-review": () => ({
        outputs: { review_file: "./moira-ws/quick-task-demo/plans/1/review.md", issues_count: 0 },
      }),
      "execute-step": (i) => ({
        outputs: { progress_execution_outcome: `unit ${i + 1} done` },
        note: `unit ${i + 1} of 3`,
      }),
      "final-review": () => ({
        outputs: {
          review_file: "./moira-ws/quick-task-demo/result-reviews/1/review.md",
          issues_count: 0,
          progress_review_outcome: "0 blocking findings",
        },
      }),
      "present-autonomous-result": () => ({
        outputs: { progress_result_outcome: "Result presented" },
      }),
    },
  },
  {
    id: "interactive-replan",
    title: "Interactive run with a rejected plan, a mid-run replan, and rework",
    description:
      "The user asked for plan changes at the gate; during unit 2 the agent teleported to replan; the final review found an issue; the user asked for rework before accepting. Every loop the process has, in one run.",
    initial: { current_step: 0, total_steps: 0, operating_mode: "interactive" },
    steps: {
      "get-task": () => scope("interactive"),
      "create-plan": () => ({
        outputs: {
          current_plan_file: "./moira-ws/quick-task-demo/plans/1/plan.md",
          total_steps: 3,
          progress_plan_outcome: "3 units",
        },
      }),
      "plan-review": (i) => ({
        outputs: {
          review_file: `./moira-ws/quick-task-demo/plans/${i + 1}/review.md`,
          issues_count: 0,
        },
      }),
      "present-plan": (i) => ({
        waited: true,
        outputs: {
          approval: i === 0 ? "no" : "yes",
          decision_file: `./moira-ws/quick-task-demo/plans/${i + 1}/decision.md`,
        },
        note: i === 0 ? "user asked for changes" : "user approved",
      }),
      "revise-plan": (i) => ({
        outputs: {
          current_plan_file: `./moira-ws/quick-task-demo/plans/${i + 2}/plan.md`,
          progress_plan_outcome: i === 0 ? "plan 2 after user feedback" : "plan 3 after replan",
        },
      }),
      "teleport-replan": () => ({
        outputs: { progress_plan_outcome: "unit 2 showed the remaining plan no longer fits" },
      }),
      "execute-step": (i) =>
        i === 1
          ? { teleportTo: "teleport-replan", note: "unit 2 of 3: plan no longer fits" }
          : {
              outputs: { progress_execution_outcome: `unit done (visit ${i + 1})` },
              note: `unit ${i > 1 ? i : i + 1} of 3`,
            },
      "final-review": (i) => ({
        outputs: {
          review_file: `./moira-ws/quick-task-demo/result-reviews/${i + 1}/review.md`,
          issues_count: i === 0 ? 1 : 0,
          progress_review_outcome: i === 0 ? "1 blocking finding" : "0 blocking findings",
        },
      }),
      "fix-issues": () => ({ outputs: { progress_review_outcome: "finding corrected" } }),
      "present-to-user": (i) => ({
        waited: true,
        outputs: {
          decision: i === 0 ? "rework" : "accept",
          decision_file: `./moira-ws/quick-task-demo/decisions/${i + 1}.md`,
          progress_result_outcome: i === 0 ? "user asked for rework" : "accepted",
        },
      }),
      rework: () => ({ outputs: { progress_result_outcome: "rework applied" } }),
    },
  },
];
