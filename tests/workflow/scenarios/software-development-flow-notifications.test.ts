/**
 * What a person receives from a Software Development Flow run, in both operating modes: the plan
 * with its goal when it is ready (to approve, or already started), each unit as its report or its
 * approval requires — one message when a unit needs both — every blocker with its reason and the
 * choices, the final result to approve, and the finish, the finish without the final commit or the
 * stop, each with the plan's units and their state. Every text is headed by the flow and the task,
 * linked to the run, with nothing internal in it; reports are linked by their URL.
 */

import { describe, expect, test } from "@jest/globals";
import { GraphValidator, runPageUrl } from "@mcp-moira/workflow-engine";
import { catalogGraph } from "../../helpers/catalog-graphs.js";
import {
  internalValues,
  runNotificationScenario,
  type NotificationMockInput,
  type NotificationScenarioResult,
} from "../../helpers/notification-scenario.js";

const workflow = catalogGraph("software-development-flow");
const note = "Add the export button";
const UNITS = [{ title: "Add the export endpoint" }, { title: "Add the export button" }];
const REPORT = "https://moira.example/artifacts/unit-report.html";
const FINAL = "https://5bd31ded.static.moira.example/";
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

function answers(
  mode: Mode,
  extra: Record<string, NotificationMockInput> = {},
): Record<string, NotificationMockInput> {
  const mocks: Record<string, NotificationMockInput> = {
    "capture-task-and-context": {
      workspace_path: "./moira-ws/sdf-notifications",
      operating_mode: mode,
      visual_validation_preference: "disabled",
      execution_note: note,
      goal_summary: "Users can download their data as a spreadsheet",
    },
    "confirm-requirements": { requirements_approval: "yes" },
    "assess-project-health": { health_outcome: "pass" },
    "create-plan": { plan_units: UNITS },
    "review-plan": { review_outcome: "pass" },
    "approve-plan": { plan_approval: "yes" },
    "activate-reviewed-plan": { current_step_index: 1, vcs_commits_authorized: false },
    "prepare-plan-unit-implementation": {
      preparation_outcome: "ready",
      visual_mode: "disabled",
      approval_required: false,
    },
    "implement-plan-unit": {},
    "complete-plan-unit": { completion_outcome: "ready" },
    "validate-cheap": { issues_count: 0 },
    "review-test-adequacy": { review_outcome: "pass" },
    "review-architecture": { review_outcome: "pass" },
    "validate-runtime": { validation_outcome: "not_applicable" },
    "validate-expensive": { validation_outcome: "not_applicable" },
    "update-unit-documentation": { documentation_outcome: "ready" },
    "review-unit-completeness": {
      review_outcome: "pass",
      unit_result_summary: "The endpoint returns the data as a spreadsheet",
    },
    "create-and-upload-step-report": { report_url: REPORT },
    "review-plan-unit-with-user": { acceptance_decision: "accepted" },
    "checkpoint-plan-unit": {},
    "validate-feature-wide": { validation_outcome: "not_applicable" },
    "review-final-semantics": {
      review_outcome: "pass",
      gaps_count: 0,
      review_file: "./moira-ws/sdf-notifications/final-reviews/001/review.md",
    },
    "create-final-report": {
      final_report_url: FINAL,
      outcome_summary: "Users can export their data from the settings page",
      limitations_summary: "Exports larger than 10,000 rows are not paged yet",
    },
    "report-and-accept-feature": { feature_decision: "accepted" },
    "finalize-feature": { finalization_outcome: "pass" },
    ...extra,
  };
  return Object.fromEntries(
    Object.entries(mocks).map(([nodeId, mock]) => [
      nodeId,
      Array.isArray(mock)
        ? mock.map((item) => withProgress(nodeId, item))
        : withProgress(nodeId, mock as Answer),
    ]),
  );
}

const heading = (run: NotificationScenarioResult) =>
  `[Software Development Flow · ${note}](${runPageUrl({ executionId: run.executionId })})`;
const ids = (run: NotificationScenarioResult) => run.notifications.map((m) => m.nodeId);
const text = (run: NotificationScenarioResult, nodeId: string) =>
  run.notifications.find((m) => m.nodeId === nodeId)!.text;

/** The messages that put a choice to the person. */
const ASKING = new Set([
  "notify-plan-approval",
  "notify-unit-approval",
  "notify-unit-approval-report",
  "notify-final-approval",
  "notify-health-blocker",
  "notify-runtime-blocker",
  "notify-expensive-blocker",
  "notify-feature-blocker",
  "notify-finalization-blocker",
  "notify-unit-closure",
]);

function expectClean(run: NotificationScenarioResult) {
  for (const { text: body } of run.notifications) {
    expect(body.startsWith(heading(run))).toBe(true);
    expect(internalValues(body, workflow)).toEqual([]);
  }
  // Exactly the questions ask.
  expect(run.notifications.filter((m) => QUESTION.test(m.text)).map((m) => m.nodeId)).toEqual(
    ids(run).filter((id) => ASKING.has(id)),
  );
}

/** The stored «waiting for you» mark at each visit of a step, in order. */
const gateMarks = (run: NotificationScenarioResult, nodeId: string) =>
  run.pauses.filter((pause) => pause.nodeId === nodeId).map((pause) => pause.gateWaiting);

/** A message sent right before a step the person decides ends by saying the run waits for them. */
const WAITING_FOR_YOU = /🙋 waiting for you: [^\n]+$/u;

const ALL_DONE = "📝 2/2\n✓ 1. Add the export endpoint\n✓ 2. Add the export button";
const unitTwoPlan = (overrides: Answer) => [
  { preparation_outcome: "ready", visual_mode: "disabled", approval_required: false },
  { preparation_outcome: "ready", ...overrides },
];

describe("Software Development Flow notifications", () => {
  test("interactive: plan to approve, a unit to approve, a unit with report and approval in one message, the result to approve, the finish", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("interactive", {
        "prepare-plan-unit-implementation": [
          { preparation_outcome: "ready", visual_mode: "disabled", approval_required: true },
          { preparation_outcome: "ready", visual_mode: "html_report", approval_required: true },
        ],
      }),
    });
    expect(ids(run)).toEqual([
      "notify-plan-approval",
      "notify-unit-approval",
      "notify-unit-approval-report",
      "notify-final-approval",
      "notify-workflow-complete",
    ]);
    expectClean(run);
    const [plan, unitOne, unitTwo, finalApproval, finished] = run.notifications.map((m) => m.text);
    expect(plan).toContain("🎯 Goal: Users can download their data as a spreadsheet");
    expect(plan).toContain(
      "Approve it and the work goes ahead on this plan, or reject it with feedback",
    );
    expect(plan).toContain("○ 2. Add the export button");
    expect(unitOne).toContain(
      "👤 *Unit 1 “Add the export endpoint” is ready for your review* — The endpoint returns the data as a spreadsheet",
    );
    expect(unitOne).not.toContain("Report:");
    expect(unitTwo).toContain("Unit 2 “Add the export button” is ready for your review");
    expect(unitTwo).toContain(`Report: ${REPORT}`);
    expect(finalApproval).toContain("Users can export their data from the settings page");
    expect(finalApproval).toContain("Limitations: Exports larger than 10,000 rows");
    expect(finalApproval).toContain(`Final report: ${FINAL}`);
    expect(finalApproval).toContain(ALL_DONE);
    expect(finished).toMatch(/^\[[^\n]+\]\([^\n]+\)\n+🏁 \*Finished\* — Users can export/u);
    expect(finished).toContain("No commits were made; the changes are in the working tree.");
    expect(finished).toContain(`Final report: ${FINAL}`);
    expect(finished).toContain(ALL_DONE);
    // Every decision here is the person's.
    expect(gateMarks(run, "confirm-requirements")).toEqual([true]);
    expect(gateMarks(run, "approve-plan")).toEqual([true]);
    expect(gateMarks(run, "review-plan-unit-with-user")).toEqual([true, true]);
    expect(gateMarks(run, "report-and-accept-feature")).toEqual([true]);
    for (const message of [plan, unitOne, unitTwo, finalApproval]) {
      expect(message).toMatch(WAITING_FOR_YOU);
    }
  });

  test("autonomous: the work goes ahead with the goal, a report without stopping for approval, the finish with the commits — nothing asks", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("autonomous", {
        "activate-reviewed-plan": { current_step_index: 1, vcs_commits_authorized: true },
        "prepare-plan-unit-implementation": unitTwoPlan({
          visual_mode: "html_report",
          approval_required: true,
        }),
      }),
    });
    expect(ids(run)).toEqual([
      "notify-implementation-started",
      "notify-report-ready",
      "notify-workflow-complete",
    ]);
    expectClean(run);
    expect(run.route).not.toContain("review-plan-unit-with-user");
    const [started, report, finished] = run.notifications.map((m) => m.text);
    expect(started).toContain("▶️ *Plan approved — the work goes ahead on this plan.*");
    expect(started).toContain("🎯 Goal: Users can download their data as a spreadsheet");
    expect(started).toContain("○ 2. Add the export button");
    expect(report).toContain(
      `🖼 *Unit 2 “Add the export button” is done* — The endpoint returns the data as a spreadsheet\n\nReport: ${REPORT}`,
    );
    expect(finished).toContain("The work is committed locally.");
    expect(finished).toContain(ALL_DONE);
    expect(run.pauses.filter((pause) => pause.gateWaiting)).toEqual([]);
  });

  test.each([
    [
      "the health check",
      {
        "assess-project-health": [
          { health_outcome: "external_blocker" },
          { health_outcome: "pass" },
        ],
      },
      "notify-health-blocker",
      "🚧 *Blocked before planning* — The package registry is unreachable",
      "assess-project-health",
    ],
    [
      "runtime validation",
      {
        "validate-runtime": [
          { validation_outcome: "external_blocker" },
          { validation_outcome: "not_applicable" },
          { validation_outcome: "not_applicable" },
        ],
      },
      "notify-runtime-blocker",
      "🚧 *Unit 1 “Add the export endpoint” is blocked* — The package registry is unreachable",
      "validate-runtime",
    ],
    [
      "broad validation",
      {
        "validate-expensive": [
          { validation_outcome: "external_blocker" },
          { validation_outcome: "not_applicable" },
          { validation_outcome: "not_applicable" },
        ],
      },
      "notify-expensive-blocker",
      "🚧 *Unit 1 “Add the export endpoint” is blocked* — The package registry is unreachable",
      "validate-expensive",
    ],
    [
      "the final checks",
      {
        "validate-feature-wide": [
          { validation_outcome: "external_blocker" },
          { validation_outcome: "not_applicable" },
        ],
      },
      "notify-feature-blocker",
      "🚧 *The final checks are blocked* — The package registry is unreachable",
      "validate-feature-wide",
    ],
  ] as const)(
    "a blocker at %s is sent with its reason and the choices, in both modes",
    async (_where, blocked, nodeId, words, source) => {
      for (const mode of ["interactive", "autonomous"] as const) {
        const [first, ...rest] = blocked[source as keyof typeof blocked] as unknown as Answer[];
        const run = await runNotificationScenario(workflow, {
          mockInputs: answers(mode, {
            [source]: [
              { ...first, blocker_summary: "The package registry is unreachable" },
              ...rest,
            ],
            [`wait-for-${nodeId.replace("notify-", "").replace("-blocker", "")}-state-change`]: {
              blocker_decision: "retry",
            },
          }),
        });
        expect(ids(run).filter((id) => id === nodeId)).toHaveLength(1);
        const message = text(run, nodeId);
        expect(message).toContain(words);
        expect(message).toContain(
          "Choose: fix it and let the agent try again, or end the whole run — the work done so far stays.",
        );
        // An external blocker waits for the person in both modes: the agent may retry on its own
        // only once the state has changed, and only the person can change it or end the run.
        const waitStep = `wait-for-${nodeId.replace("notify-", "").replace("-blocker", "")}-state-change`;
        expect(gateMarks(run, waitStep)).toEqual([true]);
        expect(message).toMatch(WAITING_FOR_YOU);
        expectClean(run);
      }
    },
  );

  test("finalization blocked: the choices include finishing without the final commit, and that finish says what is left", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("interactive", {
        "activate-reviewed-plan": { current_step_index: 1, vcs_commits_authorized: true },
        "prepare-plan-unit-implementation": unitTwoPlan({
          visual_mode: "disabled",
          approval_required: false,
        }),
        "finalize-feature": {
          finalization_outcome: "external_blocker",
          blocker_summary: "The repository is locked by another process",
        },
        "resolve-finalization-blocker": { blocker_decision: "finish_without_finalization" },
      }),
    });
    expect(ids(run).slice(-2)).toEqual([
      "notify-finalization-blocker",
      "notify-workflow-finished-without-finalization",
    ]);
    expect(text(run, "notify-finalization-blocker")).toContain(
      "🚧 *Finishing is blocked* — The repository is locked by another process\n\nChoose: fix it and let the agent try again, finish without the final local commit",
    );
    const closed = text(run, "notify-workflow-finished-without-finalization");
    expect(closed).toContain(
      "⚠️ *Finished without the final local commit* — The repository is locked by another process",
    );
    expect(closed).toContain("committing the remaining changes is left to you");
    expect(closed).toContain(ALL_DONE);
    expect(gateMarks(run, "resolve-finalization-blocker")).toEqual([true]);
    expectClean(run);
  });

  test("autonomous: a blocked finish still waits for the person, and the agent retries once it changed", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("autonomous", {
        "activate-reviewed-plan": { current_step_index: 1, vcs_commits_authorized: true },
        "prepare-plan-unit-implementation": unitTwoPlan({
          visual_mode: "disabled",
          approval_required: false,
        }),
        "finalize-feature": [
          {
            finalization_outcome: "external_blocker",
            blocker_summary: "The repository is locked by another process",
          },
          { finalization_outcome: "pass" },
        ],
        "resolve-finalization-blocker": { blocker_decision: "retry" },
      }),
    });
    expect(ids(run).slice(-2)).toEqual(["notify-finalization-blocker", "notify-workflow-complete"]);
    // Only the person can clear the external state or end the run, so the autonomous run is shown
    // as waiting for them while it stands there.
    expect(gateMarks(run, "resolve-finalization-blocker")).toEqual([true]);
    expect(text(run, "notify-finalization-blocker")).toMatch(WAITING_FOR_YOU);
    expectClean(run);
  });

  test("a person who ends the run at a blocker is told it stopped, why, and what is left", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("interactive", {
        "validate-runtime": {
          validation_outcome: "external_blocker",
          blocker_summary: "The staging database is down",
        },
        "wait-for-runtime-state-change": { blocker_decision: "end_workflow" },
      }),
    });
    expect(ids(run).slice(-2)).toEqual(["notify-runtime-blocker", "notify-workflow-stopped"]);
    const stopped = text(run, "notify-workflow-stopped");
    expect(stopped).toContain("⛔ *Stopped* — you ended the run. The staging database is down");
    expect(stopped).toContain("nothing after this point was done");
    // The run has ended: the unit it stopped in is not shown as still in progress.
    expect(stopped).toContain("📝 0/2\n○ 1. Add the export endpoint\n○ 2. Add the export button");
    expectClean(run);
  });

  test.each([
    [
      "the health check, before any plan",
      {
        "assess-project-health": {
          health_outcome: "external_blocker",
          blocker_summary: "The package registry is unreachable",
        },
        "wait-for-health-state-change": { blocker_decision: "end_workflow" },
      },
      "The package registry is unreachable",
      null,
    ],
    [
      "the final checks, with every unit done",
      {
        "validate-feature-wide": {
          validation_outcome: "external_blocker",
          blocker_summary: "The staging database is down",
        },
        "wait-for-feature-state-change": { blocker_decision: "end_workflow" },
      },
      "The staging database is down",
      ALL_DONE,
    ],
    [
      "finalization, with every unit done",
      {
        "activate-reviewed-plan": { current_step_index: 1, vcs_commits_authorized: true },
        "finalize-feature": {
          finalization_outcome: "external_blocker",
          blocker_summary: "The repository is locked by another process",
        },
        "resolve-finalization-blocker": { blocker_decision: "end_workflow" },
      },
      "The repository is locked by another process",
      ALL_DONE,
    ],
  ] as const)("a stop at %s says only what is true", async (_where, stop, reason, list) => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("interactive", stop as unknown as Record<string, NotificationMockInput>),
    });
    const stopped = text(run, "notify-workflow-stopped");
    expect(stopped).toContain(`you ended the run. ${reason}`);
    expect(stopped).toContain(
      "The work done so far stays in the repository; nothing after this point was done.",
    );
    // The list closes the message when a plan exists, and is absent before one.
    expect(stopped.match(/📝[^]*$/)?.[0] ?? null).toBe(list);
    expectClean(run);
  });

  test("a unit that needs a plan change asks an interactive person, and an autonomous run tells what the agent does with it", async () => {
    const replan = {
      "review-architecture": [
        {
          review_outcome: "replan",
          blocker_summary: "The export needs a background job the plan lacks",
        },
        { review_outcome: "pass" },
        { review_outcome: "pass" },
      ],
      "approve-current-unit-closure": { closure_decision: "approved" },
      "revise-plan-for-replan": { plan_units: UNITS },
      "activate-reviewed-plan": [
        { current_step_index: 1, vcs_commits_authorized: false },
        { current_step_index: 1, vcs_commits_authorized: false },
      ],
    };
    const interactive = await runNotificationScenario(workflow, {
      mockInputs: answers("interactive", replan),
    });
    expect(text(interactive, "notify-unit-closure")).toContain(
      "🔀 *Unit 1 “Add the export endpoint” needs a plan change* — The export needs a background job the plan lacks\n\nChoose: approve closing this unit and revising the plan, or end the whole run",
    );
    // The revised plan is put to the person again.
    expect(ids(interactive).filter((id) => id === "notify-plan-approval")).toHaveLength(2);
    expect(gateMarks(interactive, "approve-current-unit-closure")).toEqual([true]);
    expect(text(interactive, "notify-unit-closure")).toMatch(WAITING_FOR_YOU);
    expectClean(interactive);

    const autonomous = await runNotificationScenario(workflow, {
      mockInputs: answers("autonomous", replan),
    });
    // Autonomous: the person is told before the gate, in words true whichever way it decides.
    expect(ids(autonomous)).not.toContain("notify-unit-closure");
    expect(text(autonomous, "notify-unit-closure-agent")).toContain(
      "🔀 *Unit 1 “Add the export endpoint” needs a plan change* — The export needs a background job the plan lacks\n\nWhen the reason holds, the agent closes this unit and revises the plan; otherwise it will ask you whether to end the run.",
    );
    expect(autonomous.route.indexOf("notify-unit-closure-agent")).toBeLessThan(
      autonomous.route.indexOf("approve-current-unit-closure"),
    );
    expect(ids(autonomous).filter((id) => id === "notify-implementation-started")).toHaveLength(2);
    // The autonomous run decides the closure itself: nobody is waited for.
    expect(gateMarks(autonomous, "approve-current-unit-closure")).toEqual([false]);
    expect(text(autonomous, "notify-unit-closure-agent")).not.toContain("waiting for you");
    expectClean(autonomous);
  });

  test("a replan that changes the units is put again with the new titles, keeping the closed unit done", async () => {
    const revised = [
      { title: "Add the export endpoint" },
      { title: "Add the export job" },
      { title: "Add the export button" },
    ];
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("interactive", {
        "prepare-plan-unit-implementation": {
          preparation_outcome: "ready",
          visual_mode: "disabled",
          approval_required: true,
        },
        "review-architecture": [
          { review_outcome: "pass" },
          { review_outcome: "replan", blocker_summary: "Large exports need a background job" },
          { review_outcome: "pass" },
          { review_outcome: "pass" },
        ],
        "approve-current-unit-closure": { closure_decision: "approved" },
        "revise-plan-for-replan": { plan_units: revised },
        "activate-reviewed-plan": [
          { current_step_index: 1, vcs_commits_authorized: false },
          { current_step_index: 2, vcs_commits_authorized: false },
        ],
      }),
    });
    const plans = run.notifications.filter((m) => m.nodeId === "notify-plan-approval");
    expect(plans).toHaveLength(2);
    expect(plans[1].text).toContain(
      "📝 1/3\n✓ 1. Add the export endpoint\n▶ 2. Add the export job\n○ 3. Add the export button",
    );
    // After the revised plan is activated, the closed unit still counts as done.
    const approvals = run.notifications.filter((m) => m.nodeId === "notify-unit-approval");
    expect(approvals.map((m) => /📝 [^\n]+/u.exec(m.text)![0])).toEqual([
      "📝 0/2: Add the export endpoint",
      "📝 1/3: Add the export job",
      "📝 2/3: Add the export button",
    ]);
    expect(text(run, "notify-workflow-complete")).toContain(
      "📝 3/3\n✓ 1. Add the export endpoint\n✓ 2. Add the export job\n✓ 3. Add the export button",
    );
    expectClean(run);
  });

  test("on an HTTP instance the report links it serves are accepted and sent", async () => {
    // A self-hosted or dev instance without TLS serves artifacts over http.
    const unitReport = "http://3f1c.static.moira-localhost.localtest.me:8100/";
    const finalReport = "http://9af2.static.moira-localhost.localtest.me:8100/";
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("autonomous", {
        "prepare-plan-unit-implementation": {
          preparation_outcome: "ready",
          visual_mode: "html_report",
          approval_required: false,
        },
        "create-and-upload-step-report": { report_url: unitReport },
        "create-final-report": {
          final_report_url: finalReport,
          outcome_summary: "Users can export their data from the settings page",
          limitations_summary: "None",
        },
      }),
    });
    expect(text(run, "notify-report-ready")).toContain(`Report: ${unitReport}`);
    expect(text(run, "notify-workflow-complete")).toContain(`Final report: ${finalReport}`);
  });

  test("a goal revised with the requirements is the goal the plan message shows", async () => {
    const run = await runNotificationScenario(workflow, {
      mockInputs: answers("interactive", {
        "confirm-requirements": [
          { requirements_approval: "no", user_feedback: "Only a user's own projects" },
          { requirements_approval: "yes" },
        ],
        "revise-requirements": { goal_summary: "Users can export only their own projects" },
      }),
    });
    expect(text(run, "notify-plan-approval")).toContain(
      "🎯 Goal: Users can export only their own projects",
    );
  });

  // The reader lines exist only because the flow refuses an answer without them.
  test.each([
    ["capture-task-and-context", "execution_note", {}],
    ["capture-task-and-context", "goal_summary", {}],
    ["create-plan", "plan_units", {}],
    ["review-unit-completeness", "unit_result_summary", {}],
    ["create-final-report", "final_report_url", {}],
    ["create-final-report", "outcome_summary", {}],
    [
      "validate-runtime",
      "blocker_summary",
      { validation_outcome: "external_blocker", blocker_summary: "Down" },
    ],
  ] as const)("%s refuses an answer without %s", async (nodeId, field, base) => {
    const all = answers("interactive", Object.keys(base).length ? { [nodeId]: base } : {});
    const answer: Answer = { ...(all[nodeId] as Answer) };
    delete answer[field];
    await expect(
      runNotificationScenario(workflow, { mockInputs: { ...all, [nodeId]: answer } }),
    ).rejects.toThrow(new RegExp(`The answer for ${nodeId} \\(visit 1\\) was rejected`, "u"));
  });

  test("the flow validates without a notification content warning", async () => {
    const result = await new GraphValidator().validateUnified(workflow);
    expect(result.valid).toBe(true);
    expect(result.issues.filter((issue) => issue.message.startsWith("Notification "))).toEqual([]);
  });
});
