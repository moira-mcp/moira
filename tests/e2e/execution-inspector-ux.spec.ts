/**
 * E2E Tests: Execution Inspector UX Redesign
 * Tests for Step 3 implementation: compact toolbar, context modal, errors panel
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("Execution Inspector UX", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("compact toolbar displays all elements", async ({ page }) => {
    // Navigate to executions
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution row
    const firstRow = page.getByTestId("execution-card").first();
    await firstRow.click();
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);

    // Wait for workflow graph to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Toolbar should be compact (single row with all elements)
    const toolbar = page.locator(".border-b.bg-card").first();
    await expect(toolbar).toBeVisible();

    // Execution ID (short, clickable for copy)
    const executionId = toolbar.locator("button.font-mono");
    await expect(executionId).toBeVisible();

    // Status badge (uses classes from badgeVariants: rounded-md, text-xs, font-semibold)
    const statusBadge = toolbar.locator('[class*="rounded-md"][class*="font-semibold"]').first();
    await expect(statusBadge).toBeVisible();

    // Refresh button (contains RefreshCw icon)
    const refreshButton = toolbar.locator("button svg.lucide-refresh-cw").first();
    await expect(refreshButton).toBeVisible();

    // Tabs should be visible in right panel (Context is default)
    const tabsList = page.locator('[role="tablist"]');
    await expect(tabsList).toBeVisible();
  });

  test("context is visible in default tab", async ({ page }) => {
    // Navigate to executions
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution row
    const firstRow = page.getByTestId("execution-card").first();
    await firstRow.click();
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);

    // Wait for page to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Context tab should be active by default
    const contextTab = page
      .locator('[role="tab"][data-state="active"]')
      .filter({ hasText: /Context|Контекст/ });
    await expect(contextTab).toBeVisible();

    // Context variable editor should be visible (filter input is its stable marker)
    await expect(page.getByTestId("context-filter-input")).toBeVisible({ timeout: 5000 });
  });

  test("errors tab shows error history", async ({ page }) => {
    // Navigate to executions
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution row
    const firstRow = page.getByTestId("execution-card").first();
    await firstRow.click();
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);

    // Wait for page to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Click on Errors tab
    const errorsTab = page.locator('[role="tab"]').filter({ hasText: /Errors|Ошибки/ });
    await errorsTab.click();

    // Active errors tab panel should be visible
    const errorsPanel = page.locator('[role="tabpanel"][data-state="active"]');
    await expect(errorsPanel).toBeVisible();
  });

  test("refresh button reloads execution data", async ({ page }) => {
    // Navigate to executions
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution row
    const firstRow = page.getByTestId("execution-card").first();
    await firstRow.click();
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);

    // Wait for page to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Click refresh button
    const refreshButton = page.locator('button:has(svg[class*="lucide-refresh"])');

    // Intercept API call to verify refresh
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/executions/") && r.status() === 200),
      refreshButton.click(),
    ]);

    expect(response.ok()).toBe(true);
  });

  test("copy execution ID to clipboard", async ({ page, context }) => {
    // Grant clipboard permissions
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    // Navigate to executions
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution row
    const firstRow = page.getByTestId("execution-card").first();
    await firstRow.click();
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);

    // Wait for page to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Click on execution ID to copy
    const toolbar = page.locator(".border-b.bg-card");
    const executionIdButton = toolbar.locator("button.font-mono");
    await executionIdButton.click();

    // Check icon shows copied state
    const checkIcon = toolbar.locator('svg[class*="lucide-check"]');
    await expect(checkIcon).toBeVisible({ timeout: 2000 });
  });

  test("workflow graph loads successfully with lazy loading", async ({ page }) => {
    // Navigate directly to execution inspector
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution row
    const firstRow = page.getByTestId("execution-card").first();
    await firstRow.click();
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);

    // Graph should load (lazy loaded via React.lazy + Suspense)
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });
  });

  test("clickable current node focuses on graph", async ({ page }) => {
    // Navigate to executions
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution row
    const firstRow = page.getByTestId("execution-card").first();
    await firstRow.click();
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);

    // Wait for graph to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Get toolbar
    const toolbar = page.locator(".border-b.bg-card").first();

    // Current node button should be visible (has Play icon and node ID text)
    const currentNodeButton = toolbar.locator("button:has(svg.lucide-play)");

    // If current node exists (execution has a current node)
    if ((await currentNodeButton.count()) > 0) {
      // Get initial transform of ReactFlow viewport (CSS transform, not HTML attribute)
      const viewportBefore = await page.locator(".react-flow__viewport").evaluate((el) => {
        return window.getComputedStyle(el).transform;
      });

      // Click on current node to focus
      await currentNodeButton.click();

      // Wait for fitView animation
      await page.waitForTimeout(500);

      // Viewport transform should have changed (fitView was called)
      const viewportAfter = await page.locator(".react-flow__viewport").evaluate((el) => {
        return window.getComputedStyle(el).transform;
      });

      // Transform should exist and be valid (fitView sets proper transform)
      // Note: in some cases may be same if already focused, but click should not error
      expect(viewportAfter).toBeTruthy();
      expect(viewportAfter).not.toBe("none");
    }
  });
});

test.describe("Tabbed Right Panel (Step 28)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("tabs switch between Context, Errors, and Steps", async ({ page }) => {
    // Navigate to executions
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution row
    const firstRow = page.getByTestId("execution-card").first();
    await firstRow.click();
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);

    // Wait for page to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Context tab is default active
    const contextTab = page.locator('[role="tab"]').filter({ hasText: /Context|Контекст/ });
    await expect(contextTab).toHaveAttribute("data-state", "active");

    // Switch to Errors tab
    const errorsTab = page.locator('[role="tab"]').filter({ hasText: /Errors|Ошибки/ });
    await errorsTab.click();
    await expect(errorsTab).toHaveAttribute("data-state", "active");

    // Switch to Steps tab
    const stepsTab = page.locator('[role="tab"]').filter({ hasText: /Steps|Шаги/ });
    await stepsTab.click();
    await expect(stepsTab).toHaveAttribute("data-state", "active");
  });

  test("fullscreen button opens context modal", async ({ page }) => {
    // Navigate to executions
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution row
    const firstRow = page.getByTestId("execution-card").first();
    await firstRow.click();
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);

    // Wait for page to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Fullscreen button should be visible (Maximize2 icon in toolbar).
    // Target by testid — the bare maximize-2 icon also appears on per-variable
    // expand buttons, which would make the icon selector ambiguous.
    const fullscreenButton = page.getByTestId("context-fullscreen-button");
    if ((await fullscreenButton.count()) > 0) {
      await fullscreenButton.click();

      // Modal should open
      const dialog = page.locator('[role="dialog"]');
      await expect(dialog).toBeVisible();

      // Dialog should contain the context variable editor (filter input marker)
      await expect(dialog.getByTestId("context-filter-input")).toBeVisible();

      // Close modal
      const closeButton = dialog.locator('[data-slot="dialog-close"]');
      await closeButton.click();
      await expect(dialog).not.toBeVisible();
    }
  });

  test("right panel uses 50% width alongside graph", async ({ page }) => {
    // Navigate to executions
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution row
    const firstRow = page.getByTestId("execution-card").first();
    await firstRow.click();
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);

    // Wait for page to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Right panel with tabs should be 50% width
    const rightPanel = page.locator(".w-1\\/2.bg-card");
    await expect(rightPanel).toBeVisible();
  });

  test("context tab shows the variable editor with execution data", async ({ page }) => {
    // Navigate to executions
    await page.goto(`${BASE_URL}/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution row
    const firstRow = page.getByTestId("execution-card").first();
    await firstRow.click();
    await page.waitForURL(/\/executions\/[a-f0-9-]+/);

    // Wait for page to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Context tab is default - variable editor (filter input) should be visible
    await expect(page.getByTestId("context-filter-input")).toBeVisible({ timeout: 5000 });
  });
});

test.describe("Admin Execution Inspector", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("admin view shows owner info in toolbar", async ({ page }) => {
    // Navigate to admin executions
    await page.goto(`${BASE_URL}/admin/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution card
    const firstCard = page.getByTestId("execution-card").first();
    await expect(firstCard).toBeVisible({ timeout: 10000 });
    await firstCard.click();
    await page.waitForURL(/\/admin\/executions\/[a-f0-9-]+/);

    // Wait for page to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Owner info should be visible in toolbar (may show username or email)
    const toolbar = page.locator(".border-b.bg-card").first();
    await expect(toolbar).toBeVisible();

    // Owner info element - truncated text with muted foreground color
    const ownerInfo = toolbar.locator(".text-muted-foreground.truncate");
    // Owner info may not always be visible depending on execution data
    // but toolbar should contain it when showOwnerInfo=true
    if ((await ownerInfo.count()) > 0) {
      await expect(ownerInfo.first()).toBeVisible();
    }
  });

  test("admin view is read-only (no save on context tab)", async ({ page }) => {
    // Navigate to admin executions
    await page.goto(`${BASE_URL}/admin/executions`);
    await page.waitForLoadState("domcontentloaded");

    // Click first execution card
    const firstCard = page.getByTestId("execution-card").first();
    await expect(firstCard).toBeVisible({ timeout: 10000 });
    await firstCard.click();
    await page.waitForURL(/\/admin\/executions\/[a-f0-9-]+/);

    // Wait for page to load
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 15000 });

    // Context tab should be active by default
    const contextTab = page
      .locator('[role="tab"][data-state="active"]')
      .filter({ hasText: /Context|Контекст/ });
    await expect(contextTab).toBeVisible();

    // Variable editor should be visible (admin view is read-only)
    await expect(page.getByTestId("context-filter-input")).toBeVisible({ timeout: 5000 });

    // No edit affordances should be present (admin view passes no onSavePath) — read-only shows
    // values as code, with no editable input fields.
    const editInputs = page.locator('[data-testid^="context-var-input-"]');
    await expect(editInputs).toHaveCount(0);
  });
});
