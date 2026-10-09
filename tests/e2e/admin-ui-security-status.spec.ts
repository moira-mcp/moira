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
    const forceResetBtn = page.getByRole("button", { name: "Force Password Reset", exact: true });

    // Wait for API response
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/admin/users/${testUser.userId}/force-password-reset` &&
        response.request().method() === "POST",
    );

    await forceResetBtn.click();
    // Confirm in AlertDialog
    const resetDialog = page.getByRole("alertdialog", {
      name: "Force Password Reset",
      exact: true,
      includeHidden: true,
    });
    await expect(resetDialog).toBeVisible();
    await resetDialog.getByRole("button", { name: "Force Password Reset", exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { userId: testUser.userId, passwordResetRequired: true },
    });
    await expect(resetDialog).toHaveCount(0);

    // Check badge visible (confirms data loaded)
    const badge = page.locator("text=Password Reset Required").first();
    await expect(badge).toBeVisible({ timeout: 15000 });

    // Check info panel visible
    const infoPanel = page.locator("text=Requested:").first();
    await expect(infoPanel).toBeVisible({ timeout: 5000 });

    // Check Clear Reset button visible
    const clearButton = page.getByRole("button", { name: "Clear Reset", exact: true });
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
    const forceResetBtn = page.getByRole("button", { name: "Force Password Reset", exact: true });
    const resetResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/admin/users/${testUser.userId}/force-password-reset` &&
        response.request().method() === "POST",
    );
    await forceResetBtn.click();
    const resetDialog = page.getByRole("alertdialog", {
      name: "Force Password Reset",
      exact: true,
      includeHidden: true,
    });
    await expect(resetDialog).toBeVisible();
    await resetDialog.getByRole("button", { name: "Force Password Reset", exact: true }).click();
    const resetResponse = await resetResponsePromise;
    expect(resetResponse.status()).toBe(200);
    expect(await resetResponse.json()).toMatchObject({
      success: true,
      data: { userId: testUser.userId, passwordResetRequired: true },
    });
    await expect(resetDialog).toHaveCount(0);

    // Wait for badge to appear (confirms force reset completed)
    await expect(page.locator("text=Password Reset Required").first()).toBeVisible({
      timeout: 15000,
    });

    // Click clear reset button
    const clearButton = page.getByRole("button", { name: "Clear Reset", exact: true });

    // Wait for the API call to complete after clicking
    const responsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/admin/users/${testUser.userId}` &&
        response.request().method() === "PUT",
    );

    await clearButton.click();
    // Confirm in AlertDialog
    const clearDialog = page.getByRole("alertdialog", {
      name: "Clear Reset",
      exact: true,
      includeHidden: true,
    });
    await expect(clearDialog).toBeVisible();
    await clearDialog.getByRole("button", { name: "Clear Reset", exact: true }).click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { id: testUser.userId, updated: true },
    });
    await expect(clearDialog).toHaveCount(0);

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

    const blockResponse = await fetch(`${FETCH_URL}/api/admin/users/${testUser.userId}/block`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: "UI test block" }),
    });
    expect(blockResponse.status).toBe(200);
    expect(await blockResponse.json()).toMatchObject({
      success: true,
      data: { id: testUser.userId, blocked: true },
    });

    // Navigate to user page
    await page.goto(`${BASE_URL}/admin/users/${testUser.userId}`);
    await page.waitForLoadState("domcontentloaded");

    // Check blocked badge visible
    const badge = page.getByText("Blocked", { exact: true });
    await expect(badge).toBeVisible({ timeout: 10000 });

    // Check block info panel visible
    const blockInfo = page.locator("text=UI test block");
    await expect(blockInfo).toBeVisible({ timeout: 5000 });

    // Check Unblock button visible
    const unblockButton = page.getByRole("button", { name: "Unblock User", exact: true });
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
    const blockButton = page.getByRole("button", { name: "Block User", exact: true });
    const unblockButton = page.getByRole("button", { name: "Unblock User", exact: true });
    const blockedBadge = page.getByText("Blocked", { exact: true });
    await expect(blockButton).toBeVisible();

    // The shared confirmation keeps the block reason with the action.
    await blockButton.click();
    const blockDialog = page.getByRole("alertdialog", {
      name: "Block User",
      exact: true,
      includeHidden: true,
    });
    await expect(blockDialog).toBeVisible();
    await blockDialog.getByRole("textbox").fill("Test block reason");

    // Click block confirm and wait for API response
    const blockResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/admin/users/${testUser.userId}/block` &&
        response.request().method() === "POST",
    );

    await blockDialog.getByRole("button", { name: "Block User", exact: true }).click();
    const blockResponse = await blockResponsePromise;
    expect(blockResponse.status()).toBe(200);
    expect(await blockResponse.json()).toMatchObject({
      success: true,
      data: { id: testUser.userId, blocked: true },
    });
    await expect(blockDialog).toHaveCount(0);

    // Should now show Unblock button
    await expect(unblockButton).toBeVisible();
    await expect(blockedBadge).toBeVisible();

    // Click unblock button - opens AlertDialog
    await unblockButton.click();
    const unblockDialog = page.getByRole("alertdialog", {
      name: "Unblock User",
      exact: true,
      includeHidden: true,
    });
    await expect(unblockDialog).toBeVisible();

    // Click confirm and wait for API response
    const unblockResponsePromise = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/admin/users/${testUser.userId}/unblock` &&
        response.request().method() === "POST",
    );

    await unblockDialog.getByRole("button", { name: "Unblock User", exact: true }).click();
    const unblockResponse = await unblockResponsePromise;
    expect(unblockResponse.status()).toBe(200);
    expect(await unblockResponse.json()).toMatchObject({
      success: true,
      data: { id: testUser.userId, unblocked: true },
    });
    await expect(unblockDialog).toHaveCount(0);

    // Should show Block button again
    await expect(blockButton).toBeVisible();
    await expect(blockedBadge).not.toBeVisible();
  });
});
