/**
 * The run page on a real Quick Task run, in its two views. On the map: block cards with their
 * status, pass count, measured time and the contents sidebar beside them, a repair loop shown as
 * a repeated block with its return chip, and the block panel carrying the block's timings, what
 * its visits did and the steps with their evidence. On the graph: the same run as the technical
 * node graph, which a step in the panel focuses. Plus the route cursor moving the whole page back
 * through the run, the deep links of both views (and of the views this page used to have), the
 * first-load state, and the page kept usable on a phone when the projection fails or the workflow
 * has no process view.
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
import { openPanelSection } from "./helpers/diagram.js";

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

/** A block's card on the map diagram (the contents row carries the same id in the sidebar). */
function mapCard(page: Page, blockId: string) {
  return page.locator(`[data-testid="canvas-view"] [data-block-id="${blockId}"]`);
}

test("the map shows the repair loop as a repeated block and the block panel tells its story", async ({
  page,
}) => {
  const run = await openRun(page);
  try {
    // The map is the default view.
    await expect(page.getByTestId("execution-progress")).toHaveAttribute("data-view", "map");
    await expect(page.getByTestId("map-view")).toBeVisible();

    // The second review is where the run waits: the review block (review, check and repair steps)
    // is on its second pass; the plan block completed once, the execute block is not reached.
    const review = mapCard(page, "plan-review");
    await expect(review).toHaveAttribute("data-current", "true");
    await expect(review).toHaveAttribute("data-status", "waiting");
    await expect(review).toContainText("×2");
    await expect(mapCard(page, "plan")).toHaveAttribute("data-status", "done");
    await expect(mapCard(page, "execute")).toHaveAttribute("data-status", "pending");

    // The contents sidebar lists every block in process order with the same statuses.
    const contents = page.getByTestId("map-contents-list");
    await expect(contents.locator("[data-block-id]")).toHaveCount(7);
    await expect(page.getByTestId("map-contents-plan-review")).toHaveAttribute(
      "data-status",
      "waiting",
    );
    await expect(page.getByTestId("map-contents-plan")).toHaveAttribute("data-status", "done");

    // The repair loop is a transition of the review block back into itself: a dashed self edge
    // under the card, named by the loop port on the card's own bottom band. Hovering that port
    // lights the edge it names and nothing else.
    const loop = "plan-review→plan-review:review found issues";
    await expect(page.locator(`[data-edge-kind="self"][data-transition="${loop}"]`)).toHaveCount(1);
    const loopPort = review.locator(`[data-port="loop"][data-transition="${loop}"]`);
    await expect(loopPort).toContainText("review found issues");
    await loopPort.hover();
    await expect(page.locator('[data-edge-kind][data-focused="true"]')).toHaveCount(1);
    await expect(page.locator(`[data-transition="${loop}"][data-focused="true"]`)).toHaveCount(1);
    await page.mouse.move(0, 0);
    await expect(page.locator('[data-edge-kind][data-focused="true"]')).toHaveCount(0);

    // The block panel opens on the current block: its passes with durations, what its visits did,
    // and the steps with the evidence each demands back.
    const detail = page.getByTestId("block-detail");
    await expect(detail).toHaveAttribute("data-block-id", "plan-review");
    await expect(detail.getByTestId("block-timings")).toHaveAttribute("data-recorded", "true");
    // Three passes through the review block's working steps: review, repair, review again.
    await expect(detail.getByTestId("block-timing-pass")).toHaveCount(3);
    await expect(detail.getByTestId("block-timing-total")).not.toHaveText("—");
    // The card carries a measured time of its own, so the map answers "where did the run spend
    // itself" without opening anything. It is not compared with the panel's total: the block is
    // open, so the card shows the running pass and the two tick apart.
    await expect(
      review.locator("[data-step-facts] > *").filter({ hasText: /^\d+\s(s|min|h|с|мин|ч)\b/ }),
    ).toHaveCount(1);
    await openPanelSection(page, "panel-section-route");
    await expect(detail.getByTestId("block-route-visit").first()).toBeVisible();
    await openPanelSection(page, "panel-section-steps");
    const currentStep = detail.locator('[data-node-id][aria-current="step"]');
    await expect(currentStep).toHaveAttribute("data-node-id", "plan-review");
    await expect(currentStep.locator("[data-node-inputs]")).toContainText("issues_count");

    // Selecting another block is a deep link and switches the panel to it — from the diagram and
    // from the contents alike.
    // The map opens on the block the run is at, and its card is the one at hand: clicking it
    // selects the block, which is a deep link.
    await review.click();
    await expect(page).toHaveURL(/block=plan-review/);
    await expect(detail).toHaveAttribute("data-block-id", "plan-review");
    await page.getByTestId("map-contents-execute").click();
    await expect(page).toHaveURL(/block=execute/);
    await expect(detail).toHaveAttribute("data-block-id", "execute");
    // A block the run never entered says so instead of showing a zero.
    await expect(detail.getByTestId("block-timings-empty")).toBeVisible();
    await expect(detail.getByTestId("block-timing-total")).toHaveText("—");

    // The finder, folded into the toolbar, answers "which block is this step in" and selects it.
    await page.getByTestId("map-toolbar").getByTestId("toolbar-finder").click();
    await page.getByTestId("map-node-finder").fill("fix-issues");
    await page.locator('[data-node-match="fix-issues"]').click();
    await expect(detail).toHaveAttribute("data-block-id", "verify");

    // A step focuses the technical node graph: the page switches to the graph view and the
    // viewport lands on a different transform for two different steps. The contents sidebar
    // reaches any block, including one outside the diagram's current viewport.
    await page.getByTestId("map-contents-scope").click();
    await expect(page).toHaveURL(/block=scope/);
    await expect(detail).toHaveAttribute("data-block-id", "scope");
    const graphViewport = page.locator('[data-testid="execution-progress"] .react-flow__viewport');
    const transformOf = () => graphViewport.evaluate((el) => window.getComputedStyle(el).transform);
    await detail.locator('[data-node-id="get-task"] button').click();
    await expect(page.getByTestId("execution-progress")).toHaveAttribute("data-view", "graph");
    await expect(page).toHaveURL(/view=graph/);
    await expect(graphViewport).toBeVisible({ timeout: 15000 });
    // The panel follows the jump to its node level, and the graph is centred on that step.
    await expect(page.getByTestId("node-panel")).toHaveAttribute("data-node-id", "get-task");
    await expect.poll(transformOf).not.toBe("none");
    const onGetTask = await transformOf();
    // Back to the block level and on to another step: a different step, a different camera.
    await page.getByTestId("node-panel-back").click();
    await expect(detail).toHaveAttribute("data-block-id", "scope");
    await detail.locator('[data-node-id="start"] button').click();
    await expect(page.getByTestId("node-panel")).toHaveAttribute("data-node-id", "start");
    await expect.poll(transformOf, { timeout: 5000 }).not.toBe(onGetTask);
  } finally {
    await run.cleanup();
  }
});

test("the route cursor moves the whole page back through the run; both views are deep-linkable", async ({
  page,
}) => {
  const run = await openRun(page);
  try {
    // The block panel's route facts are the recorded route of the selected block: the repair loop
    // stays inside the review block, so a revisit there is marked as a loop.
    await page.goto(`${BASE_URL}/executions/${run.executionId}?block=plan-review`);
    await openPanelSection(page, "panel-section-route");
    const facts = page.getByTestId("block-route-facts");
    await expect(facts).toBeVisible();
    await expect(facts.getByTestId("block-route-loop").first()).toBeVisible();
    const visits = facts.getByTestId("block-route-visit");
    expect(await visits.count()).toBeGreaterThan(1);

    // Clicking a visit puts the cursor there: the URL carries it and the cursor control says so.
    const firstVisitSeq = await visits.first().getAttribute("data-seq");
    await visits.first().locator("button").click();
    await expect(page).toHaveURL(new RegExp(`at=${firstVisitSeq}`));
    await expect(page.getByTestId("cursor-position")).toContainText(String(firstVisitSeq));
    await expect(facts.locator(`[data-seq="${firstVisitSeq}"]`)).toContainText("you are here");

    // The map follows the cursor: at the first review visit the run has not yet repeated the
    // block, and clearing the cursor brings the waiting state back.
    await expect(mapCard(page, "plan-review")).not.toContainText("×2");
    await page.getByTestId("cursor-clear").click();
    await expect(page).not.toHaveURL(/at=/);
    await expect(mapCard(page, "plan-review")).toHaveAttribute("data-status", "waiting");
    await expect(mapCard(page, "plan-review")).toContainText("×2");

    // The graph is a page view of its own, deep-linkable, and draws one edge per output.
    await page.goto(`${BASE_URL}/executions/${run.executionId}?view=graph`);
    await expect(page.getByTestId("execution-progress")).toHaveAttribute("data-view", "graph");
    await expect(page.locator("[data-graph-node]").first()).toBeVisible({ timeout: 15000 });
    // A view is mounted when first shown: a page opened on the graph has no map in the DOM
    // (the map then opens on the current block when the reader switches to it).
    await expect(page.getByTestId("map-view")).toHaveCount(0);
    // The decision after the review routes to two places, and the graph gives every output its
    // own source handle — and so its own edge — instead of one shared exit. The expected set is
    // read from the definition the server serves, not written down here.
    const definition = (
      (await (await page.request.get(`${BASE_URL}/api/workflows/moira/quick-task`)).json()) as {
        data: { workflow: { nodes: Array<{ id: string; connections?: Record<string, string> }> } };
      }
    ).data.workflow;
    const decision = definition.nodes.find((node) => node.id === "check-plan-review-clean")!;
    const expectedHandles = Object.keys(decision.connections ?? {})
      .map((output) => `out:check-plan-review-clean.${output}`)
      .sort();
    expect(expectedHandles.length).toBeGreaterThan(1);
    const outputs = await page
      .locator('[data-graph-node="check-plan-review-clean"] [data-handleid^="out:"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute("data-handleid")).sort());
    expect(outputs).toEqual(expectedHandles);

    // A link written for one of the views this page used to have resolves to the map.
    for (const legacy of ["lanes", "canvas", "outline", "route", "nonsense"]) {
      await page.goto(`${BASE_URL}/executions/${run.executionId}?view=${legacy}`);
      await expect(page.getByTestId("execution-progress")).toHaveAttribute("data-view", "map");
      await expect(page.getByTestId("map-view")).toBeVisible();
    }

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
    await expect(mapCard(page, "scope")).toHaveAttribute("data-status", "waiting");
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
    await expect(mapCard(page, "scope")).toHaveAttribute("data-status", "waiting");
    await page.getByTestId("answer-field-task_file").fill(`${workspace}/task.md`);
    const answered = page.waitForResponse(
      (r) => r.url().includes("/answer") && r.request().method() === "POST" && r.status() === 200,
    );
    await page.getByTestId("answer-submit").click();
    await answered;
    // The run moved on: the scope block is done, the plan block waits, the route carries the
    // adjustment by the user. The variables rows keep every name inside the panel even with
    // long path values (a broken layout pushed the first column out of view).
    await expect(mapCard(page, "scope")).toHaveAttribute("data-status", "done");
    const panelBox = (await page.getByTestId("run-panel").boundingBox())!;
    for (const name of ["operating_mode", "progress_scope_outcome"]) {
      const row = page.locator(`[data-variable="${name}"]`).first();
      const box = (await row.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(panelBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1);
      await expect(row).toContainText(name);
    }
    await expect(mapCard(page, "plan")).toHaveAttribute("data-status", "waiting");
    await expect(page.getByTestId("adjustment-count")).toContainText("1");
    // The scope block's own facts name the adjustment and who made it.
    await page.getByTestId("map-contents-scope").click();
    await page.getByRole("tab", { name: /Block|Блок/ }).click();
    await openPanelSection(page, "panel-section-route");
    const adjusted = page.getByTestId("block-route-facts").getByTestId("block-route-adjusted");
    await expect(adjusted).toHaveCount(1);
    await expect(adjusted).toContainText(/person|человек/i);
    // The progress_scope_outcome row's history opens under the row: the change by the answering
    // node, marked as adjusted. With the cursor on the start visit the row shows the registry
    // default and the panel says the values are the cursor's; cleared, the answered value again.
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    const history = page.getByTestId("variable-history-progress_scope_outcome");
    await expect(history).toBeVisible();
    await history.click();
    const changes = page.locator('[data-history-of="progress_scope_outcome"]');
    await expect(changes).toBeVisible();
    await expect(changes.locator("[data-history-seq]").last()).toContainText("get-task");
    await expect(changes.locator("[data-history-seq]").last()).toContainText(/adjusted|изменено/);
    await page.goto(`${BASE_URL}/executions/${run.processId}?at=0`);
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await expect(page.getByTestId("variables-cursor-note")).toBeVisible();
    await expect(page.locator('[data-variable="progress_scope_outcome"]')).toHaveAttribute(
      "data-value",
      "Pending",
    );
    await page.getByTestId("cursor-clear").click();
    await expect(page.locator('[data-variable="progress_scope_outcome"]')).toHaveAttribute(
      "data-value",
      "Captured from the page",
    );
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
    await expect(page.getByTestId("map-view")).toBeVisible();
    // Narrow width: the contents stack under the diagram and nothing overflows horizontally.
    const diagram = (await page.getByTestId("canvas-view").boundingBox())!;
    const sidebar = (await page.getByTestId("map-contents").boundingBox())!;
    expect(sidebar.y).toBeGreaterThanOrEqual(diagram.y + diagram.height - 1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    // The explanation of the view costs one row: its body is closed until the reader opens it,
    // so the picture keeps at least two fifths of the viewport (a broken layout once left the
    // diagram a strip about a hundred pixels tall).
    await expect(page.getByTestId("guidance-map-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("guidance-map-body")).toHaveCount(0);
    const picture = (await page.getByTestId("execution-progress").boundingBox())!;
    expect(picture.height).toBeGreaterThanOrEqual(900 * 0.4);

    run.setMode("error");
    const errorResponse = page.waitForResponse(
      (response) => response.url().includes("/progress") && response.status() === 500,
    );
    await page.reload();
    await errorResponse;
    // The projection's status line (the variables tab's waiting badge is a status of its own).
    await expect(
      page.getByRole("status").filter({ hasText: /temporarily unavailable|временно недоступен/i }),
    ).toBeVisible();
    await expect(page.locator(".react-flow__viewport")).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("tab", { name: /Variables|Переменные/ })).toBeVisible();

    run.setMode("none");
    const absentResponse = page.waitForResponse(
      (response) => response.url().includes("/progress") && response.status() === 404,
    );
    await page.reload();
    await absentResponse;
    await expect(page.getByText(run.executionId.substring(0, 8), { exact: true })).toBeVisible();
    // Without a projection the technical graph fills the page on its own.
    await expect(page.locator(".react-flow__viewport")).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId("execution-progress")).toHaveCount(0);
    await expect(page.locator('[data-view="graph"]')).toBeVisible();
  } finally {
    run.releaseSlow();
    await run.cleanup();
  }
});
