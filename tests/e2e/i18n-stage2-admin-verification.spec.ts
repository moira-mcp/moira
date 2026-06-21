import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

/**
 * Helper to handle Beta Agreement dialog (works for both EN and RU locales)
 */
async function handleBetaDialog(page: import("@playwright/test").Page) {
  await page.waitForTimeout(500);
  const dialog = page.locator('[role="dialog"]');
  if ((await dialog.count()) > 0) {
    // Support both English and Russian button text
    const acceptBtn = page.locator(
      'button:has-text("Accept and Continue"), button:has-text("Принять и продолжить")',
    );
    if ((await acceptBtn.count()) > 0) {
      await acceptBtn.first().click({ force: true });
      await page
        .waitForSelector('[data-slot="dialog-overlay"]', { state: "hidden", timeout: 5000 })
        .catch(() => {});
      await page.waitForTimeout(300);
    }
  }
}

test.describe("i18n Stage 2 - Admin Pages Verification", () => {
  test.describe("English Admin Pages", () => {
    test.use({ locale: "en-US" });

    test("should display admin dashboard in English", async ({ page }) => {
      await loginAsAdmin(page);
      await handleBetaDialog(page);

      // Navigate to admin panel
      await page.goto(`${BASE_URL}/admin`);
      await page.waitForLoadState("domcontentloaded");

      // Check admin dashboard title
      await expect(page.locator('h1:has-text("Admin Dashboard")')).toBeVisible();
    });

    test("should display user management in English", async ({ page }) => {
      await loginAsAdmin(page);
      await handleBetaDialog(page);

      await page.goto(`${BASE_URL}/admin/users`);
      await page.waitForLoadState("domcontentloaded");

      // Check user management title
      await expect(page.locator('h1:has-text("User Management")')).toBeVisible();
      // Check user cards are loaded (no table headers in card-based UI)
      await expect(page.getByTestId("user-card").first()).toBeVisible({ timeout: 10000 });
    });

    test("should display audit log in English", async ({ page }) => {
      await loginAsAdmin(page);
      await handleBetaDialog(page);

      await page.goto(`${BASE_URL}/admin/audit-log`);
      await page.waitForLoadState("domcontentloaded");

      // Check audit log title (it's h1 with text-2xl class)
      await expect(page.getByText("Audit Log", { exact: true }).first()).toBeVisible();
    });
  });

  test.describe("Russian Admin Pages", () => {
    test.use({ locale: "ru-RU" });

    test("should display admin dashboard in Russian", async ({ page }) => {
      await loginAsAdmin(page);
      await handleBetaDialog(page);

      await page.goto(`${BASE_URL}/admin`);
      await page.waitForLoadState("domcontentloaded");

      // Check admin dashboard title in Russian
      await expect(page.locator('h1:has-text("Панель администратора")')).toBeVisible();
    });

    test("should display user management in Russian", async ({ page }) => {
      await loginAsAdmin(page);
      await handleBetaDialog(page);

      await page.goto(`${BASE_URL}/admin/users`);
      await page.waitForLoadState("domcontentloaded");

      // Check user management title in Russian
      await expect(page.locator('h1:has-text("Управление пользователями")')).toBeVisible();
      // Check user cards are loaded (no table headers in card-based UI)
      await expect(page.getByTestId("user-card").first()).toBeVisible({ timeout: 10000 });
    });

    test("should display audit log in Russian", async ({ page }) => {
      await loginAsAdmin(page);
      await handleBetaDialog(page);

      await page.goto(`${BASE_URL}/admin/audit-log`);
      await page.waitForLoadState("domcontentloaded");

      // Check audit log title in Russian (it's h1 with text-2xl class)
      await expect(page.getByText("Журнал аудита", { exact: true }).first()).toBeVisible();
    });
  });
});
