/**
 * Auth UX Quality Tests
 *
 * These tests verify UX quality issues that were found during manual testing:
 * 1. After login the user lands in the Web UI at the root (/)
 * 2. Error block width matches form width
 * 3. Form doesn't re-render when error clears (no lost keystrokes)
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl, getTestFetchUrl } from "../utils/test-config.js";
import { verifyUserEmail } from "../utils/mcp-auth.js";
import { fillConsentCheckboxes } from "./helpers/consent-helper.js";

const BASE_URL = getTestBaseUrl();
const FETCH_URL = getTestFetchUrl();

test.describe("Auth UX Quality", () => {
  test("Login redirects to the Web UI at root", async ({ page }) => {
    const testEmail = `verify-redirect-${Date.now()}@example.com`;
    const testPassword = "TestPass123!";

    // Register user (Name field removed for GDPR data minimization)
    await page.goto(`${BASE_URL}/register`);
    await page.waitForLoadState("domcontentloaded");

    await page.getByRole("textbox", { name: "Email" }).fill(testEmail);
    await page.getByRole("textbox", { name: "Password" }).fill(testPassword);

    // Fill consent checkboxes (GDPR requirement)
    await fillConsentCheckboxes(page);

    await page.getByRole("button", { name: "Create an account" }).click();

    await page.waitForURL(`${BASE_URL}/registration-success`, { timeout: 10000 });

    // Verify email via API
    await verifyUserEmail(FETCH_URL, testEmail);

    // Now login and check redirect
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    // Wait for form to be fully hydrated before interacting
    const emailInput = page.getByRole("textbox", { name: "Email" });
    const passwordInput = page.getByRole("textbox", { name: "Password" });
    await expect(emailInput).toBeEditable({ timeout: 10000 });
    await expect(passwordInput).toBeEditable({ timeout: 10000 });

    await emailInput.fill(testEmail);
    await passwordInput.fill(testPassword);
    await page.getByRole("button", { name: "Login" }).click();

    // After login the user must land in the Web UI at the root (/)
    await page.waitForURL(
      (url) => {
        const path = new URL(url).pathname;
        return path === "/";
      },
      { timeout: 10000 },
    );

    // Verify we're in the Web UI at root: the app dashboard, not the landing page. A fresh
    // user must accept the beta agreement modal first; while it is open the page behind it
    // is hidden from the accessibility tree.
    const currentPath = new URL(page.url()).pathname;
    expect(currentPath).toBe("/");
    await page.getByRole("button", { name: "Accept and Continue" }).click();
    await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible({
      timeout: 10000,
    });
  });

  test("Login error block has same width as form card", async ({ page }) => {
    // Navigate to login
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    // Get the auth card (Better Auth UI card containing the form)
    // The card has rounded-xl border and contains the Sign In form
    const authCard = page
      .locator('[class*="rounded-xl"][class*="border"]')
      .filter({ has: page.locator("form") });
    await expect(authCard).toBeVisible();
    const cardBox = await authCard.boundingBox();
    expect(cardBox).toBeTruthy();

    // Trigger error with wrong password
    await page.getByRole("textbox", { name: "Email" }).fill("nonexistent@example.com");
    await page.getByRole("textbox", { name: "Password" }).fill("wrongpassword");
    await page.getByRole("button", { name: "Login" }).click();

    // Wait for error to appear
    const errorBlock = page.getByTestId("auth-error");
    await expect(errorBlock).toBeVisible({ timeout: 5000 });

    // Get error block width
    const errorBox = await errorBlock.boundingBox();
    expect(errorBox).toBeTruthy();

    // Error width should match card width (within 10px tolerance)
    const widthDiff = Math.abs(cardBox!.width - errorBox!.width);
    expect(widthDiff).toBeLessThan(10);
  });

  test("Form input not lost when error clears on typing", async ({ page }) => {
    // Navigate to login
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    // Trigger error
    await page.getByRole("textbox", { name: "Email" }).fill("test@example.com");
    const passwordInput = page.getByRole("textbox", { name: "Password" });
    await passwordInput.fill("wrong");
    await page.getByRole("button", { name: "Login" }).click();

    // Wait for error
    const errorBlock = page.getByTestId("auth-error");
    await expect(errorBlock).toBeVisible({ timeout: 5000 });

    // Clear password and type new one character by character
    await passwordInput.clear();

    // Type slowly to catch re-render issues
    const testString = "abc123";
    for (const char of testString) {
      await passwordInput.press(char);
      await page.waitForTimeout(50); // Small delay between keystrokes
    }

    // CRITICAL: All characters must be in the input
    // If form re-renders on error clear, first character would be lost
    const inputValue = await passwordInput.inputValue();
    expect(inputValue).toBe(testString);

    // Error should be cleared after typing
    await expect(errorBlock).not.toBeVisible({ timeout: 2000 });
  });
});
