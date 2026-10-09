import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("i18n Stage 1 Verification", () => {
  test.describe("English Translations", () => {
    test.use({ locale: "en-US" });

    test("should display the login page in English", async ({ page }) => {
      await page.goto(`${BASE_URL}/login`);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByText("Sign In", { exact: true })).toBeVisible();
      await expect(page.getByText("Enter your email and password to sign in")).toBeVisible();
    });
  });

  test.describe("Russian Translations", () => {
    test.use({ locale: "ru-RU" });

    test("should display the login page in Russian", async ({ page }) => {
      await page.goto(`${BASE_URL}/login`);
      await page.waitForLoadState("domcontentloaded");
      // Use card-title selector to avoid matching both title and submit button with same text
      await expect(page.locator('[data-slot="card-title"]:has-text("Войти")')).toBeVisible();
      await expect(page.getByText("Введите ваш email и пароль для входа")).toBeVisible();
    });
  });

  test("Application Stability", async ({ page }) => {
    // Increase timeout for multi-step navigation test
    test.setTimeout(60000);

    await loginAsAdmin(page);

    // Check Dashboard loads (sidebar should be visible)
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible({ timeout: 10000 });

    // Ordinary clicks wait for admission rechecks to restore the sidebar's actionability.
    const workflowsButton = page.locator('[data-slot="sidebar-menu-button"]:has-text("Workflows")');
    await workflowsButton.waitFor({ state: "visible", timeout: 10000 });
    await workflowsButton.click();
    await page.waitForURL(`${BASE_URL}/workflows`, { timeout: 15000 });
    await expect(workflowsButton).toBeVisible();

    // Navigate to Executions
    const executionsButton = page.locator(
      '[data-slot="sidebar-menu-button"]:has-text("Executions")',
    );
    await executionsButton.click();
    await page.waitForURL(`${BASE_URL}/executions`, { timeout: 15000 });
    await expect(executionsButton).toBeVisible();
  });
});
