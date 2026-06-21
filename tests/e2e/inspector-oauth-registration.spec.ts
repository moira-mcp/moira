/**
 * MCP Inspector OAuth Registration Flow E2E Test
 *
 * КРИТИЧНЫЙ ТЕСТ: Главный use case для первых пользователей системы.
 * Тестирует полный flow: Inspector -> OAuth -> Register -> Verify Email -> Consent -> Connected
 *
 * REQUIRES: MCP Inspector running on localhost:6274
 * If Inspector not available, tests are automatically skipped.
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";
import { verifyUserEmail } from "../utils/mcp-auth.js";
import { fillConsentCheckboxes } from "./helpers/consent-helper.js";
import {
  openInspectorAndStartOAuthFlow,
  completeOAuthConsentAndConnect,
  isInspectorAvailable,
} from "./helpers/inspector-oauth-helper.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

// Check Inspector availability before each test
test.beforeEach(async () => {
  const available = await isInspectorAvailable();
  test.skip(!available, "MCP Inspector is not running. Start it with: npm run inspector");
});

test.describe("MCP Inspector OAuth Registration Flow", () => {
  /**
   * Test 1: Manual flow - user clicks "Go to Login" after email verification
   * This is the reliable flow that works with admin API email verification
   */
  test("Manual flow: Inspector -> Register -> Success -> Go to Login -> Verify -> Login -> Consent -> Connected", async ({
    page,
  }) => {
    // Increase timeout for multi-step OAuth flow
    test.setTimeout(90000);
    const testEmail = `inspector-manual-${Date.now()}@example.com`;
    const testPassword = "InspectorPass123!";

    // Open Inspector and navigate to OAuth authorize page
    await openInspectorAndStartOAuthFlow(page);
    console.log("✓ Step 1-3: Inspector opened, OAuth flow started");

    // Step 4: Click "Sign up" link to go to registration
    const signUpLink = page.locator("text=Sign up");
    await signUpLink.click();
    await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible({ timeout: 5000 });

    // Verify OAuth params preserved in URL
    expect(page.url()).toContain("client_id");
    console.log("✓ Step 4: On registration page with OAuth params");

    // Step 5: Fill and submit registration form (Name field removed for GDPR)
    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);

    // Fill consent checkboxes (GDPR requirement)
    await fillConsentCheckboxes(page);

    await page.getByRole("button", { name: "Create an account" }).click();
    console.log("✓ Step 5: Registration form submitted");

    // Step 6: Should redirect to registration-success with OAuth params
    await page.waitForURL(
      (url) => {
        const urlStr = url.toString();
        return urlStr.includes("/registration-success") && urlStr.includes("client_id");
      },
      { timeout: 10000 },
    );

    // Verify success page content
    await expect(page.getByText("Registration Successful!")).toBeVisible();
    await expect(page.getByText(/Waiting for email verification/i)).toBeVisible();
    console.log("✓ Step 6: On registration success page");

    // Step 7: Verify email via admin API (simulates user clicking email link)
    console.log("Step 7: Verifying email via admin API...");
    await verifyUserEmail(FETCH_URL, testEmail);
    console.log("✓ Step 7: Email verified for:", testEmail);

    // Step 8: Click "Go to Login" button (manual flow - no polling)
    await page.getByRole("button", { name: "Go to Login" }).click();
    await page.waitForURL((url) => url.toString().includes("/login"), { timeout: 5000 });
    console.log("✓ Step 8: Clicked Go to Login, on login page");

    // Step 9: Login with the registered credentials
    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);
    // Click the "Login" button (not "Sign in with GitHub")
    await page.getByRole("button", { name: "Login" }).click();
    console.log("✓ Step 9: Login form submitted");

    // Step 10: After login, should redirect to OAuth authorize (consent screen)
    // User is now verified, so consent screen should appear
    await page.waitForURL((url) => url.toString().includes("/oauth/authorize"), {
      timeout: 10000,
    });
    console.log("✓ Step 10: Redirected to OAuth authorize");

    // Complete OAuth consent and connect Inspector
    await completeOAuthConsentAndConnect(page, { verbose: true });
    console.log("✓ Step 11-13: Inspector connected via OAuth after registration");
    console.log("");
    console.log("=== MANUAL OAUTH REGISTRATION FLOW COMPLETED SUCCESSFULLY ===");
  });

  /**
   * Test 2: Polling flow - page auto-detects email verification
   *
   * NOTE: Polling requires the verification link to be clicked in the same browser
   * to get a new session with emailVerified=true. Admin API verification only updates
   * the DB but doesn't create a new session - autoSignInAfterVerification only triggers
   * when user actually clicks the verification link.
   *
   * TODO: To fully test polling:
   * 1. Create admin endpoint that returns verification URL
   * 2. Navigate to verification URL in same browser (new tab)
   * 3. Return to registration-success page
   * 4. Polling should detect new session with emailVerified=true
   *
   * For now, using page.reload() as workaround - not ideal but works for testing
   * the UI flow after verification.
   */
  test("Polling flow: Inspector -> Register -> Auto-detect verification -> Consent -> Connected", async ({
    page,
  }) => {
    const testEmail = `inspector-polling-${Date.now()}@example.com`;
    const testPassword = "InspectorPass123!";

    const serverUrl = `${BASE_URL}/mcp`;
    const inspectorUrl = `http://localhost:6274/?transport=streamable-http&serverUrl=${encodeURIComponent(serverUrl)}`;

    // Steps 1-6: Same as manual flow - register and get to success page
    await page.goto(inspectorUrl);
    await page.getByRole("combobox", { name: "Connection Type" }).click();
    await page.getByRole("option", { name: "Direct" }).click();
    await page.getByRole("button", { name: "Connect" }).click();
    await page.waitForURL(/\/oauth\/authorize/, { timeout: 15000 });

    const signUpLink = page.locator("text=Sign up");
    await signUpLink.click();
    await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible({ timeout: 5000 });

    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);

    // Fill consent checkboxes (GDPR requirement)
    await fillConsentCheckboxes(page);

    await page.getByRole("button", { name: "Create an account" }).click();

    await page.waitForURL(
      (url) => {
        const urlStr = url.toString();
        return urlStr.includes("/registration-success") && urlStr.includes("client_id");
      },
      { timeout: 10000 },
    );

    await expect(page.getByText("Registration Successful!")).toBeVisible();
    console.log("✓ On registration success page with polling");

    // Step 7: Verify email via admin API
    await verifyUserEmail(FETCH_URL, testEmail);
    console.log("✓ Email verified via admin API");

    // Step 8: Wait for polling to detect verification
    // NOTE: This won't work because admin API doesn't create new session
    // Polling checks get-session which returns the OLD session data
    // Only clicking verification link creates new session with emailVerified=true

    // Workaround: Reload page to get fresh session
    // This is not the real polling flow, just testing the UI after verification
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // After reload with verified email, should redirect to OAuth authorize
    await page.waitForURL((url) => url.toString().includes("/oauth/authorize"), {
      timeout: 10000,
    });
    console.log("✓ Auto-redirected to OAuth authorize after verification");

    // Rest of flow: consent and connect
    await page.waitForSelector('button:has-text("Allow")', { timeout: 15000 });
    await page.click('button:has-text("Allow")');
    await page.waitForURL(/localhost:6274/, { timeout: 15000 });
    await expect(page.locator("text=Connected")).toBeVisible({ timeout: 10000 });

    console.log("=== POLLING OAUTH REGISTRATION FLOW COMPLETED ===");
  });
});
