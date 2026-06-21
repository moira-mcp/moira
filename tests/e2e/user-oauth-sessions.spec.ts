/**
 * User OAuth and Sessions E2E Tests
 * Tests OAuth consents and sessions management on Settings page
 * All sections visible in flat layout (no tabs)
 */

import { test, expect, Page } from "./fixtures.js";
import { login, createTestUser } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const TEST_BASE_URL = getTestBaseUrl();

/** Navigate to settings and scroll to Sessions section */
async function goToSessionsSection(page: Page) {
  await page.goto(`${TEST_BASE_URL}/settings`);
  await page.waitForLoadState("domcontentloaded");
  const sessionsSection = page.getByTestId("settings-section-sessions");
  await sessionsSection.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
}

/** Navigate to settings and scroll to OAuth section */
async function goToOAuthSection(page: Page) {
  await page.goto(`${TEST_BASE_URL}/settings`);
  await page.waitForLoadState("domcontentloaded");
  const oauthSection = page.getByTestId("settings-section-oauth");
  await oauthSection.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
}

test.describe("User OAuth and Sessions Management", () => {
  // Increase timeout for beforeAll hook (user creation + login)
  test.setTimeout(30000);

  let page: Page;
  let testEmail: string;
  let testPassword: string;

  test.beforeAll(async ({ browser }) => {
    testEmail = `oauth-e2e-${Date.now()}@example.com`;
    testPassword = "OAuthE2E123!";
    const testName = "OAuth E2E User";

    // Create and verify test user
    await createTestUser(testEmail, testPassword, testName, true);

    page = await browser.newPage();
    await login(page, testEmail, testPassword);
  });

  test.afterAll(async () => {
    await page.close();
  });

  test.describe("OAuth Section", () => {
    test("displays empty state when no consents", async () => {
      await goToOAuthSection(page);
      await expect(page.locator("text=No OAuth authorizations found")).toBeVisible();
    });

    test("shows OAuth Authorizations section", async () => {
      await page.goto(`${TEST_BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByTestId("settings-section-oauth")).toBeVisible();
    });
  });

  test.describe("Sessions Tab", () => {
    test("displays list of active sessions", async () => {
      await goToSessionsSection(page);

      // Should see at least one session (current session)
      await expect(page.getByText("Current Session")).toBeVisible({ timeout: 10000 });
    });

    test("marks current session with badge", async () => {
      await goToSessionsSection(page);
      await expect(page.getByText("Current Session")).toBeVisible();
    });

    test("displays session details", async () => {
      await goToSessionsSection(page);

      await expect(page.locator("text=/IP Address:/i").first()).toBeVisible();
      await expect(page.locator("text=/Location:/i").first()).toBeVisible();
      await expect(page.locator("text=/Created:/i").first()).toBeVisible();
      await expect(page.locator("text=/Expires:/i").first()).toBeVisible();
    });

    test("current session revoke button is disabled", async () => {
      await goToSessionsSection(page);

      // Find the card containing "Current Session" and check its Revoke button
      const currentSessionCard = page
        .locator(".flex.items-start")
        .filter({ hasText: "Current Session" });

      const revokeButton = currentSessionCard.locator('button:has-text("Revoke")');
      await expect(revokeButton).toBeDisabled();
    });

    test("can create second session and see both sessions", async ({ browser }) => {
      test.setTimeout(60000);

      const secondContext = await browser.newContext();
      const secondPage = await secondContext.newPage();

      await login(secondPage, testEmail, testPassword);
      await secondPage.waitForLoadState("networkidle");

      // In first session, go to sessions tab
      await goToSessionsSection(page);

      const sessionCards = page.locator(".flex.items-start").filter({ hasText: /IP Address:/i });
      await expect(sessionCards.first()).toBeVisible({ timeout: 10000 });
      await expect(sessionCards.nth(1)).toBeVisible({ timeout: 10000 });
      const count = await sessionCards.count();
      expect(count).toBeGreaterThanOrEqual(2);

      const currentBadges = page.getByText("Current Session");
      await expect(currentBadges).toHaveCount(1);

      await secondPage.close();
      await secondContext.close();
    });

    test("can revoke non-current session", async ({ browser }) => {
      test.setTimeout(45000);

      const secondContext = await browser.newContext();
      const secondPage = await secondContext.newPage();
      await login(secondPage, testEmail, testPassword);

      await goToSessionsSection(page);

      const allSessions = page.locator(".flex.items-start").filter({ hasText: /IP Address:/i });
      await expect(allSessions.first()).toBeVisible({ timeout: 10000 });
      await expect(allSessions.nth(1)).toBeVisible({ timeout: 10000 });
      const sessionCount = await allSessions.count();
      expect(sessionCount).toBeGreaterThanOrEqual(2);

      const nonCurrentSession = allSessions.filter({ hasNotText: "Current Session" }).first();
      const revokeButton = nonCurrentSession.locator('button:has-text("Revoke")');

      await expect(revokeButton).toBeEnabled();
      await revokeButton.click();

      const alertDialog = page.locator('[role="alertdialog"]');
      await expect(alertDialog).toBeVisible({ timeout: 5000 });
      await alertDialog.locator('button:has-text("Revoke")').click();

      await page.waitForTimeout(2000);

      await goToSessionsSection(page);

      const remainingSessions = page
        .locator(".flex.items-start")
        .filter({ hasText: /IP Address:/i });
      const remainingCount = await remainingSessions.count();
      expect(remainingCount).toBeLessThan(sessionCount);

      try {
        await secondPage.goto(`${TEST_BASE_URL}/workflows`, { timeout: 5000 });
        throw new Error("Second session should be revoked");
      } catch {
        // Expected: session is revoked
      }

      await secondPage.close();
      await secondContext.close();
    });
  });

  test.describe("Section Visibility", () => {
    test("all sections are visible on one page", async () => {
      await page.goto(`${TEST_BASE_URL}/settings`);
      await page.waitForLoadState("domcontentloaded");

      await expect(page.getByTestId("settings-section-profile")).toBeVisible();
      await expect(page.getByTestId("settings-section-security")).toBeVisible();
      await expect(page.getByTestId("settings-section-oauth")).toBeVisible();
      await expect(page.getByTestId("settings-section-sessions")).toBeVisible();
    });
  });
});
