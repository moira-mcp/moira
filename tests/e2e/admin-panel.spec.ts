/**
 * Admin Panel E2E Tests
 * Tests admin-only functionality with NEW architecture (no tabs, separate routes)
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin, login, createTestUser } from "./helpers/auth-helper.js";

import { getTestBaseUrl } from "../utils/test-config.js";
const BASE_URL = getTestBaseUrl();

test.describe("Admin Panel", () => {
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
  });

  test("admin can access admin dashboard", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForLoadState("domcontentloaded");
    const health = page.getByTestId("admin-system-health");
    await expect(health).toBeVisible();
    await expect(health).toContainText("healthy");
    await expect(page.getByText("Maintenance", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Logout All Users", exact: true })).toBeVisible();
  });

  test("system events retain unknown times and display a known epoch time", async ({ page }) => {
    await page.route("**/api/admin/stats", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          data: {
            ...body.data,
            recentActivity: [
              {
                id: "system-event-undated",
                workflowId: "undated-flow",
                status: "paused",
                timestamp: null,
                action: "Workflow execution paused",
              },
              {
                id: "system-event-epoch",
                workflowId: "epoch-flow",
                status: "completed",
                timestamp: 0,
                action: "Workflow execution completed",
              },
            ],
          },
        },
      });
    });

    await page.goto(`${BASE_URL}/admin`);
    const events = page.getByTestId("admin-recent-activity");
    const unknown = events
      .locator("div")
      .filter({
        has: page.getByText("Workflow execution paused · undated-flow", { exact: true }),
      })
      .last();
    await expect(unknown).toBeVisible();
    await expect(unknown.locator("span").last()).toHaveText("—");

    const epoch = events
      .locator("div")
      .filter({
        has: page.getByText("Workflow execution completed · epoch-flow", { exact: true }),
      })
      .last();
    await expect(epoch).toBeVisible();
    const epochTime = epoch.locator("span").last();
    await expect(epochTime).toHaveText(/(?:Jan 1|Dec 31).*\d{2}:\d{2}/);
  });

  test("admin can navigate to users page", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.click('a[href="/admin/users"]');
    await page.waitForURL(`${BASE_URL}/admin/users`);
    await expect(page.locator('h1:has-text("User Management")')).toBeVisible({ timeout: 10000 });
  });

  test("admin can view users list", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/users`);
    await page.waitForLoadState("domcontentloaded");
    // Wait for user cards to load
    await expect(page.getByTestId("user-card").first()).toBeVisible({ timeout: 10000 });
    // Admin user should be visible in a card
    await expect(page.getByText("admin@moira.local").first()).toBeVisible();
  });

  test("admin can navigate to system settings", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.click('a[href="/admin/settings"]');
    await page.waitForURL(`${BASE_URL}/admin/settings`);
    await expect(page.locator('input[placeholder*="Key"]')).toBeVisible();
  });

  test("admin can create setting definition", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin/settings`);

    const uniqueKey = `test.setting_${Date.now()}`;
    await page.fill('input[placeholder*="Key"]', uniqueKey);
    await page.selectOption("select", "string");
    await page.fill('input[placeholder="Category"]', "test");
    await page.fill('input[placeholder="Label"]', "Test Setting");
    await page.click('button[type="submit"]:has-text("Create Definition")');

    await expect(page.locator(`text=${uniqueKey}`)).toBeVisible();
  });

  test("admin can navigate to deleted workflows", async ({ page }) => {
    await page.goto(`${BASE_URL}/admin`);
    await page.click('a[href="/admin/deleted-workflows"]');
    await page.waitForURL(`${BASE_URL}/admin/deleted-workflows`);
    await expect(page.locator('h1:has-text("Deleted Workflows")')).toBeVisible({ timeout: 10000 });
  });

  test("admin can download database backup", async ({ page }) => {
    // Downloads don't work reliably over remote WebSocket Playwright connection
    test.skip(
      process.env.PLAYWRIGHT_REMOTE === "true",
      "Download tests not supported in remote mode",
    );
    // Increase timeout for this test - backup can take time
    test.setTimeout(90000);

    await page.goto(`${BASE_URL}/admin/settings`);
    await page.waitForLoadState("networkidle");

    // Use the caller-owned settings navigation to reveal Database Maintenance.
    await page.getByTestId("admin-settings-nav-maintenance").click();
    await expect(page.getByTestId("tab-maintenance")).toBeVisible();
    expect(new URL(page.url()).searchParams.get("tab")).toBe("maintenance");
    await expect(page.locator("text=Database Maintenance")).toBeVisible({
      timeout: 15000,
    });

    // Find backup button (text is "Backup" from localization)
    const backupButton = page.locator('button:has-text("Backup")');
    await expect(backupButton).toBeVisible();
    await expect(backupButton).toBeEnabled();

    // Setup download listener before clicking - wait up to 90 seconds for backup
    const downloadPromise = page.waitForEvent("download", { timeout: 90000 });

    // Click backup button to open confirmation dialog
    await backupButton.click();

    // Confirm in AlertDialog (replaced native confirm())
    const confirmButton = page.locator('[role="alertdialog"] button:has-text("Backup")');
    await expect(confirmButton).toBeVisible({ timeout: 5000 });
    await confirmButton.click();

    // Wait for download to start
    const download = await downloadPromise;

    // Verify download filename pattern
    expect(download.suggestedFilename()).toMatch(/moira-backup-.*\.db$/);

    // Verify file is not empty (has content)
    // Use saveAs() instead of path() — path() is not available when connecting remotely
    const { join } = await import("path");
    const { mkdtempSync, statSync, unlinkSync, rmdirSync } = await import("fs");
    const { tmpdir } = await import("os");
    const tempDir = mkdtempSync(join(tmpdir(), "moira-test-"));
    const savePath = join(tempDir, download.suggestedFilename());
    await download.saveAs(savePath);
    const stat = statSync(savePath);
    expect(stat.size).toBeGreaterThan(0);
    unlinkSync(savePath);
    rmdirSync(tempDir);
  });
});

test.describe("Non-Admin Access", () => {
  test("non-admin cannot see admin link", async ({ page }) => {
    // Create verified test user via API (includes consent fields)
    const testEmail = `user-${Date.now()}@test.com`;
    const testPassword = "Test123!";
    await createTestUser(testEmail, testPassword, "Test User");

    // Login and navigate to app
    await login(page, testEmail, testPassword);

    const adminLink = page.locator('a[href="/admin"]');
    await expect(adminLink).not.toBeVisible();
  });

  test("non-admin redirected from admin routes", async ({ page }) => {
    // Create verified test user via API (includes consent fields)
    const testEmail = `user-redirect-${Date.now()}@test.com`;
    const testPassword = "Test123!";
    await createTestUser(testEmail, testPassword, "Test User");

    // Login and navigate to app
    await login(page, testEmail, testPassword);

    // Try to access admin routes - should redirect to /workflows
    await page.goto(`${BASE_URL}/admin`);
    await page.waitForURL(`${BASE_URL}/workflows`, { timeout: 5000 });
    expect(page.url()).toBe(`${BASE_URL}/workflows`);

    await page.goto(`${BASE_URL}/admin/users`);
    await page.waitForURL(`${BASE_URL}/workflows`, { timeout: 5000 });
    expect(page.url()).toBe(`${BASE_URL}/workflows`);

    await page.goto(`${BASE_URL}/admin/settings`);
    await page.waitForURL(`${BASE_URL}/workflows`, { timeout: 5000 });
    expect(page.url()).toBe(`${BASE_URL}/workflows`);
  });
});
