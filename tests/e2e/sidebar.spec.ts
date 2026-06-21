/**
 * Sidebar E2E Tests
 * Tests shadcn sidebar collapse/expand, navigation, and tooltips
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test.describe("Sidebar Navigation & Collapse", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("sidebar displays all navigation items", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Check main navigation items are visible in sidebar
    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toBeVisible();

    // Check navigation menu items
    await expect(
      page.locator('[data-slot="sidebar-menu-button"]').filter({ hasText: /Home|Главная/i }),
    ).toBeVisible();
    await expect(
      page
        .locator('[data-slot="sidebar-menu-button"]')
        .filter({ hasText: /Workflows|Рабочие процессы/i }),
    ).toBeVisible();
    await expect(
      page
        .locator('[data-slot="sidebar-menu-button"]')
        .filter({ hasText: /Executions|Выполнения/i }),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="sidebar-menu-button"]').filter({ hasText: /Notes|Заметки/i }),
    ).toBeVisible();

    console.log("✓ All sidebar navigation items visible");
  });

  test("sidebar navigation works correctly", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Navigate to Workflows
    await page
      .locator('[data-slot="sidebar-menu-button"]')
      .filter({ hasText: /Workflows|Рабочие процессы/i })
      .click();
    await page.waitForURL(`${BASE_URL}/workflows`);
    expect(page.url()).toBe(`${BASE_URL}/workflows`);

    // Navigate to Executions
    await page
      .locator('[data-slot="sidebar-menu-button"]')
      .filter({ hasText: /Executions|Выполнения/i })
      .click();
    await page.waitForURL(`${BASE_URL}/executions`);
    expect(page.url()).toBe(`${BASE_URL}/executions`);

    // Navigate to Notes
    await page
      .locator('[data-slot="sidebar-menu-button"]')
      .filter({ hasText: /Notes|Заметки/i })
      .click();
    await page.waitForURL(`${BASE_URL}/notes`);
    expect(page.url()).toBe(`${BASE_URL}/notes`);

    console.log("✓ Sidebar navigation works correctly");
  });

  test("sidebar collapse toggle works", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Ensure any modal overlay is closed before interacting with sidebar
    const dialogOverlay = page.locator('[data-slot="dialog-overlay"]');
    if (await dialogOverlay.isVisible({ timeout: 1000 }).catch(() => false)) {
      // Click accept button if beta modal is open
      const acceptButton = page.locator(
        'button:has-text("Accept and Continue"), button:has-text("Принять и продолжить")',
      );
      if (
        await acceptButton
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false)
      ) {
        await acceptButton.first().click();
        await page
          .waitForSelector('[data-slot="dialog-overlay"]', { state: "detached", timeout: 5000 })
          .catch(() => {});
      }
    }

    // Find sidebar and trigger (use first() to get desktop trigger, not mobile header trigger)
    const sidebar = page.locator('[data-slot="sidebar"]');
    const trigger = page.locator('[data-slot="sidebar-trigger"]').first();

    // Initial state - expanded
    await expect(sidebar).toHaveAttribute("data-state", "expanded");

    // Click trigger to collapse
    await trigger.click();
    await page.waitForTimeout(300); // Wait for animation

    // Verify collapsed state
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");

    // Click trigger to expand again (get fresh reference with first())
    await page.locator('[data-slot="sidebar-trigger"]').first().click();
    await page.waitForTimeout(300);

    // Verify expanded state
    await expect(sidebar).toHaveAttribute("data-state", "expanded");

    console.log("✓ Sidebar collapse/expand toggle works");
  });

  test("sidebar collapsed mode shows icons only", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Ensure any modal overlay is closed before interacting with sidebar
    const dialogOverlay = page.locator('[data-slot="dialog-overlay"]');
    if (await dialogOverlay.isVisible({ timeout: 1000 }).catch(() => false)) {
      // Click accept button if beta modal is open
      const acceptButton = page.locator(
        'button:has-text("Accept and Continue"), button:has-text("Принять и продолжить")',
      );
      if (
        await acceptButton
          .first()
          .isVisible({ timeout: 500 })
          .catch(() => false)
      ) {
        await acceptButton.first().click();
        await page
          .waitForSelector('[data-slot="dialog-overlay"]', { state: "detached", timeout: 5000 })
          .catch(() => {});
      }
    }

    // Collapse sidebar (use first() to get desktop trigger)
    const trigger = page.locator('[data-slot="sidebar-trigger"]').first();
    await trigger.click();
    await page.waitForTimeout(300);

    // In collapsed mode, menu buttons should still be visible (icons)
    const menuButtons = page.locator('[data-slot="sidebar-menu-button"]');
    const count = await menuButtons.count();
    expect(count).toBeGreaterThan(0);

    // Text labels should be hidden (truncated/hidden via CSS)
    // Check that sidebar width is reduced
    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toHaveAttribute("data-collapsible", "icon");

    console.log("✓ Sidebar collapsed mode shows icons correctly");
  });

  test("sidebar tooltip appears on hover in collapsed mode", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Collapse sidebar (use first() to get desktop trigger)
    const trigger = page.locator('[data-slot="sidebar-trigger"]').first();
    await trigger.click();
    await page.waitForTimeout(300);

    // Hover over a menu button
    const workflowsButton = page
      .locator('[data-slot="sidebar-menu-button"]')
      .filter({ hasText: /Workflows|Рабочие процессы/i });
    await workflowsButton.hover();
    await page.waitForTimeout(100);

    // Check tooltip appears (Radix Tooltip uses data-state="instant-open" or "delayed-open")
    const tooltip = page.locator('[role="tooltip"]');
    await expect(tooltip).toBeVisible({ timeout: 2000 });

    console.log("✓ Sidebar tooltip appears on hover in collapsed mode");
  });

  test("sidebar state persists after page reload", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Collapse sidebar (use first() to get desktop trigger)
    const trigger = page.locator('[data-slot="sidebar-trigger"]').first();
    await trigger.click();
    await page.waitForTimeout(300);

    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");

    // Reload page
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Check state persisted (via cookie)
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");

    console.log("✓ Sidebar state persists after reload");
  });

  test("keyboard shortcut toggles sidebar", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    const sidebar = page.locator('[data-slot="sidebar"]');

    // Initial state - expanded
    await expect(sidebar).toHaveAttribute("data-state", "expanded");

    // Press Cmd+B (Mac) or Ctrl+B (Windows/Linux)
    await page.keyboard.press("Meta+b");
    await page.waitForTimeout(300);

    // Verify collapsed
    await expect(sidebar).toHaveAttribute("data-state", "collapsed");

    // Press again to expand
    await page.keyboard.press("Meta+b");
    await page.waitForTimeout(300);

    // Verify expanded
    await expect(sidebar).toHaveAttribute("data-state", "expanded");

    console.log("✓ Keyboard shortcut toggles sidebar");
  });

  test("user menu displays in sidebar footer", async ({ page }) => {
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Check user menu in sidebar footer
    const sidebarFooter = page.locator('[data-slot="sidebar-footer"]');
    await expect(sidebarFooter).toBeVisible();

    // Should have user menu button (contains avatar initials)
    const userMenuButton = sidebarFooter.locator("button");
    await expect(userMenuButton).toBeVisible();

    // Click to open dropdown and verify it works
    await userMenuButton.click();
    const dropdownMenu = page.locator('[role="menu"]');
    await expect(dropdownMenu).toBeVisible({ timeout: 3000 });

    console.log("✓ User menu displays in sidebar footer");
  });
});

test.describe("Admin Sidebar", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("admin sidebar shows all admin navigation items", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState("domcontentloaded");

    // Check admin navigation items
    await expect(
      page
        .locator('[data-slot="sidebar-menu-button"]')
        .filter({ hasText: /Dashboard|Панель управления/i }),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="sidebar-menu-button"]').filter({ hasText: /Users|Пользователи/i }),
    ).toBeVisible();
    await expect(
      page
        .locator('[data-slot="sidebar-menu-button"]')
        .filter({ hasText: /Executions|Выполнения/i }),
    ).toBeVisible();
    await expect(
      page.locator('[data-slot="sidebar-menu-button"]').filter({ hasText: /Audit|Журнал/i }),
    ).toBeVisible();

    console.log("✓ Admin sidebar shows all navigation items");
  });

  test("back to app navigation works", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState("domcontentloaded");

    // Find and click back to app link
    const backLink = page
      .locator('[data-slot="sidebar-menu-button"]')
      .filter({ hasText: /Back to App|Назад|←/i });
    await expect(backLink).toBeVisible();
    await backLink.click();

    // Should navigate to main app
    await page.waitForURL(`${BASE_URL}/`);
    expect(page.url()).toBe(`${BASE_URL}/`);

    console.log("✓ Back to app navigation works");
  });
});
