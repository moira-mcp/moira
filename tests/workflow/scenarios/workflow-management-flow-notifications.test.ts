/**
 * What a person receives from a Workflow Management Flow run, at the simple, standard and complex levels, for
 * a new workflow and an edit, in both operating modes: the plan when the build starts (to approve,
 * in an interactive run at the standard level), the questions an interactive run asks, one message
 * after each decision an autonomous run takes, and the finish — created or updated, name and
 * version, saved to the catalogue or not, or cancelled — with the planned stages or changes and
 * their state. Every text is headed by the flow and the task, linked to the run, with nothing
 * internal in it.
 */

import { describe, expect, test } from "@jest/globals";
import { GraphValidator, runPageUrl, type WorkflowGraph } from "@mcp-moira/workflow-engine";
import { catalogGraph } from "../../helpers/catalog-graphs.js";
import {
  internalValues,
  runNotificationScenario,
  type NotificationMockContext,
  type NotificationMockInput,
  type NotificationScenarioResult,
} from "../../helpers/notification-scenario.js";

const workflow = catalogGraph("workflow-management-flow");
const note = "Build the release checklist";
const stages = [{ title: "Collect the release items" }, { title: "Check each item" }];
const QUESTION = /\b(?:choose|approve|reject)\b|\?/iu;

type Answer = Record<string, unknown>;
type Mode = "interactive" | "autonomous";

/** Every step's own progress outcomes, which the flow requires beside the step's answer. */
function withProgress(nodeId: string, answer: Answer): Answer {
  const target = workflow.nodes.find((candidate) => candidate.id === nodeId) as
    { inputSchema?: { globalInputs?: string[] } } | undefined;
  const progress = (target?.inputSchema?.globalInputs ?? []).filter((name) =>
    name.startsWith("progress_"),
  );
  return { ...Object.fromEntries(progress.map((name) => [name, "Pending"])), ...answer };
}

function prepared(mocks: Record<string, NotificationMockInput>) {
  return Object.fromEntries(
    Object.entries(mocks).map(([nodeId, mock]) => [
      nodeId,
      typeof mock === "function"
        ? (ctx: NotificationMockContext) => withProgress(nodeId, mock(ctx))
        : Array.isArray(mock)
          ? mock.map((item) => withProgress(nodeId, item))
          : withProgress(nodeId, mock),
    ]),
  );
}

function answers(
  action: "create" | "edit",
  mode: Mode,
  tier: "simple" | "standard" | "complex",
  extra: Record<string, NotificationMockInput> = {},
): Record<string, NotificationMockInput> {
  const workspace = `./moira-ws/workflow-management-flow-${action}-${tier}-${mode}`;
  return prepared({
    "get-action-type": {
      action_type: action,
      operating_mode: mode,
      workspace_path: workspace,
      execution_note: note,
      ...(action === "edit" ? { workflow_identity: "release-checklist", offline_mode: false } : {}),
    },
    "prepare-edit-workflow": {
      local_workflow_path: "",
      workflow_artifact_path: `${workspace}/workflow.json`,
    },
    "gather-workflow-requirements": { complexity_tier: tier, planned_changes: stages },
    "gather-edit-requirements": {
      recorded_tier: tier,
      complexity_tier: tier,
      planned_changes: stages,
    },
    "ask-full-antipattern-audit": {
      full_antipattern_audit: "no",
      decision_summary: "The change is narrow and the flow was audited last week",
    },
    "audit-complete-workflow": { additional_edit_scope: "none" },
    "design-workflow-structure": { planned_changes: stages },
    "create-edit-plan": { planned_changes: stages },
    "review-workflow-design": { design_review_outcome: "pass" },
    "approve-structure": { structure_approved: "yes" },
    "present-edit-plan": { plan_approval: "yes" },
    "create-workflow-json": { workflow_artifact_path: `${workspace}/workflow.json` },
    "apply-workflow-changes": {},
    "review-workflow-minimum": { light_repair_pending: "", light_review_outcome: "pass" },
    "review-workflow-quality": { quality_review_outcome: "pass" },
    "user-final-review": { work_approved: "yes" },
    "report-final-result": {},
    "ask-upload": {
      upload_confirmed: false,
      decision_summary: "No upload was authorized for this run",
      workflow_name: "Release checklist",
      workflow_version: "1.2.0",
    },
    ...extra,
  });
}

const heading = (run: NotificationScenarioResult) =>
  `[Workflow Management Flow · ${note}](${runPageUrl({ executionId: run.executionId })})`;

/** The messages that put a question to the person; an autonomous run sends none of them. */
const ASKING = new Set([
  "notify-structure-approval",
  "notify-edit-plan-approval",
  "notify-audit-question",
  "notify-final-review",
  "notify-upload-question",
  "notify-upload-error",
]);

/** The steps where the flow waits for the person's decision (`humanGate`). */
const GATES = new Set([
  "approve-structure",
  "present-edit-plan",
  "user-final-review",
  "ask-full-antipattern-audit",
  "ask-upload",
  "handle-upload-error",
]);

/** The stored «waiting for you» mark at each visit of a step, in order. */
const gateMarks = (run: NotificationScenarioResult, nodeId: string) =>
  run.pauses.filter((pause) => pause.nodeId === nodeId).map((pause) => pause.gateWaiting);

function expectClean(run: NotificationScenarioResult, mode: Mode) {
  for (const { text } of run.notifications) {
    expect(text.startsWith(heading(run))).toBe(true);
    expect(internalValues(text, workflow)).toEqual([]);
  }
  // Exactly the questions ask: none in an autonomous run, each question in an interactive one.
  const sent = run.notifications.map((message) => message.nodeId);
  expect(
    run.notifications.filter((message) => QUESTION.test(message.text)).map((m) => m.nodeId),
  ).toEqual(mode === "autonomous" ? [] : sent.filter((id) => ASKING.has(id)));
  // An interactive run waits for the person at every decision step, and each question ends by
  // saying so; an autonomous run decides every step it enters and never waits for the person.
  const atGates = run.pauses.filter((pause) => GATES.has(pause.nodeId));
  expect(atGates.map((pause) => [pause.nodeId, pause.gateWaiting])).toEqual(
    atGates.map((pause) => [pause.nodeId, mode === "interactive"]),
  );
  if (mode === "autonomous") expect(run.pauses.filter((pause) => pause.gateWaiting)).toEqual([]);
  for (const message of run.notifications.filter((m) => ASKING.has(m.nodeId))) {
    expect(message.text).toMatch(/🙋 waiting for you: [^\n]+$/u);
  }
}

const ids = (run: NotificationScenarioResult) => run.notifications.map((message) => message.nodeId);
const text = (run: NotificationScenarioResult, nodeId: string) =>
  run.notifications.find((message) => message.nodeId === nodeId)!.text;
const PLAN_READY = new Set([
  "notify-create-started",
  "notify-edit-started",
  "notify-structure-approval",
  "notify-edit-plan-approval",
]);
const LIST_PENDING = "📝 0/2\n○ 1. Collect the release items\n○ 2. Check each item";
const LIST_DONE = "📝 2/2\n✓ 1. Collect the release items\n✓ 2. Check each item";

describe("Workflow Management Flow notifications", () => {
  test.each([
    [
      "create",
      "simple",
      "interactive",
      ["notify-create-started", "notify-final-review", "notify-upload-question", "notify-finished"],
    ],
    [
      "create",
      "simple",
      "autonomous",
      ["notify-create-started", "notify-upload-not-saving", "notify-finished"],
    ],
    [
      "create",
      "standard",
      "interactive",
      [
        "notify-structure-approval",
        "notify-final-review",
        "notify-upload-question",
        "notify-finished",
      ],
    ],
    [
      "create",
      "standard",
      "autonomous",
      ["notify-create-started", "notify-upload-not-saving", "notify-finished"],
    ],
    [
      "edit",
      "simple",
      "interactive",
      ["notify-edit-started", "notify-final-review", "notify-upload-question", "notify-finished"],
    ],
    [
      "edit",
      "standard",
      "interactive",
      [
        "notify-audit-question",
        "notify-edit-plan-approval",
        "notify-final-review",
        "notify-upload-question",
        "notify-finished",
      ],
    ],
    [
      "edit",
      "standard",
      "autonomous",
      [
        "notify-audit-skipped",
        "notify-edit-started",
        "notify-upload-not-saving",
        "notify-finished",
      ],
    ],
    [
      "edit",
      "simple",
      "autonomous",
      ["notify-edit-started", "notify-upload-not-saving", "notify-finished"],
    ],
    // The complex level: a new workflow takes the design path; an edit is audited in full
    // without the audit question, then its plan is approved.
    [
      "create",
      "complex",
      "autonomous",
      ["notify-create-started", "notify-upload-not-saving", "notify-finished"],
    ],
    [
      "edit",
      "complex",
      "interactive",
      [
        "notify-edit-plan-approval",
        "notify-final-review",
        "notify-upload-question",
        "notify-finished",
      ],
    ],
  ] as const)(
    "%s at the %s level, %s: the plan, the questions, the finish",
    async (action, tier, mode, sequence) => {
      const run = await runNotificationScenario(workflow, {
        mockInputs: answers(action, mode, tier),
      });
      expect(ids(run)).toEqual(sequence);
      expectClean(run, mode);
      // The autonomous run enters the save question itself, and the audit question in a standard
      // edit, and answers them without the person.
      if (mode === "autonomous") {
        expect(gateMarks(run, "ask-upload")).toEqual([false]);
        if (action === "edit" && tier === "standard") {
          expect(gateMarks(run, "ask-full-antipattern-audit")).toEqual([false]);
        }
      }
      // The plan when it is announced: nothing done yet, every stage or change listed.
      const plan = run.notifications.find((message) => PLAN_READY.has(message.nodeId))!;
      expect(plan.text).toContain(LIST_PENDING);
      const finish = text(run, "notify-finished");
      expect(finish).toMatch(
        new RegExp(
          `🏁 \\*Workflow ${action === "create" ? "created" : "updated"}\\* — “Release checklist” version 1\\.2\\.0, not saved to the catalogue\\.`,
          "u",
        ),
      );
      expect(finish).toContain(LIST_DONE);
    },
  );

  test("interactive plan approval names the choices and lists the stages", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("create", "interactive", "standard"),
    });
    const approval = text(run, "notify-structure-approval");
    expect(approval).toContain(
      "approve it and the workflow is built, or reject it with feedback and the structure is revised",
    );
    expect(approval).toContain(LIST_PENDING);
    expect(text(run, "notify-final-review")).toContain(
      "approve it and it goes on to saving, or ask for changes",
    );
    expect(text(run, "notify-upload-question")).toContain(
      "Choose how to save it, or not to save it.",
    );
  });

  test("a plan revised after the person rejects the result is announced again with nothing done", async () => {
    const revised = [...stages, { title: "Publish the checklist" }];
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("create", "interactive", "simple", {
        "user-final-review": [
          { work_approved: "no", final_feedback: "Add a publishing step" },
          { work_approved: "yes" },
        ],
        "revise-create-requirements": { planned_changes: revised },
      }),
    });
    expect(ids(run)).toEqual([
      "notify-create-started",
      "notify-final-review",
      "notify-create-started",
      "notify-final-review",
      "notify-upload-question",
      "notify-finished",
    ]);
    expect(run.notifications[2].text).toContain(
      "📝 0/3\n○ 1. Collect the release items\n○ 2. Check each item\n○ 3. Publish the checklist",
    );
    expect(text(run, "notify-finished")).toContain(
      "📝 3/3\n✓ 1. Collect the release items\n✓ 2. Check each item\n✓ 3. Publish the checklist",
    );
  });

  test("a plan revised at the standard level after the person rejects the result is announced again with nothing done", async () => {
    const redesigned = [{ title: "Collect the release items" }, { title: "Sign off the release" }];
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("create", "interactive", "standard", {
        "user-final-review": [
          { work_approved: "no", final_feedback: "Replace the check with a sign-off" },
          { work_approved: "yes" },
        ],
        "revise-create-requirements": { planned_changes: redesigned },
        "design-workflow-structure": [{ planned_changes: stages }, { planned_changes: redesigned }],
      }),
    });
    const approvals = run.notifications.filter((m) => m.nodeId === "notify-structure-approval");
    expect(approvals).toHaveLength(2);
    // Built once already, the new plan still reads as nothing done.
    expect(approvals[1].text).toContain(
      "📝 0/2\n○ 1. Collect the release items\n○ 2. Sign off the release",
    );
    expect(text(run, "notify-finished")).toContain(
      "📝 2/2\n✓ 1. Collect the release items\n✓ 2. Sign off the release",
    );
  });

  test("a process revision on the simple level announces the corrected plan before the new build", async () => {
    const corrected = [{ title: "Collect the release items" }, { title: "Tag the release" }];
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("create", "interactive", "simple", {
        "teleport-revise-process": { planned_changes: corrected },
      }),
      teleportAt: {
        node: "review-workflow-minimum",
        visit: 1,
        teleportTo: "teleport-revise-process",
      },
    });
    const started = run.notifications.filter((m) => m.nodeId === "notify-create-started");
    expect(started).toHaveLength(2);
    expect(started[1].text).toContain(
      "📝 0/2\n○ 1. Collect the release items\n○ 2. Tag the release",
    );
    expect(text(run, "notify-finished")).toContain(
      "📝 2/2\n✓ 1. Collect the release items\n✓ 2. Tag the release",
    );
  });

  test("a person who lowers the level at the approval is told the lowered plan before it is built", async () => {
    const lowered = [{ title: "List the release items" }];
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("create", "interactive", "standard", {
        "approve-structure": {
          structure_approved: "no",
          structure_feedback: "Too many stages for this",
          lowering_request: "Just a simple list, please",
          complexity_tier: "simple",
          escalation_reason: "",
          planned_changes: lowered,
        },
      }),
    });
    expect(ids(run).slice(0, 2)).toEqual(["notify-structure-approval", "notify-create-started"]);
    expect(text(run, "notify-create-started")).toContain("📝 0/1\n○ 1. List the release items");
    expect(text(run, "notify-finished")).toContain("📝 1/1\n✓ 1. List the release items");
    expectClean(run, "interactive");
  });

  test("a lowering without the lowered plan is refused", async () => {
    await expect(
      runNotificationScenario(workflow, {
        mockInputs: answers("create", "interactive", "standard", {
          "approve-structure": {
            structure_approved: "no",
            structure_feedback: "Too many stages for this",
            lowering_request: "Just a simple list, please",
            complexity_tier: "simple",
            escalation_reason: "",
          },
        }),
      }),
    ).rejects.toThrow(/The answer for approve-structure \(visit 1\) was rejected/u);
  });

  test("a run that saved, was revised and then not saved ends saying it is not in the catalogue", async () => {
    const workspace = "./moira-ws/workflow-management-flow-edit-saved-then-revised";
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("edit", "interactive", "simple", {
        "prepare-edit-workflow": {
          local_workflow_path: "workflows/release-checklist.json",
          workflow_artifact_path: `${workspace}/workflow.json`,
        },
        "ask-upload": [
          {
            upload_confirmed: true,
            upload_method: "standard",
            decision_summary: "The person chose to save it",
            workflow_name: "Release checklist",
            workflow_version: "1.2.0",
          },
          {
            upload_confirmed: false,
            decision_summary: "The person keeps the revised version local",
            workflow_name: "Release checklist",
            workflow_version: "1.3.0",
          },
        ],
        "save-workflow-to-target": { upload_success: "yes" },
        "sync-local-file": {},
        "teleport-revise-process": { planned_changes: stages },
      }),
      teleportAt: { node: "sync-local-file", visit: 1, teleportTo: "teleport-revise-process" },
    });
    expect(text(run, "notify-finished")).toContain(
      "“Release checklist” version 1.3.0, not saved to the catalogue.",
    );
  });

  test.each([
    ["yes", "notify-audit-chosen", "auditing the whole workflow before planning the change"],
    ["no", "notify-audit-skipped", "planning only the requested change, without a full audit"],
  ] as const)(
    "autonomous audit decision %s is announced after it, with the reason",
    async (value, nodeId, words) => {
      const run = await runNotificationScenario(workflow, {
        mockInputs: answers("edit", "autonomous", "standard", {
          "ask-full-antipattern-audit": {
            full_antipattern_audit: value,
            decision_summary: "The flow was imported from an unknown source",
          },
          "audit-complete-workflow": { additional_edit_scope: "none" },
        }),
      });
      expect(ids(run).filter((id) => id.startsWith("notify-audit"))).toEqual([nodeId]);
      expect(run.route.indexOf("ask-full-antipattern-audit")).toBeLessThan(
        run.route.indexOf(nodeId),
      );
      expect(text(run, nodeId)).toContain(
        `🔁 *Decided for you* — ${words}. The flow was imported from an unknown source`,
      );
      expectClean(run, "autonomous");
    },
  );

  test("an autonomous upload the task authorized is announced, and the finish says it is in the catalogue", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("create", "autonomous", "standard", {
        "ask-upload": {
          upload_confirmed: true,
          upload_method: "standard",
          decision_summary: "The task asked for the new workflow to be published",
          workflow_name: "Release checklist",
          workflow_version: "1.2.0",
        },
        "save-workflow-to-target": { upload_success: "yes" },
      }),
    });
    expect(ids(run)).toEqual(["notify-create-started", "notify-upload-saving", "notify-finished"]);
    expect(text(run, "notify-upload-saving")).toContain(
      "saving the workflow to your catalogue. The task asked for the new workflow to be published",
    );
    expect(text(run, "notify-finished")).toContain(
      "“Release checklist” version 1.2.0, saved to your workflow catalogue.",
    );
    expectClean(run, "autonomous");
  });

  const failedUpload = {
    upload_success: "no",
    upload_error: "HTTP 503 from /api/workflows/5727de67",
    failure_summary: "The server was unavailable",
  };

  test("interactive: a failed upload asks with the reason and the choices; cancelling ends the run cancelled", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("create", "interactive", "simple", {
        "ask-upload": {
          upload_confirmed: true,
          upload_method: "standard",
          decision_summary: "The person chose to save it",
          workflow_name: "Release checklist",
          workflow_version: "1.2.0",
        },
        "save-workflow-to-target": failedUpload,
        "handle-upload-error": {
          error_action: "cancel",
          decision_summary: "The person cancelled because the server is down",
        },
      }),
    });
    expect(ids(run).slice(-2)).toEqual(["notify-upload-error", "notify-cancelled"]);
    expect(text(run, "notify-upload-error")).toContain(
      "⚠️ *Saving the workflow failed* — The server was unavailable\n\nChoose: try again, keep it unsaved, or cancel. When the workflow belongs to someone else, you can instead save a separate copy, or replace the original if you have administrator rights.",
    );
    const cancelled = text(run, "notify-cancelled");
    expect(cancelled).toContain(
      "⏹ *Cancelled* — “Release checklist” version 1.2.0 was built but not saved: The server was unavailable",
    );
    expect(cancelled).toContain(LIST_DONE);
    expect(gateMarks(run, "handle-upload-error")).toEqual([true]);
    expectClean(run, "interactive");
  });

  test.each([
    ["retry", "trying the upload again"],
    ["copy_new", "saving it as a separate copy"],
    ["admin_override", "replacing the original workflow"],
  ] as const)(
    "autonomous upload error: %s is announced after the decision, then a skip",
    async (action, words) => {
      const run = await runNotificationScenario(workflow, {
        mockInputs: answers("create", "autonomous", "simple", {
          "ask-upload": {
            upload_confirmed: true,
            upload_method: "standard",
            decision_summary: "The task asked for it to be published",
            workflow_name: "Release checklist",
            workflow_version: "1.2.0",
          },
          "save-workflow-to-target": [failedUpload, failedUpload],
          "handle-upload-error": [
            { error_action: action, decision_summary: "The task authorized this method" },
            { error_action: "skip", decision_summary: "The server stays unavailable" },
          ],
        }),
      });
      expect(ids(run)).toEqual([
        "notify-create-started",
        "notify-upload-saving",
        "notify-upload-retrying",
        "notify-upload-skipped",
        "notify-finished",
      ]);
      expect(text(run, "notify-upload-retrying")).toContain(
        `🔁 *Decided for you* — ${words}. The task authorized this method`,
      );
      expect(text(run, "notify-upload-skipped")).toContain(
        "keeping the workflow unsaved. The server stays unavailable",
      );
      expect(text(run, "notify-finished")).toContain("not saved to the catalogue.");
      expect(gateMarks(run, "handle-upload-error")).toEqual([false, false]);
      expectClean(run, "autonomous");
    },
  );

  // The reader lines exist only because the flow refuses an answer without them.
  test.each([
    ["get-action-type", "execution_note", "create", "standard"],
    ["gather-workflow-requirements", "planned_changes", "create", "simple"],
    ["design-workflow-structure", "planned_changes", "create", "standard"],
    ["create-edit-plan", "planned_changes", "edit", "standard"],
    ["ask-full-antipattern-audit", "decision_summary", "edit", "standard"],
    ["ask-upload", "decision_summary", "create", "simple"],
    ["ask-upload", "workflow_version", "create", "simple"],
  ] as const)("%s refuses an answer without %s (%s, %s)", async (nodeId, field, action, tier) => {
    const base = answers(action, "interactive", tier);
    const answer: Answer = { ...(base[nodeId] as Answer) };
    delete answer[field];
    await expect(
      runNotificationScenario(workflow, { mockInputs: { ...base, [nodeId]: answer } }),
    ).rejects.toThrow(new RegExp(`The answer for ${nodeId} \\(visit 1\\) was rejected`, "u"));
  });

  test("a failed upload is refused without its reason, and an autonomous error decision without its summary", async () => {
    const upload = {
      "ask-upload": {
        upload_confirmed: true,
        upload_method: "standard",
        decision_summary: "Authorized",
        workflow_name: "Release checklist",
        workflow_version: "1.2.0",
      },
    };
    const { failure_summary: _reason, ...failedWithoutReason } = failedUpload;
    await expect(
      runNotificationScenario(workflow, {
        mockInputs: answers("create", "interactive", "simple", {
          ...upload,
          "save-workflow-to-target": failedWithoutReason,
        }),
      }),
    ).rejects.toThrow(/The answer for save-workflow-to-target \(visit 1\) was rejected/u);
    await expect(
      runNotificationScenario(workflow, {
        mockInputs: answers("create", "autonomous", "simple", {
          ...upload,
          "save-workflow-to-target": failedUpload,
          "handle-upload-error": { error_action: "skip" },
        }),
      }),
    ).rejects.toThrow(/The answer for handle-upload-error \(visit 1\) was rejected/u);
  });

  test("the flow validates without a notification content warning", async () => {
    const result = await new GraphValidator().validateUnified(workflow as WorkflowGraph);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.message.startsWith("Notification "))).toEqual([]);
  });
});
