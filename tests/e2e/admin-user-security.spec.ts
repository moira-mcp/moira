/**
 * Admin User Security E2E Tests
 * Tests admin security actions in AdminUserDetail page
 */

import { test, expect, type Page } from "./fixtures.js";
import { loginAsAdmin, createTestUser, getSessionCookieHeader } from "./helpers/auth-helper.js";
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
      // Initial state - the flag was cleared in beforeEach, so the badge is absent
      const badge = page.locator("text=Password Reset Required").first();
      await expect(badge).not.toBeVisible();

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
      // Create multiple sessions for target user (each sign-in opens a new web session)
      await getSessionCookieHeader(targetEmail, targetPassword);
      await getSessionCookieHeader(targetEmail, targetPassword);

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

      // beforeEach cleared the password-reset flag: no badge, force reset available
      await expect(page.locator("text=Password Reset Required")).toHaveCount(0);
      await expect(forceResetBtn).toBeEnabled();

      // The target user never authorized an OAuth client: zero tokens, revoke disabled
      await expect(page.locator("text=OAuth Tokens").first().locator("..")).toContainText("0");
      await expect(revokeTokensBtn).toBeDisabled();
    });
  });

  test.describe("Step 5: Web Sessions Section", () => {
    // The Web Sessions heading reads "Web Sessions (N)"; N is the session count.
    const sessionCountOf = async (page: Page): Promise<number> => {
      const headingText = await page.locator("text=Web Sessions").first().textContent();
      const match = headingText?.match(/\((\d+)\)/);
      if (!match) throw new Error(`Web Sessions heading has no count: ${headingText}`);
      return parseInt(match[1]);
    };

    test.beforeEach(async ({ page }) => {
      // Create at least one session for target user (a sign-in opens a new web session)
      await getSessionCookieHeader(targetEmail, targetPassword);

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
      // At least the session created in beforeEach is counted in the heading
      expect(await sessionCountOf(page)).toBeGreaterThan(0);
    });

    test("revoke individual session shows confirmation dialog", async ({ page }) => {
      expect(await sessionCountOf(page)).toBeGreaterThan(0);

      // The per-session button is the only one named exactly "Revoke"
      await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
      // AlertDialog should appear
      await expect(page.locator('[role="alertdialog"]')).toBeVisible();
      // Dismiss by clicking Cancel
      await page.locator('[role="alertdialog"] button:has-text("Cancel")').click();
      await expect(page.locator('[role="alertdialog"]')).not.toBeVisible();
    });

    test("revoke all sessions button exists and shows confirmation", async ({ page }) => {
      expect(await sessionCountOf(page)).toBeGreaterThan(0);

      // With sessions present the "Revoke All Sessions" button is rendered and enabled
      const revokeAllBtn = page.getByRole("button", { name: "Revoke All Sessions", exact: true });
      await expect(revokeAllBtn.first()).toBeEnabled();
      await revokeAllBtn.first().click();
      // AlertDialog should appear
      await expect(page.locator('[role="alertdialog"]')).toBeVisible();
      // Dismiss by clicking Cancel
      await page.locator('[role="alertdialog"] button:has-text("Cancel")').click();
      await expect(page.locator('[role="alertdialog"]')).not.toBeVisible();
    });

    test("can revoke individual session successfully", async ({ page }) => {
      const initialCount = await sessionCountOf(page);
      expect(initialCount).toBeGreaterThan(0);

      // Revoke the first session and confirm in the AlertDialog
      await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
      await page.locator('[role="alertdialog"]').waitFor();
      await page.locator('[role="alertdialog"] button:has-text("Revoke")').click();

      // Wait for session count to decrease
      await expect.poll(() => sessionCountOf(page), { timeout: 10000 }).toBeLessThan(initialCount);
    });
  });

  test.describe("Step 5: OAuth Connections Section", () => {
    test("displays OAuth Connections section", async ({ page }) => {
      const heading = page.locator("text=OAuth Connections").first();
      await expect(heading).toBeVisible({ timeout: 5000 });
    });

    test("shows empty state when no OAuth connections", async ({ page }) => {
      // The target user never authorized an OAuth client: zero count and the empty message
      const heading = page.locator("text=OAuth Connections").first();
      await expect(heading).toContainText("OAuth Connections (0)");
      await expect(page.locator("text=No OAuth connections")).toBeVisible();
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

    test("revoke all OAuth is disabled without connections", async ({ page }) => {
      await expect(page.locator("text=OAuth Connections").first()).toContainText("(0)");

      // Without connections the section renders no "Revoke All OAuth" button and the
      // Security Actions "Revoke All OAuth Tokens" button is disabled
      await expect(page.getByRole("button", { name: "Revoke All OAuth", exact: true })).toHaveCount(
        0,
      );
      await expect(page.locator("button", { hasText: "Revoke All OAuth Tokens" })).toBeDisabled();
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
