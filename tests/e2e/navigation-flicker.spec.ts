/**
 * Navigation never blanks the page: while a lazily loaded section's code arrives the sidebar
 * stays and the content area shows a skeleton; on the run page a refresh, a mode switch and a
 * cursor move keep the projection mounted through the pending progress request; on the flow page
 * a save keeps the modes strip and the diagram mounted through the two refetches (detail and
 * process) and shows a slim pending indicator instead of the page loader.
 */

import { test, expect, type Page, type Route } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createAuthenticatedMCPClient, startWorkflowExecutionState } from "../utils/mcp-auth.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

/** Holds every `method` request matching `pattern` until `release()`; resolves `started` on the first. */
async function holdRequests(page: Page, pattern: string | RegExp, method = "GET") {
  let release: (() => void) | undefined;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = true;
  await page.route(pattern, async (route: Route) => {
    if (holding && route.request().method() === method) {
      markStarted?.();
      await gate;
    }
    await route.continue();
  });
  return {
    started,
    release() {
      holding = false;
      release?.();
    },
  };
}

test("moving to a section whose code is still loading keeps the current page and the sidebar", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE_URL}/`);
  const sidebar = page.locator('[data-slot="sidebar"]').first();
  await expect(sidebar).toBeVisible();
  const dashboard = page.getByRole("heading", { name: /Dashboard|Панель/ }).first();
  await expect(dashboard).toBeVisible();
  // Every script requested from now on is a lazy page chunk.
  const chunk = await holdRequests(page, /\/\d+\.[0-9a-f]+\.js(\?|$)/);
  await page.click('a[href="/executions"]');
  await chunk.started;
  // The router keeps the current page on screen until the next one can render: no loader, no
  // skeleton, the sidebar untouched.
  await expect(page).toHaveURL(/\/executions$/);
  await expect(dashboard).toBeVisible();
  await expect(sidebar).toBeVisible();
  expect(await page.getByText("loading...", { exact: true }).count()).toBe(0);
  expect(await page.getByTestId("route-skeleton").count()).toBe(0);
  chunk.release();
  await expect(page.getByRole("heading", { name: /Executions|Запуски/ }).first()).toBeVisible();
  await expect(sidebar).toBeVisible();
});

test("a direct load of a section whose code is still loading shows a skeleton inside the layout", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const chunk = await holdRequests(page, /\/\d+\.[0-9a-f]+\.js(\?|$)/);
  await page.goto(`${BASE_URL}/executions`, { waitUntil: "commit" });
  await chunk.started;
  await expect(page.getByTestId("route-skeleton")).toBeVisible();
  await expect(page.locator('[data-slot="sidebar"]').first()).toBeVisible();
  expect(await page.getByText("loading...", { exact: true }).count()).toBe(0);
  chunk.release();
  await expect(page.getByTestId("route-skeleton")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Executions|Запуски/ }).first()).toBeVisible();
});

test("the run page keeps its projection through a refresh, a mode switch and a cursor move", async ({
  page,
}) => {
  const authenticated = await createAuthenticatedMCPClient();
  const run = await startWorkflowExecutionState(authenticated.client, "moira/quick-task", {
    skipTelegramCheck: true,
  });
  try {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE_URL}/executions/${run.processId}`);
    const projection = page.getByTestId("execution-progress");
    await expect(projection).toBeVisible();

    const held = await holdRequests(page, `**/api/executions/${run.processId}/progress**`);
    const refresh = page.locator("button[data-pending], button:has(svg.lucide-refresh-cw)").first();
    await refresh.click();
    await held.started;
    // Pending, but the projection and the toolbar stay; the first-load banner never returns.
    await expect(refresh).toHaveAttribute("data-pending", "true");
    await expect(projection).toBeAttached();
    await expect(page.getByTestId("execution-progress-loading")).toHaveCount(0);
    // Mode and cursor are state over the data already present.
    await page.getByTestId("run-modes").locator('[data-mode="canvas"]').click();
    await expect(page).toHaveURL(/view=canvas/);
    await expect(projection).toBeAttached();
    await page.getByTestId("run-modes").locator('[data-mode="lanes"]').click();
    await expect(projection).toBeAttached();
    held.release();
    await expect(refresh).not.toHaveAttribute("data-pending", "true");
    await expect(projection).toBeVisible();
    await expect(page.getByText(/Loading execution\.\.\.|Загрузка запуска\.\.\./)).toHaveCount(0);

    // A refetch that fails keeps the projection on screen; the unavailable banner is a
    // first-load state and does not replace a picture the page already has.
    await page.route(`**/api/executions/${run.processId}/progress**`, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"failed"}' }),
    );
    const failed = page.waitForResponse(
      (response) => response.url().includes("/progress") && response.status() === 500,
    );
    await refresh.click();
    await failed;
    await expect(refresh).not.toHaveAttribute("data-pending", "true");
    await expect(projection).toBeVisible();
    await expect(page.getByText(/temporarily unavailable|временно недоступен/i)).toHaveCount(0);

    // A panel tab keeps its content too: the Locks tab shows its history once, and reopening it
    // refreshes behind the list instead of replacing it with a spinner.
    const locksTab = page.getByRole("tab", { name: /Locks|Блокировки/ });
    await locksTab.click();
    const locksPanel = page.getByTestId("locks-panel");
    await expect(locksPanel).toBeVisible();
    await expect(page.getByTestId("locks-loading")).toHaveCount(0);
    const lockHistory = await holdRequests(page, `**/api/executions/${run.processId}/locks**`);
    await page.getByRole("tab", { name: /Block|Блок/ }).click();
    await locksTab.click();
    await lockHistory.started;
    await expect(locksPanel).toHaveAttribute("data-pending", "true");
    await expect(page.getByTestId("locks-loading")).toHaveCount(0);
    await expect(locksPanel).toContainText(/No lock history|Нет истории блокировок|Node|Нода/);
    lockHistory.release();
    await expect(locksPanel).not.toHaveAttribute("data-pending", "true");

    // A refresh whose execution request fails keeps the run on screen and says so in a toast.
    await page.route(`**/api/executions/${run.processId}`, (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"down"}' }),
    );
    await refresh.click();
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible();
    await expect(page.getByTestId("run-page")).toBeAttached();
    await expect(projection).toBeAttached();
  } finally {
    await authenticated.cleanup();
  }
});

test("the flow page keeps the modes strip and the diagram through the refetches after a save", async ({
  page,
}) => {
  await loginAsAdmin(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const copy = await page.request.post(`${BASE_URL}/api/workflows/moira/quick-task/copy`, {
    data: { newName: `Flicker ${Date.now()}` },
  });
  expect(copy.status()).toBe(200);
  const id = ((await copy.json()) as { data: { workflowId: string } }).data.workflowId;
  try {
    await page.goto(`${BASE_URL}/workflows/${id}?edit=1`);
    await expect(page.getByTestId("flow-edit-panel")).toBeVisible();
    await expect(page.getByTestId("page-loader")).toHaveCount(0);
    await page.getByTestId("edit-block-label-plan").fill("Plan (renamed)");
    await expect(page.getByTestId("flow-edit-save")).toBeEnabled();
    // Switch to the canvas in the app (a page load would discard the edit) so a diagram is mounted.
    await page.getByTestId("flow-modes").locator('[data-mode="canvas"]').click();
    await expect(page.locator('[data-testid="flow-view"] .react-flow')).toBeVisible();

    const detail = await holdRequests(page, `**/api/workflows/${id}`);
    await page.getByTestId("flow-edit-save").click();
    await detail.started;
    // The save succeeded and the detail refetch is held: content stays, the page loader never mounts.
    await expect(page.getByTestId("flow-pending")).toBeVisible();
    await expect(page.getByTestId("flow-modes")).toBeAttached();
    await expect(page.locator('[data-testid="flow-view"] .react-flow')).toBeAttached();
    await expect(page.getByTestId("page-loader")).toHaveCount(0);
    detail.release();
    // The process refetch for the new revision follows; the picture stays through it as well.
    await expect(page.getByTestId("flow-pending")).toHaveCount(0);
    await expect(page.getByTestId("page-loader")).toHaveCount(0);
    await expect(
      page.locator('[data-testid="flow-view"] [data-block-id="plan"]').first(),
    ).toContainText("Plan (renamed)");

    // A refetch that fails keeps the content and says so once.
    await page.route(`**/api/workflows/${id}`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"down"}' })
        : route.continue(),
    );
    await page.getByTestId("flow-modes").locator('[data-mode="outline"]').click();
    await page.getByTestId("edit-block-label-plan").fill("Plan (renamed twice)");
    await page.getByTestId("flow-modes").locator('[data-mode="canvas"]').click();
    await page.getByTestId("flow-edit-save").click();
    await expect(page.locator('[data-sonner-toast][data-type="error"]')).toBeVisible();
    await expect(page.getByTestId("flow-modes")).toBeAttached();
    await expect(page.getByTestId("page-loader")).toHaveCount(0);
    await expect(page.locator('[data-testid="flow-view"] .react-flow')).toBeAttached();
    await expect(page.getByTestId("flow-pending")).toHaveCount(0);
  } finally {
    await page.request.delete(`${BASE_URL}/api/workflows/${id}`);
  }
});
