/**
 * Admin User Security E2E Tests
 * Tests admin security actions in AdminUserDetail page
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin, createTestUser } from "./helpers/auth-helper.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

// Create target user once for all tests
let targetEmail: string;
let targetPassword: string;
let targetUserId: string;

test.describe("Admin User Security Management", () => {
  // Setup target user once before all tests
  test.beforeAll(async () => {
    targetEmail = `target-security-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    targetPassword = "TargetSecurity123!";

    // Create verified target user via API (includes consent fields)
    const result = await createTestUser(targetEmail, targetPassword, "Target Security E2E");
    if (!result.success || !result.userId) {
      throw new Error(`Failed to create test user: ${result.error}`);
    }
    targetUserId = result.userId;
  });

  // Login as admin before each test
  test.beforeEach(async ({ page }) => {
    await loginAsAdmin(page);

    // Reset user state via API before loading page
    const adminCookies = await page.context().cookies();
    const cookieHeader = adminCookies.map((c) => `${c.name}=${c.value}`).join("; ");

    // Clear passwordResetRequired flag to ensure tests can run
    await fetch(`${FETCH_URL}/api/admin/users/${targetUserId}`, {
      method: "PUT",
      headers: {
        Cookie: cookieHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        passwordResetRequired: false,
      }),
    });

    await page.goto(`${BASE_URL}/admin/users/${targetUserId}`);
    await page.waitForLoadState("domcontentloaded");
    // Wait for Security Actions section to load instead of arbitrary timeout
    await page.locator("text=Security Actions").first().waitFor({ timeout: 10000 });
  });

  test.describe("Security Actions Panel", () => {
    test("displays Security Actions section", async ({ page }) => {
      // CardTitle может рендериться как h2 или h3
      await expect(page.locator("text=Security Actions").first()).toBeVisible({ timeout: 10000 });
    });

    test("displays security activity stats", async ({ page }) => {
      await expect(page.locator("text=Active Sessions").first()).toBeVisible({ timeout: 5000 });
      await expect(page.locator("text=OAuth Tokens").first()).toBeVisible({ timeout: 5000 });
    });

    test("displays Force Password Reset button", async ({ page }) => {
      const button = page.locator("button", { hasText: "Force Password Reset" });
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
    });

    test("displays Revoke All OAuth Tokens button", async ({ page }) => {
      const button = page.locator("button", { hasText: "Revoke All OAuth Tokens" });
      await expect(button).toBeVisible();
    });
  });

  test.describe("Security UI Elements", () => {
    test("displays revoke OAuth button in panel", async ({ page }) => {
      const button = page.locator("button", { hasText: "Revoke All OAuth Tokens" });
      await expect(button).toBeVisible();
    });

    test("displays OAuth tokens count in stats", async ({ page }) => {
      await expect(page.locator("text=OAuth Tokens").first()).toBeVisible({ timeout: 5000 });
    });
  });

  test.describe("Functional Tests - Force Password Reset", () => {
    test("force password reset workflow updates user status", async ({ page }) => {
      // Initial state - badge not visible
      const badge = page.locator("text=Password Reset Required").first();
      const badgeVisible = await badge.isVisible().catch(() => false);

      if (badgeVisible) {
        // Already has reset required, skip functional test
        console.log("Password reset already required, skipping functional test");
        return;
      }

      // Click force reset button
      const forceResetBtn = page.locator("button", {
        hasText: "Force Password Reset",
      });
      await expect(forceResetBtn).toBeEnabled();

      // Wait for API response
      const responsePromise = page.waitForResponse(
        (resp) => resp.url().includes("/force-password-reset") && resp.status() === 200,
        { timeout: 10000 },
      );

      await forceResetBtn.click();

      // Confirm in AlertDialog
      await page.locator('[role="alertdialog"]').waitFor();
      await page.locator('[role="alertdialog"] button:has-text("Force Password Reset")').click();

      // Wait for API response
      const apiResponse = await responsePromise;
      expect(apiResponse.status()).toBe(200);

      // Reload page to see updated state
      await page.reload();
      await page.waitForLoadState("domcontentloaded");

      // Verify badge now visible
      await expect(badge).toBeVisible({ timeout: 10000 });

      // Verify button now disabled
      await expect(forceResetBtn).toBeDisabled();

      // Verify password reset status panel visible
      await expect(page.locator("text=Requested:").first()).toBeVisible();
    });

    test("force password reset revokes all user sessions (Step 6)", async ({ page, context }) => {
      // Create multiple sessions for target user
      const session1 = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetEmail,
          password: targetPassword,
        }),
      });
      expect(session1.status).toBe(200);

      const session2 = await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetEmail,
          password: targetPassword,
        }),
      });
      expect(session2.status).toBe(200);

      // Reload page to see sessions in UI
      await page.reload();
      await page.waitForLoadState("domcontentloaded");

      // Get initial session count from UI
      const sessionHeading = page.locator("text=Web Sessions").first();
      await sessionHeading.waitFor({ timeout: 10000 });
      const initialHeadingText = await sessionHeading.textContent();
      const initialMatch = initialHeadingText?.match(/\((\d+)\)/);
      const initialSessionCount = initialMatch ? parseInt(initialMatch[1]) : 0;

      expect(initialSessionCount).toBeGreaterThanOrEqual(2);

      // Click force reset button
      const forceResetBtn = page.locator("button").filter({ hasText: "Force Password Reset" });

      // Wait for API response
      const responsePromise = page.waitForResponse(
        (resp) => resp.url().includes("/force-password-reset") && resp.status() === 200,
        { timeout: 10000 },
      );

      await forceResetBtn.click();

      // Confirm in AlertDialog
      await page.locator('[role="alertdialog"]').waitFor();
      await page.locator('[role="alertdialog"] button:has-text("Force Password Reset")').click();

      // Wait for API response
      const apiResponse = await responsePromise;
      expect(apiResponse.status()).toBe(200);

      // Verify response contains sessionsRevoked field
      const apiJson = await apiResponse.json();
      expect(apiJson.data).toHaveProperty("sessionsRevoked");
      expect(apiJson.data.sessionsRevoked).toBeGreaterThanOrEqual(2);

      // Reload page to see updated state
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await sessionHeading.waitFor({ timeout: 10000 });

      // Verify all sessions revoked (count should be 0)
      const updatedHeadingText = await sessionHeading.textContent();
      const updatedMatch = updatedHeadingText?.match(/\((\d+)\)/);
      const updatedSessionCount = updatedMatch ? parseInt(updatedMatch[1]) : 0;

      expect(updatedSessionCount).toBe(0);

      // Verify password reset required badge visible
      const badge = page.locator("text=Password Reset Required").first();
      await expect(badge).toBeVisible();
    });
  });

  test.describe("Functional Tests - Button States", () => {
    test("buttons reflect current state correctly", async ({ page }) => {
      const forceResetBtn = page.locator("button", {
        hasText: "Force Password Reset",
      });
      const revokeTokensBtn = page.locator("button", {
        hasText: "Revoke All OAuth Tokens",
      });

      // Check if password reset already required
      const badgeVisible = await page
        .locator("text=Password Reset Required")
        .first()
        .isVisible()
        .catch(() => false);

      if (badgeVisible) {
        // Button should be disabled
        await expect(forceResetBtn).toBeDisabled();
      } else {
        // Button should be enabled
        await expect(forceResetBtn).toBeEnabled();
      }

      // Check OAuth tokens count
      const statsText = await page.locator("text=OAuth Tokens").first().locator("..").textContent();
      const tokenCount = parseInt(statsText?.match(/\d+/)?.[0] || "0");

      if (tokenCount === 0) {
        await expect(revokeTokensBtn).toBeDisabled();
      } else {
        await expect(revokeTokensBtn).toBeEnabled();
      }
    });
  });

  test.describe("Step 5: Web Sessions Section", () => {
    test.beforeEach(async ({ page }) => {
      // Create at least one session for target user
      await fetch(`${FETCH_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: targetEmail,
          password: targetPassword,
        }),
      });

      // Reload page to see new session
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await page.locator("text=Web Sessions").first().waitFor({ timeout: 10000 });
    });

    test("displays Web Sessions section", async ({ page }) => {
      const heading = page.locator("text=Web Sessions").first();
      await expect(heading).toBeVisible();
    });

    test("lists user sessions with details", async ({ page }) => {
      // Check if sessions heading shows count
      const heading = page.locator("text=Web Sessions").first();
      const headingText = await heading.textContent();

      // Sessions should exist (at least the one we just created)
      expect(headingText).toContain("Web Sessions");

      // Check count in parentheses
      const match = headingText?.match(/\((\d+)\)/);
      if (match) {
        const count = parseInt(match[1]);
        // Should have at least 1 session from beforeEach
        expect(count).toBeGreaterThan(0);
      }
    });

    test("revoke individual session shows confirmation dialog", async ({ page }) => {
      // Check if we have sessions
      const heading = page.locator("text=Web Sessions").first();
      const headingText = await heading.textContent();
      const match = headingText?.match(/\((\d+)\)/);
      const sessionCount = match ? parseInt(match[1]) : 0;

      if (sessionCount === 0) {
        // No sessions to test, skip
        return;
      }

      // Find first revoke button for individual session
      const revokeButton = page.locator("button").filter({ hasText: "Revoke" }).first();
      const isEnabled = await revokeButton.isEnabled().catch(() => false);

      if (isEnabled) {
        await revokeButton.click();
        // AlertDialog should appear
        await expect(page.locator('[role="alertdialog"]')).toBeVisible();
        // Dismiss by clicking Cancel
        await page.locator('[role="alertdialog"] button:has-text("Cancel")').click();
      }
    });

    test("revoke all sessions button exists and shows confirmation", async ({ page }) => {
      // Check if we have sessions
      const heading = page.locator("text=Web Sessions").first();
      const headingText = await heading.textContent();
      const match = headingText?.match(/\((\d+)\)/);
      const sessionCount = match ? parseInt(match[1]) : 0;

      // Look for "Revoke All Sessions" button
      const revokeAllBtn = page.locator("button").filter({ hasText: "Revoke All Sessions" });
      const isVisible = await revokeAllBtn.isVisible().catch(() => false);

      if (!isVisible || sessionCount === 0) {
        // No button or no sessions, skip
        return;
      }

      const isEnabled = await revokeAllBtn.isEnabled().catch(() => false);
      if (isEnabled) {
        await revokeAllBtn.click();
        // AlertDialog should appear
        await expect(page.locator('[role="alertdialog"]')).toBeVisible();
        // Dismiss by clicking Cancel
        await page.locator('[role="alertdialog"] button:has-text("Cancel")').click();
      }
    });

    test("can revoke individual session successfully", async ({ page }) => {
      // Wait for Web Sessions section to be fully loaded
      const heading = page.locator("text=Web Sessions").first();
      await heading.waitFor({ timeout: 15000 });

      // Get initial session count
      const initialText = await heading.textContent();
      const initialMatch = initialText?.match(/\((\d+)\)/);
      const initialCount = initialMatch ? parseInt(initialMatch[1]) : 0;

      if (initialCount === 0) {
        // No sessions to revoke
        return;
      }

      // Click first revoke button
      const revokeButton = page.locator("button").filter({ hasText: "Revoke" }).first();
      const isEnabled = await revokeButton.isEnabled().catch(() => false);

      if (!isEnabled) {
        // Button not enabled, skip
        return;
      }

      await revokeButton.click();
      // Confirm in AlertDialog
      await page.locator('[role="alertdialog"]').waitFor();
      await page.locator('[role="alertdialog"] button:has-text("Revoke")').click();

      // Wait for session count to decrease
      await expect(async () => {
        const updatedText = await heading.textContent();
        const updatedMatch = updatedText?.match(/\((\d+)\)/);
        const updatedCount = updatedMatch ? parseInt(updatedMatch[1]) : 0;
        expect(updatedCount).toBeLessThan(initialCount);
      }).toPass({ timeout: 10000 });
    });
  });

  test.describe("Step 5: OAuth Connections Section", () => {
    test("displays OAuth Connections section", async ({ page }) => {
      const heading = page.locator("text=OAuth Connections").first();
      await expect(heading).toBeVisible({ timeout: 5000 });
    });

    test("shows empty state when no OAuth connections", async ({ page }) => {
      const heading = page.locator("text=OAuth Connections").first();
      await heading.waitFor({ timeout: 5000 });
      const countText = await heading.textContent();

      // OAuth Connections heading exists
      expect(countText).toContain("OAuth Connections");

      // If count is (0), should show "No OAuth connections" message
      if (countText?.includes("(0)")) {
        const emptyMessage = page.locator("text=No OAuth connections");
        await expect(emptyMessage).toBeVisible();
      }
    });

    test("revoke all OAuth button exists", async ({ page }) => {
      // Ensure we're on the admin user detail page (not redirected to login)
      await expect(page.locator("text=OAuth Connections").first()).toBeVisible({ timeout: 10000 });

      // Look for "Revoke All OAuth" button in OAuth Connections section
      // Scroll to make sure the section is visible
      await page.locator("text=OAuth Connections").first().scrollIntoViewIfNeeded();

      const revokeAllBtn = page.locator("button", { hasText: "Revoke All OAuth" });

      // Button should exist (might be disabled if no connections)
      const count = await revokeAllBtn.count();
      expect(count).toBeGreaterThan(0);
    });

    test("revoke all OAuth shows confirmation dialog when connections exist", async ({ page }) => {
      const heading = page.locator("text=OAuth Connections").first();
      await heading.waitFor({ timeout: 5000 });
      const countText = await heading.textContent();
      const match = countText?.match(/\((\d+)\)/);
      const connectionCount = match ? parseInt(match[1]) : 0;

      if (connectionCount === 0) {
        // No connections, button should be disabled
        const revokeAllBtn = page.locator("button", { hasText: "Revoke All OAuth" });
        await expect(revokeAllBtn).toBeDisabled();
        return;
      }

      // Has connections, test confirmation dialog
      const revokeAllBtn = page.locator("button", { hasText: "Revoke All OAuth" });
      await revokeAllBtn.click();
      // AlertDialog should appear
      await expect(page.locator('[role="alertdialog"]')).toBeVisible();
      // Dismiss by clicking Cancel
      await page.locator('[role="alertdialog"] button:has-text("Cancel")').click();
    });
  });

  test.describe("Step 5: Integration - Sessions and OAuth Management", () => {
    test("both sections display correctly on page", async ({ page }) => {
      // Wait for page content to load
      await page.waitForLoadState("domcontentloaded");

      // Both sections should be visible
      await expect(page.locator("text=Web Sessions").first()).toBeVisible({ timeout: 10000 });
      await expect(page.locator("text=OAuth Connections").first()).toBeVisible({ timeout: 10000 });
    });

    test("sections are separated and distinct", async ({ page }) => {
      // Web Sessions section
      const sessionSection = page.locator("text=Web Sessions").first().locator("../..");
      await expect(sessionSection).toBeVisible();

      // OAuth Connections section
      const oauthSection = page.locator("text=OAuth Connections").first().locator("../..");
      await expect(oauthSection).toBeVisible();

      // Sections should be separate (different parent elements)
      const sessionBox = await sessionSection.boundingBox();
      const oauthBox = await oauthSection.boundingBox();

      expect(sessionBox).not.toBeNull();
      expect(oauthBox).not.toBeNull();

      // Sections should not overlap (different Y positions)
      if (sessionBox && oauthBox) {
        expect(Math.abs(sessionBox.y + sessionBox.height - oauthBox.y)).toBeGreaterThan(10);
      }
    });
  });
});
