/**
 * E2E Test: Theme Loading State Consistency
 *
 * Tests that auth pages don't show hardcoded white/black backgrounds
 * during loading state transitions. The loading div should use CSS
 * variables to match the current theme.
 *
 * Related issue: #250
 */

import { test, expect } from "./fixtures.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

test.describe("Theme Loading State", () => {
  test("Loading div uses theme-aware background on login page", async ({ page }) => {
    await page.goto(`${BASE_URL}/login`);

    // Wait for the page to fully load
    await page.waitForLoadState("domcontentloaded");

    // The page should have bg-background class somewhere in the DOM
    // This verifies the loading state uses theme CSS variables
    const bgBackgroundElements = await page.locator(".bg-background").count();
    expect(bgBackgroundElements).toBeGreaterThan(0);

    // Verify no hardcoded white background on the main container
    const mainDiv = page.locator("body > div").first();
    const bgColor = await mainDiv.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    // In dark mode, background should NOT be pure white (rgb(255, 255, 255))
    // In light mode, background should NOT be pure black (rgb(0, 0, 0))
    // Both themes use CSS variables that resolve to theme colors
    expect(bgColor).not.toBe("rgb(255, 255, 255)");
    expect(bgColor).not.toBe("rgb(0, 0, 0)");
  });

  test("Loading div uses theme-aware background on register page", async ({ page }) => {
    await page.goto(`${BASE_URL}/register`);

    // Wait for the page to fully load
    await page.waitForLoadState("domcontentloaded");

    // The page should have bg-background class
    const bgBackgroundElements = await page.locator(".bg-background").count();
    expect(bgBackgroundElements).toBeGreaterThan(0);

    // Verify consistent background styling
    const mainDiv = page.locator("body > div").first();
    const bgColor = await mainDiv.evaluate((el) => {
      return window.getComputedStyle(el).backgroundColor;
    });

    expect(bgColor).not.toBe("rgb(255, 255, 255)");
    expect(bgColor).not.toBe("rgb(0, 0, 0)");
  });

  test("No visible background flash during navigation between auth pages", async ({ page }) => {
    // Navigate to login
    await page.goto(`${BASE_URL}/login`);
    await page.waitForLoadState("domcontentloaded");

    // Get initial background color
    const loginBgColor = await page.evaluate(() => {
      const el = document.querySelector(".bg-background");
      return el ? window.getComputedStyle(el).backgroundColor : null;
    });

    expect(loginBgColor).not.toBeNull();

    // Navigate to register
    const registerLink = page.getByRole("link", { name: /sign up|register/i });
    if ((await registerLink.count()) > 0) {
      await registerLink.click();
      await page.waitForLoadState("domcontentloaded");

      // Get register page background color
      const registerBgColor = await page.evaluate(() => {
        const el = document.querySelector(".bg-background");
        return el ? window.getComputedStyle(el).backgroundColor : null;
      });

      // Both pages should have the same background color (theme consistent)
      expect(registerBgColor).toBe(loginBgColor);
    }
  });
});
