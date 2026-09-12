/**
 * The run page on a real Quick Task run: the lanes rail with block statuses, the block-detail
 * panel and the technical-graph focus, a repair loop shown as a repeated block with its return
 * arc, the route cursor dimming later visits and changing the lanes, the loading state, and the
 * page kept usable on a phone when the projection fails or the workflow has no process view.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import {
  advanceWorkflowExecution,
  createAuthenticatedMCPClient,
  startWorkflowExecutionState,
  type RunningWorkflowExecution,
} from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();
const workspace = "./moira-ws/quick-task-0000aaaa-0000-4000-8000-000000000000";

/** Drive a Quick Task through one rejected plan review into the second review: a real loop. */
async function quickTaskWithRepairLoop(
  client: Awaited<ReturnType<typeof createAuthenticatedMCPClient>>["client"],
): Promise<RunningWorkflowExecution> {
  const run = await startWorkflowExecutionState(client, "moira/quick-task", {
    skipTelegramCheck: true,
  });
  await advanceWorkflowExecution(client, run, {
    task_file: `${workspace}/task.md`,
    execution_file: `${workspace}/execution.md`,
    operating_mode: "autonomous",
    progress_scope_outcome: "Task contract captured",
  });
  await advanceWorkflowExecution(client, run, {
    current_plan_file: `${workspace}/plans/001/plan.md`,
    total_steps: 3,
    progress_plan_outcome: "Three-unit plan ready for review",
  });
  await advanceWorkflowExecution(client, run, {
    review_file: `${workspace}/plans/001/review.md`,
    issues_count: 1,
    progress_plan_outcome: "Plan review found a blocking issue",
  });
  await advanceWorkflowExecution(client, run, {
    current_plan_file: `${workspace}/plans/002/plan.md`,
    total_steps: 3,
    progress_plan_outcome: "Corrected plan replaced the rejected revision",
  });
  return run;
}

type ProgressMode = "live" | "none" | "error" | "slow";

async function openRun(page: Page) {
  const authenticated = await createAuthenticatedMCPClient();
  const run = await quickTaskWithRepairLoop(authenticated.client);
  let mode: ProgressMode = "live";
  let releaseSlow: (() => void) | undefined;
  let markSlowRequestStarted: (() => void) | undefined;
  const slowRequestStarted = new Promise<void>((resolve) => {
    markSlowRequestStarted = resolve;
  });
  await page.route(`**/api/executions/${run.processId}/progress**`, async (route) => {
    if (mode === "none") {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: '{"error":"none"}',
      });
      return;
    }
    if (mode === "error") {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"error":"failed"}',
      });
      return;
    }
    if (mode === "slow") {
      markSlowRequestStarted?.();
      await new Promise<void>((resolve) => {
        releaseSlow = resolve;
      });
    }
    await route.continue();
  });
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/executions/${run.processId}`);
  await expect(page.getByTestId("execution-progress")).toBeVisible();
  return {
    executionId: run.processId,
    setMode(next: ProgressMode) {
      mode = next;
    },
    slowRequestStarted,
    releaseSlow() {
      releaseSlow?.();
    },
    cleanup: authenticated.cleanup,
  };
}

test("lanes show the repair loop as a repeated block and the block panel drills into steps", async ({
  page,
}) => {
  const run = await openRun(page);
  try {
    // The second review is where the run waits: the review block (review, check and repair steps)
    // is on its second pass; the plan block completed once.
    const review = page.getByTestId("progress-node-plan-review");
    await expect(review).toHaveAttribute("aria-current", "step");
    await expect(review).toHaveAttribute("data-status", "waiting");
    await expect(review.getByTestId("lane-iterations")).toHaveText("×2");
    await expect(page.getByTestId("progress-node-plan")).toHaveAttribute("data-status", "done");
    await expect(page.getByTestId("progress-node-execute")).toHaveAttribute(
      "data-status",
      "pending",
    );
    // The lanes rail draws the return arc of the repair loop with its authored label.
    await expect(page.getByTestId("lanes-rail").locator("[data-arc]").first()).toBeVisible();
    await expect(page.getByTestId("lanes-rail")).toContainText("review found issues");

    // The block panel opens on the current block with its steps and expected evidence.
    const detail = page.getByTestId("block-detail");
    await expect(detail).toHaveAttribute("data-block-id", "plan-review");
    const currentStep = detail.locator('[data-node-id][aria-current="step"]');
    await expect(currentStep).toHaveAttribute("data-node-id", "plan-review");
    await expect(currentStep.locator("[data-node-inputs]")).toContainText("issues_count");

    // Selecting another block is a deep link and switches the panel to it. The rail opens
    // centred on the current lane at full size, so the first lane is outside its viewport until
    // the reader fits the whole rail (or pans); the fit control is the one-click way.
    await page.getByTestId("lanes-rail").locator(".react-flow__controls-fitview").click();
    await page.getByTestId("progress-node-scope").click();
    await expect(page).toHaveURL(/block=scope/);
    await expect(page.getByTestId("block-detail")).toHaveAttribute("data-block-id", "scope");

    // A step focuses the technical node graph in the graph tab: focusing two different steps
    // leaves the viewport on two different transforms. The lanes rail beside the panel is a
    // React Flow instance of its own, so the graph's viewport is read inside the panel.
    const graphViewport = page.getByTestId("run-panel").locator(".react-flow__viewport");
    const transformOf = () => graphViewport.evaluate((el) => window.getComputedStyle(el).transform);
    await page.getByTestId("block-detail").locator('[data-node-id="get-task"] button').click();
    await expect(page.getByRole("tab", { name: /Graph|Граф/ })).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect(graphViewport).toBeVisible({ timeout: 15000 });
    await expect.poll(transformOf).not.toBe("none");
    const onGetTask = await transformOf();
    await page.getByRole("tab", { name: /Block|Блок/ }).click();
    await page.getByTestId("block-detail").locator('[data-node-id="start"] button').click();
    await expect(page.getByRole("tab", { name: /Graph|Граф/ })).toHaveAttribute(
      "data-state",
      "active",
    );
    await expect.poll(transformOf, { timeout: 5000 }).not.toBe(onGetTask);
  } finally {
    await run.cleanup();
  }
});

test("the route cursor dims later visits and the lanes follow it; every mode is deep-linkable", async ({
  page,
}) => {
  const run = await openRun(page);
  try {
    await page.goto(`${BASE_URL}/executions/${run.executionId}?view=route`);
    const routeList = page.getByTestId("route-list");
    await expect(routeList).toBeVisible();
    // The repair loop stays inside the review block, so the route marks the revisited step as a
    // loop rather than a return between blocks.
    await expect(routeList.locator('[data-visit-seq][data-loop="true"]').first()).toBeVisible();
    await expect(routeList.locator('[data-visit-seq="6"]')).toHaveAttribute("data-loop", "true");

    // Put the cursor on the first plan step: later visits fade and the URL carries it.
    await routeList.locator('[data-visit-seq="2"]').click();
    await expect(page).toHaveURL(/at=2/);
    await expect(routeList.locator('[data-visit-seq="4"]')).toHaveAttribute("data-beyond", "true");
    await expect(page.getByTestId("cursor-position")).toContainText("2");

    // Lanes at the cursor: the plan block is active, the review block not yet reached.
    await page.getByTestId("run-modes").locator('[data-mode="lanes"]').click();
    await expect(page).toHaveURL(/view=lanes/);
    await expect(page.getByTestId("progress-node-plan")).toHaveAttribute("data-status", "active");
    await expect(page.getByTestId("progress-node-plan-review")).toHaveAttribute(
      "data-status",
      "pending",
    );
    await page.getByTestId("cursor-clear").click();
    await expect(page.getByTestId("progress-node-plan-review")).toHaveAttribute(
      "data-status",
      "waiting",
    );

    // Canvas fills the viewport and draws the loop as a distinct edge; outline reads the cycle.
    await page.goto(`${BASE_URL}/executions/${run.executionId}?view=canvas`);
    await expect(page.getByTestId("canvas-view")).toBeVisible({ timeout: 15000 });
    await expect(page.locator('[data-edge-kind="cycle"]').first()).toBeVisible();
    const canvasBox = await page.getByTestId("canvas-view").boundingBox();
    const pageBox = page.viewportSize()!;
    expect(canvasBox!.height).toBeGreaterThan(pageBox.height * 0.5);
    await page.goto(`${BASE_URL}/executions/${run.executionId}?view=outline`);
    await expect(page.getByTestId("outline-document")).toBeVisible();
    await expect(page.locator('[data-transition-kind="cycle"]').first()).toBeVisible();

    // The walkthrough opens from the header and lives in the URL.
    await page.getByTestId("guide-open").click();
    await expect(page.getByTestId("walkthrough")).toHaveAttribute("data-guide-step", "process");
    await page.getByTestId("walkthrough-next").click();
    await expect(page).toHaveURL(/guide=2/);
    await expect(page.getByTestId("walkthrough")).toHaveAttribute("data-guide-step", "agent");
  } finally {
    await run.cleanup();
  }
});

test("answering the waiting step from the page continues the run and records the adjustment", async ({
  page,
}) => {
  const authenticated = await createAuthenticatedMCPClient();
  try {
    const run = await startWorkflowExecutionState(authenticated.client, "moira/quick-task", {
      skipTelegramCheck: true,
    });
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/executions/${run.processId}`);
    await expect(page.getByTestId("progress-node-scope")).toHaveAttribute("data-status", "waiting");
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    const form = page.getByTestId("answer-form");
    await expect(form).toHaveAttribute("data-node-id", "get-task");
    // The form lists the step's own fields and the globals it declares; required ones gate submit.
    await expect(page.getByTestId("answer-submit")).toBeDisabled();
    await page.getByTestId("answer-field-task_file").fill(`${workspace}/task.md`);
    await page.getByTestId("answer-field-execution_file").fill(`${workspace}/execution.md`);
    await page.getByTestId("answer-field-operating_mode").selectOption("autonomous");
    await page.getByTestId("answer-field-progress_scope_outcome").fill("Captured from the page");
    // A schema-invalid answer is refused with the step's message and changes nothing.
    await page.getByTestId("answer-field-task_file").fill("nope");
    await page.getByTestId("answer-submit").click();
    await expect(page.getByTestId("answer-error")).toContainText(/validation/i);
    await expect(page.getByTestId("progress-node-scope")).toHaveAttribute("data-status", "waiting");
    await page.getByTestId("answer-field-task_file").fill(`${workspace}/task.md`);
    const answered = page.waitForResponse(
      (r) => r.url().includes("/answer") && r.request().method() === "POST" && r.status() === 200,
    );
    await page.getByTestId("answer-submit").click();
    await answered;
    // The run moved on: the scope block is done, the plan block waits, the route carries the
    // adjustment by the user. The variables table keeps every name inside the panel even with
    // long path values (a broken layout pushed the first column out of view).
    await expect(page.getByTestId("progress-node-scope")).toHaveAttribute("data-status", "done");
    const panelBox = (await page.getByTestId("run-panel").boundingBox())!;
    for (const name of ["operating_mode", "progress_scope_outcome"]) {
      const cell = page.locator(`[data-variable="${name}"] td`).first();
      const box = (await cell.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(panelBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
      await expect(cell).toContainText(name);
    }
    await expect(page.getByTestId("progress-node-plan")).toHaveAttribute("data-status", "waiting");
    await expect(page.getByTestId("adjustment-count")).toContainText("1");
    await page.getByTestId("run-modes").locator('[data-mode="route"]').click();
    const adjusted = page
      .getByTestId("route-list")
      .locator('[data-visit-seq][data-adjusted="true"]');
    await expect(adjusted).toHaveCount(1);
    await expect(adjusted).toContainText(/person|человек/i);
    // The agent's attempt from before the answer is stale: it must read current_step.
    const stale = await advanceWorkflowExecution(authenticated.client, run, {
      task_file: `${workspace}/task.md`,
      execution_file: `${workspace}/execution.md`,
      operating_mode: "autonomous",
      progress_scope_outcome: "from the agent",
    });
    expect(stale).toContain("ATTEMPT_STALE");
  } finally {
    await authenticated.cleanup();
  }
});

test("shows the loading state and keeps the page usable on a phone without a projection", async ({
  page,
}) => {
  const run = await openRun(page);
  try {
    run.setMode("slow");
    const reload = page.reload({ waitUntil: "domcontentloaded" });
    await run.slowRequestStarted;
    await expect(page.getByTestId("execution-progress-loading")).toBeVisible();
    run.releaseSlow();
    await reload;
    await expect(page.getByTestId("execution-progress")).toBeVisible();

    await page.setViewportSize({ width: 600, height: 900 });
    run.setMode("live");
    await page.reload();
    await expect(page.getByTestId("execution-progress")).toBeVisible();
    // Narrow width: the rail turns vertical and nothing overflows the page horizontally.
    await expect(page.locator("[data-lanes-orientation]")).toHaveAttribute(
      "data-lanes-orientation",
      "vertical",
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    // On a phone the mode note folds to its title and the picture keeps at least two fifths of
    // the viewport (the broken layout left the canvas a strip about a hundred pixels tall).
    await expect(page.getByTestId("guidance-lanes")).toHaveAttribute("data-folded", "true");
    const picture = (await page.getByTestId("execution-progress").boundingBox())!;
    expect(picture.height).toBeGreaterThanOrEqual(900 * 0.4);

    run.setMode("error");
    const errorResponse = page.waitForResponse(
      (response) => response.url().includes("/progress") && response.status() === 500,
    );
    await page.reload();
    await errorResponse;
    await expect(page.getByRole("status")).toContainText(
      /temporarily unavailable|временно недоступен/i,
    );
    await expect(page.locator(".react-flow__viewport")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("tab", { name: /Context|Контекст/ })).toBeVisible();

    run.setMode("none");
    const absentResponse = page.waitForResponse(
      (response) => response.url().includes("/progress") && response.status() === 404,
    );
    await page.reload();
    await absentResponse;
    await expect(page.getByText(run.executionId.substring(0, 8), { exact: true })).toBeVisible();
    await expect(page.locator(".react-flow__viewport")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("execution-progress")).toHaveCount(0);
  } finally {
    run.releaseSlow();
    await run.cleanup();
  }
});
