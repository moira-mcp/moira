/**
 * What a person receives from a Robust Task run, in both operating modes: the plan when it is
 * ready, a decision it needs (interactive: before, with the choices) or a decision taken for them
 * (autonomous: exactly one message, after deciding, with the reason), and the finish in words with
 * the plan's final state — headed by the flow and the task, linked to the run, with no file path,
 * no internal value and no raw status in the text.
 */

import { describe, expect, test } from "@jest/globals";
import { GraphValidator, runPageUrl } from "@mcp-moira/workflow-engine";
import { catalogGraph } from "../../helpers/catalog-graphs.js";
import {
  internalValues,
  runNotificationScenario,
  type NotificationMockContext,
  type NotificationScenarioResult,
} from "../../helpers/notification-scenario.js";

const workflow = catalogGraph("robust-task");
const plan = [{ title: "Parse the ledger" }, { title: "Reconcile the entries" }];
const revised = [{ title: "Parse the ledger" }, { title: "Match entries by date" }];
const QUESTION = /\b(?:choose|approve|reject)\b|\?/iu;

function answers(mode: "interactive" | "autonomous", extra: Record<string, unknown> = {}) {
  return {
    "initialize-workspace": {
      workspace_path: "./moira-ws/robust-task-ledger-20260926-1200/",
      operating_mode: mode,
      progress_intake_outcome: `Task contract established, ${mode}`,
      execution_note: "Reconcile the September ledger",
      goal_summary: "Every September ledger entry matches the bank statement",
    },
    "create-plan": {
      current_plan_file: "plans/001/plan.md",
      plan_steps: plan,
      progress_plan_outcome: "Two-step plan",
    },
    "review-plan": { review_outcome: "pass", progress_plan_outcome: "Plan reviewed clean" },
    "approve-plan": { decision: "yes", progress_plan_outcome: "Plan approved" },
    "execute-step": {
      evidence_file: "steps/1/plans/001/attempts/1/evidence.md",
      progress_execution_outcome: "Step done with evidence",
    },
    "review-step": {
      verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
      review_outcome: "pass",
      progress_step_review_outcome: "Step reviewed clean",
    },
    "final-review": {
      review_file: "final/reviews/001-review.md",
      review_outcome: "pass",
      progress_final_review_outcome: "Result reviewed clean",
    },
    "deliver-result": {
      delivery_file: "final/delivery.md",
      delivery_status: "complete",
      summary: "The ledger is reconciled.",
      // The progress synopsis is internal; the finish shows result_summary.
      progress_delivery_outcome: "complete; see final/delivery.md",
      result_summary: "The September ledger is reconciled and every entry matched",
    },
    ...extra,
  };
}

const incomplete = {
  "deliver-result": {
    delivery_file: "final/delivery.md",
    delivery_status: "incomplete",
    summary: "One entry stays unmatched.",
    progress_delivery_outcome: "incomplete; see final/delivery.md",
    result_summary: "The ledger is reconciled except one unmatched entry",
  },
};

function expectClean(run: NotificationScenarioResult) {
  for (const { text } of run.notifications) {
    expect(
      text.startsWith(
        `[Robust Task · Reconcile the September ledger](${runPageUrl({ executionId: run.executionId })})`,
      ),
    ).toBe(true);
    expect(internalValues(text, workflow)).toEqual([]);
  }
  // The scan cannot see plain-word statuses: the finish must word its status exactly.
  const finish = run.notifications.at(-1)!;
  expect(finish.nodeId).toBe("notify-completion");
  expect(finish.text).toMatch(
    /^\[[^\n]+\]\([^\n]+\)\n+🏁 \*(?:Completed|Completed with open items)\* — [A-Z]/u,
  );
}

describe("Robust Task notifications", () => {
  test("interactive: the plan to approve, then the finish with every step done", async () => {
    const run = await runNotificationScenario(workflow, { mockInputs: answers("interactive") });
    expect(run.notifications.map((message) => message.nodeId)).toEqual([
      "notify-plan-approval",
      "notify-completion",
    ]);
    expectClean(run);
    const [ready, finished] = run.notifications.map((message) => message.text);
    expect(ready).toContain("approve it and the work goes ahead, or reject it with feedback");
    expect(ready).toContain("🎯 Goal: Every September ledger entry matches the bank statement");
    expect(ready).toContain("📝 0/2\n▶ 1. Parse the ledger\n○ 2. Reconcile the entries");
    expect(finished).toContain("🏁 *Completed* — The September ledger is reconciled");
    expect(finished).toContain("📝 2/2\n✓ 1. Parse the ledger\n✓ 2. Reconcile the entries");
    expect(finished).not.toContain("delivery");
  });

  test("autonomous: work goes ahead with the plan, and nothing asks for a decision", async () => {
    const run = await runNotificationScenario(workflow, { mockInputs: answers("autonomous") });
    expect(run.notifications.map((message) => message.nodeId)).toEqual([
      "notify-work-started",
      "notify-completion",
    ]);
    expectClean(run);
    for (const { text } of run.notifications) expect(text).not.toMatch(QUESTION);
    expect(run.notifications[0].text).toContain("Plan approved — the work goes ahead");
    expect(run.notifications[0].text).toContain(
      "🎯 Goal: Every September ledger entry matches the bank statement",
    );
  });

  test("a replan announces the new plan in the next message", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("autonomous", {
        "review-step": (ctx: { visit: number }) => ({
          verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
          ...(ctx.visit === 1
            ? { review_outcome: "replan", failure_summary: "Entries must be matched by date" }
            : { review_outcome: "pass" }),
          progress_step_review_outcome: "Step review",
        }),
        "replan-from-verdict": {
          current_plan_file: "plans/002/plan.md",
          plan_steps: revised,
          progress_plan_outcome: "Replaced plan",
          progress_execution_outcome: "Pending",
          progress_step_review_outcome: "Pending",
          progress_final_review_outcome: "Pending",
        },
      }),
    });
    expect(run.notifications.map((message) => message.nodeId)).toEqual([
      "notify-work-started",
      "notify-work-started",
      "notify-completion",
    ]);
    expect(run.notifications[1].text).toContain(
      "▶ 1. Parse the ledger\n○ 2. Match entries by date",
    );
    expect(run.notifications[2].text).toContain(
      "✓ 1. Parse the ledger\n✓ 2. Match entries by date",
    );
  });

  test("a plan repaired before approval is announced, and run, with its new length", async () => {
    const repaired = [...plan, { title: "Write the reconciliation report" }];
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("interactive", {
        "review-plan": (ctx: NotificationMockContext) => ({
          ...(ctx.visit === 1
            ? { review_outcome: "repair", failure_summary: "The report step is missing" }
            : { review_outcome: "pass" }),
          progress_plan_outcome: ctx.visit === 1 ? "The report step is missing" : "Plan clean",
        }),
        "fix-plan": {
          repair_outcome: "changed",
          current_plan_file: "plans/002/plan.md",
          plan_steps: repaired,
          progress_plan_outcome: "Report step added",
          progress_execution_outcome: "Pending",
          progress_step_review_outcome: "Pending",
          progress_final_review_outcome: "Pending",
        },
      }),
    });
    const [ready, finished] = run.notifications.map((message) => message.text);
    expect(ready).toContain(
      "📝 0/3\n▶ 1. Parse the ledger\n○ 2. Reconcile the entries\n○ 3. Write the reconciliation report",
    );
    expect(finished).toContain(
      "📝 3/3\n✓ 1. Parse the ledger\n✓ 2. Reconcile the entries\n✓ 3. Write the reconciliation report",
    );
  });

  // A step whose result keeps failing review exhausts its repair budget (three repairs by default).
  const exhausted = {
    "review-step": {
      verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
      review_outcome: "repair",
      repair_owner: "result",
      failure_summary: "Two entries still disagree with the bank statement",
      progress_step_review_outcome:
        "repair, owner result; verdict in steps/1/plans/001/attempts/1/verdict.md",
    },
    "repair-step": {
      repair_outcome: "changed",
      evidence_file: "steps/1/plans/001/attempts/1/evidence.md",
      progress_step_review_outcome:
        "repair, owner result; verdict in steps/1/plans/001/attempts/1/verdict.md",
    },
    "ask-retry-decision": {
      decision: "finish_incomplete",
      decision_file: "steps/1/decisions/001.md",
      decision_summary: "Stopping here: the bank statement itself is missing two entries",
      progress_step_review_outcome: "Finishing with the step incomplete",
    },
    ...incomplete,
  };

  test("interactive: an exhausted step asks the person, naming the step, the failure and the choices", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("interactive", exhausted),
    });
    expect(run.notifications.map((message) => message.nodeId)).toEqual([
      "notify-plan-approval",
      "notify-escalation",
      "notify-completion",
    ]);
    expectClean(run);
    const escalation = run.notifications[1].text;
    expect(escalation).toContain("step 1 “Parse the ledger” keeps failing its review");
    expect(escalation).toContain("Two entries still disagree with the bank statement");
    expect(escalation).toContain(
      "Choose: try it again, change the plan, or finish with this step incomplete.",
    );
    expect(run.notifications[2].text).toContain("🏁 *Completed with open items*");
    // The run has ended: the step it stopped at reads as open, not in progress.
    expect(run.notifications[2].text).toContain(
      "📝 0/2\n○ 1. Parse the ledger\n○ 2. Reconcile the entries",
    );
  });

  test("autonomous: exactly one message about the exhausted step, sent after the decision", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("autonomous", exhausted),
    });
    expect(run.notifications.map((message) => message.nodeId)).toEqual([
      "notify-work-started",
      "notify-retry-decided",
      "notify-completion",
    ]);
    expectClean(run);
    const decided = run.notifications[1].text;
    // After the decision: the decision node was passed before this message was sent.
    expect(run.route.indexOf("ask-retry-decision")).toBeLessThan(
      run.route.indexOf("notify-retry-decided"),
    );
    expect(decided).toContain("Decided for you");
    expect(decided).toContain("finishing with this step incomplete");
    expect(decided).toContain("the bank statement itself is missing two entries");
    for (const { text } of run.notifications) expect(text).not.toMatch(QUESTION);
  });

  // The plan keeps failing review until the review bound (five rounds by default).
  const planStuck = {
    "review-plan": {
      review_outcome: "repair",
      failure_summary: "The plan misses the refunds",
      progress_plan_outcome: "Plan 002, two steps; review: repair",
    },
    "fix-plan": {
      repair_outcome: "changed",
      current_plan_file: "plans/002/plan.md",
      plan_steps: plan,
      progress_plan_outcome: "Plan 002, two steps; review: repair",
      progress_execution_outcome: "Pending",
      progress_step_review_outcome: "Pending",
      progress_final_review_outcome: "Pending",
    },
    "ask-plan-review-limit": {
      decision: "finish_incomplete",
      decision_summary: "Stopping: the refunds data is not available to plan against",
      progress_plan_outcome: "Plan review bound reached",
    },
    ...incomplete,
  };

  test.each([
    [
      "interactive",
      ["notify-plan-review-limit", "notify-completion"],
      "Choose: fix the plan once more",
      "The plan misses the refunds",
    ],
    [
      "autonomous",
      ["notify-plan-limit-decided", "notify-completion"],
      "finishing with the plan incomplete",
      "the refunds data is not available",
    ],
  ] as const)("%s: the plan review bound", async (mode, sequence, words, detail) => {
    const run = await runNotificationScenario(workflow, { mockInputs: answers(mode, planStuck) });
    expect(run.notifications.map((message) => message.nodeId)).toEqual(sequence);
    expectClean(run);
    expect(run.notifications[0].text).toContain(words);
    expect(run.notifications[0].text).toContain(detail);
    // Execution never started, and the run has ended: nothing reads as in progress.
    expect(run.notifications[1].text).toContain(
      "📝 0/2\n○ 1. Parse the ledger\n○ 2. Reconcile the entries",
    );
  });

  // The result keeps failing the final review until the bound.
  const resultStuck = {
    "final-review": {
      review_file: "final/reviews/001-review.md",
      review_outcome: "repair",
      repair_owner: "deliverable",
      failure_summary: "One refund is booked twice",
      progress_final_review_outcome: "repair, owner deliverable",
    },
    "fix-final-review": {
      repair_outcome: "changed",
      progress_final_review_outcome: "repair, owner deliverable",
    },
    "ask-final-review-limit": {
      decision: "accept_incomplete",
      decision_summary: "Accepting it: the duplicate is in the bank's own export",
      progress_final_review_outcome: "Final review bound reached",
    },
    ...incomplete,
  };

  test.each([
    ["interactive", "notify-final-review-limit", "Choose: fix the result once more, or accept it"],
    ["autonomous", "notify-final-limit-decided", "accepting the result with its open items"],
  ] as const)("%s: the final review bound", async (mode, node, words) => {
    const run = await runNotificationScenario(workflow, { mockInputs: answers(mode, resultStuck) });
    const ids = run.notifications.map((message) => message.nodeId);
    expect(ids.slice(-2)).toEqual([node, "notify-completion"]);
    expect(ids.filter((id) => id === node)).toHaveLength(1);
    expectClean(run);
    expect(run.notifications.at(-2)!.text).toContain(words);
  });

  // A review fails until the decision has been taken, then passes — so every decision value is
  // rendered and the run still finishes.
  const decided = (node: string) => (ctx: NotificationMockContext) =>
    ctx.variables[node] === undefined;
  const failStepUntil = (node: string) => (ctx: NotificationMockContext) => ({
    verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
    ...(decided(node)(ctx)
      ? {
          review_outcome: "repair",
          repair_owner: "result",
          failure_summary: "Two entries still disagree with the bank statement",
        }
      : { review_outcome: "pass" }),
    progress_step_review_outcome: "Two entries still disagree with the bank statement",
  });

  test.each([
    [
      "retry",
      {
        "review-step": failStepUntil("ask-retry-decision"),
        "repair-step": exhausted["repair-step"],
        "ask-retry-decision": {
          decision: "retry",
          decision_file: "steps/1/decisions/001.md",
          decision_summary: "Retrying: the missing statement page has now arrived",
          progress_step_review_outcome: "Retrying the step",
        },
      },
      "notify-retry-decided",
      "step 1 “Parse the ledger”: trying it again. Retrying: the missing statement page",
    ],
    [
      "replan",
      {
        "review-step": failStepUntil("ask-retry-decision"),
        "repair-step": exhausted["repair-step"],
        "ask-retry-decision": {
          decision: "replan",
          decision_file: "steps/1/decisions/001.md",
          decision_summary: "Changing the plan: entries must be matched by date first",
          progress_step_review_outcome: "Replanning",
        },
        "replan-from-decision": {
          current_plan_file: "plans/002/plan.md",
          plan_steps: revised,
          progress_plan_outcome: "Replaced plan",
          progress_execution_outcome: "Pending",
          progress_step_review_outcome: "Pending",
          progress_final_review_outcome: "Pending",
        },
      },
      "notify-retry-decided",
      "step 1 “Parse the ledger”: changing the plan. Changing the plan: entries must be matched",
    ],
    [
      "repair at the plan review bound",
      {
        "review-plan": (ctx: NotificationMockContext) => ({
          ...(decided("ask-plan-review-limit")(ctx)
            ? { review_outcome: "repair", failure_summary: "The plan misses the refunds" }
            : { review_outcome: "pass" }),
          progress_plan_outcome: "The plan misses the refunds",
        }),
        "fix-plan": planStuck["fix-plan"],
        "ask-plan-review-limit": {
          decision: "repair",
          decision_summary: "Fixing it once more: the refunds export is now available",
          progress_plan_outcome: "One more plan repair",
        },
      },
      "notify-plan-limit-decided",
      "fixing the plan once more. Fixing it once more: the refunds export",
    ],
    [
      "repair at the final review bound",
      {
        "final-review": (ctx: NotificationMockContext) => ({
          review_file: "final/reviews/001-review.md",
          ...(decided("ask-final-review-limit")(ctx)
            ? {
                review_outcome: "repair",
                repair_owner: "deliverable",
                failure_summary: "One refund is booked twice",
              }
            : { review_outcome: "pass" }),
          progress_final_review_outcome: "One refund is booked twice",
        }),
        "fix-final-review": resultStuck["fix-final-review"],
        "ask-final-review-limit": {
          decision: "repair",
          decision_summary: "Fixing it once more: the duplicate refund can be removed",
          progress_final_review_outcome: "One more result repair",
        },
      },
      "notify-final-limit-decided",
      "fixing the result once more. Fixing it once more: the duplicate refund",
    ],
  ] as const)(
    "autonomous: the decision to %s is worded in its one message",
    async (_decision, extra, node, words) => {
      const run = await runNotificationScenario(workflow, {
        mockInputs: answers("autonomous", extra),
      });
      const messages = run.notifications.filter((message) => message.nodeId === node);
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toContain(words);
      expect(run.notifications.at(-1)!.text).toContain("🏁 *Completed* —");
      expectClean(run);
    },
  );

  // The reader lines exist only because the flow refuses an answer without them.
  test.each([
    [
      "initialize-workspace",
      {
        workspace_path: "./moira-ws/robust-task-ledger-20260926-1200/",
        operating_mode: "interactive",
        progress_intake_outcome: "Task contract established",
        execution_note: "Reconcile the September ledger",
      },
    ],
    ["review-plan", { review_outcome: "repair", progress_plan_outcome: "Plan review: repair" }],
    [
      "review-step",
      {
        verdict_file: "steps/1/plans/001/attempts/1/verdict.md",
        review_outcome: "repair",
        repair_owner: "result",
        progress_step_review_outcome: "Step review: repair",
      },
    ],
    [
      "final-review",
      {
        review_file: "final/reviews/001-review.md",
        review_outcome: "replan",
        progress_final_review_outcome: "Final review: replan",
      },
    ],
    [
      "deliver-result",
      {
        delivery_file: "final/delivery.md",
        delivery_status: "complete",
        summary: "The ledger is reconciled.",
        progress_delivery_outcome: "Delivered",
      },
    ],
  ])("%s refuses an answer without its reader field", async (node, answer) => {
    await expect(
      runNotificationScenario(workflow, {
        mockInputs: answers("interactive", { [node]: answer }),
      }),
    ).rejects.toThrow(new RegExp(`The answer for ${node} \\(visit 1\\) was rejected`, "u"));
  });

  test("the flow validates without a notification content warning", async () => {
    const result = await new GraphValidator().validateUnified(workflow);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.message.startsWith("Notification "))).toEqual([]);
  });
});
