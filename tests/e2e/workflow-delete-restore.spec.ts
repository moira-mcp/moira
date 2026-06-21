/**
 * E2E tests for Workflow Delete and Restore functionality
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

import { getTestBaseUrl } from "../utils/test-config.js";
const BASE_URL = getTestBaseUrl();

test.describe("Workflow Delete and Restore Flow", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("delete button visible on workflow detail page", async ({ page }) => {
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");

    // Search for test workflow (required because there are 800+ workflows)
    const searchInput = page.locator('input[placeholder*="Search"]');
    await searchInput.fill("react-flow-theme-test");
    await page.waitForTimeout(500);

    // Click on workflow name to navigate (workflows list shows clickable items)
    const workflowItem = page.locator("text=React Flow Theme Test").first();
    await expect(workflowItem).toBeVisible({ timeout: 10000 });
    await workflowItem.click();
    await page.waitForURL(/\/workflows\/.+/, { timeout: 10000 });
    await expect(page.locator('button:has-text("Delete Workflow")')).toBeVisible();
  });

  test("deleted workflows page shows search", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/deleted-workflows`);
    await expect(page.locator('h1:has-text("Deleted Workflows")')).toBeVisible();
    await expect(page.locator('input[placeholder*="Search"]')).toBeVisible();
  });
});
