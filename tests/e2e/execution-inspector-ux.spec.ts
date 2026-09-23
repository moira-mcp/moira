/**
 * E2E Tests: the run page keeps the inspector's toolbar, panel tabs, context editing, technical
 * graph and admin variant. Opens the first execution in the list, whatever its workflow: with a
 * process view the page has two views and the technical graph is the second of them; without one
 * the graph fills the page as before.
 */

import { test, expect, type Page } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, startWorkflowExecutionState } from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

async function openFirstExecution(page: Page, listUrl = `${BASE_URL}/executions`) {
  await page.goto(listUrl);
  await page.waitForLoadState("domcontentloaded");
  const firstRow = page.getByTestId("execution-card").first();
  await expect(firstRow).toBeVisible({ timeout: 10000 });
  await firstRow.click();
  await page.waitForURL(/\/executions\/[a-f0-9-]+/);
  await expect(page.getByTestId("run-page")).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId("run-panel").locator('[role="tablist"]')).toBeVisible();
}

/**
 * The technical node graph: the page's `graph` view. Only the view being read is mounted, so once
 * the graph is shown it is the page's single React Flow instance. The runs here have a process,
 * so the view tabs come with it; they are waited for rather than counted, because the process
 * loads after the page and a count taken before it arrives finds no tab and leaves the map on
 * screen.
 */
async function showTechnicalGraph(page: Page) {
  const graphTab = page.getByTestId("run-modes").locator('[data-mode="graph"]');
  await expect(graphTab).toBeVisible({ timeout: 15000 });
  await graphTab.click();
  await expect(page.getByTestId("execution-progress")).toHaveAttribute("data-view", "graph");
  const graph = page.locator(".react-flow").last();
  await expect(graph).toBeVisible({ timeout: 15000 });
  return graph;
}

test.describe("Run page toolbar and panel", () => {
  let runningExecutionId: string;
  let cleanupRunning: () => Promise<void>;

  test.beforeAll(async () => {
    // A run known to wait on a step, so the current-node focus is exercised unconditionally.
    const authenticated = await createAuthenticatedMCPClient();
    cleanupRunning = authenticated.cleanup;
    const run = await startWorkflowExecutionState(authenticated.client, "moira/quick-task", {
      skipTelegramCheck: true,
    });
    runningExecutionId = run.processId;
  });

  test.afterAll(async () => {
    await cleanupRunning();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("compact toolbar displays all elements", async ({ page }) => {
    await openFirstExecution(page);
    const toolbar = page.locator(".border-b.bg-card").first();
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator("button.font-mono")).toBeVisible();
    await expect(
      toolbar.locator('[class*="rounded-md"][class*="font-semibold"]').first(),
    ).toBeVisible();
    await expect(toolbar.locator("button svg.lucide-refresh-cw").first()).toBeVisible();
  });

  test("the variables tab holds the run's values and opens the same panel fullscreen", async ({
    page,
  }) => {
    await openFirstExecution(page);
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await expect(page.getByTestId("context-filter-input")).toBeVisible({ timeout: 5000 });
    // There is no separate context tab: the variables panel is the one surface.
    await expect(page.getByRole("tab", { name: /Context|Контекст/ })).toHaveCount(0);
    const fullscreenButton = page.getByTestId("context-fullscreen-button");
    await expect(fullscreenButton).toBeVisible();
    await fullscreenButton.click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("context-filter-input")).toBeVisible();
    // "Fullscreen" gives the panel room: the dialog is at least twice as wide as the docked
    // panel (the dialog primitive's small default would be narrower than the panel).
    const panelWidth = (await page.getByTestId("run-panel").boundingBox())!.width;
    const dialogWidth = (await dialog.boundingBox())!.width;
    expect(dialogWidth).toBeGreaterThanOrEqual(panelWidth * 2);
    await dialog.locator('[data-slot="dialog-close"]').click();
    await expect(dialog).not.toBeVisible();
  });

  test("panel tabs switch between block, variables, errors, steps and locks", async ({ page }) => {
    await openFirstExecution(page);
    for (const name of [
      /Variables|Переменные/,
      /Errors|Ошибки/,
      /Steps|Шаги/,
      /Locks|Блокировки/,
    ]) {
      const tab = page.getByRole("tab", { name });
      await tab.click();
      await expect(tab).toHaveAttribute("data-state", "active");
      await expect(page.locator('[role="tabpanel"][data-state="active"]')).toBeVisible();
    }
  });

  test("refresh button reloads execution data", async ({ page }) => {
    await openFirstExecution(page);
    const refreshButton = page.locator('button:has(svg[class*="lucide-refresh"])');
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/executions/") && r.status() === 200),
      refreshButton.click(),
    ]);
    expect(response.ok()).toBe(true);
  });

  test("copy execution ID to clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await openFirstExecution(page);
    const toolbar = page.locator(".border-b.bg-card").first();
    await toolbar.locator("button.font-mono").click();
    await expect(toolbar.locator('svg[class*="lucide-check"]')).toBeVisible({ timeout: 2000 });
  });

  test("the technical node graph is one click away and the current node focuses it", async ({
    page,
  }) => {
    // Keep the graph pane narrow enough that a fixed readable zoom would clip the card.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto(`${BASE_URL}/executions/${runningExecutionId}`);
    await expect(page.getByTestId("run-page")).toBeVisible({ timeout: 15000 });
    const graph = await showTechnicalGraph(page);
    const transformOf = () =>
      graph
        .locator(".react-flow__viewport")
        .evaluate((el) => window.getComputedStyle(el).transform);
    await expect.poll(transformOf).not.toBe("none");
    // The graph opens on the waiting node: its card sits inside the graph's own box.
    const inView = async () => {
      const box = await graph.boundingBox();
      const card = await graph
        .locator('[data-graph-node][data-current="true"]')
        .first()
        .boundingBox();
      return (
        !!box &&
        !!card &&
        card.x >= box.x &&
        card.y >= box.y &&
        card.x + card.width <= box.x + box.width &&
        card.y + card.height <= box.y + box.height
      );
    };
    await expect.poll(inView, { timeout: 5000 }).toBe(true);
    const onCurrent = await transformOf();
    // The fit control in the diagram's toolbar gives the overview back; the header's
    // current-node button returns.
    await page.getByTestId("graph-toolbar").getByTestId("toolbar-fit").click();
    await expect.poll(transformOf, { timeout: 5000 }).not.toBe(onCurrent);
    const toolbar = page.locator(".border-b.bg-card").first();
    await toolbar.locator("button:has(svg.lucide-play)").click();
    await expect.poll(inView, { timeout: 5000 }).toBe(true);
  });

  test("the panel sits beside the run on desktop and under it on a phone", async ({ page }) => {
    await openFirstExecution(page);
    const panel = page.getByTestId("run-panel");
    await expect(panel).toBeVisible();
    const desktop = await panel.boundingBox();
    const runPage = await page.getByTestId("run-page").boundingBox();
    expect(desktop!.width).toBeLessThan(runPage!.width * 0.5);
    await page.setViewportSize({ width: 600, height: 900 });
    const phone = await panel.boundingBox();
    const phonePage = await page.getByTestId("run-page").boundingBox();
    expect(Math.round(phone!.width)).toBe(Math.round(phonePage!.width));
    // On a phone the technical graph draws no navigator over its cards, and the map's navigator
    // is the reader's own choice in the toolbar rather than something fixed to the diagram: it
    // opens folded and appears only once switched on.
    await expect(page.getByTestId("canvas-view").locator(".react-flow")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByTestId("canvas-view").locator(".react-flow__minimap")).toHaveCount(0);
    await page.getByTestId("map-toolbar").getByTestId("toolbar-minimap").click();
    await expect(page.getByTestId("canvas-view").locator(".react-flow__minimap")).toHaveCount(1);
    await page.getByTestId("map-toolbar").getByTestId("toolbar-minimap").click();
    await expect(page.getByTestId("canvas-view").locator(".react-flow__minimap")).toHaveCount(0);
    const graph = await showTechnicalGraph(page);
    await expect(graph.locator(".react-flow__minimap")).toHaveCount(0);
  });
});

test.describe("Admin run page", () => {
  let executionId: string;
  let cleanup: () => Promise<void>;
  let multiUserAdmin = false;

  test.beforeAll(async () => {
    const features = (await (await fetch(`${BASE_URL}/api/features`)).json()) as {
      data: { features: { multiUserAdmin: boolean } };
    };
    multiUserAdmin = features.data.features.multiUserAdmin;
    const authenticated = await createAuthenticatedMCPClient();
    cleanup = authenticated.cleanup;
    const run = await startWorkflowExecutionState(authenticated.client, "moira/quick-task", {
      skipTelegramCheck: true,
    });
    executionId = run.processId;
  });

  test.afterAll(async () => {
    await cleanup();
  });

  test.beforeEach(async ({ page }) => {
    // The admin execution routes exist only with the multi-user admin capability; a self-host
    // instance redirects them to the admin home, so the page cannot be exercised there.
    test.skip(!multiUserAdmin, "multiUserAdmin capability is off on this instance");
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/executions/${executionId}`);
    await expect(page.getByTestId("run-page")).toBeVisible({ timeout: 15000 });
  });

  test("admin view shows owner info in the toolbar and the run's process view", async ({
    page,
  }) => {
    const toolbar = page.locator(".border-b.bg-card").first();
    await expect(toolbar).toBeVisible();
    await expect(toolbar.locator(".text-muted-foreground.truncate").first()).toBeVisible();
    await expect(page.getByTestId("execution-progress")).toBeVisible();
    await expect(
      page.locator('[data-testid="canvas-view"] [data-block-id="scope"]'),
    ).toHaveAttribute("data-status", "waiting");
  });

  test("admin view is read-only in the variables panel but may answer the waiting step", async ({
    page,
  }) => {
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await expect(page.getByTestId("context-filter-input")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("[data-variable]").first()).toBeVisible();
    await expect(page.locator('[data-testid^="context-var-input-"]')).toHaveCount(0);
    await expect(page.getByTestId("answer-form")).toHaveAttribute("data-node-id", "get-task");
  });
});
