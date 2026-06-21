/**
 * API Tokens Settings E2E Tests
 * Tests the full token lifecycle: create → display → list → revoke
 */

import { test, expect } from "./fixtures.js";
import { login, createTestUser } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test.describe("API Tokens Settings", () => {
  const testEmail = `token-e2e-${Date.now()}@test.local`;
  const testPassword = "TestPassword123!";
  const testName = "Token Test User";

  test.beforeAll(async () => {
    const result = await createTestUser(testEmail, testPassword, testName, true);
    expect(result.success).toBe(true);
  });

  test("API Tokens section visible on settings page", async ({ page }) => {
    await login(page, testEmail, testPassword);
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForSelector('h1:has-text("Settings")');

    const section = page.getByTestId("settings-section-api-tokens");
    await section.scrollIntoViewIfNeeded();
    await expect(section).toBeVisible();
    await expect(page.getByTestId("create-token-button")).toBeVisible();
  });

  test("create token, display once, and verify in list", async ({ page }) => {
    test.slow();
    await login(page, testEmail, testPassword);
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForSelector('h1:has-text("Settings")');

    // Scroll to API Tokens section
    const section = page.getByTestId("settings-section-api-tokens");
    await section.scrollIntoViewIfNeeded();

    // Click Create Token
    await page.getByTestId("create-token-button").click();

    // Create dialog should be visible
    const dialog = page.getByTestId("create-token-dialog");
    await expect(dialog).toBeVisible();

    // Fill in token name
    const tokenName = `test-token-${Date.now()}`;
    await page.getByTestId("token-name-input").fill(tokenName);

    // Submit with default expiration (90d)
    await page.getByTestId("confirm-create-token").click();

    // Token display dialog should appear
    const displayDialog = page.getByTestId("token-display-dialog");
    await expect(displayDialog).toBeVisible({ timeout: 10000 });

    // Verify token value is shown and starts with moira_
    const tokenValue = page.getByTestId("displayed-token-value");
    await expect(tokenValue).toBeVisible();
    const tokenText = await tokenValue.textContent();
    expect(tokenText).toBeTruthy();
    expect(tokenText!.startsWith("moira_")).toBe(true);

    // Copy button should be present
    await expect(page.getByTestId("copy-token-button")).toBeVisible();

    // Close the display dialog
    await page.getByTestId("close-token-display").click();
    await expect(displayDialog).not.toBeVisible();

    // Verify token appears in the list
    await section.scrollIntoViewIfNeeded();
    const tokenNameInList = page.locator('[data-testid="token-name"]', { hasText: tokenName });
    await expect(tokenNameInList).toBeVisible({ timeout: 5000 });

    // Verify prefix is shown (monospace)
    const prefix = page.locator('[data-testid="token-prefix"]').first();
    await expect(prefix).toBeVisible();
    const prefixText = await prefix.textContent();
    expect(prefixText).toMatch(/^moira_[a-f0-9]+\.\.\.$/);
  });

  test("revoke token with confirmation", async ({ page }) => {
    test.slow();
    await login(page, testEmail, testPassword);
    await page.goto(`${BASE_URL}/settings`);
    await page.waitForSelector('h1:has-text("Settings")');

    // Create a token first (use default expiry to avoid Select interaction)
    const section = page.getByTestId("settings-section-api-tokens");
    await section.scrollIntoViewIfNeeded();
    await page.getByTestId("create-token-button").click();

    const tokenName = `revoke-test-${Date.now()}`;
    await page.getByTestId("token-name-input").fill(tokenName);
    await page.getByTestId("confirm-create-token").click();

    // Wait for token display dialog and close it
    await expect(page.getByTestId("token-display-dialog")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("close-token-display").click();
    await expect(page.getByTestId("token-display-dialog")).not.toBeVisible();

    // Wait for list to refresh and find our token
    await section.scrollIntoViewIfNeeded();
    const tokenRow = page.locator('[data-testid="token-name"]', { hasText: tokenName });
    await expect(tokenRow).toBeVisible({ timeout: 5000 });

    // Find the revoke button within the same card
    const card = tokenRow.locator("xpath=ancestor::div[contains(@class, 'rounded')]").first();
    const revokeBtn = card.locator('button:has-text("Revoke")');
    await revokeBtn.click();

    // Confirm in the alert dialog
    const confirmBtn = page.getByRole("alertdialog").getByRole("button", { name: /revoke/i });
    await expect(confirmBtn).toBeVisible({ timeout: 5000 });
    await confirmBtn.click();

    // Verify the token shows "Revoked" status
    await page.waitForTimeout(500);
    await section.scrollIntoViewIfNeeded();
    const revokedBadge = page.locator("text=Revoked").first();
    await expect(revokedBadge).toBeVisible({ timeout: 5000 });
  });
});
