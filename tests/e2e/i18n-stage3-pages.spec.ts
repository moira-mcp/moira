import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("i18n Stage 3 - Core Application Pages Translations", () => {
  test.describe("English Core Pages", () => {
    test.use({ locale: "en-US" });

    test("Dashboard shows English content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/`);
      await page.waitForLoadState("domcontentloaded");

      // Check dashboard content
      await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible({ timeout: 5000 });
      await expect(page.locator("text=Recent Workflows")).toBeVisible();
      await expect(page.locator("text=Total Workflows")).toBeVisible();
    });

    test("Workflows page shows English content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/workflows`);
      await page.waitForLoadState("domcontentloaded");

      // Check workflows explorer content
      await expect(page.locator("text=Workflows").first()).toBeVisible({ timeout: 5000 });
      // Check FilterBar filter dropdowns (migrated from labeled dropdowns to inline Selects)
      await expect(page.locator('[data-testid="status-filter"]')).toBeVisible();
      await expect(page.locator('[data-testid="visibility-filter"]')).toBeVisible();
    });

    test("Executions page shows English content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/executions`);
      await page.waitForLoadState("networkidle");

      // Check executions page content
      await expect(page.locator('h1:has-text("Executions")')).toBeVisible({ timeout: 5000 });
      // Wait for page to finish loading (cards or empty state)
      await expect(
        page.locator('[data-testid="execution-card"], [data-testid="empty-state"]').first(),
      ).toBeVisible({ timeout: 15000 });
      const pageText = await page.textContent("body");
      expect(pageText).toMatch(/Your workflow execution history|No executions yet/);
    });

    test("Settings page shows English content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Check settings page content
      await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("Russian Core Pages", () => {
    test.use({ locale: "ru-RU" });

    test("Dashboard shows Russian content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/`);
      await page.waitForLoadState("domcontentloaded");

      // Check dashboard content in Russian
      await expect(page.locator('h1:has-text("Панель управления")')).toBeVisible({ timeout: 5000 });
      await expect(page.locator("text=Недавние воркфлоу")).toBeVisible();
      await expect(page.locator("text=Всего воркфлоу")).toBeVisible();
    });

    test("Workflows page shows Russian content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/workflows`);
      await page.waitForLoadState("domcontentloaded");

      // Check workflows explorer content in Russian
      await expect(page.locator("text=Воркфлоу").first()).toBeVisible({ timeout: 5000 });
      // Check FilterBar filter dropdowns (migrated from labeled dropdowns to inline Selects)
      await expect(page.locator('[data-testid="status-filter"]')).toBeVisible();
      await expect(page.locator('[data-testid="visibility-filter"]')).toBeVisible();
    });

    test("Executions page shows Russian content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/executions`);
      await page.waitForLoadState("domcontentloaded");

      // Check executions page content in Russian
      await expect(page.locator('h1:has-text("Запуски")')).toBeVisible({ timeout: 5000 });
      const pageText = await page.textContent("body");
      expect(pageText).toMatch(/История запусков|Запусков пока нет/);
    });

    test("Settings page shows Russian content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Check settings page content in Russian
      await expect(page.locator('h1:has-text("Настройки")')).toBeVisible({ timeout: 5000 });
    });
  });
});
