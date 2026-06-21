import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("i18n Stage 2 - Layout and Navigation Translations", () => {
  test.describe("English Navigation", () => {
    test.use({ locale: "en-US" });

    test("sidebar navigation shows English labels", async ({ page }) => {
      // Login via HTTP (fast, includes beta dialog bypass)
      await loginAsAdmin(page);

      // Check sidebar nav items in English (using shadcn sidebar selectors)
      await expect(page.locator('[data-slot="sidebar-menu-button"]:has-text("Home")')).toBeVisible({
        timeout: 5000,
      });
      await expect(
        page.locator('[data-slot="sidebar-menu-button"]:has-text("Workflows")'),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="sidebar-menu-button"]:has-text("Executions")'),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="sidebar-menu-button"]:has-text("Notes")'),
      ).toBeVisible();
    });

    test("user menu shows English labels", async ({ page }) => {
      // Login via HTTP (fast, includes beta dialog bypass)
      await loginAsAdmin(page);

      // Open user menu (in sidebar footer)
      const userMenuButton = page.locator('[data-slot="sidebar-footer"] button');
      await expect(userMenuButton).toBeVisible({ timeout: 5000 });
      await userMenuButton.click({ force: true });
      await page.waitForTimeout(300);

      // Check menu items in English (use first() to avoid strict mode)
      const menu = page.locator('[role="menu"]');
      await expect(menu).toBeVisible({ timeout: 3000 });
      await expect(page.getByRole("menuitem", { name: /Theme/i }).first()).toBeVisible();
      await expect(page.getByRole("menuitem", { name: /Logout/i }).first()).toBeVisible();
    });
  });

  test.describe("Russian Navigation", () => {
    test.use({ locale: "ru-RU" });

    test("sidebar navigation shows Russian labels", async ({ page }) => {
      // Login via HTTP (fast, includes beta dialog bypass)
      await loginAsAdmin(page);

      // Check sidebar nav items in Russian (using shadcn sidebar selectors)
      await expect(
        page.locator('[data-slot="sidebar-menu-button"]:has-text("Главная")'),
      ).toBeVisible({ timeout: 5000 });
      await expect(
        page.locator('[data-slot="sidebar-menu-button"]:has-text("Воркфлоу")'),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="sidebar-menu-button"]:has-text("Запуски")'),
      ).toBeVisible();
      await expect(
        page.locator('[data-slot="sidebar-menu-button"]:has-text("Заметки")'),
      ).toBeVisible();
    });

    test("user menu shows Russian labels", async ({ page }) => {
      // Login via HTTP (fast, includes beta dialog bypass)
      await loginAsAdmin(page);

      // Open user menu (in sidebar footer)
      const userMenuButton = page.locator('[data-slot="sidebar-footer"] button');
      await expect(userMenuButton).toBeVisible({ timeout: 5000 });
      await userMenuButton.click({ force: true });
      await page.waitForTimeout(300);

      // Check menu items in Russian (use first() to avoid strict mode)
      const menu = page.locator('[role="menu"]');
      await expect(menu).toBeVisible({ timeout: 3000 });
      await expect(page.getByRole("menuitem", { name: /Тема/i }).first()).toBeVisible();
      await expect(page.getByRole("menuitem", { name: /Выход/i }).first()).toBeVisible();
    });
  });
});
