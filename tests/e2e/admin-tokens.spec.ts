/**
 * Admin Token Management E2E Tests
 * Tests admin page: list tokens, search/filter, admin revoke
 */

import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures.js";
import { loginAsAdmin, createTestUser, getSessionCookieHeader } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

/**
 * Helper: create a token via API for a given `Cookie` header value
 */
async function createTokenViaApi(
  cookieHeader: string,
  name: string,
): Promise<{ id: string; tokenPrefix: string }> {
  const res = await fetch(`${FETCH_URL}/api/tokens`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookieHeader },
    body: JSON.stringify({ name, expiresIn: "30d" }),
  });
  if (!res.ok) throw new Error(`Token creation failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: data.data.id, tokenPrefix: data.data.tokenPrefix };
}

test.describe("Admin Token Management", () => {
  const userPassword = "TestPassword123!";
  // Set by beforeAll, and fresh on every run of it. Under fullyParallel a worker runs this hook
  // again whenever it comes back to this file after tests from other files, in the same module
  // instance: names fixed when the module loaded would then create a second token with the same
  // name, and the search would find two.
  let userEmail: string;
  let tokenName: string;
  let createdTokenId: string;

  test.beforeAll(async () => {
    const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    userEmail = `admin-tokens-e2e-${runId}@test.local`;
    tokenName = `admin-e2e-token-${runId}`;

    // Create test user and a token
    const result = await createTestUser(userEmail, userPassword, "Token E2E User", true);
    expect(result.success).toBe(true);

    const cookieHeader = await getSessionCookieHeader(userEmail, userPassword);
    const token = await createTokenViaApi(cookieHeader, tokenName);
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

    // Type a unique part of our token name and wait for the debounced, filtered reload
    const filtered = page.waitForResponse(
      (r) =>
        r.url().includes("/api/admin/tokens") &&
        r.url().includes(encodeURIComponent(tokenName)) &&
        r.status() === 200,
    );
    await page.getByTestId("admin-tokens-search").fill(tokenName);
    await filtered;

    // Our token is the only one matching the search
    const tokenEl = page.getByTestId("token-name").filter({ hasText: tokenName });
    await expect(tokenEl).toHaveCount(1, { timeout: 5000 });
    await expect(page.getByTestId("token-name")).toHaveCount(1);
  });

  test("status filter works", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin/tokens`);
    await expect(page.getByTestId("admin-tokens-search")).toBeVisible({ timeout: 10000 });

    // Select "Active" status filter and wait for the filtered reload
    const activeReload = page.waitForResponse(
      (r) => r.url().includes("/api/admin/tokens") && r.status() === 200,
    );
    await page.getByTestId("status-filter").click();
    await page.locator('[role="option"]').filter({ hasText: "Active" }).click();
    await activeReload;

    // Our active token should be visible
    const tokenEl = page.getByTestId("token-name").filter({ hasText: tokenName });
    await expect(tokenEl.first()).toBeVisible({ timeout: 5000 });

    // Select "Revoked" - our active token should disappear
    await page.getByTestId("status-filter").click();
    await page.locator('[role="option"]').filter({ hasText: "Revoked" }).click();

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

    // A working token is the normal state and carries no status badge
    const tokenRow = page.locator(`[data-testid="token-row-${createdTokenId}"]`);
    await expect(tokenRow.getByText(/^(Active|Revoked|Expired)$/)).toHaveCount(0);

    // Click revoke
    await revokeButton.click();

    // Confirmation dialog should appear
    const dialog = page.locator('[role="alertdialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });
    await expect(dialog).toContainText(tokenName);

    // Confirm revoke
    await dialog.locator('button:has-text("Revoke")').click();

    // Token should now show Revoked badge
    await expect(tokenRow.locator("text=Revoked")).toBeVisible({ timeout: 5000 });

    // Revoke button should no longer be visible
    await expect(revokeButton).not.toBeVisible();
  });
});
