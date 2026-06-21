import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

test.describe("i18n Stage 5 - Language Switcher", () => {
  test.describe("English Default", () => {
    test.use({ locale: "en-US" });

    test("Language switcher is visible in user menu", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/`);
      await page.waitForLoadState("domcontentloaded");

      // Open user menu (use email text which is more reliable)
      const userMenuTrigger = page.locator(`button:has-text("${ADMIN_CREDENTIALS.email}")`).first();
      await userMenuTrigger.click();

      // Check language option exists
      await expect(page.locator("text=/Language:/")).toBeVisible({ timeout: 5000 });
    });

    test("Clicking language switches to Russian", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/`);
      await page.waitForLoadState("domcontentloaded");

      // Verify English content first
      await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible({ timeout: 5000 });

      // Open user menu and click language
      const userMenuTrigger = page.locator(`button:has-text("${ADMIN_CREDENTIALS.email}")`).first();
      await userMenuTrigger.click();

      // Wait for dropdown to be visible before clicking
      const languageItem = page.locator("text=/Language:/");
      await expect(languageItem).toBeVisible({ timeout: 5000 });
      await languageItem.click();

      // Verify Russian content now shows
      await expect(page.locator('h1:has-text("Панель управления")')).toBeVisible({ timeout: 5000 });
    });

    test("Language preference persists after page reload", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/`);
      await page.waitForLoadState("domcontentloaded");

      // Switch to Russian
      const userMenuTrigger = page.locator(`button:has-text("${ADMIN_CREDENTIALS.email}")`).first();
      await userMenuTrigger.click();

      // Wait for dropdown to be visible before clicking
      const languageItem = page.locator("text=/Language:/");
      await expect(languageItem).toBeVisible({ timeout: 5000 });
      await languageItem.click();

      // Verify Russian
      await expect(page.locator('h1:has-text("Панель управления")')).toBeVisible({ timeout: 5000 });

      // Reload page
      await page.reload();
      await page.waitForLoadState("domcontentloaded");

      // Russian should still be selected
      await expect(page.locator('h1:has-text("Панель управления")')).toBeVisible({ timeout: 5000 });
    });

    test("Switching back to English works", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/`);
      await page.waitForLoadState("domcontentloaded");

      // Switch to Russian first
      const userMenuTrigger1 = page
        .locator(`button:has-text("${ADMIN_CREDENTIALS.email}")`)
        .first();
      await userMenuTrigger1.click();

      // Wait for dropdown to be visible before clicking
      const languageItemEn = page.locator("text=/Language:/");
      await expect(languageItemEn).toBeVisible({ timeout: 5000 });
      await languageItemEn.click();

      // Verify Russian UI appeared
      await expect(page.locator('h1:has-text("Панель управления")')).toBeVisible({ timeout: 5000 });

      // Small delay to let the UI settle after language change
      await page.waitForTimeout(500);

      // Switch back to English (menu item now shows "Язык:" in Russian)
      const userMenuTrigger2 = page
        .locator(`button:has-text("${ADMIN_CREDENTIALS.email}")`)
        .first();
      await userMenuTrigger2.click();

      // Wait for dropdown to be visible before clicking - now in Russian
      const languageItemRu = page.locator("text=/Язык:/");
      await expect(languageItemRu).toBeVisible({ timeout: 5000 });
      await languageItemRu.click();

      // Verify English again
      await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("Russian Default", () => {
    test.use({ locale: "ru-RU" });

    test("Russian browser starts with Russian UI", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/`);
      await page.waitForLoadState("domcontentloaded");

      // Should show Russian UI based on browser locale
      await expect(page.locator('h1:has-text("Панель управления")')).toBeVisible({ timeout: 5000 });
    });

    test("Can switch to English from Russian", async ({ page }) => {
      await loginAsAdmin(page);

      await page.goto(`${BASE_URL}/`);
      await page.waitForLoadState("domcontentloaded");

      // Verify Russian first
      await expect(page.locator('h1:has-text("Панель управления")')).toBeVisible({ timeout: 5000 });

      // Open user menu and switch to English (menu shows "Язык:" in Russian)
      const userMenuTrigger = page.locator(`button:has-text("${ADMIN_CREDENTIALS.email}")`).first();
      await userMenuTrigger.click();

      // Wait for dropdown to be visible before clicking
      const languageItem = page.locator("text=/Язык:/");
      await expect(languageItem).toBeVisible({ timeout: 5000 });
      await languageItem.click();

      // Verify English
      await expect(page.locator('h1:has-text("Dashboard")')).toBeVisible({ timeout: 5000 });
    });
  });
});
