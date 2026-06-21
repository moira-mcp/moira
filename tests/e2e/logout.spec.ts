/**
 * Logout Button Component Tests
 * Tests logout button visibility and functionality
 *
 * IMPORTANT: Tests run against Docker by default (localhost:DOCKER_PORT from .env)
 * Override with TEST_BASE_URL env variable for other environments
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { login, createTestUser } from "./helpers/auth-helper.js";

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

test.describe("Logout Button and Session Display", () => {
  test("Logout button NOT visible when not authenticated", async ({ page }) => {
    // Clear any existing session
    await page.context().clearCookies();

    // Navigate to login page (public)
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    // Logout button should NOT be visible on login page
    const logoutButton = page.locator('button:has-text("Logout")');
    const isVisible = await logoutButton.isVisible({ timeout: 1000 }).catch(() => false);

    expect(isVisible).toBeFalsy();
  });

  test("User email NOT displayed when not authenticated", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    // Should not show any email in header
    const emailText = await page.locator("text=/.*@.*/").count();
    expect(emailText).toBe(0);
  });

  test("Logout button visible and functional when authenticated", async ({ page }) => {
    // Create verified test user via API (includes consent fields)
    const testEmail = `test-${Date.now()}@example.com`;
    const testPassword = "TestPass123!";
    await createTestUser(testEmail, testPassword, "Test User");

    // Login and navigate to app
    await login(page, testEmail, testPassword);

    // Handle Beta Agreement dialog
    await handleBetaDialog(page);

    // Navigate to main app
    await page.goto(`${BASE_URL}/`);
    await page.waitForLoadState("domcontentloaded");

    // Handle Beta Agreement dialog again if needed
    await handleBetaDialog(page);

    // User menu button should be visible in sidebar footer
    const userMenuButton = page.locator('[data-slot="sidebar-footer"] button');
    await expect(userMenuButton).toBeVisible({ timeout: 5000 });

    // Verify email is shown somewhere in the button (as part of composite text)
    const buttonText = await userMenuButton.textContent();
    expect(buttonText).toContain(testEmail);

    // Open UserMenu dropdown
    await userMenuButton.click();
    await page.waitForTimeout(300);

    // Wait for dropdown menu to open
    const menu = page.locator('[role="menu"]');
    await expect(menu).toBeVisible({ timeout: 3000 });

    // Logout menuitem should be visible
    const logoutItem = page.locator('[role="menuitem"]:has-text("Logout")');
    await expect(logoutItem).toBeVisible();

    // Click Logout
    await logoutItem.click();

    // Should redirect to login
    await page.waitForURL((url) => url.toString().includes("/login"), { timeout: 10000 });
    expect(page.url()).toContain("/login");

    // Session should be cleared
    const cookies = await page.context().cookies();
    const hasAuthCookie = cookies.some((c) => c.name.includes("better-auth") && c.value.length > 0);
    expect(hasAuthCookie).toBeFalsy();
  });
});
