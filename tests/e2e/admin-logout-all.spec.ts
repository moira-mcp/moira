/**
 * Admin Logout All Users E2E Tests
 * Tests the Logout All button in Admin Dashboard
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test.describe("Admin Logout All Users", () => {
  // Run serially to avoid killing other tests' admin sessions with "Logout All"
  test.describe.configure({ mode: "serial" });
  // Increase timeout for serial tests under full suite load
  test.setTimeout(60000);

  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin`);
    // Wait for dashboard content instead of networkidle (admin page has polling)
    await page
      .locator("text=Admin Dashboard")
      .or(page.locator("text=Панель админа"))
      .first()
      .waitFor({ timeout: 10000 });
  });

  test("logout all button is visible in admin dashboard", async ({ page }) => {
    // Check System Health section exists (CardTitle renders as <div>, not <h2>)
    const systemHealthSection = page
      .locator("text=Backend Status")
      .or(page.locator("text=Статус бэкенда"))
      .first();
    await expect(systemHealthSection).toBeVisible();

    // Check logout button exists
    const logoutButton = page.locator(
      'button:has-text("Logout All"), button:has-text("Разлогинить")',
    );
    await expect(logoutButton).toBeVisible();
  });

  test("clicking logout all opens confirmation dialog", async ({ page }) => {
    // Click logout button
    const logoutButton = page.locator(
      'button:has-text("Logout All"), button:has-text("Разлогинить")',
    );
    await logoutButton.click();

    // Verify dialog appears
    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog).toBeVisible();

    // Verify dialog has correct title
    const dialogTitle = dialog.locator('h2, [class*="title"]').first();
    await expect(dialogTitle).toContainText(/Logout All|Разлогинить/);

    // Verify dialog has description
    const dialogDescription = dialog.locator('[data-slot="alert-dialog-description"]');
    await expect(dialogDescription).toBeVisible();
  });

  test("cancel button closes dialog without action", async ({ page }) => {
    // Open dialog
    const logoutButton = page.locator(
      'button:has-text("Logout All"), button:has-text("Разлогинить")',
    );
    await logoutButton.click();

    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog).toBeVisible();

    // Click cancel
    const cancelButton = page.locator('button:has-text("Cancel"), button:has-text("Отмена")');
    await cancelButton.click();

    // Dialog should close
    await expect(dialog).not.toBeVisible();

    // Admin should still be logged in
    await expect(page.locator("text=Total Workflows").first()).toBeVisible();
  });

  test("confirm button performs logout all action", async ({ page }) => {
    // Mock the logout-all API to avoid killing other tests' sessions
    let apiCalled = false;
    await page.route("**/api/admin/sessions/all", async (route) => {
      apiCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { deletedSessions: 1, message: "All sessions invalidated" },
          timestamp: new Date().toISOString(),
        }),
      });
    });

    // Open dialog
    const logoutButton = page.locator(
      'button:has-text("Logout All"), button:has-text("Разлогинить")',
    );
    await logoutButton.click();

    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog).toBeVisible();

    // Click confirm
    const confirmButton = dialog.locator(
      'button:has-text("Logout All"), button:has-text("Разлогинить всех")',
    );
    await confirmButton.click();

    // Dialog should close
    await expect(dialog).not.toBeVisible();

    // Verify API was called
    expect(apiCalled).toBe(true);

    // Dashboard should still work
    await expect(page.locator("text=Total Workflows").first()).toBeVisible();
  });

  test("shows loading state during logout", async ({ page }) => {
    let releaseResponse!: () => void;
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let markRequestEntered!: () => void;
    const requestEntered = new Promise<void>((resolve) => {
      markRequestEntered = resolve;
    });
    // Keep the request pending until the loading UI has actually been checked.
    await page.route("**/api/admin/sessions/all", async (route) => {
      markRequestEntered();
      await responseReleased;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          data: { deletedSessions: 1, message: "All sessions invalidated" },
          timestamp: new Date().toISOString(),
        }),
      });
    });

    // Open dialog
    const logoutButton = page.locator(
      'button:has-text("Logout All"), button:has-text("Разлогинить")',
    );
    await logoutButton.click();

    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog).toBeVisible();

    const confirmButton = dialog.locator(
      'button:has-text("Logout All"), button:has-text("Разлогинить всех")',
    );

    try {
      await confirmButton.click();
      await requestEntered;
      await expect(dialog).toBeVisible();
      await expect(confirmButton).toBeDisabled();
      await expect(confirmButton.locator("svg.animate-spin")).toBeVisible();
      await expect(
        dialog.getByRole("button", { name: /Cancel|Отмена/, exact: true }),
      ).toBeDisabled();
    } finally {
      // A failed assertion must also release the route before browser teardown.
      releaseResponse();
    }

    await expect(dialog).not.toBeVisible({ timeout: 5000 });
  });
});
