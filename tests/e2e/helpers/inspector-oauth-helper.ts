/**
 * Helper functions for MCP Inspector OAuth flow tests
 * Extracts common OAuth authentication and connection logic
 */

import { Page, expect } from "@playwright/test";
import { getTestBaseUrl, getTestFetchUrl } from "../../utils/test-config.js";
import { verifyUserEmail } from "../../utils/mcp-auth.js";

const INSPECTOR_URL = "http://localhost:6274";

/**
 * Check if MCP Inspector is available.
 * - Local browser: checks localhost:6274 from Mac
 * - Remote browser: checks REMOTE_HOST:6274 from Mac (Inspector on PC binds 0.0.0.0)
 *   Browser on PC still accesses Inspector via localhost:6274
 */
export async function isInspectorAvailable(): Promise<boolean> {
  const checkUrl =
    process.env.PLAYWRIGHT_REMOTE === "true"
      ? `http://${process.env.REMOTE_HOST || "192.0.2.1"}:6274`
      : INSPECTOR_URL;
  try {
    const response = await fetch(checkUrl, { method: "HEAD" });
    return response.ok || response.status === 200 || response.status === 304;
  } catch {
    return false;
  }
}

/**
 * Throws an error if MCP Inspector is not available.
 * Call this at the start of any test that requires Inspector.
 */
export async function requireInspectorAvailable(): Promise<void> {
  const available = await isInspectorAvailable();
  if (!available) {
    throw new Error(
      "MCP Inspector is not running. Start it with: npm run inspector\n" +
        "Inspector should be available at http://localhost:6274",
    );
  }
}

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

// Timeout constants for OAuth flow operations (in milliseconds)
const OAUTH_BUTTON_TIMEOUT = 10000;
const OAUTH_REDIRECT_TIMEOUT = 15000;
const CONNECTION_STATUS_TIMEOUT = 15000;

export interface InspectorUser {
  email: string;
  password: string;
  name: string;
  acceptedTermsAt: string;
  acceptedNotRussianResidentAt: string;
}

/**
 * Constructs the MCP Inspector URL with the encoded serverUrl query parameter.
 * Kept in a helper to avoid duplication between OAuth helper flows.
 */
function buildInspectorUrl(): string {
  const serverUrl = `${BASE_URL}/mcp`;
  return `http://localhost:6274/?transport=streamable-http&serverUrl=${encodeURIComponent(serverUrl)}`;
}

/**
 * Creates a test user if it doesn't exist and verifies their email
 */
export async function createAndVerifyInspectorUser(user: InspectorUser): Promise<void> {
  try {
    const response = await fetch(`${FETCH_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(user),
    });

    if (!response.ok) {
      let errorBody: string | undefined;
      try {
        errorBody = await response.text();
      } catch {
        // Ignore body read errors; we'll still throw with status info.
      }

      // Treat "user already exists" or "email not verified" as non-fatal conditions.
      // Check both status code and error code in response
      const isUserExists =
        response.status === 409 ||
        (response.status === 422 &&
          errorBody !== undefined &&
          errorBody.includes("USER_ALREADY_EXISTS"));

      // Also handle "email not verified" error (user exists but email not verified)
      const isEmailNotVerified =
        response.status === 400 &&
        errorBody !== undefined &&
        errorBody.includes("EMAIL_NOT_VERIFIED");

      if (isUserExists || isEmailNotVerified) {
        // User already exists or needs email verification; verify email and continue
        await verifyUserEmail(FETCH_URL, user.email);
        return;
      }

      throw new Error(
        `Failed to create inspector user (status ${response.status} ${response.statusText})` +
          (errorBody ? `: ${errorBody}` : ""),
      );
    }

    // Verify email for newly created user
    await verifyUserEmail(FETCH_URL, user.email);
  } catch (error) {
    // If error is from our throw above, just rethrow it
    if (error instanceof Error && error.message.startsWith("Failed to create inspector user")) {
      throw error;
    }
    // Log and rethrow other unexpected issues such as network errors or API changes

    console.error("Error while creating inspector user:", error);
    throw error;
  }
}

/**
 * Completes the full Inspector OAuth flow and connects to MCP server
 *
 * @param page - Playwright page object
 * @param user - User credentials for login
 * @param options - Optional configuration
 * @returns Promise that resolves when connected
 */
export async function connectInspectorWithOAuth(
  page: Page,
  user: InspectorUser,
  options?: {
    skipUserCreation?: boolean;
    verbose?: boolean;
  },
): Promise<void> {
  const { skipUserCreation = false, verbose = false } = options || {};

  // Create and verify user unless skipped
  if (!skipUserCreation) {
    await createAndVerifyInspectorUser(user);
  }

  const inspectorUrl = buildInspectorUrl();

  // Open Inspector with prefilled URL
  await page.goto(inspectorUrl);
  if (verbose) console.log("✓ Inspector opened");

  // Select Direct connection
  await page.getByRole("combobox", { name: "Connection Type" }).click();
  await page.getByRole("option", { name: "Direct" }).click();

  // Click "Open Auth Settings" button
  await page.getByRole("button", { name: "Open Auth Settings" }).click();

  // Click "Quick OAuth Flow" button - triggers OAuth and redirects to authorize page
  await page.getByRole("button", { name: "Quick OAuth Flow" }).click();
  await page.waitForURL(/\/oauth\/authorize/, { timeout: OAUTH_REDIRECT_TIMEOUT });
  if (verbose) console.log("✓ OAuth redirect triggered");

  // Fill login form
  await page.getByRole("textbox", { name: "Email" }).fill(user.email);
  await page.getByRole("textbox", { name: "Password" }).fill(user.password);
  await page.getByRole("button", { name: "Login" }).click();

  // After login, consent screen appears - click Allow
  const allowButton = page.getByRole("button", { name: "Allow" });
  await allowButton.waitFor({ state: "visible", timeout: OAUTH_BUTTON_TIMEOUT });
  await allowButton.click();
  if (verbose) console.log("✓ Consent granted");

  // After the OAuth callback/redirect, click "Back to Connect" on the callback page
  const backToConnectButton = page.getByRole("button", { name: "Back to Connect" });
  await backToConnectButton.waitFor({ state: "visible", timeout: OAUTH_BUTTON_TIMEOUT });
  await backToConnectButton.click();

  // Wait for redirect back to Inspector
  await page.waitForURL(/localhost:6274/, { timeout: OAUTH_REDIRECT_TIMEOUT });
  if (verbose) console.log("✓ Redirected back to Inspector");

  // Now click Connect button to actually establish the MCP connection
  await page.getByRole("button", { name: "Connect" }).click();

  // Wait for Connected status
  await expect(page.locator("text=Connected")).toBeVisible({ timeout: CONNECTION_STATUS_TIMEOUT });
  if (verbose) console.log("✓ Inspector connected via OAuth");
}

/**
 * Opens Inspector and navigates to OAuth authorize page (without logging in)
 * Useful for registration flow tests that need to sign up instead of login
 */
export async function openInspectorAndStartOAuthFlow(page: Page): Promise<void> {
  const inspectorUrl = buildInspectorUrl();

  // Open Inspector with prefilled URL
  await page.goto(inspectorUrl);

  // Select Direct connection
  await page.getByRole("combobox", { name: "Connection Type" }).click();
  await page.getByRole("option", { name: "Direct" }).click();

  // Click "Open Auth Settings" button
  await page.getByRole("button", { name: "Open Auth Settings" }).click();

  // Click "Quick OAuth Flow" button
  await page.getByRole("button", { name: "Quick OAuth Flow" }).click();

  // Wait for redirect to OAuth authorize page
  await page.waitForURL(/\/oauth\/authorize/, { timeout: OAUTH_REDIRECT_TIMEOUT });
}

/**
 * Completes OAuth consent and connects to Inspector
 * Used after user has already logged in/registered and is on consent screen
 */
export async function completeOAuthConsentAndConnect(
  page: Page,
  options?: { verbose?: boolean },
): Promise<void> {
  const { verbose = false } = options || {};

  // Click Allow on consent screen
  const allowButton = page.getByRole("button", { name: "Allow" });
  await allowButton.waitFor({ state: "visible", timeout: OAUTH_BUTTON_TIMEOUT });
  await allowButton.click();
  if (verbose) console.log("✓ Consent granted");

  // Click "Back to Connect" button
  const backToConnectButton = page.getByRole("button", { name: "Back to Connect" });
  await backToConnectButton.waitFor({ state: "visible", timeout: OAUTH_BUTTON_TIMEOUT });
  await backToConnectButton.click();

  // Wait for redirect back to Inspector
  await page.waitForURL(/localhost:6274/, { timeout: OAUTH_REDIRECT_TIMEOUT });
  if (verbose) console.log("✓ Redirected back to Inspector");

  // Click Connect button to establish the MCP connection
  await page.getByRole("button", { name: "Connect" }).click();

  // Wait for Connected status
  await expect(page.locator("text=Connected")).toBeVisible({ timeout: CONNECTION_STATUS_TIMEOUT });
  if (verbose) console.log("✓ Inspector connected");
}
