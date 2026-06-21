/**
 * E2E tests for Admin UI Security Status (Step 9)
 * Tests password reset and block status UI elements
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin, createTestUser } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

test.describe("Admin UI Security Status", () => {
  test("password reset badge and info panel visible when flag set", async ({ page }) => {
    // Create test user
    const email = `reset-ui-${Date.now()}@test.com`;
    const password = "TestPassword123!";
    const testUser = await createTestUser(email, password, "Reset UI Test", true);

    if (!testUser.success || !testUser.userId) {
      throw new Error("Failed to create test user");
    }

    // Login as admin
    await loginAsAdmin(page);

    // Navigate to user page first
    await page.goto(`${BASE_URL}/admin/users/${testUser.userId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Force password reset via UI button (AlertDialog)
    const forceResetBtn = page.locator('button:has-text("Force Password Reset")');

    // Wait for API response
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/admin/users/") &&
        response.url().includes("/force-password-reset"),
    );

    await forceResetBtn.click();
    // Confirm in AlertDialog
    await page.locator('[role="alertdialog"]').waitFor();
    await page.locator('[role="alertdialog"] button:has-text("Force Password Reset")').click();
    await responsePromise;

    // Check badge visible (confirms data loaded)
    const badge = page.locator("text=Password Reset Required").first();
    await expect(badge).toBeVisible({ timeout: 15000 });

    // Check info panel visible
    const infoPanel = page.locator("text=Requested:").first();
    await expect(infoPanel).toBeVisible({ timeout: 5000 });

    // Check Clear Reset button visible
    const clearButton = page.locator('button:has-text("Clear Reset")');
    await expect(clearButton).toBeVisible({ timeout: 5000 });
  });

  test("clear reset button removes password reset requirement", async ({ page }) => {
    // Create test user
    const email = `clear-reset-ui-${Date.now()}@test.com`;
    const password = "TestPassword123!";
    const testUser = await createTestUser(email, password, "Clear Reset UI Test", true);

    if (!testUser.success || !testUser.userId) {
      throw new Error("Failed to create test user");
    }

    // Login as admin
    await loginAsAdmin(page);

    // Navigate to user page
    await page.goto(`${BASE_URL}/admin/users/${testUser.userId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);

    // Force password reset via UI (AlertDialog)
    const forceResetBtn = page.locator('button:has-text("Force Password Reset")');
    await forceResetBtn.click();
    await page.locator('[role="alertdialog"]').waitFor();
    await page.locator('[role="alertdialog"] button:has-text("Force Password Reset")').click();

    // Wait for badge to appear (confirms force reset completed)
    await expect(page.locator("text=Password Reset Required").first()).toBeVisible({
      timeout: 15000,
    });

    // Click clear reset button
    const clearButton = page.locator('button:has-text("Clear Reset")');

    // Wait for the API call to complete after clicking
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/admin/users/${testUser.userId}`) &&
        response.request().method() === "PUT",
    );

    await clearButton.click();
    // Confirm in AlertDialog
    await page.locator('[role="alertdialog"]').waitFor();
    await page.locator('[role="alertdialog"] button:has-text("Clear Reset")').click();
    await responsePromise;

    // Wait for UI to update and badge to disappear
    const badge = page.locator("text=Password Reset Required").first();
    await expect(badge).not.toBeVisible({ timeout: 5000 });
  });

  test("block badge visible when user is blocked", async ({ page }) => {
    // Create test user
    const email = `block-ui-${Date.now()}@test.com`;
    const password = "TestPassword123!";
    const testUser = await createTestUser(email, password, "Block UI Test", true);

    if (!testUser.success || !testUser.userId) {
      throw new Error("Failed to create test user");
    }

    // Login as admin
    await loginAsAdmin(page);

    // Block user
    const cookies = await page.context().cookies();
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    await fetch(`${FETCH_URL}/api/admin/users/${testUser.userId}/block`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "UI test block" }),
    });

    // Navigate to user page
    await page.goto(`${BASE_URL}/admin/users/${testUser.userId}`);
    await page.waitForLoadState("domcontentloaded");

    // Check blocked badge visible
    const badge = page.locator("text=Blocked").first();
    await expect(badge).toBeVisible({ timeout: 10000 });

    // Check block info panel visible
    const blockInfo = page.locator("text=UI test block");
    await expect(blockInfo).toBeVisible({ timeout: 5000 });

    // Check Unblock button visible
    const unblockButton = page.locator('button:has-text("Unblock User")');
    await expect(unblockButton).toBeVisible();
  });

  test("block/unblock toggle works", async ({ page }) => {
    // Increase timeout for this multi-step test
    test.setTimeout(60000);

    // Create test user
    const email = `toggle-block-ui-${Date.now()}@test.com`;
    const password = "TestPassword123!";
    const testUser = await createTestUser(email, password, "Toggle Block UI Test", true);

    if (!testUser.success || !testUser.userId) {
      throw new Error("Failed to create test user");
    }

    // Login as admin
    await loginAsAdmin(page);

    // Navigate to user page - use domcontentloaded instead of networkidle to avoid timeout
    await page.goto(`${BASE_URL}/admin/users/${testUser.userId}`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500); // Small stabilization delay

    // Initially should show Block button
    await expect(page.locator('button:has-text("Block User")')).toBeVisible();

    // Click block button - opens Dialog with input for reason
    await page.click('button:has-text("Block User")');
    await page.locator('[role="dialog"]').waitFor();
    await page.locator('[role="dialog"] input').fill("Test block reason");

    // Click block confirm and wait for API response
    const blockResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/admin/users/") && response.url().includes("/block"),
    );

    await page.locator('[role="dialog"] button:has-text("Block User")').click();
    await blockResponsePromise;

    // Should now show Unblock button
    await expect(page.locator('button:has-text("Unblock User")')).toBeVisible();
    await expect(page.locator("text=Blocked").first()).toBeVisible();

    // Click unblock button - opens AlertDialog
    await page.click('button:has-text("Unblock User")');
    await page.locator('[role="alertdialog"]').waitFor();

    // Click confirm and wait for API response
    const unblockResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/admin/users/") && response.url().includes("/unblock"),
    );

    await page.locator('[role="alertdialog"] button:has-text("Unblock User")').click();
    await unblockResponsePromise;

    // Should show Block button again
    await expect(page.locator('button:has-text("Block User")')).toBeVisible();
    await expect(page.locator("text=Blocked").first()).not.toBeVisible();
  });
});
