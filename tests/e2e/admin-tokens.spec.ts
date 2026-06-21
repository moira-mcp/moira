/**
 * Admin Token Management E2E Tests
 * Tests admin page: list tokens, search/filter, admin revoke
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin, createTestUser } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

/**
 * Helper: create a token via API for a given session cookie
 */
async function createTokenViaApi(
  sessionCookie: string,
  name: string,
): Promise<{ id: string; tokenPrefix: string }> {
  const cookieName = BASE_URL.startsWith("https://")
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
  const res = await fetch(`${FETCH_URL}/api/tokens`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `${cookieName}=${sessionCookie}`,
    },
    body: JSON.stringify({ name, expiresIn: "30d" }),
  });
  const data = await res.json();
  return { id: data.data.id, tokenPrefix: data.data.tokenPrefix };
}

/**
 * Helper: get session cookie for a user via API
 */
async function getSessionCookie(email: string, password: string): Promise<string> {
  const res = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie") || "";
  const cookieName = BASE_URL.startsWith("https://")
    ? "__Secure-better-auth.session_token"
    : "better-auth.session_token";
  const match = setCookie.match(new RegExp(`${cookieName}=([^;]+)`));
  return match?.[1] || "";
}

test.describe("Admin Token Management", () => {
  const userEmail = `admin-tokens-e2e-${Date.now()}@test.local`;
  const userPassword = "TestPassword123!";
  const tokenName = `admin-e2e-token-${Date.now()}`;
  let createdTokenId: string;

  test.beforeAll(async () => {
    // Create test user and a token
    const result = await createTestUser(userEmail, userPassword, "Token E2E User", true);
    expect(result.success).toBe(true);

    const sessionCookie = await getSessionCookie(userEmail, userPassword);
    expect(sessionCookie).toBeTruthy();

    const token = await createTokenViaApi(sessionCookie, tokenName);
    createdTokenId = token.id;
  });

  test("admin tokens page accessible from sidebar", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/tokens`);

    // Page title should be visible
    await expect(page.locator("h1, h2").filter({ hasText: "API Tokens" })).toBeVisible({
      timeout: 10000,
    });

    // Search input should be present
    await expect(page.getByTestId("admin-tokens-search")).toBeVisible();
  });

  test("displays tokens with user info", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/tokens`);

    // Wait for token list to load
    await expect(page.getByTestId("admin-tokens-search")).toBeVisible({ timeout: 10000 });

    // Should show our created token
    const tokenName_ = page.getByTestId("token-name").filter({ hasText: tokenName });
    await expect(tokenName_.first()).toBeVisible({ timeout: 10000 });

    // Should show user email
    const userInfo = page.getByTestId("token-user").filter({ hasText: userEmail });
    await expect(userInfo.first()).toBeVisible();

    // Should show token prefix (monospace code element)
    await expect(page.getByTestId("token-prefix").first()).toBeVisible();
  });

  test("search filters tokens by name", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/tokens`);
    await expect(page.getByTestId("admin-tokens-search")).toBeVisible({ timeout: 10000 });

    // Type a unique part of our token name
    await page.getByTestId("admin-tokens-search").fill(tokenName);

    // Wait for debounce + reload
    await page.waitForTimeout(500);

    // Our token should still be visible
    const tokenEl = page.getByTestId("token-name").filter({ hasText: tokenName });
    await expect(tokenEl.first()).toBeVisible({ timeout: 5000 });
  });

  test("status filter works", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/tokens`);
    await expect(page.getByTestId("admin-tokens-search")).toBeVisible({ timeout: 10000 });

    // Select "Active" status filter
    await page.getByTestId("status-filter").click();
    await page.locator('[role="option"]').filter({ hasText: "Active" }).click();

    // Our active token should be visible
    await page.waitForTimeout(500);
    const tokenEl = page.getByTestId("token-name").filter({ hasText: tokenName });
    await expect(tokenEl.first()).toBeVisible({ timeout: 5000 });

    // Select "Revoked" - our active token should disappear
    await page.getByTestId("status-filter").click();
    await page.locator('[role="option"]').filter({ hasText: "Revoked" }).click();
    await page.waitForTimeout(500);

    // Token should not be visible (it's active, not revoked)
    const revokedTokens = page.getByTestId("token-name").filter({ hasText: tokenName });
    await expect(revokedTokens).toHaveCount(0, { timeout: 5000 });
  });

  test("admin can revoke token", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/tokens`);
    await expect(page.getByTestId("admin-tokens-search")).toBeVisible({ timeout: 10000 });

    // Find our token's revoke button
    const revokeButton = page.getByTestId(`revoke-token-${createdTokenId}`);
    await expect(revokeButton).toBeVisible({ timeout: 10000 });

    // Click revoke
    await revokeButton.click();

    // Confirmation dialog should appear
    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog).toContainText(tokenName);

    // Confirm revoke
    await dialog.locator('button:has-text("Revoke")').click();

    // Token should now show Revoked badge
    await page.waitForTimeout(1000);
    const tokenRow = page.locator(`[data-testid="token-row-${createdTokenId}"]`);
    await expect(tokenRow.locator("text=Revoked")).toBeVisible({ timeout: 5000 });

    // Revoke button should no longer be visible
    await expect(revokeButton).not.toBeVisible();
  });
});
