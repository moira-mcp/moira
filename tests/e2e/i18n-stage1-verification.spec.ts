import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

/**
 * Helper to handle Beta Agreement dialog (works for both EN and RU locales)
 * Uses aggressive retry strategy to ensure dialog is fully closed
 */
async function handleBetaDialog(page: import("@playwright/test").Page) {
  // Wait for page to stabilize and any dialog to appear
  await page.waitForTimeout(1500);

  const overlay = page.locator('[data-slot="dialog-overlay"]');
  const maxAttempts = 5;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const overlayVisible = await overlay.isVisible().catch(() => false);
    if (!overlayVisible) {
      // Double-check after a short delay (animation might be in progress)
      await page.waitForTimeout(300);
      const stillVisible = await overlay.isVisible().catch(() => false);
      if (!stillVisible) break;
    }

    // Support both English and Russian button text for Beta Agreement
    const acceptBtn = page.locator(
      'button:has-text("Accept and Continue"), button:has-text("Принять и продолжить")',
    );
    const acceptBtnVisible = await acceptBtn
      .first()
      .isVisible()
      .catch(() => false);

    if (acceptBtnVisible) {
      await acceptBtn.first().click({ force: true });
      // Wait for overlay to be fully hidden with longer timeout
      await overlay.waitFor({ state: "hidden", timeout: 15000 }).catch(() => {});
      // Extra wait for animation to complete
      await page.waitForTimeout(1000);
    } else {
      // No Beta Agreement button - might be another dialog type
      // Try finding any close/cancel button in the dialog
      const dialog = page.locator('[role="dialog"]');
      const closeBtn = dialog.getByRole("button", { name: /^Close$|^Закрыть$|^Cancel$|^Отмена$/ });
      const closeBtnVisible = await closeBtn
        .first()
        .isVisible()
        .catch(() => false);

      if (closeBtnVisible) {
        await closeBtn.first().click({ force: true });
        await page.waitForTimeout(500);
      } else {
        // No button found, try pressing Escape
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);
      }
    }
  }

  // Final aggressive cleanup - if overlay still visible after all attempts
  const overlayStillVisible = await overlay.isVisible().catch(() => false);
  if (overlayStillVisible) {
    // Try clicking outside the dialog area
    await page.mouse.click(10, 10);
    await page.waitForTimeout(300);

    // Multiple Escape presses
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }

    // Final wait and verify
    await overlay.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  }

  // Ensure page is interactive before returning
  await page.waitForTimeout(500);
}

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

    // Login
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");
    await page.fill('input[name="email"]', ADMIN_CREDENTIALS.email);
    await page.fill('input[name="password"]', ADMIN_CREDENTIALS.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(`${BASE_URL}/`);

    // Wait for page load
    await page.waitForLoadState("domcontentloaded");

    // Handle Beta Agreement dialog if present - with extra verification
    await handleBetaDialog(page);

    // Double-check dialog is fully closed before proceeding
    const overlay = page.locator('[data-slot="dialog-overlay"]');
    await overlay.waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});

    // Check Dashboard loads (sidebar should be visible)
    await expect(page.locator('[data-slot="sidebar"]')).toBeVisible({ timeout: 10000 });

    // Navigate to Workflows using sidebar - use force click to bypass any overlay remnants
    const workflowsButton = page.locator('[data-slot="sidebar-menu-button"]:has-text("Workflows")');
    await workflowsButton.waitFor({ state: "visible", timeout: 10000 });
    await workflowsButton.click({ force: true });
    await page.waitForURL(`${BASE_URL}/workflows`, { timeout: 15000 });
    await expect(workflowsButton).toBeVisible();

    // Navigate to Executions
    const executionsButton = page.locator(
      '[data-slot="sidebar-menu-button"]:has-text("Executions")',
    );
    await executionsButton.click({ force: true });
    await page.waitForURL(`${BASE_URL}/executions`, { timeout: 15000 });
    await expect(executionsButton).toBeVisible();
  });
});
