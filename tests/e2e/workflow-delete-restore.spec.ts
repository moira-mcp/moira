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

    // The Workflows home is now a single "Your library" surface: filter it by NAME, then
    // open the admin-owned flow via its card's edit action (the card name is not a link).
    const searchInput = page.getByTestId("library-search");
    await searchInput.fill("React Flow Theme Test");
    const card = page.getByTestId("flow-card").filter({ hasText: "React Flow Theme Test" });
    await expect(card.first()).toBeVisible({ timeout: 10000 });
    await card.first().getByTestId("edit-workflow").click();
    await page.waitForURL(/\/workflows\/.+/, { timeout: 10000 });
    await expect(page.locator('button:has-text("Delete Workflow")')).toBeVisible();
  });

  test("deleted workflows page shows search", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/deleted-workflows`);
    await expect(page.locator('h1:has-text("Deleted Workflows")')).toBeVisible();
    await expect(page.locator('input[placeholder*="Search"]')).toBeVisible();
  });
});
