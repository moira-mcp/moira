/**
 * E2E Tests: Forgot Password Flow
 * Tests the "I forgot my password" flow initiated by user
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { createTestUser } from "./helpers/auth-helper.js";
import { waitForDockerLog } from "../utils/docker-command.js";

const BASE_URL = getTestBaseUrl();

test.describe("Forgot Password Flow E2E", () => {
  const testPassword = "TestPassword123!";

  test.beforeAll(async ({ request }) => {
    const response = await request.get(`${BASE_URL}/api/features`);
    expect(response.ok()).toBe(true);
    const body = (await response.json()) as {
      data?: { emailDelivery?: { state?: string; available?: boolean } };
    };
    if (body.data?.emailDelivery?.state !== "real" || !body.data.emailDelivery.available) {
      throw new Error(
        "Forgot Password Flow E2E requires a real email-delivery capability with reserved test-recipient suppression",
      );
    }
  });

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
    const testUserEmail = `reset-flow-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const result = await createTestUser(testUserEmail, testPassword, "Reset Flow Test", true);
    expect(result.success).toBe(true);
    expect(result.userId).toBeTruthy();

    // Request password reset via API (use page.request to go through browser on PC)
    const forgotResponse = await page.request.post(`${BASE_URL}/api/auth/request-password-reset`, {
      headers: { "Content-Type": "application/json" },
      data: {
        email: testUserEmail,
        redirectTo: `${BASE_URL}/reset-password`,
      },
    });
    expect(forgotResponse.ok()).toBe(true);

    // Select this request's reset email, rather than another parallel user's verification/reset URL.
    const recipient = JSON.stringify(`"to":${JSON.stringify(testUserEmail)}`);
    const emailLog = await waitForDockerLog(
      `awk 'index($0, ${recipient}) && index($0, "TEST MODE: Email URLs for manual testing") && index($0, "/api/auth/reset-password/") { print; exit }'`,
    );
    const emailEvent = JSON.parse(emailLog.trim()) as { to: string; urls: string[] };
    expect(emailEvent.to).toBe(testUserEmail);
    const callbacks = emailEvent.urls
      .map((value) => new URL(value))
      .filter(
        (url) =>
          url.origin === new URL(BASE_URL).origin &&
          /^\/api\/auth\/reset-password\/[^/]+$/.test(url.pathname) &&
          url.searchParams.get("callbackURL") === `${BASE_URL}/reset-password`,
      );
    expect(callbacks).toHaveLength(1);
    const callback = callbacks[0];
    const token = callback.pathname.split("/").at(-1);

    await page.goto(callback.href);
    await expect(page).toHaveURL(
      (url) => url.pathname === "/reset-password" && url.searchParams.get("token") === token,
    );
    const newPassword = "ResetPassword456!";
    await page.getByLabel("New Password", { exact: true }).fill(newPassword);
    const resetResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/auth/reset-password" &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save new password", exact: true }).click();
    const reset = await resetResponse;
    expect(reset.status()).toBe(200);
    expect(await reset.json()).toMatchObject({ status: true });
    await expect(page).toHaveURL((url) => url.pathname === "/login");

    const headers = { Origin: new URL(BASE_URL).origin };
    const oldSignIn = await page.request.post(`${BASE_URL}/api/auth/sign-in/email`, {
      headers,
      data: { email: testUserEmail, password: testPassword },
    });
    expect(oldSignIn.status()).toBe(401);
    expect(await oldSignIn.json()).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });

    const newSignIn = await page.request.post(`${BASE_URL}/api/auth/sign-in/email`, {
      headers,
      data: { email: testUserEmail, password: newPassword },
    });
    expect(newSignIn.status()).toBe(200);
    expect(await newSignIn.json()).toMatchObject({
      user: { id: result.userId, email: testUserEmail },
    });
    // APIRequestContext applies the new session cookie to this isolated browser context.
    const profile = await page.request.get(`${BASE_URL}/api/user/profile`);
    expect(profile.status()).toBe(200);
    expect(await profile.json()).toMatchObject({
      success: true,
      data: { id: result.userId, email: testUserEmail },
    });
  });

  test("reset-password callback endpoint returns correct redirect", async ({ page }) => {
    // Create test user
    const testUserEmail = `callback-test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
    const result = await createTestUser(testUserEmail, testPassword, "Callback Test", true);
    expect(result.success).toBe(true);

    // Request password reset (use page.request to go through browser on PC)
    await page.request.post(`${BASE_URL}/api/auth/request-password-reset`, {
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
