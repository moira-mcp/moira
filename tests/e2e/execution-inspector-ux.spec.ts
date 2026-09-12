/**
 * E2E Tests: the run page keeps the inspector's toolbar, panel tabs, context editing, technical
 * graph and admin variant. Opens the first execution in the list, whatever its workflow: with a
 * process view the run occupies the page and the technical graph sits in the Graph tab; without
 * one the graph fills the page as before.
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

/** Bring the technical node graph on screen: the Graph tab when the run has a process view. */
/**
 * The technical node graph: in the panel's graph tab when the run has a process view (the lanes
 * rail beside it is a React Flow instance of its own), else in the main section.
 */
async function showTechnicalGraph(page: Page) {
  const graphTab = page.getByRole("tab", { name: /Graph|Граф/ });
  const inPanel = (await graphTab.count()) > 0;
  if (inPanel) await graphTab.click();
  const graph = inPanel
    ? page.getByTestId("run-panel").locator(".react-flow")
    : page.locator(".react-flow");
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

  test("the context tab shows the variable editor and opens fullscreen", async ({ page }) => {
    await openFirstExecution(page);
    await page.getByRole("tab", { name: /Context|Контекст/ }).click();
    await expect(page.getByTestId("context-filter-input")).toBeVisible({ timeout: 5000 });
    const fullscreenButton = page.getByTestId("context-fullscreen-button");
    await expect(fullscreenButton).toBeVisible();
    await fullscreenButton.click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("context-filter-input")).toBeVisible();
    await dialog.locator('[data-slot="dialog-close"]').click();
    await expect(dialog).not.toBeVisible();
  });

  test("tabs switch between context, errors, steps and locks", async ({ page }) => {
    await openFirstExecution(page);
    for (const name of [/Context|Контекст/, /Errors|Ошибки/, /Steps|Шаги/, /Locks|Блокировки/]) {
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
    await page.goto(`${BASE_URL}/executions/${runningExecutionId}`);
    await expect(page.getByTestId("run-page")).toBeVisible({ timeout: 15000 });
    const graph = await showTechnicalGraph(page);
    const transformOf = () =>
      graph
        .locator(".react-flow__viewport")
        .evaluate((el) => window.getComputedStyle(el).transform);
    await expect.poll(transformOf).not.toBe("none");
    const overview = await transformOf();
    // The toolbar's current-node button moves the viewport onto the waiting node.
    const toolbar = page.locator(".border-b.bg-card").first();
    await toolbar.locator("button:has(svg.lucide-play)").click();
    await expect.poll(transformOf, { timeout: 5000 }).not.toBe(overview);
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
    await expect(page.getByTestId("progress-node-scope")).toHaveAttribute("data-status", "waiting");
  });

  test("admin view is read-only on the context tab but may answer the waiting step", async ({
    page,
  }) => {
    await page.getByRole("tab", { name: /Context|Контекст/ }).click();
    await expect(page.getByTestId("context-filter-input")).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid^="context-var-input-"]')).toHaveCount(0);
    await page.getByRole("tab", { name: /Variables|Переменные/ }).click();
    await expect(page.getByTestId("answer-form")).toHaveAttribute("data-node-id", "get-task");
  });
});
