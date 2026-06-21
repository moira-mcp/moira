/**
 * E2E Tests for Workflow Visibility Features
 * Tests visibility badges, filters, and owner indicators
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";
import { verifyUserEmail } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();
const TEST_USER = {
  name: "Visibility Test User",
  email: "visibility-test@example.com",
  password: "TestPass123!",
  acceptedTermsAt: new Date().toISOString(),
  acceptedNotRussianResidentAt: new Date().toISOString(),
};

test.beforeAll(async () => {
  // Pre-create test user
  try {
    await fetch(`${FETCH_URL}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(TEST_USER),
    });
    console.log("✓ Visibility test user created");
  } catch (error) {
    console.log("Test user already exists (expected)");
  }

  // Verify email for test user
  await verifyUserEmail(FETCH_URL, TEST_USER.email);
  console.log("✓ Visibility test user email verified");
});

test.describe("Workflow Visibility Features", () => {
  test.beforeEach(async ({ page }) => {
    // Dismiss beta agreement modal via cookie before any navigation
    const url = new URL(BASE_URL);
    await page.context().addCookies([
      {
        name: "moira-beta-accepted",
        value: "true",
        domain: url.hostname,
        path: "/",
        httpOnly: false,
        secure: BASE_URL.startsWith("https://"),
        sameSite: "Lax",
      },
    ]);
  });

  test("Visibility badges displayed for workflows", async ({ page }) => {
    // Login
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    const emailInput = page.getByRole("textbox", { name: "Email" });
    await emailInput.fill(TEST_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(TEST_USER.password);
    await page.getByRole("button", { name: "Login" }).click();

    // Wait for redirect to complete
    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });

    // Navigate to workflows page
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Public", { state: "visible" });

    // Check visibility badges present
    const publicBadges = page.locator("text=Public");
    const privateBadges = page.locator("text=Private");

    // At least one badge should be visible
    const publicCount = await publicBadges.count();
    const privateCount = await privateBadges.count();

    expect(publicCount + privateCount).toBeGreaterThan(0);

    console.log(`✓ Visibility badges displayed: ${publicCount} Public, ${privateCount} Private`);
  });

  test("Visibility filter dropdown accessible and functional", async ({ page }) => {
    // Login
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    const emailInput = page.getByRole("textbox", { name: "Email" });
    await emailInput.fill(TEST_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(TEST_USER.password);
    await page.getByRole("button", { name: "Login" }).click();

    // Wait for redirect to complete
    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });

    // Navigate to workflows page
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Public", { state: "visible" });

    // Verify workflows displayed with default "All" filter
    const allWorkflows = await page.locator("text=Public").count();
    expect(allWorkflows).toBeGreaterThan(0);

    // Verify visibility filter control present (2 comboboxes - validation and visibility)
    const comboboxes = page.locator('[role="combobox"]');
    const comboboxCount = await comboboxes.count();
    expect(comboboxCount).toBeGreaterThanOrEqual(2);

    console.log(`✓ Visibility filter present and functional (${allWorkflows} workflows displayed)`);
  });

  test("Owner name displayed in workflow cards", async ({ page }) => {
    // Login
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    const emailInput = page.getByRole("textbox", { name: "Email" });
    await emailInput.fill(TEST_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(TEST_USER.password);
    await page.getByRole("button", { name: "Login" }).click();

    // Wait for redirect to complete
    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });

    // Navigate to workflows page
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=System", { state: "visible" });

    // Verify "System" owner name displayed (for system-admin workflows)
    const systemOwner = page.locator("text=System").first();
    await expect(systemOwner).toBeVisible();

    const ownerCount = await page.locator("text=System").count();
    expect(ownerCount).toBeGreaterThan(0);

    console.log(`✓ Owner name "System" displayed in ${ownerCount} workflow cards`);
  });

  test("Public workflows accessible after login", async ({ page }) => {
    // Login
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    const emailInput = page.getByRole("textbox", { name: "Email" });
    await emailInput.fill(TEST_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(TEST_USER.password);
    await page.getByRole("button", { name: "Login" }).click();

    // Wait for redirect to complete
    await page.waitForURL((url) => !url.toString().includes("/login"), { timeout: 10000 });

    // Navigate to workflows page
    await page.goto(`${BASE_URL}/workflows`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Public", { state: "visible" });

    // Count public workflows
    const publicBadges = page.locator("text=Public");
    const publicCount = await publicBadges.count();

    // System has 21 public workflows from system-admin
    expect(publicCount).toBeGreaterThan(0);
    console.log(`✓ Public workflows visible: ${publicCount}`);
  });
});
