/**
 * E2E Tests: Forced Password Reset Flow
 * Tests the complete forced password reset user experience
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { loginAsAdmin, createTestUser } from "./helpers/auth-helper.js";

const BASE_URL = getTestBaseUrl();

test.describe("Forced Password Reset E2E", () => {
  // These tests involve multi-step flows (admin login, force reset, user login, password change)
  // that need extended timeout under full suite load
  test.setTimeout(90000);

  const testPassword = "TestPassword123!";
  const newPassword = "NewTestPassword456!";

  test("complete forced password reset flow", async ({ page, request }) => {
    // Create unique test user with verified email using helper
    const testUserEmail = `forced-reset-flow-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;

    const result = await createTestUser(
      testUserEmail,
      testPassword,
      "Forced Reset Flow Test",
      true,
    );
    expect(result.success).toBe(true);
    const testUserId = result.userId!;

    // Admin login via page
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    // Navigate to user detail page
    await page.goto(`/admin/users/${testUserId}`, { timeout: 15000 });
    await page.waitForLoadState("domcontentloaded");
    // Wait for Security Actions section to load
    await page.locator("text=Security Actions").first().waitFor({ timeout: 15000 });

    // Force password reset via AlertDialog
    const forceResetButton = page.locator('button:has-text("Force Password Reset")');
    await expect(forceResetButton).toBeVisible({ timeout: 10000 });
    await forceResetButton.click();

    // Confirm in AlertDialog
    await page.locator('[role="alertdialog"]').waitFor();
    await page.locator('[role="alertdialog"] button:has-text("Force Password Reset")').click();

    // Wait for the Password Reset Required badge to appear (API response + UI update)
    await expect(page.locator("text=Password Reset Required").first()).toBeVisible({
      timeout: 10000,
    });

    // Logout admin - clear cookies and do full page reload to reset React state
    await page.context().clearCookies();
    // Full navigation (not just React Router) to reset all client-side state
    await page.goto("/login", { waitUntil: "load" });
    // Ensure page is fully loaded and React state is fresh
    await page.waitForLoadState("domcontentloaded");

    // User login - should redirect to force-password-reset
    await page.fill('input[type="email"]', testUserEmail);
    await page.fill('input[type="password"]', testPassword);
    await page.click('button[type="submit"]');

    // Wait for login to process and redirect chain to complete
    // The redirect chain is: /login -> / -> /force-password-reset
    // First wait for navigation away from login page
    await page.waitForURL((url) => !url.toString().includes("/login"), {
      timeout: 15000,
    });

    // Wait for network to settle after login
    await page.waitForLoadState("domcontentloaded");

    // Now wait for force-password-reset redirect (may require another navigation)
    await page.waitForURL((url) => url.toString().includes("/force-password-reset"), {
      timeout: 15000,
    });
    await expect(page.locator("text=Password Reset Required")).toBeVisible();

    // Try navigate away - should be blocked
    await page.goto("/workflows");
    await page.waitForURL("/force-password-reset", { timeout: 15000 });

    // Validation errors
    await page.fill("input#currentPassword", testPassword);
    await page.fill("input#newPassword", newPassword);
    await page.fill("input#confirmPassword", "WrongPassword123!");
    await page.click('button[type="submit"]');
    await expect(page.locator("text=New passwords do not match")).toBeVisible();

    // Successfully change password
    await page.fill("input#currentPassword", testPassword);
    await page.fill("input#newPassword", newPassword);
    await page.fill("input#confirmPassword", newPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL("/workflows", { timeout: 30000 });

    // Verify can access app
    await page.goto("/");
    await expect(page).toHaveURL(/\/?$/);

    // Logout and login with new password
    await page.context().clearCookies();
    await page.goto("/login", { waitUntil: "load" });
    // Wait for login form to be ready instead of networkidle (which can hang)
    await expect(page.locator('input[type="email"]')).toBeVisible({ timeout: 10000 });

    await page.fill('input[type="email"]', testUserEmail);
    await page.fill('input[type="password"]', newPassword);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/?/, { timeout: 15000 });
    await expect(page).toHaveURL(/\/?$/);
  });

  test("should show correct error for wrong current password", async ({ page, request }) => {
    // Create unique test user with verified email using helper
    const testUserEmail = `forced-reset-error-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;

    const result = await createTestUser(
      testUserEmail,
      testPassword,
      "Forced Reset Error Test",
      true,
    );
    expect(result.success).toBe(true);
    const testUserId = result.userId!;

    // Admin login via page
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    // Navigate to user detail page
    await page.goto(`/admin/users/${testUserId}`, { timeout: 15000 });
    await page.waitForLoadState("domcontentloaded");
    // Wait for Security Actions section to load
    await page.locator("text=Security Actions").first().waitFor({ timeout: 15000 });

    // Force password reset via AlertDialog
    const forceResetButton = page.locator('button:has-text("Force Password Reset")');
    await expect(forceResetButton).toBeVisible({ timeout: 10000 });
    await forceResetButton.click();

    // Confirm in AlertDialog
    await page.locator('[role="alertdialog"]').waitFor();
    await page.locator('[role="alertdialog"] button:has-text("Force Password Reset")').click();

    // Wait for API response and UI update
    await expect(page.locator("text=Password Reset Required").first()).toBeVisible({
      timeout: 10000,
    });

    // Logout admin - clear cookies and do full page reload to reset React state
    await page.context().clearCookies();
    // Full navigation (not just React Router) to reset all client-side state
    await page.goto("/login", { waitUntil: "load" });
    // Ensure page is fully loaded and React state is fresh
    await page.waitForLoadState("domcontentloaded");

    // Login as test user
    await page.fill('input[type="email"]', testUserEmail);
    await page.fill('input[type="password"]', testPassword);
    await page.click('button[type="submit"]');

    // Wait for login to process and redirect chain to complete
    await page.waitForURL((url) => !url.toString().includes("/login"), {
      timeout: 15000,
    });
    await page.waitForLoadState("domcontentloaded");

    // Wait for redirect: /login -> / -> /force-password-reset
    await page.waitForURL((url) => url.toString().includes("/force-password-reset"), {
      timeout: 15000,
    });

    // Try with wrong current password
    await page.fill("input#currentPassword", "WrongCurrentPassword123!");
    await page.fill("input#newPassword", "AnotherNewPassword789!");
    await page.fill("input#confirmPassword", "AnotherNewPassword789!");
    await page.click('button[type="submit"]');

    // Check that error message is displayed in AuthErrorDisplay component
    const errorDiv = page.getByTestId("auth-error");
    await expect(errorDiv).toBeVisible();
    // Error should contain authentication error message
    await expect(errorDiv).toContainText(/Authentication Error|incorrect|failed|error/i);
  });
});
