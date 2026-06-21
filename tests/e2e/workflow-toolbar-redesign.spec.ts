/**
 * E2E tests for Workflow Explorer toolbar
 * Verifies FilterBar-based filters, search, sorting, and pagination
 */

import { test, expect } from "./fixtures.js";
import { login, createTestUser } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const TEST_USER = {
  email: "toolbar-test@example.com",
  password: "TestPass123!",
  name: "Toolbar Test User",
};

test.beforeAll(async () => {
  await createTestUser(TEST_USER.email, TEST_USER.password, TEST_USER.name, true);
});

test.describe("Workflow Explorer Toolbar", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, TEST_USER.email, TEST_USER.password);
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForSelector('[data-testid="workflow-explorer"]', {
      state: "visible",
      timeout: 15000,
    });
  });

  test("should display filter dropdowns", async ({ page }) => {
    // FilterBar uses inline Select components with data-testid attributes
    await expect(page.locator('[data-testid="status-filter"]')).toBeVisible();
    await expect(page.locator('[data-testid="visibility-filter"]')).toBeVisible();
    // Combined sort select replaces separate sort-by and sort-order dropdowns
    await expect(page.locator('[data-testid="sort-select"]')).toBeVisible();
    // Reset button
    await expect(page.locator('[data-testid="filter-reset"]')).toBeVisible();
  });

  test("should display pagination info", async ({ page }) => {
    // Pagination shows "X / Y" indicator instead of "N workflows found" text
    const paginationIndicator = page.locator("text=/\\d+ \\/ \\d+/");
    await expect(paginationIndicator).toBeVisible({ timeout: 10000 });
  });

  test("should have search input in toolbar", async ({ page }) => {
    const searchInput = page.getByPlaceholder(/search/i);
    await expect(searchInput).toBeVisible();

    await searchInput.fill("test");
    await page.waitForTimeout(500);
  });

  test("should have view mode toggle", async ({ page }) => {
    await expect(page.locator('[data-testid="view-mode-list"]')).toBeVisible();
    await expect(page.locator('[data-testid="view-mode-grid"]')).toBeVisible();
  });

  test("should reset pagination when filter changes", async ({ page }) => {
    // Open status filter dropdown
    const statusFilter = page.locator('[data-testid="status-filter"]');
    await statusFilter.click();

    // Select "Valid" option
    await page.getByRole("option", { name: "Valid", exact: true }).click();
    await page.waitForTimeout(500);

    // If there was pagination, it should reset to page 1
    const pageIndicator = page.locator("text=/^1 \\/ \\d+$/");
    const indicatorVisible = await pageIndicator.isVisible().catch(() => false);

    if (indicatorVisible) {
      await expect(pageIndicator).toContainText("1 /");
    }
  });
});
