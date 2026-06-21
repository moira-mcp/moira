/**
 * E2E Tests for Admin Analytics (merged into Admin Dashboard)
 * Analytics content is now integrated into the admin dashboard page.
 * The /admin/analytics route redirects to /admin.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("Admin Analytics (merged into Dashboard)", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState("domcontentloaded");
    // Wait for dashboard content to render instead of networkidle
    // (admin dashboard has ongoing API calls that prevent networkidle)
    await expect(page.getByRole("heading", { name: "Admin Dashboard" })).toBeVisible({
      timeout: 15000,
    });
  });

  test("should redirect /analytics to dashboard", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/analytics`);
    await page.waitForURL(`${BASE_URL}/admin`, { timeout: 10000 });
    expect(page.url()).not.toContain("/analytics");
  });

  test("should display time range selector on dashboard", async ({ page }) => {
    const selector = page.locator('[role="combobox"]').first();
    await expect(selector).toBeVisible({ timeout: 10000 });
  });

  test("should display analytics overview cards on dashboard", async ({ page }) => {
    await expect(page.locator("text=Total Workflows").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator("text=Total Executions").first()).toBeVisible();
  });

  test("should display top workflows section", async ({ page }) => {
    await expect(page.locator("text=Top 10 Workflows").first()).toBeVisible({ timeout: 10000 });
  });

  test("should display executions chart when data exists", async ({ page }) => {
    const chart = page.getByTestId("executions-chart");
    const chartExists = await chart.count();
    if (chartExists > 0) {
      await expect(chart).toBeVisible();
    }
  });

  test("should not have Analytics link in sidebar", async ({ page }) => {
    const sidebar = page.locator('[data-slot="sidebar"]');
    await expect(sidebar).not.toContainText("Analytics");
  });
});
