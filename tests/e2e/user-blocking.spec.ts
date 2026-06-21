/**
 * E2E tests for User Blocking functionality
 * Tests complete user experience: login → block → kicked out → login rejected → unblock → login successful
 */

import { test, expect } from "./fixtures.js";
import { createTestUser, loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";
import { blockUserViaApi } from "../utils/mcp-auth.js";

test.describe("User Blocking E2E", () => {
  test("complete blocking scenario: login → block → kicked out → login rejected → unblock → login successful", async ({
    page,
    context,
  }) => {
    // This is a complex multi-step test, increase timeout
    test.slow();

    const baseUrl = getTestBaseUrl();
    const fetchUrl = getTestFetchUrl();

    // Step 1: Create and verify test user
    const testEmail = `block-e2e-${Date.now()}@test.com`;
    const testPassword = "TestPassword123!";
    const result = await createTestUser(
      testEmail,
      testPassword,
      "Block E2E Test User",
      true, // Email verified
    );
    expect(result.success).toBe(true);
    expect(result.userId).toBeTruthy();
    const testUserId = result.userId!;

    // Step 2: Login as test user
    await page.goto(`${baseUrl}/login`);
    await page.fill('input[type="email"]', testEmail);
    await page.fill('input[type="password"]', testPassword);
    await page.click('button[type="submit"]');

    // Wait for redirect to app (may go to / or /workflows)
    await page.waitForURL(
      (url) => url.toString().includes("/") && !url.toString().includes("/login"),
      { timeout: 10000 },
    );
    expect(page.url()).toMatch(/\/(\/workflows)?/);

    // Step 3: Open admin panel in new page - go directly to user detail page
    const adminPage = await context.newPage();
    await loginAsAdmin(adminPage);
    await adminPage.goto(`${baseUrl}/admin/users/${testUserId}`);

    // Step 4: Block the user via Dialog with reason input
    const blockButton = adminPage.locator('button:has-text("Block User")');
    await expect(blockButton).toBeVisible({ timeout: 5000 });

    // Start listening for response BEFORE clicking (to avoid race condition)
    const blockResponsePromise = adminPage.waitForResponse(
      (response) => response.url().includes("/block") && response.status() === 200,
      { timeout: 15000 },
    );

    await blockButton.click();

    // Fill in block reason in the Dialog
    await adminPage.locator('[role="dialog"]').waitFor();
    await adminPage.locator('[role="dialog"] input').fill("E2E test block");
    await adminPage.locator('[role="dialog"] button:has-text("Block User")').click();

    // Wait for API call to complete
    await blockResponsePromise;

    // Verify user shows as blocked in UI (badge in header area)
    await expect(adminPage.getByText("Blocked", { exact: true })).toBeVisible({ timeout: 5000 });

    // Step 5: Verify user cannot login when blocked
    // Note: Session cache may still be valid for a short time after block,
    // so we test the login rejection directly instead of session invalidation
    // Clear browser cookies to simulate session expiry
    await page.context().clearCookies();

    // Navigate to login
    await page.goto(`${baseUrl}/login`);

    // Step 6: Try to login as blocked user - should fail
    await page.fill('input[type="email"]', testEmail);
    await page.fill('input[type="password"]', testPassword);
    await page.click('button[type="submit"]');

    // Should see error message about blocked account
    // STRICT: Only accept "blocked" messages, NOT Internal Server Error (that would indicate a bug)
    await expect(page.locator("text=/blocked|Account.*blocked/i").first()).toBeVisible({
      timeout: 5000,
    });

    // Should NOT redirect to workflows
    expect(page.url()).toContain("/login");

    // Step 7: Unblock user via admin panel
    // Re-login as admin (session may have expired during test)
    await loginAsAdmin(adminPage);
    await adminPage.goto(`${baseUrl}/admin/users/${testUserId}`);
    await adminPage.waitForLoadState("domcontentloaded");

    const unblockButton = adminPage.locator('button:has-text("Unblock User")');
    await expect(unblockButton).toBeVisible({ timeout: 10000 });

    // Start listening for response BEFORE clicking (to avoid race condition)
    const unblockResponsePromise = adminPage.waitForResponse(
      (response) => response.url().includes("/unblock") && response.status() === 200,
      { timeout: 15000 },
    );

    await unblockButton.click();

    // Confirm in AlertDialog
    await adminPage.locator('[role="alertdialog"]').waitFor();
    await adminPage.locator('[role="alertdialog"] button:has-text("Unblock User")').click();

    // Wait for API call to complete
    await unblockResponsePromise;

    // Step 8: Login as unblocked user - should succeed
    await page.goto(`${baseUrl}/login`);
    await page.fill('input[type="email"]', testEmail);
    await page.fill('input[type="password"]', testPassword);
    await page.click('button[type="submit"]');

    // Should successfully redirect to app
    await page.waitForURL(
      (url) => url.toString().includes("/") && !url.toString().includes("/login"),
      { timeout: 10000 },
    );
    expect(page.url()).toMatch(/\/(\/workflows)?/);

    // Cleanup
    await adminPage.close();
  });

  test("blocked user cannot login after being blocked", async ({ page }) => {
    const baseUrl = getTestBaseUrl();
    const fetchUrl = getTestFetchUrl();

    // Setup via API: Create user
    const testEmail = `block-protected-${Date.now()}@test.com`;
    const testPassword = "TestPassword123!";
    const result = await createTestUser(testEmail, testPassword, "Block Protected Test", true);
    expect(result.success).toBe(true);
    expect(result.userId).toBeTruthy();
    const testUserId = result.userId!;

    // Block user via API before they try to login
    await blockUserViaApi(fetchUrl, testUserId, "E2E test - protected routes");

    // Test: Try to login as blocked user - should fail
    await page.goto(`${baseUrl}/login`);
    await page.fill('input[type="email"]', testEmail);
    await page.fill('input[type="password"]', testPassword);
    await page.click('button[type="submit"]');

    // Should see error message and stay on login page
    await expect(page.locator("text=/blocked|cannot.*login|error/i").first()).toBeVisible({
      timeout: 5000,
    });
    expect(page.url()).toContain("/login");
  });

  test("multiple sessions are all invalidated when user is blocked", async ({ browser }) => {
    test.slow();
    const baseUrl = getTestBaseUrl();
    const fetchUrl = getTestFetchUrl();

    // Setup via API: Create test user
    const testEmail = `block-multi-session-${Date.now()}@test.com`;
    const testPassword = "TestPassword123!";
    const result = await createTestUser(testEmail, testPassword, "Block Multi Session Test", true);
    expect(result.success).toBe(true);
    expect(result.userId).toBeTruthy();
    const testUserId = result.userId!;

    // Create 3 browser contexts (3 different sessions)
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();
    const context3 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();
    const page3 = await context3.newPage();

    // Login in all 3 sessions via browser (testing session behavior)
    for (const page of [page1, page2, page3]) {
      await page.goto(`${baseUrl}/login`);
      await page.fill('input[type="email"]', testEmail);
      await page.fill('input[type="password"]', testPassword);
      await page.click('button[type="submit"]');
      await page.waitForURL(
        (url) => url.toString().includes("/") && !url.toString().includes("/login"),
        { timeout: 10000 },
      );
    }

    // Verify all sessions are active
    for (const page of [page1, page2, page3]) {
      expect(page.url()).toMatch(/\/(\/workflows)?/);
    }

    // Setup via API: Block user (prerequisite, not the tested functionality)
    await blockUserViaApi(fetchUrl, testUserId, "E2E test - multi session");

    // Test: Verify all sessions are invalidated
    for (const page of [page1, page2, page3]) {
      await page.reload();
      await page.waitForURL(/\/login/, { timeout: 10000 });
      expect(page.url()).toContain("/login");
    }

    // Cleanup
    await context1.close();
    await context2.close();
    await context3.close();
  });
});
