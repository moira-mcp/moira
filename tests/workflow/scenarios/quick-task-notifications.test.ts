/**
 * What a person receives from a Quick Task run, in both operating modes: the plan when it is ready
 * (to approve, or already started), the result when it waits for them, and the finish with the
 * plan's final state — headed by the flow and the task the first step named, linked to the run,
 * with nothing internal in the text and no question in an autonomous run.
 */

import { describe, expect, test } from "@jest/globals";
import { GraphValidator, runPageUrl } from "@mcp-moira/workflow-engine";
import { catalogGraph } from "../../helpers/catalog-graphs.js";
import {
  internalValues,
  runNotificationScenario,
  type NotificationMockContext,
} from "../../helpers/notification-scenario.js";

const workflow = catalogGraph("quick-task");
const note = "Add a dark_mode toggle";
const firstPlan = [{ title: "Add the setting" }, { title: "Wire the toggle" }];
const revisedPlan = [
  { title: "Add the setting" },
  { title: "Wire the toggle" },
  { title: "Document the toggle" },
];
const ws = ({ executionId }: NotificationMockContext) => `./moira-ws/quick-task-${executionId}`;

function answers(mode: "interactive" | "autonomous", extra: Record<string, unknown> = {}) {
  return {
    "get-task": (ctx: NotificationMockContext) => ({
      task_file: `${ws(ctx)}/task.md`,
      execution_file: `${ws(ctx)}/execution.md`,
      operating_mode: mode,
      progress_scope_outcome: `Task captured, ${mode}`,
      execution_note: note,
    }),
    "create-plan": (ctx: NotificationMockContext) => ({
      current_plan_file: `${ws(ctx)}/plans/001/plan.md`,
      plan_steps: firstPlan,
      progress_plan_outcome: "Two-unit plan",
    }),
    "plan-review": (ctx: NotificationMockContext) => ({
      review_file: `${ws(ctx)}/plans/00${ctx.visit}/review.md`,
      issues_count: 0,
      progress_plan_outcome: "Plan reviewed clean",
    }),
    "execute-step": { progress_execution_outcome: "Unit done and verified" },
    "final-review": (ctx: NotificationMockContext) => ({
      review_file: `${ws(ctx)}/result-reviews/00${ctx.visit}/review.md`,
      issues_count: 0,
      progress_review_outcome: "Result reviewed clean",
      result_summary: "The settings page has a working dark_mode toggle",
    }),
    "present-autonomous-result": { progress_result_outcome: "Result presented" },
    ...extra,
  };
}

const heading = (executionId: string) =>
  `[Quick Task · Add a dark_mode toggle](${runPageUrl({ executionId })})`;

describe("Quick Task notifications", () => {
  test("interactive: plan to approve (again after a rejection), result to review (again after rework), finish", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("interactive", {
        "present-plan": (ctx: NotificationMockContext) => ({
          approval: ctx.visit === 1 ? "no" : "yes",
          decision_file: `${ws(ctx)}/plans/00${ctx.visit}/decision.md`,
          progress_plan_outcome: ctx.visit === 1 ? "Plan rejected" : "Plan approved",
        }),
        "revise-plan": (ctx: NotificationMockContext) => ({
          current_plan_file: `${ws(ctx)}/plans/002/plan.md`,
          plan_steps: revisedPlan,
          progress_plan_outcome: "Three-unit plan",
        }),
        "present-to-user": (ctx: NotificationMockContext) => ({
          decision: ctx.visit === 1 ? "rework" : "accept",
          decision_file: `${ws(ctx)}/result-reviews/00${ctx.visit}/decision.md`,
          progress_result_outcome: ctx.visit === 1 ? "Rework requested" : "Accepted",
        }),
        rework: { progress_result_outcome: "Reworked" },
      }),
    });
    expect(run.notifications.map((message) => message.nodeId)).toEqual([
      "notify-plan-approval",
      "notify-plan-approval",
      "notify-result-ready",
      "notify-result-ready",
      "notify-finished",
    ]);
    const [plan, revised, result, , finished] = run.notifications.map((message) => message.text);
    for (const { text } of run.notifications) {
      expect(text.startsWith(heading(run.executionId))).toBe(true);
      expect(internalValues(text, workflow)).toEqual([]);
    }
    // The plan to approve, with the choices in words; after a rejection, the revised plan.
    expect(plan).toContain("approve it and the work goes ahead, or reject it with feedback");
    expect(plan).toContain("📝 0/2\n▶ 1. Add the setting\n○ 2. Wire the toggle");
    expect(revised).toContain(
      "📝 0/3\n▶ 1. Add the setting\n○ 2. Wire the toggle\n○ 3. Document the toggle",
    );
    // The result waits for the reader: one line, the choices, and where the run stands.
    expect(result).toContain("The settings page has a working dark\\_mode toggle");
    expect(result).toContain(
      "Accept it to finish, or ask for rework and say what to change.\n\n📝 3/3\n\n",
    );
    // The finish: the result and every unit done.
    expect(finished).toContain("Finished");
    expect(finished).toContain(
      "📝 3/3\n✓ 1. Add the setting\n✓ 2. Wire the toggle\n✓ 3. Document the toggle",
    );
  });

  test("autonomous: work started with the plan, then the finish — nothing asks for a decision", async () => {
    const run = await runNotificationScenario(workflow, { mockInputs: answers("autonomous") });
    expect(run.notifications.map((message) => message.nodeId)).toEqual([
      "notify-work-started",
      "notify-finished",
    ]);
    const [started, finished] = run.notifications.map((message) => message.text);
    for (const text of [started, finished]) {
      expect(text.startsWith(heading(run.executionId))).toBe(true);
      expect(internalValues(text, workflow)).toEqual([]);
      expect(text).not.toMatch(
        /\b(?:approve|reject|accept|rework)\b|your review|waiting for you|\?/iu,
      );
    }
    expect(started).toContain("Plan approved — the work goes ahead");
    expect(started).toContain("📝 0/2\n▶ 1. Add the setting\n○ 2. Wire the toggle");
    expect(finished).toContain("📝 2/2\n✓ 1. Add the setting\n✓ 2. Wire the toggle");
  });

  test("autonomous replan mid-run: the revised plan is announced with the finished unit kept", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("autonomous", {
        "teleport-replan": { progress_plan_outcome: "The plan no longer fits" },
        "revise-plan": (ctx: NotificationMockContext) => ({
          current_plan_file: `${ws(ctx)}/plans/002/plan.md`,
          plan_steps: revisedPlan,
          progress_plan_outcome: "Three-unit plan",
        }),
      }),
      teleportAt: { node: "execute-step", visit: 2, teleportTo: "teleport-replan" },
    });
    expect(run.notifications.map((message) => message.nodeId)).toEqual([
      "notify-work-started",
      "notify-work-started",
      "notify-finished",
    ]);
    const replanned = run.notifications[1].text;
    // The wording holds for a plan revised mid-run, and the list keeps the unit already done.
    expect(replanned).toContain("Plan approved — the work goes ahead");
    expect(replanned).toContain(
      "📝 1/3\n✓ 1. Add the setting\n▶ 2. Wire the toggle\n○ 3. Document the toggle",
    );
    expect(replanned).not.toMatch(/\b(?:approve|reject|accept|rework)\b|\?/iu);
  });

  test("the flow validates without a notification content warning", async () => {
    const result = await new GraphValidator().validateUnified(workflow);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.message.startsWith("Notification "))).toEqual([]);
  });
});
