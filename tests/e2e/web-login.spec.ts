import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";
import { verifyUserEmail } from "../utils/mcp-auth.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();
const TEST_USER = {
  name: "Web Login Test",
  email: "web-login-test@example.com",
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
    console.log("✓ Test user created");
  } catch (error) {
    console.log("Test user already exists (expected)");
  }

  // Verify email for test user
  await verifyUserEmail(FETCH_URL, TEST_USER.email);
  console.log("✓ Test user email verified");
});

test.describe("Web Interface Login Flow", () => {
  test("Complete login flow via web interface", async ({ page }) => {
    // Navigate to login page
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    // Verify Better Auth UI loaded
    const emailInput = page.getByRole("textbox", { name: "Email" });
    await expect(emailInput).toBeVisible();

    // Fill login form
    await emailInput.fill(TEST_USER.email);
    await page.getByRole("textbox", { name: "Password" }).fill(TEST_USER.password);

    // Submit login
    await page.getByRole("button", { name: "Login" }).click();

    // Wait for redirect to main app
    await page.waitForURL(
      (url) => !url.toString().includes("/login") && !url.toString().includes("/register"),
      { timeout: 10000 },
    );

    // Close beta modal if present and wait for it to fully disappear
    await page.waitForLoadState("domcontentloaded");
    const modal = page.locator('div[role="dialog"]');
    const modalCount = await modal.count();
    if (modalCount > 0) {
      await page.click('button:has-text("Accept and Continue")');
      // Wait for modal to be completely removed from DOM (not just hidden)
      await page.waitForSelector('div[role="dialog"]', { state: "detached" });
      await page.waitForLoadState("domcontentloaded");
    }

    // Verify redirected to main app
    expect(page.url()).not.toContain("/login");
    expect(page.url()).not.toContain("/register");

    // Verify session cookie created
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((c) => c.name.includes("better-auth"));
    expect(sessionCookie).toBeDefined();

    // Verify user email displayed in sidebar
    const userEmail = page.locator(`text=${TEST_USER.email}`);
    await expect(userEmail).toBeVisible({ timeout: 5000 });

    // Verify UserMenu button is visible
    const userButton = page.locator(`button:has-text("${TEST_USER.email}")`).first();
    await expect(userButton).toBeVisible();

    console.log("✓ Web login flow completed successfully");
  });
});
