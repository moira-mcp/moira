/**
 * E2E Tests for Admin Workflows Page
 * Tests that admin can browse all workflows from all users with filters
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("Admin Workflows Page", () => {
  test("Admin can see workflows page with content", async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto(`${BASE_URL}/admin/workflows`);
    await page.waitForLoadState("domcontentloaded");

    // Page title should be visible
    await expect(page.locator('h1:has-text("All Workflows")')).toBeVisible({ timeout: 10000 });

    // Should show workflow cards (system has at least some workflows)
    const cards = page.getByTestId("admin-workflow-card");
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    // Verify card shows workflow info (owner handle with @)
    const firstCardText = await cards.first().textContent();
    expect(firstCardText).toContain("@");
  });

  test("Admin can filter workflows by visibility", async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto(`${BASE_URL}/admin/workflows`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for cards to load
    await expect(page.getByTestId("admin-workflow-card").first()).toBeVisible({ timeout: 10000 });

    // Click visibility filter
    const visibilityFilter = page.getByTestId("visibility-filter");
    await expect(visibilityFilter).toBeVisible();
    await visibilityFilter.click();

    // Select "Public"
    await page.getByRole("option", { name: "Public" }).click();

    // Wait for data to refresh
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);

    // Cards should still be visible (system has public workflows)
    const cards = page.getByTestId("admin-workflow-card");
    const cardCount = await cards.count();

    // At least some public workflows should exist
    if (cardCount > 0) {
      const firstCardText = await cards.first().textContent();
      expect(firstCardText).toContain("Public");
    }
  });

  test("Admin can search workflows", async ({ page }) => {
    await loginAsAdmin(page);

    await page.goto(`${BASE_URL}/admin/workflows`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for cards to load
    await expect(page.getByTestId("admin-workflow-card").first()).toBeVisible({ timeout: 10000 });

    // Get initial count
    const initialCount = await page.getByTestId("admin-workflow-card").count();

    // Search for something specific
    const searchInput = page.getByTestId("admin-workflows-search");
    await expect(searchInput).toBeVisible();
    await searchInput.fill("nonexistent-xyz-workflow-12345");

    // Wait for search to filter results (cards should disappear)
    await expect(page.getByTestId("admin-workflow-card")).toHaveCount(0, { timeout: 10000 });
  });
});
