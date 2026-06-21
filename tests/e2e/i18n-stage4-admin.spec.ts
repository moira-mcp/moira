import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("i18n Stage 4 - Admin Section Pages Translations", () => {
  test.describe("English Admin Pages", () => {
    test.use({ locale: "en-US" });

    test("Admin Dashboard shows English content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin`);
      await page.waitForLoadState("domcontentloaded");

      // Check admin dashboard content
      await expect(page.locator('h1:has-text("Admin Dashboard")')).toBeVisible({ timeout: 5000 });
      await expect(page.locator("text=Backend Status")).toBeVisible();
      await expect(page.locator("text=Quick Links")).toBeVisible();
      await expect(page.locator("text=Total Workflows").first()).toBeVisible();
    });

    test("User Management shows English content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin/users`);
      await page.waitForLoadState("domcontentloaded");

      // Check user management content
      await expect(page.locator('h1:has-text("User Management")')).toBeVisible({ timeout: 5000 });

      // User cards loaded (no table headers in card-based UI)
      await expect(page.getByTestId("user-card").first()).toBeVisible({ timeout: 10000 });
    });

    test("Admin Executions shows English content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin/executions`);
      await page.waitForLoadState("domcontentloaded");

      // Check admin executions content
      await expect(page.locator('h1:has-text("All Executions")')).toBeVisible({ timeout: 5000 });
      await expect(page.locator("text=Monitor workflow executions")).toBeVisible();

      // Filters - shadcn Select renders as button trigger, not native <select>/<option>
      await expect(page.getByRole("combobox").first()).toBeVisible();
      await expect(page.locator("text=All statuses").first()).toBeVisible();
    });

    test("System Settings shows English content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Check settings page content (unified settings page with tabs)
      await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 5000 });
      await expect(page.locator("text=Create New Definition")).toBeVisible();
      await page.getByRole("tab", { name: "Maintenance" }).click();
      await expect(page.locator("text=Database Maintenance")).toBeVisible();
    });

    test("Audit Log shows English content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin/audit-log`);
      await page.waitForLoadState("networkidle");

      // Check audit log content
      await expect(page.locator('h1:has-text("Audit Log")')).toBeVisible({ timeout: 5000 });
      await expect(page.locator("text=System audit trail")).toBeVisible();

      // Cards should load (no table headers anymore — sort is via Select)
      await expect(page.locator('[data-testid="audit-log-card"]').first()).toBeVisible({
        timeout: 15000,
      });
    });

    test("Deleted Workflows shows English content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin/deleted-workflows`);
      await page.waitForLoadState("networkidle");

      // Check deleted workflows content
      await expect(page.locator('h1:has-text("Deleted Workflows")')).toBeVisible({ timeout: 5000 });

      // Wait for loading to finish — either cards or empty message must appear
      const cardsOrEmpty = page
        .getByTestId("deleted-workflow-card")
        .first()
        .or(page.getByText("No deleted workflows", { exact: false }));
      await expect(cardsOrEmpty).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("Russian Admin Pages", () => {
    test.use({ locale: "ru-RU" });

    test("Admin Dashboard shows Russian content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin`);
      await page.waitForLoadState("domcontentloaded");

      // Check admin dashboard content in Russian
      await expect(page.locator('h1:has-text("Панель администратора")')).toBeVisible({
        timeout: 5000,
      });
      await expect(page.locator("text=Статус бэкенда")).toBeVisible();
      await expect(page.locator("text=Быстрые ссылки")).toBeVisible();
      await expect(page.locator("text=Всего воркфлоу").first()).toBeVisible();
    });

    test("User Management shows Russian content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin/users`);
      await page.waitForLoadState("domcontentloaded");

      // Check user management content in Russian
      await expect(page.locator('h1:has-text("Управление пользователями")')).toBeVisible({
        timeout: 5000,
      });

      // User cards loaded (no table headers in card-based UI)
      await expect(page.getByTestId("user-card").first()).toBeVisible({ timeout: 10000 });
    });

    test("Admin Executions shows Russian content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin/executions`);
      await page.waitForLoadState("domcontentloaded");

      // Check admin executions content in Russian
      await expect(page.locator('h1:has-text("Все запуски")')).toBeVisible({ timeout: 5000 });
      await expect(page.locator("text=Мониторинг запусков воркфлоу")).toBeVisible();

      // Filters in Russian - shadcn Select renders as button trigger, not native <select>/<option>
      await expect(page.getByRole("combobox").first()).toBeVisible();
      await expect(page.locator("text=Все статусы").first()).toBeVisible();
    });

    test("System Settings shows Russian content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin/settings`);
      await page.waitForLoadState("domcontentloaded");

      // Check settings page content in Russian (unified settings page with tabs)
      await expect(page.locator('h1:has-text("Настройки")')).toBeVisible({
        timeout: 5000,
      });
      await expect(page.locator("text=Создать новое определение")).toBeVisible();
      await page.getByRole("tab", { name: /Обслуживание|Maintenance/ }).click();
      await expect(page.locator("text=Обслуживание базы данных")).toBeVisible();
    });

    test("Audit Log shows Russian content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin/audit-log`);
      await page.waitForLoadState("networkidle");

      // Check audit log content in Russian
      await expect(page.locator('h1:has-text("Журнал аудита")')).toBeVisible({ timeout: 5000 });
      await expect(page.locator("text=системных событий")).toBeVisible();

      // Cards should load (no table headers anymore — sort is via Select)
      await expect(page.locator('[data-testid="audit-log-card"]').first()).toBeVisible({
        timeout: 15000,
      });
    });

    test("Deleted Workflows shows Russian content", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/admin/deleted-workflows`);
      await page.waitForLoadState("networkidle");

      // Check deleted workflows content in Russian
      await expect(page.locator('h1:has-text("Удалённые воркфлоу")')).toBeVisible({
        timeout: 5000,
      });

      // Wait for loading to finish — either cards or empty message must appear
      const cardsOrEmpty = page
        .getByTestId("deleted-workflow-card")
        .first()
        .or(page.getByText("Удалённых воркфлоу нет", { exact: false }));
      await expect(cardsOrEmpty).toBeVisible({ timeout: 5000 });
    });
  });
});
