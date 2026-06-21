/**
 * E2E Auth Helpers - Fast Version
 *
 * Uses HTTP requests + cookie injection instead of browser form filling.
 * Much faster (~1.5s vs ~3-4s) and avoids race conditions with parallel tests.
 *
 * For tests that need to verify ACTUAL browser login flow (form, validation, etc.),
 * use the browser-based helpers from './auth-helper.browser.ts'
 */

import { Page, BrowserContext } from "@playwright/test";
import { getTestBaseUrl, getTestFetchUrl } from "../../utils/test-config.js";
import { TEST_USERS } from "../fixtures/test-constants.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

// Cookie name for beta agreement bypass (from useBetaAgreement.tsx)
const BETA_AGREEMENT_COOKIE = "moira-beta-accepted";

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
 * Extract session cookie value from Set-Cookie header.
 */
function extractSessionCookie(setCookieHeader: string | null): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/(?:__Secure-)?better-auth\.session_token=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Extract cookie attributes from Set-Cookie header
 */
function parseCookieAttributes(setCookieHeader: string): {
  path?: string;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
} {
  const attrs: ReturnType<typeof parseCookieAttributes> = {};

  const parts = setCookieHeader.split(";").slice(1);
  for (const part of parts) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed.startsWith("path=")) {
      attrs.path = part.trim().split("=")[1];
    } else if (trimmed.startsWith("expires=")) {
      attrs.expires = new Date(part.trim().split("=").slice(1).join("="));
    } else if (trimmed === "httponly") {
      attrs.httpOnly = true;
    } else if (trimmed === "secure") {
      attrs.secure = true;
    } else if (trimmed.startsWith("samesite=")) {
      const value = part.trim().split("=")[1];
      if (value.toLowerCase() === "strict") attrs.sameSite = "Strict";
      else if (value.toLowerCase() === "lax") attrs.sameSite = "Lax";
      else if (value.toLowerCase() === "none") attrs.sameSite = "None";
    }
  }

  return attrs;
}

/**
 * Set beta agreement cookie in browser context.
 * Can be called BEFORE any navigation (unlike localStorage).
 */
async function setBetaCookie(context: BrowserContext): Promise<void> {
  const url = new URL(BASE_URL);
  await context.addCookies([
    {
      name: BETA_AGREEMENT_COOKIE,
      value: "true",
      domain: url.hostname,
      path: "/",
      httpOnly: false,
      secure: BASE_URL.startsWith("https://"),
      sameSite: "Lax",
    },
  ]);
}

/**
 * Login via HTTP and set cookie in browser context (internal helper).
 */
async function httpLogin(page: Page, email: string, password: string): Promise<string> {
  const response = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Login failed: ${response.status} ${error}`);
  }

  const setCookieHeader = response.headers.get("set-cookie");
  const sessionCookie = extractSessionCookie(setCookieHeader);

  if (!sessionCookie) {
    throw new Error("No session cookie in sign-in response");
  }

  const attrs = setCookieHeader ? parseCookieAttributes(setCookieHeader) : {};
  const url = new URL(BASE_URL);

  await page.context().addCookies([
    {
      name: getSessionCookieName(BASE_URL),
      value: sessionCookie,
      domain: url.hostname,
      path: attrs.path || "/",
      httpOnly: attrs.httpOnly ?? true,
      secure: attrs.secure ?? BASE_URL.startsWith("https://"),
      sameSite: attrs.sameSite || "Lax",
      expires: attrs.expires ? Math.floor(attrs.expires.getTime() / 1000) : undefined,
    },
  ]);

  return sessionCookie;
}

/**
 * Login and navigate to app.
 * Uses HTTP fetch + cookie injection - no browser form filling.
 *
 * @param page - Playwright page
 * @param email - User email
 * @param password - User password
 * @param autoAcceptBeta - If true, bypass beta modal via cookie (default: true)
 */
export async function login(
  page: Page,
  email: string,
  password: string,
  autoAcceptBeta = true,
): Promise<void> {
  await httpLogin(page, email, password);

  if (autoAcceptBeta) {
    await setBetaCookie(page.context());
  }

  await page.goto(`${BASE_URL}/`);
  // Wait for domcontentloaded which is more reliable than networkidle
  await page.waitForLoadState("domcontentloaded");
  // Ensure we're authenticated by waiting for app-specific content
  // MCP Moira text appears in sidebar (desktop) or mobile header (mobile)
  // Also check for navigation links which are present on both
  // Increased timeout to 30s to handle high load during parallel test runs
  await page.waitForSelector(
    'h1:has-text("MCP Moira"), span:has-text("MCP Moira"), nav a[href="/workflows"], a[href="/"]',
    { timeout: 30000 },
  );
}

/**
 * Login as admin user
 */
export async function loginAsAdmin(page: Page, autoAcceptBeta = true): Promise<void> {
  await login(page, TEST_USERS.ADMIN.email, TEST_USERS.ADMIN.password, autoAcceptBeta);
}

/**
 * Accept beta agreement modal (does nothing if not present)
 */
export async function acceptBetaAgreement(page: Page): Promise<void> {
  try {
    const acceptButton = page.locator(
      'button:has-text("Accept and Continue"), button:has-text("Принять и продолжить")',
    );
    const buttonVisible = await acceptButton
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    if (buttonVisible) {
      await acceptButton.first().click();
      await page
        .waitForSelector('[data-slot="dialog-overlay"]', { state: "detached", timeout: 5000 })
        .catch(() => {});
      await page
        .waitForSelector('[data-slot="dialog-content"]', { state: "detached", timeout: 2000 })
        .catch(() => {});
      await page.waitForTimeout(300);
    }
  } catch {
    // Modal not present
  }
}

/**
 * Create new user with optional email verification.
 * Uses pure HTTP requests - no browser automation.
 */
export async function createTestUser(
  email: string,
  password: string,
  name: string,
  verifyEmail = true,
): Promise<{ success: boolean; userId?: string; error?: string }> {
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
  } catch (error) {
    return { success: false, error: `Sign-up error: ${error}` };
  }

  if (verifyEmail) {
    try {
      const { verifyUserEmail } = await import("../../utils/mcp-auth.js");
      await verifyUserEmail(FETCH_URL, email);

      // Get userId after verification
      const adminSessionCookie = await getAdminSessionCookie();
      const usersResponse = await fetch(
        `${FETCH_URL}/api/admin/users?search=${encodeURIComponent(email)}&limit=10`,
        {
          headers: { Cookie: formatSessionCookie(FETCH_URL, adminSessionCookie) },
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

      return { success: true };
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
