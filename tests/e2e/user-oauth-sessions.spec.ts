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
      await expect(page.getByText("No OAuth authorizations found", { exact: true })).toBeVisible();
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
      await expect(page.locator("text=/Created:/i").first()).toBeVisible();
      await expect(page.locator("text=/Expires:/i").first()).toBeVisible();
      // No country is known for these sessions: the row leaves it out rather than printing a filler.
      await expect(page.getByTestId("settings-section-sessions")).not.toContainText("Unknown");
      // The device is named by browser and system, not by the raw User-Agent header.
      const device = page
        .locator('[data-testid^="session-row-"][data-current="true"]')
        .getByTestId("session-device");
      // This session signed in through the API client, whose header is the bare product token.
      const rawHeader = await device.getAttribute("data-hint");
      expect(rawHeader).toBeTruthy();
      await expect(device).toHaveText(/ client$| on /);
      await expect(device).not.toHaveText(rawHeader!);
    });

    test("current session revoke button is disabled", async () => {
      await goToSessionsSection(page);

      // Find the card containing "Current Session" and check its Revoke button
      const currentSessionCard = page.locator('[data-testid^="session-row-"][data-current="true"]');

      const revokeButton = currentSessionCard.getByRole("button", { name: "Revoke" });
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

      const sessionCards = page.locator('[data-testid^="session-row-"]');
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

      const allSessions = page.locator('[data-testid^="session-row-"]');
      await expect(allSessions.first()).toBeVisible({ timeout: 10000 });
      await expect(allSessions.nth(1)).toBeVisible({ timeout: 10000 });
      const sessionCount = await allSessions.count();
      expect(sessionCount).toBeGreaterThanOrEqual(2);

      const nonCurrentSession = page
        .locator('[data-testid^="session-row-"]:not([data-current="true"])')
        .first();
      const revokeButton = nonCurrentSession.getByRole("button", { name: "Revoke" });

      await expect(revokeButton).toBeEnabled();
      await revokeButton.click();

      const alertDialog = page.locator('[role="alertdialog"]');
      await expect(alertDialog).toBeVisible({ timeout: 5000 });
      await alertDialog.locator('button:has-text("Revoke")').click();
      await expect(page.getByText("The session was signed out")).toBeVisible();

      await goToSessionsSection(page);

      const remainingSessions = page.locator('[data-testid^="session-row-"]');
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

  test.describe("Unknown session details", () => {
    test("a Russian reader sees what is known and no English placeholder for what is not", async () => {
      const now = Date.now();
      const session = (id: string, fields: Record<string, unknown>) => ({
        id,
        createdAt: new Date(now - 3_600_000).toISOString(),
        expiresAt: new Date(now + 86_400_000).toISOString(),
        isCurrent: false,
        ...fields,
      });
      // The server reports what it does not know as null.
      await page.route("**/api/user/sessions*", (route) =>
        route.fulfill({
          json: {
            success: true,
            data: [
              session("unknown-everything", { ipAddress: null, userAgent: null, country: null }),
              session("located", {
                ipAddress: "203.0.113.7",
                userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0",
                country: "DE",
              }),
            ],
            total: 2,
            limit: 8,
            offset: 0,
            timestamp: new Date(now).toISOString(),
          },
        }),
      );
      try {
        await page.goto(`${TEST_BASE_URL}/settings?lang=ru`);
        const sessions = page.getByTestId("settings-section-sessions");
        const unknown = sessions.getByTestId("session-row-unknown-everything");
        const located = sessions.getByTestId("session-row-located");
        await expect(unknown).toBeVisible();

        await expect(unknown.getByTestId("session-device")).toHaveText("Неизвестное устройство");
        await expect(unknown.getByTestId("session-location")).toHaveCount(0);
        await expect(unknown.getByTestId("session-ip")).toHaveCount(0);
        await expect(located.getByTestId("session-location")).toHaveText("Местоположение: DE");
        await expect(located.getByTestId("session-ip")).toHaveText("IP адрес: 203.0.113.7");
        await expect(sessions).not.toContainText("Unknown");
      } finally {
        await page.unroute("**/api/user/sessions*");
        // The language choice is remembered; restore English for the other tests on this page.
        await page.goto(`${TEST_BASE_URL}/settings?lang=en`);
      }
    });
  });

  test.describe("Paging inside the cards", () => {
    const TOTAL = 20;
    const now = Date.now();
    const lists: ReadonlyArray<{
      name: string;
      route: string;
      pager: string;
      row: (id: string) => string;
      item: (id: string) => Record<string, unknown>;
    }> = [
      {
        name: "sessions",
        route: "**/api/user/sessions*",
        pager: "sessions-pager",
        row: (id: string) => `session-row-${id}`,
        item: (id: string) => ({
          id,
          ipAddress: "203.0.113.7",
          userAgent: "node",
          country: null,
          createdAt: new Date(now - 3_600_000).toISOString(),
          expiresAt: new Date(now + 86_400_000).toISOString(),
          isCurrent: false,
        }),
      },
      {
        name: "connected apps",
        route: "**/api/user/oauth-consents*",
        pager: "oauth-pager",
        row: (id: string) => `oauth-consent-${id}`,
        item: (id: string) => ({
          id,
          clientId: `client-${id}`,
          clientName: `App ${id}`,
          clientIcon: null,
          scopes: ["openid"],
          createdAt: new Date(now - 3_600_000).toISOString(),
        }),
      },
    ];

    for (const list of lists) {
      test(`the ${list.name} list pages with the shared pager, in its card rather than stuck to the page`, async () => {
        // A server page of the requested window over TOTAL items named item-1…item-20.
        await page.route(list.route, (route) => {
          const url = new URL(route.request().url());
          const limit = Number(url.searchParams.get("limit") ?? 8);
          const offset = Number(url.searchParams.get("offset") ?? 0);
          const ids = Array.from({ length: TOTAL }, (_, index) => `item-${index + 1}`);
          return route.fulfill({
            json: {
              success: true,
              data: ids.slice(offset, offset + limit).map((id) => list.item(id)),
              total: TOTAL,
              limit,
              offset,
              timestamp: new Date(now).toISOString(),
            },
          });
        });
        try {
          await page.goto(`${TEST_BASE_URL}/settings?lang=en`);
          const pager = page.getByTestId(list.pager);
          await pager.scrollIntoViewIfNeeded();
          await expect(pager).toContainText("Showing 1-8 of 20");
          await expect(page.getByTestId(list.row("item-1"))).toBeVisible();
          // The embedded variant: part of the card's flow, not the sticky footer of a full-page list.
          expect(await pager.evaluate((element) => getComputedStyle(element).position)).toBe(
            "static",
          );

          await pager.getByTestId("pagination-next").click();
          await expect(pager).toContainText("Showing 9-16 of 20");
          await expect(page.getByTestId(list.row("item-9"))).toBeVisible();
          await expect(page.getByTestId(list.row("item-1"))).toHaveCount(0);

          await pager.getByTestId("pagination-last").click();
          await expect(pager).toContainText("Showing 17-20 of 20");
          await expect(page.getByTestId(list.row("item-20"))).toBeVisible();
          await expect(pager.getByTestId("pagination-next")).toBeDisabled();

          await pager.getByTestId("pagination-first").click();
          await expect(pager).toContainText("Showing 1-8 of 20");
        } finally {
          await page.unroute(list.route);
        }
      });
    }
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
