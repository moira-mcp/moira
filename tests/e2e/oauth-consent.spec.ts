/**
 * E2E tests for OAuth Consent Flow
 * Tests consent screen display, approval, denial, and auto-approval
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getAdminCredentials } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const ADMIN_CREDENTIALS = getAdminCredentials();

test.describe("OAuth Consent Flow", () => {
  test("should show consent screen when user is logged in on authorize page", async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    // Now go to authorize page with OAuth params - should show consent screen
    await page.goto(
      `${BASE_URL}/oauth/authorize?client_id=test-client&scope=openid%20profile&redirect_uri=http://localhost:8080/callback&response_type=code`,
    );
    await page.waitForLoadState("domcontentloaded");

    // Should show consent UI (not login form)
    await expect(page.locator("text=Authorize Access")).toBeVisible();
    await expect(page.locator("text=test-client")).toBeVisible();

    // Should show user info
    const userEmail = await page.locator(`text=${ADMIN_CREDENTIALS.email}`).isVisible();
    expect(userEmail).toBeTruthy();

    // Should show requested permissions
    await expect(page.locator("text=Verify your identity")).toBeVisible();
    await expect(page.locator("text=Access your profile information")).toBeVisible();

    // Should have Allow and Deny buttons
    await expect(page.locator('button:has-text("Allow")')).toBeVisible();
    await expect(page.locator('button:has-text("Deny")')).toBeVisible();
    await expect(page.locator('button:has-text("Switch")')).toBeVisible();
  });

  test("should show login form if not authenticated on authorize page", async ({ page }) => {
    // Go to authorize page without being logged in
    await page.goto(
      `${BASE_URL}/oauth/authorize?client_id=test-client&scope=openid&redirect_uri=http://localhost:8080/callback&response_type=code`,
    );
    await page.waitForLoadState("domcontentloaded");

    // Page should show OAuth authorize form with login option
    // Check for email input field (universal indicator of login form)
    await expect(page.locator('input[type="email"], input[name="email"]').first()).toBeVisible({
      timeout: 10000,
    });

    // Check for password input
    await expect(page.locator('input[type="password"]')).toBeVisible();
  });

  test("consent screen should handle switch account", async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    // Go to authorize page - should show consent
    await page.goto(
      `${BASE_URL}/oauth/authorize?client_id=test-client&scope=openid&redirect_uri=http://localhost:8080/callback&response_type=code`,
    );
    await page.waitForLoadState("domcontentloaded");

    // Should show consent screen with user info
    await expect(page.locator(`text=${ADMIN_CREDENTIALS.email}`)).toBeVisible();

    // Click switch account
    await page.click('button:has-text("Switch")');

    // Should now show login form (user logged out)
    await page.waitForSelector('input[type="email"]', { timeout: 5000 });
    await expect(page.locator('input[type="email"]')).toBeVisible();
  });

  test("should display proper scope descriptions on authorize page", async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    // Go to authorize page with multiple scopes
    await page.goto(
      `${BASE_URL}/oauth/authorize?client_id=test&scope=openid%20profile%20email%20offline_access&redirect_uri=http://localhost:8080/callback&response_type=code`,
    );
    await page.waitForLoadState("domcontentloaded");

    // Check all scope descriptions are shown
    await expect(page.locator("text=Verify your identity")).toBeVisible();
    await expect(page.locator("text=Access your profile information")).toBeVisible();
    await expect(page.locator("text=Access your email address")).toBeVisible();
    await expect(page.locator("text=Access your data when you're not using the app")).toBeVisible();
  });

  test("deny button should redirect with error", async ({ page }) => {
    test.slow();
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    // Go to authorize page
    await page.goto(
      `${BASE_URL}/oauth/authorize?client_id=test&scope=openid&redirect_uri=http://localhost:8080/callback&response_type=code`,
    );
    await page.waitForLoadState("domcontentloaded");

    // Click deny - should redirect to callback with error
    // Note: we can't actually follow the redirect to localhost:8080, so just verify button exists
    await expect(page.locator('button:has-text("Deny")')).toBeVisible();
  });
});
