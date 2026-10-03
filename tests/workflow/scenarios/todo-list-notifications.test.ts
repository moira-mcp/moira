/**
 * What a person receives from a Todo List run: the checklist when it is ready and again, with every
 * item's state, when all tasks are done — headed by the flow and the task explicitly persisted at intake,
 * linked to the run, with nothing internal in the text.
 */

import { describe, expect, test } from "@jest/globals";
import { GraphValidator, runPageUrl } from "@mcp-moira/workflow-engine";
import { catalogGraph } from "../../helpers/catalog-graphs.js";
import {
  internalValues,
  runNotificationScenario,
  type NotificationScenario,
} from "../../helpers/notification-scenario.js";

const workflow = catalogGraph("todo-list");
const taskTitle = "Tidy the release_notes *draft*";
const note = "The draft stays unpublished until the release is approved";
const runScenario = (scenario: NotificationScenario) =>
  runNotificationScenario(workflow, {
    ...scenario,
    note,
    taskTitle: { atNode: "obtain-tasks", title: taskTitle },
  });
const tasks = [
  { action: "Collect the merged changes", expected_result: "A list of every merged change" },
  { action: "Group them by area", expected_result: "Changes grouped under each area" },
  { action: "Write the summary", expected_result: "A one-paragraph summary" },
];

function answers(overrides: Record<string, unknown> = {}) {
  return {
    "obtain-tasks": {
      execution_note: note,
      tasks,
      progress_checklist_outcome: "Three ordered tasks",
    },
    "execute-task": { evidence: "Verified", progress_execution_outcome: "Task done and verified" },
    ...overrides,
  };
}

describe("Todo List notifications", () => {
  test("the checklist is announced when ready and again, all done, at the finish", async () => {
    const run = await runScenario({ mockInputs: answers() });
    expect(run.notifications.map((message) => message.nodeId)).toEqual([
      "notify-checklist-ready",
      "notify-finished",
    ]);
    const [ready, finished] = run.notifications.map((message) => message.text);
    expect(run.taskIdentity?.title).toBe(taskTitle);
    expect(run.note).toBe(note);

    // The heading names the flow and the independently persisted task, linked to the run.
    for (const text of [ready, finished]) {
      expect(
        text.startsWith(
          `[Todo List · Tidy the release_notes *draft*](${runPageUrl({ executionId: run.executionId })})`,
        ),
      ).toBe(true);
      expect(internalValues(text, workflow)).toEqual([]);
    }
    expect(ready).toContain(
      "📝 0/3\n▶ 1. Collect the merged changes\n○ 2. Group them by area\n○ 3. Write the summary",
    );
    expect(ready).toContain("Checklist ready");
    expect(finished).toContain("All tasks done");
    expect(finished).toContain(
      "📝 3/3\n✓ 1. Collect the merged changes\n✓ 2. Group them by area\n✓ 3. Write the summary",
    );
  });

  test("a revised checklist is what the finish message lists", async () => {
    const revised = [
      tasks[0],
      { action: "Split the changes by release", expected_result: "One list per release" },
    ];
    const run = await runScenario({
      mockInputs: answers({
        "teleport-revise-tasks": {
          tasks: revised,
          resume_from_task: 2,
          progress_checklist_outcome: "Revised to two tasks",
          progress_execution_outcome: "First task done",
        },
      }),
      teleportAt: { node: "execute-task", visit: 2, teleportTo: "teleport-revise-tasks" },
    });
    const finished = run.notifications.at(-1)!;
    expect(finished.nodeId).toBe("notify-finished");
    expect(finished.text).toContain(
      "📝 2/2\n✓ 1. Collect the merged changes\n✓ 2. Split the changes by release",
    );
    expect(finished.text).not.toContain("Group them by area");
  });

  test("the flow validates without a notification content warning", async () => {
    const result = await new GraphValidator().validateUnified(workflow);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.message.startsWith("Notification "))).toEqual([]);
  });
});
