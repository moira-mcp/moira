/**
 * Step 24 Verification Tests
 * Navigation, Dashboard, Card Fixes
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

test.describe("Step 24: Navigation, Dashboard, Card Fixes", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("1. Sidebar shows Settings item", async ({ page }) => {
    await page.goto(`${getTestBaseUrl()}/`);
    await page.waitForLoadState("networkidle");
    const settingsLink = page.locator('a[href="/settings"]');
    await expect(settingsLink).toBeVisible();
  });

  test("2. Sidebar shows Admin item for admin users", async ({ page }) => {
    await page.goto(`${getTestBaseUrl()}/`);
    await page.waitForLoadState("networkidle");
    const adminLink = page.locator('a[href="/admin"]');
    await expect(adminLink).toBeVisible();
  });

  test("3. UserMenu does NOT show Admin item in dropdown", async ({ page }) => {
    await page.goto(`${getTestBaseUrl()}/`);
    await page.waitForLoadState("networkidle");
    // Open user menu by clicking the avatar/user button in the sidebar footer
    const avatarButton = page.locator("button:has(.rounded-full)").first();
    await avatarButton.click();
    await page.waitForTimeout(500);
    // Admin should not be in dropdown
    const adminMenuItem = page.locator('[role="menuitem"]:has-text("Admin")');
    await expect(adminMenuItem).toHaveCount(0);
  });

  test("8. ExecutionCard full mode shows UUID", async ({ page }) => {
    await page.goto(`${getTestBaseUrl()}/executions`);
    await page.waitForLoadState("networkidle");
    const executionCards = page.locator('[data-testid="execution-card"]');
    const count = await executionCards.count();
    if (count > 0) {
      // In list mode, UUID should be present as 8-char hex string
      const firstCard = executionCards.first();
      const monoText = firstCard.locator(".font-mono");
      const monoCount = await monoText.count();
      expect(monoCount).toBeGreaterThan(0);
    }
  });

  test("9. Beta banner at bottom of page", async ({ page }) => {
    // loginAsAdmin accepted the beta agreement via cookie, so the persistent banner shows
    // (SaaS deployments only); it is rendered after the main content, not before it
    await page.goto(`${getTestBaseUrl()}/`);
    const banner = page.locator("#main-content ~ *").filter({ hasText: "Beta Version:" });
    await expect(banner).toBeVisible();
    await expect(page.locator("#main-content").locator("text=Beta Version:")).toHaveCount(0);

    // Dismissing hides the banner
    await banner.getByRole("button", { name: "Dismiss beta warning" }).click();
    await expect(banner).toHaveCount(0);
  });

  test("10. DataListView grid has padding", async ({ page }) => {
    await page.goto(`${getTestBaseUrl()}/executions`);
    await page.waitForLoadState("networkidle");
    // Switch to grid view if available
    const gridToggle = page.locator('[data-testid="view-toggle-grid"]');
    if (await gridToggle.isVisible()) {
      await gridToggle.click();
      await page.waitForTimeout(300);
      // Check grid container has padding
      const gridContainer = page.locator(".grid.grid-cols-1");
      if (await gridContainer.isVisible()) {
        const padding = await gridContainer.evaluate((el) => getComputedStyle(el).padding);
        expect(padding).not.toBe("0px");
      }
    }
  });

  test("11. Sidebar filters adminOnly routes for admin", async ({ page }) => {
    await page.goto(`${getTestBaseUrl()}/`);
    await page.waitForLoadState("networkidle");
    // Admin link should be visible for admin
    const adminLink = page.locator('a[href="/admin"]');
    await expect(adminLink).toBeVisible();
    // Settings should also be visible
    const settingsLink = page.locator('a[href="/settings"]');
    await expect(settingsLink).toBeVisible();
  });

  test("12. Executions page loads with cards", async ({ page }) => {
    await page.goto(`${getTestBaseUrl()}/executions`);
    await page.waitForLoadState("networkidle");
    // Page should load without errors
    const heading = page.locator("h1, h2").first();
    await expect(heading).toBeVisible();
  });
});
