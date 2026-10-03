/**
 * The notification scenario harness is evidence for every standard flow's messages, so its own
 * judgement is pinned here: the internal-value scan finds each kind of value a reader cannot use
 * and leaves prose and links alone, and a rejected answer stops the scenario instead of looping.
 */

import { describe, expect, test } from "@jest/globals";
import { runPageUrl } from "@mcp-moira/workflow-engine";
import { catalogGraph } from "../../helpers/catalog-graphs.js";
import { internalValues, runNotificationScenario } from "../../helpers/notification-scenario.js";

const robustTask = catalogGraph("robust-task");

describe("the internal-value scan", () => {
  test.each([
    [
      "a workspace path in a completion line",
      "Robust Task finished (complete).\n\nAll steps done.\n\nDetails: final/delivery.md",
      "path final/delivery.md",
    ],
    ["template syntax left in the text", "Plan: {{current_plan_file}}", "template syntax"],
    ["the undefined placeholder", "Result: [[UNDEFINED_VARIABLE]]", "undefined placeholder"],
    ["a node id", "Answer notify-completion to continue", "identifier notify-completion"],
    ["a registry key", "The current_plan_file is ready", "identifier current_plan_file"],
    ["a run-id prefix", "📋 Process: 0d7c5a9e", "run id prefix"],
    ["an absolute path", "Saved to /Users/someone/out", "path /Users/someone/out"],
    [
      "a workspace directory without an extension",
      "Plans live in moira-ws/quick-task-1234/plans",
      "path moira-ws/quick-task-1234/plans",
    ],
    ["a raw enum value", "Decision: finish_incomplete", "identifier finish_incomplete"],
  ])("finds %s", (_case, text, finding) => {
    expect(internalValues(text, robustTask)).toContain(finding);
  });

  test("leaves the heading's link, prose and counts alone", () => {
    const text = [
      "[Robust Task · Reconcile the ledger](https://moira.example/executions/0d7c5a9e-2f4b-4c1d-9a8e-3b6f1c2d4e5f)",
      "The plan is approved and 2/3 steps are done.",
      "📝 2/3\n✓ 1. Parse the ledger\n✓ 2. Match entries\n▶ 3. Write the report",
      "Keep and/or drop the draft; 1/2 of the rows and 26/09/2026 stay as written.",
    ].join("\n\n");
    expect(internalValues(text, robustTask)).toEqual([]);
  });
});

describe("the harness", () => {
  test("stops with the rejection when an answer does not match the step", async () => {
    await expect(
      runNotificationScenario(catalogGraph("todo-list"), {
        mockInputs: {
          // tasks is missing: the flow refuses the answer and stays on the step.
          "obtain-tasks": {
            execution_note: "An arbitrary note cannot replace the checklist",
            progress_checklist_outcome: "One task",
          },
        },
      }),
    ).rejects.toThrow(/The answer for obtain-tasks \(visit 1\) was rejected/u);
  });

  test("persists an explicit title independently and leaves already delivered unnamed headings unchanged", async () => {
    const note = "Keep the release unpublished until Friday";
    const title = "Review the release checklist";
    const run = await runNotificationScenario(catalogGraph("todo-list"), {
      note,
      // The task is named after the initial checklist message has already been delivered.
      taskTitle: { atNode: "execute-task", title },
      mockInputs: {
        "obtain-tasks": {
          tasks: [{ action: "Review the checklist", expected_result: "Checked" }],
          progress_checklist_outcome: "One task",
        },
        "execute-task": { evidence: "Checked", progress_execution_outcome: "Done" },
      },
    });
    const link = runPageUrl({ executionId: run.executionId });
    expect(run.taskIdentity).toMatchObject({ title });
    expect(run.taskIdentity?.changeId).toEqual(expect.any(String));
    expect(run.note).toBe(note);
    expect(run.notifications[0].text.startsWith(`[Todo List](${link})`)).toBe(true);
    expect(run.notifications[1].text.startsWith(`[Todo List · ${title}](${link})`)).toBe(true);
    for (const message of run.notifications) expect(message.text).not.toContain(note);
  });
});
