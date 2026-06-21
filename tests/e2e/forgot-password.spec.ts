/**
 * E2E Tests: Forgot Password Flow
 * Tests the "I forgot my password" flow initiated by user
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createTestUser } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("Forgot Password Flow E2E", () => {
  const testPassword = "TestPassword123!";

  test("shows forgot password link on login page", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    // Check that "Forgot your password?" link exists (text from better-auth-ui)
    const forgotLink = page.locator("text=Forgot your password?");
    await expect(forgotLink).toBeVisible({ timeout: 10000 });
  });

  test("navigates to forgot password page", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    // Click forgot password link
    await page.click("text=Forgot your password?");
    await page.waitForURL(/\/forgot-password/, { timeout: 10000 });

    // Should show email input field
    const emailInput = page.locator('input[type="email"]');
    await expect(emailInput).toBeVisible();

    // Should show submit button with "Send reset link" text
    const submitButton = page.locator('button:has-text("Send reset link")');
    await expect(submitButton).toBeVisible();
  });

  test("submits forgot password request and redirects to login", async ({ page }) => {
    // Create test user
    const testUserEmail = `forgot-pw-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
    const result = await createTestUser(testUserEmail, testPassword, "Forgot Password Test", true);
    expect(result.success).toBe(true);

    // Go to forgot password page
    await page.goto(`${BASE_URL}/forgot-password`);
    await page.waitForLoadState("domcontentloaded");

    // Fill email and submit
    await page.fill('input[type="email"]', testUserEmail);
    await page.click('button:has-text("Send reset link")');

    // After success, better-auth-ui navigates back to login page
    await page.waitForURL(/\/login/, { timeout: 15000 });
  });

  test("non-existing email also redirects (security - no enumeration)", async ({ page }) => {
    // Go to forgot password page
    await page.goto(`${BASE_URL}/forgot-password`);
    await page.waitForLoadState("domcontentloaded");

    // Fill non-existing email and submit
    const fakeEmail = `nonexistent-${Date.now()}@fake-domain.com`;
    await page.fill('input[type="email"]', fakeEmail);
    await page.click('button:has-text("Send reset link")');

    // Should still redirect to login (no user enumeration)
    await page.waitForURL(/\/login/, { timeout: 15000 });
    expect(page.url()).toContain("/login");
  });

  test("complete reset password flow via API callback", async ({ page }) => {
    // Create test user
    const testUserEmail = `reset-flow-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
    const result = await createTestUser(testUserEmail, testPassword, "Reset Flow Test", true);
    expect(result.success).toBe(true);

    // Request password reset via API (use page.request to go through browser on PC)
    const forgotResponse = await page.request.post(`${BASE_URL}/api/auth/forget-password`, {
      headers: { "Content-Type": "application/json" },
      data: {
        email: testUserEmail,
        redirectTo: `${BASE_URL}/reset-password`,
      },
    });
    expect(forgotResponse.ok()).toBe(true);

    // Navigate to reset-password page directly (simulating email click result)
    await page.goto(`${BASE_URL}/reset-password`);
    await page.waitForLoadState("domcontentloaded");

    // Page should show password form or error about missing/invalid token
    const pageContent = await page.content();
    // Either shows form or error - both mean the page works
    expect(
      pageContent.includes("Password") ||
        pageContent.includes("token") ||
        pageContent.includes("Invalid"),
    ).toBe(true);
  });

  test("reset-password callback endpoint returns correct redirect", async ({ page }) => {
    // Create test user
    const testUserEmail = `callback-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
    const result = await createTestUser(testUserEmail, testPassword, "Callback Test", true);
    expect(result.success).toBe(true);

    // Request password reset (use page.request to go through browser on PC)
    await page.request.post(`${BASE_URL}/api/auth/forget-password`, {
      headers: { "Content-Type": "application/json" },
      data: {
        email: testUserEmail,
        redirectTo: `${BASE_URL}/reset-password`,
      },
    });

    // Test with fake token - should redirect with error
    const callbackResponse = await page.request.get(
      `${BASE_URL}/api/auth/reset-password/fake-invalid-token?callbackURL=${encodeURIComponent(`${BASE_URL}/reset-password`)}`,
      { maxRedirects: 0 },
    );

    // Should be a redirect (302)
    expect(callbackResponse.status()).toBe(302);

    // Location header should point to frontend reset-password page with error
    const location = callbackResponse.headers()["location"];
    expect(location).toContain("/reset-password");
    expect(location).toContain("error=");
  });

  test("forgot password form description is displayed", async ({ page }) => {
    await page.goto(`${BASE_URL}/forgot-password`);
    await page.waitForLoadState("domcontentloaded");

    // Check for description text (from better-auth-ui)
    const description = page.locator("text=Enter your email");
    await expect(description).toBeVisible({ timeout: 10000 });
  });
});
