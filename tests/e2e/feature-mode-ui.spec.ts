/**
 * Feature-mode UI gating E2E.
 *
 * The frontend reads GET /api/features and hides SaaS-specific UI in self-host:
 * registration legal-consent checkboxes and the beta modal/banner. Self-host
 * retains the narrow Users approval surface while hiding broader multi-user
 * administration; SaaS shows both. These tests mock /api/features to assert the
 * frontend reacts to each mode without rebuilding the container.
 *
 * Note: the registration form is rendered by the Better Auth UI library, which
 * renders boolean consent fields as `button[role="checkbox"]` (not plain
 * inputs), so consent presence is asserted via the checkbox role and label text.
 * Navigation uses waitUntil:"commit" + an explicit wait for the email field
 * because the auth UI keeps a long-lived connection that defers "domcontentloaded".
 */

import { test, expect, type Page } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

const ALL_FLAGS = [
  "openRegistration",
  "accountApproval",
  "emailVerificationGate",
  "verificationEmailOnSignup",
  "legalConsents",
  "betaNotices",
  "multiUserAdmin",
  "userManagement",
  "socialLogin",
] as const;

function featuresPayload(mode: "self-host" | "saas") {
  const selfHost = mode === "self-host";
  const features = Object.fromEntries(
    ALL_FLAGS.map((feature) => [
      feature,
      feature === "openRegistration" || feature === "userManagement"
        ? true
        : feature === "accountApproval"
          ? selfHost
          : !selfHost,
    ]),
  );
  return {
    success: true,
    data: { deploymentMode: mode, features },
    timestamp: new Date().toISOString(),
  };
}

/** Force GET /api/features to report the given mode for this page. */
async function mockFeatures(
  page: Page,
  mode: "self-host" | "saas",
  overrides: Record<string, boolean> = {},
) {
  await page.route("**/api/features", async (route) => {
    const payload = featuresPayload(mode);
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...payload,
        data: { ...payload.data, features: { ...payload.data.features, ...overrides } },
      }),
    });
  });
}

/** Open the registration page and wait for the auth form to render. */
async function gotoRegister(page: Page) {
  await page.goto(`${BASE_URL}/register`, { waitUntil: "commit" });
  await page.waitForSelector('input[name="email"]', { timeout: 30000 });
}

test.describe("Feature-mode UI gating", () => {
  test("self-host: registration hides legal-consent checkboxes", async ({ page }) => {
    await mockFeatures(page, "self-host");
    await gotoRegister(page);
    // Email + password render, but no consent checkboxes and no terms text.
    await expect(page.locator('input[name="password"]')).toBeVisible();
    await expect(page.locator('[role="checkbox"]')).toHaveCount(0);
    await expect(page.locator("text=/Terms of Service/i")).toHaveCount(0);
  });

  test("saas: registration shows legal-consent checkboxes", async ({ page }) => {
    await mockFeatures(page, "saas");
    await gotoRegister(page);
    // Two consent checkboxes (terms + residency) and the terms label render.
    await expect(page.locator('[role="checkbox"]')).toHaveCount(2);
    await expect(page.locator("text=/Terms of Service/i")).toBeVisible();
  });

  test("self-host: admin nav exposes Users but hides broader multi-user pages", async ({
    page,
  }) => {
    await mockFeatures(page, "self-host");
    await loginAsAdmin(page, false);
    await page.goto(`${BASE_URL}/admin`, { waitUntil: "commit" });
    // Scope to sidebar nav links (data-sidebar="menu-button") — the admin
    // dashboard also renders Quick Links cards pointing at the same hrefs.
    const sidebarLink = (href: string) =>
      page.locator(`a[data-sidebar="menu-button"][href="${href}"]`);
    await expect(sidebarLink("/admin/settings")).toBeVisible({ timeout: 30000 });
    // The narrow user-management capability remains available for approvals.
    await expect(sidebarLink("/admin/users")).toBeVisible();
    // Broader multi-user operations remain hidden from the sidebar.
    await expect(sidebarLink("/admin/executions")).toHaveCount(0);
    await expect(sidebarLink("/admin/workflows")).toHaveCount(0);
    await expect(sidebarLink("/admin/artifacts")).toHaveCount(0);

    const dashboardLink = (href: string) =>
      page.locator(`a[href="${href}"]:not([data-sidebar="menu-button"])`);
    await expect(dashboardLink("/admin/users")).toBeVisible();
    await expect(dashboardLink("/admin/executions")).toHaveCount(0);

    await page.unroute("**/api/features");
    await mockFeatures(page, "self-host", { userManagement: false });
    await page.goto(`${BASE_URL}/admin/users`, { waitUntil: "commit" });
    await page.waitForURL(`${BASE_URL}/admin`, { timeout: 30000 });
    await expect(page).toHaveURL(`${BASE_URL}/admin`);
  });

  test("saas: admin nav shows multi-user pages", async ({ page }) => {
    await mockFeatures(page, "saas");
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/admin`, { waitUntil: "commit" });
    const sidebarLink = (href: string) =>
      page.locator(`a[data-sidebar="menu-button"][href="${href}"]`);
    await expect(sidebarLink("/admin/users")).toBeVisible({ timeout: 30000 });
    await expect(sidebarLink("/admin/executions")).toBeVisible();
  });

  test("self-host: direct nav to a broader multi-user admin page redirects to dashboard", async ({
    page,
  }) => {
    await mockFeatures(page, "self-host");
    await loginAsAdmin(page, false);
    await page.goto(`${BASE_URL}/admin/executions`, { waitUntil: "commit" });
    // Multi-user gating redirects back to the admin dashboard.
    await page.waitForURL(`${BASE_URL}/admin`, { timeout: 30000 });
    await expect(page).toHaveURL(`${BASE_URL}/admin`);
  });

  test("self-host: beta modal does not appear after login", async ({ page }) => {
    await mockFeatures(page, "self-host");
    await loginAsAdmin(page, false);
    await page.goto(`${BASE_URL}/`, { waitUntil: "commit" });
    // Wait for the app shell to render before asserting modal absence.
    await page.waitForSelector('a[href="/workflows"], a[href="/"]', { timeout: 30000 });
    // The beta agreement modal (accept button) must not be present.
    await expect(
      page.locator(
        'button:has-text("Accept and Continue"), button:has-text("Принять и продолжить")',
      ),
    ).toHaveCount(0);
  });
});
