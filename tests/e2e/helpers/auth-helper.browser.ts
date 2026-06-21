/**
 * E2E Auth Helper
 * Centralized authentication functions for Playwright tests
 */

import { Page } from "@playwright/test";
import { getTestBaseUrl, getTestFetchUrl } from "../../utils/test-config.js";
import { TEST_USERS } from "../fixtures/test-constants.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

/**
 * Get the session cookie name based on the URL protocol.
 * Better Auth uses __Secure- prefix for HTTPS, no prefix for HTTP.
 */
function getSessionCookieName(baseUrl: string): string {
  const isSecure = baseUrl.startsWith("https://");
  return isSecure ? "__Secure-better-auth.session_token" : "better-auth.session_token";
}

/**
 * Format Cookie header with proper cookie name for the protocol.
 */
function formatSessionCookie(baseUrl: string, sessionCookie: string): string {
  return `${getSessionCookieName(baseUrl)}=${sessionCookie}`;
}

/**
 * Extract session cookie from Set-Cookie header.
 * Handles both secure (__Secure-) and non-secure cookie names.
 */
function extractSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  // Match both __Secure-better-auth.session_token and better-auth.session_token
  const match = setCookieHeader.match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Universal login function with optional beta modal handling
 * @param page Playwright page
 * @param email User email
 * @param password User password
 * @param autoAcceptBeta Automatically accept beta agreement modal if it appears (default: true)
 */
export async function login(
  page: Page,
  email: string,
  password: string,
  autoAcceptBeta = true,
): Promise<void> {
  await page.goto(`${BASE_URL}/login`);

  // Use locale-independent selectors (name attribute doesn't change with i18n)
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');

  // Wait for redirect away from login page
  try {
    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 5000 });
  } catch (e) {
    console.log(`[LOGIN FAILED] ${email} - URL still: ${page.url()}`);
    throw e;
  }

  if (autoAcceptBeta) {
    // Wait briefly for modal to potentially appear, then try to accept
    await page.waitForTimeout(300);
    await acceptBetaAgreement(page);
  }
}

/**
 * Login as admin user
 * @param autoAcceptBeta Automatically accept beta modal if it appears (default: true)
 */
export async function loginAsAdmin(page: Page, autoAcceptBeta = true): Promise<void> {
  await login(page, TEST_USERS.ADMIN.email, TEST_USERS.ADMIN.password, autoAcceptBeta);
}

/**
 * Login as MCP Tools test user
 * @param autoAcceptBeta Automatically accept beta modal if it appears (default: true)
 */
export async function loginAsMcpToolsTest(page: Page, autoAcceptBeta = true): Promise<void> {
  await login(
    page,
    TEST_USERS.MCP_TOOLS_TEST.email,
    TEST_USERS.MCP_TOOLS_TEST.password,
    autoAcceptBeta,
  );
}

/**
 * Accept beta agreement modal (does nothing if modal not present)
 * Supports both English and Russian locales
 */
export async function acceptBetaAgreement(page: Page): Promise<void> {
  try {
    // Find Accept button - support both EN and RU locales
    const acceptButton = page.locator(
      'button:has-text("Accept and Continue"), button:has-text("Принять и продолжить")',
    );
    const buttonVisible = await acceptButton
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    if (buttonVisible) {
      await acceptButton.first().click();
      // Wait for modal overlay to disappear
      await page
        .waitForSelector('[data-slot="dialog-overlay"]', { state: "detached", timeout: 5000 })
        .catch(() => {});
      // Also wait for content to disappear
      await page
        .waitForSelector('[data-slot="dialog-content"]', { state: "detached", timeout: 2000 })
        .catch(() => {});
      // Small delay to ensure UI is stable
      await page.waitForTimeout(300);
    }
  } catch {
    // Modal not present, do nothing
  }
}

/**
 * Decline beta agreement modal (logs out user)
 */
export async function declineBetaAgreement(page: Page): Promise<void> {
  await page.click('button:has-text("Decline")');
  // After decline, user should be logged out and redirected to landing
  await page.waitForURL(`${BASE_URL}/`);
}

/**
 * Wait for beta modal to appear
 */
export async function waitForBetaModal(page: Page, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForSelector("text=Beta Software Agreement", { timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if beta modal is visible
 */
export async function hasBetaModal(page: Page): Promise<boolean> {
  return page
    .locator("text=Beta Software Agreement")
    .isVisible()
    .catch(() => false);
}

/**
 * Create new user with optional email verification
 * Uses pure HTTP requests - no browser automation needed
 * @param email User email
 * @param password User password
 * @param name User name
 * @param verifyEmail Whether to verify email via admin API (default: true)
 * @returns Created user or existing user if already exists
 */
export async function createTestUser(
  email: string,
  password: string,
  name: string,
  verifyEmail = true,
): Promise<{ success: boolean; userId?: string; error?: string }> {
  // Create user via sign-up API with legal consent (required for GDPR compliance)
  try {
    const signUpResponse = await fetch(`${FETCH_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        name,
        acceptedTermsAt: new Date().toISOString(),
        acceptedNotRussianResidentAt: new Date().toISOString(),
      }),
    });

    if (!signUpResponse.ok && signUpResponse.status !== 422) {
      return { success: false, error: `Sign-up failed: ${signUpResponse.status}` };
    }

    // User created or already exists (422)
  } catch (error) {
    return { success: false, error: `Sign-up error: ${error}` };
  }

  // Verify email if requested - using pure HTTP requests
  if (verifyEmail) {
    try {
      // Import verifyUserEmail from mcp-auth utils (pure HTTP, no browser)
      const { verifyUserEmail } = await import("../../utils/mcp-auth.js");
      await verifyUserEmail(FETCH_URL, email);

      // Get userId after verification
      const adminSessionCookie = await getAdminSessionCookie();
      const usersResponse = await fetch(
        `${FETCH_URL}/api/admin/users?search=${encodeURIComponent(email)}&limit=10`,
        {
          headers: {
            Cookie: formatSessionCookie(FETCH_URL, adminSessionCookie),
          },
        },
      );

      if (usersResponse.ok) {
        const usersData = (await usersResponse.json()) as {
          data: { users: Array<{ id: string; email: string }> };
        };
        const user = usersData.data?.users?.find((u) => u.email === email);
        if (user) {
          return { success: true, userId: user.id };
        }
      }

      return { success: true }; // Verified but couldn't get userId
    } catch (error) {
      return { success: false, error: `Email verification failed: ${error}` };
    }
  }

  return { success: true };
}

/**
 * Get admin session cookie via pure HTTP sign-in
 */
async function getAdminSessionCookie(): Promise<string> {
  const response = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: TEST_USERS.ADMIN.email,
      password: TEST_USERS.ADMIN.password,
      rememberMe: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Admin sign-in failed: ${response.status}`);
  }

  const setCookieHeader = response.headers.get("set-cookie");
  const sessionCookie = extractSessionCookie(setCookieHeader);

  if (!sessionCookie) {
    throw new Error("No session cookie in admin sign-in response");
  }

  return sessionCookie;
}
