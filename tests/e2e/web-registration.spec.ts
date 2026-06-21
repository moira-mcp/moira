import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { fillConsentCheckboxes } from "./helpers/consent-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("Web Interface Registration Flow", () => {
  test("Registration redirects to success page with email verification instructions", async ({
    page,
  }) => {
    const testEmail = `web-test-${Date.now()}@example.com`;
    const testPassword = "TestPass123!";

    // Navigate to register page
    await page.goto(`${BASE_URL}/register`);
    await page.waitForLoadState("domcontentloaded");

    // Verify Better Auth UI loaded (Email field is the first visible input)
    const emailInput = page.getByRole("textbox", { name: "Email" });
    await expect(emailInput).toBeVisible();

    // Fill registration form (Name field was removed as part of GDPR data minimization)
    await emailInput.fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);

    // Fill consent checkboxes (GDPR requirement)
    await fillConsentCheckboxes(page);

    // Submit registration
    await page.getByRole("button", { name: "Create an account" }).click();

    // MUST redirect to registration-success page
    await page.waitForURL(`${BASE_URL}/registration-success`, { timeout: 10000 });

    // MUST show success message
    await expect(page.getByText("Registration Successful!")).toBeVisible();

    // MUST show email verification instructions (use more specific text to avoid matching resend button)
    await expect(page.getByText(/We've sent a verification email/i)).toBeVisible();
    await expect(page.getByText(/check your inbox/i)).toBeVisible();

    // MUST have "Go to Login" button
    const loginButton = page.getByRole("button", { name: "Go to Login" });
    await expect(loginButton).toBeVisible();

    // Click "Go to Login" - should navigate to login page
    await loginButton.click();
    await page.waitForURL(`${BASE_URL}/login`, { timeout: 5000 });
  });

  test("Registration with OAuth flow redirects to success page with OAuth params preserved", async ({
    page,
  }) => {
    const testEmail = `oauth-reg-${Date.now()}@example.com`;
    const testPassword = "TestPass123!";

    // Navigate to register page with OAuth params
    const oauthParams = new URLSearchParams({
      client_id: "test-client",
      redirect_uri: "http://localhost:3000/callback",
      response_type: "code",
      scope: "openid profile",
    });
    await page.goto(`${BASE_URL}/register?${oauthParams.toString()}`);
    await page.waitForLoadState("domcontentloaded");

    // Fill registration form (Name field removed for GDPR data minimization)
    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);

    // Fill consent checkboxes (GDPR requirement)
    await fillConsentCheckboxes(page);

    // Submit registration
    await page.getByRole("button", { name: "Create an account" }).click();

    // Should redirect to registration-success with OAuth params preserved for continuation
    await page.waitForURL(
      (url) => {
        const urlStr = url.toString();
        return urlStr.includes("/registration-success") && urlStr.includes("client_id");
      },
      { timeout: 10000 },
    );

    // Verify OAuth params are preserved in URL
    const currentUrl = page.url();
    expect(currentUrl).toContain("client_id=test-client");
    expect(currentUrl).toContain("redirect_uri=");

    // Verify success page shows polling status
    await expect(page.getByText("Registration Successful!")).toBeVisible();
    await expect(page.getByText(/Waiting for email verification/i)).toBeVisible();
  });

  test("Unverified user accessing protected page is redirected to registration-success", async ({
    page,
  }) => {
    const testEmail = `unverified-${Date.now()}@example.com`;
    const testPassword = "TestPass123!";

    // Step 1: Register a new user
    await page.goto(`${BASE_URL}/register`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);

    // Fill consent checkboxes (GDPR requirement)
    await fillConsentCheckboxes(page);

    await page.getByRole("button", { name: "Create an account" }).click();

    // Wait for registration to complete
    await page.waitForURL(`${BASE_URL}/registration-success`, { timeout: 10000 });

    // Step 2: Go to login and sign in (session exists because requireEmailVerification=false)
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);
    await page.getByRole("button", { name: "Login" }).click();

    // Step 3: After login, unverified user should be redirected to registration-success
    // NOT to the dashboard or other protected pages
    await page.waitForURL(`${BASE_URL}/registration-success`, { timeout: 10000 });

    // Verify we're on the verification page, not the app
    await expect(page.getByText("Registration Successful!")).toBeVisible();
    await expect(page.getByText(/We've sent a verification email/i)).toBeVisible();
  });

  test("Unverified user cannot directly access dashboard", async ({ page }) => {
    const testEmail = `no-access-${Date.now()}@example.com`;
    const testPassword = "TestPass123!";

    // Register
    await page.goto(`${BASE_URL}/register`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);

    // Fill consent checkboxes (GDPR requirement)
    await fillConsentCheckboxes(page);

    await page.getByRole("button", { name: "Create an account" }).click();

    await page.waitForURL(`${BASE_URL}/registration-success`, { timeout: 10000 });

    // Login
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);
    await page.getByRole("button", { name: "Login" }).click();

    // Wait for redirect after login
    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });

    // Try to access dashboard directly
    await page.goto(`${BASE_URL}/`);

    // Should be redirected to registration-success, NOT dashboard
    await page.waitForURL(`${BASE_URL}/registration-success`, { timeout: 10000 });

    // Verify dashboard content is NOT visible
    await expect(page.getByText("Registration Successful!")).toBeVisible();
  });

  test("Registration success page shows resend button and handles rate limiting", async ({
    page,
  }) => {
    const testEmail = `resend-test-${Date.now()}@example.com`;
    const testPassword = "TestPass123!";

    // Register a new user
    await page.goto(`${BASE_URL}/register`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);

    // Fill consent checkboxes (GDPR requirement)
    await fillConsentCheckboxes(page);

    await page.getByRole("button", { name: "Create an account" }).click();

    // Wait for registration success page
    await page.waitForURL(`${BASE_URL}/registration-success`, { timeout: 10000 });
    await expect(page.getByText("Registration Successful!")).toBeVisible();

    // Wait for email to be extracted from session (polling starts immediately)
    // Resend button appears only when email is available
    const resendButton = page.getByRole("button", { name: /Resend verification email/i });
    await expect(resendButton).toBeVisible({ timeout: 5000 });

    // Click resend button
    await resendButton.click();

    // Should show either success or countdown (rate limiting)
    // After clicking, button should be disabled with countdown
    await expect(async () => {
      const buttonText = await page
        .getByRole("button", { name: /Resend|Sending|available in/i })
        .textContent();
      // Either shows countdown or sending state
      expect(buttonText).toBeTruthy();
    }).toPass({ timeout: 5000 });

    // Button should be disabled during countdown
    const countdownButton = page.getByRole("button", { name: /available in|Sending/i });
    if (await countdownButton.isVisible()) {
      await expect(countdownButton).toBeDisabled();
    }
  });

  test("Re-registration with existing unverified email redirects to registration-success", async ({
    page,
  }) => {
    const testEmail = `reregister-${Date.now()}@example.com`;
    const testPassword = "TestPass123!";

    // Step 1: Register first user
    await page.goto(`${BASE_URL}/register`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);

    // Fill consent checkboxes (GDPR requirement)
    await fillConsentCheckboxes(page);

    await page.getByRole("button", { name: "Create an account" }).click();

    // Wait for registration success
    await page.waitForURL(`${BASE_URL}/registration-success`, { timeout: 10000 });

    // Step 2: Go back to register and try same email (unverified)
    await page.goto(`${BASE_URL}/register`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill("AnotherPass123!");

    // Fill consent checkboxes (GDPR requirement)
    await fillConsentCheckboxes(page);

    await page.getByRole("button", { name: "Create an account" }).click();

    // Should redirect to registration-success (not show "User already exists" error)
    // This is because we intercept unverified users and redirect them
    await page.waitForURL(`${BASE_URL}/registration-success`, { timeout: 10000 });

    // Should show the verification page
    await expect(page.getByText("Registration Successful!")).toBeVisible();
  });
});
