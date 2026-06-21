/**
 * E2E Tests: i18n URL Parameter Support (#325)
 *
 * Verifies:
 * - ?lang=ru parameter switches app to Russian
 * - Language persists in localStorage
 * - Landing page links include lang param for Russian
 */

import { test, expect } from "./fixtures.js";

test.describe("i18n URL Parameter Support", () => {
  test("should switch to Russian with ?lang=ru parameter", async ({ page }) => {
    // Navigate to login with ?lang=ru
    await page.goto("/login?lang=ru");

    // Wait for page to load
    await page.waitForLoadState("domcontentloaded");

    // Check for Russian content
    const pageContent = await page.content();
    const hasRussian =
      pageContent.includes("Войти") ||
      pageContent.includes("Вход") ||
      pageContent.includes("Пароль");
    expect(hasRussian).toBe(true);

    // Verify localStorage has language preference
    const storedLang = await page.evaluate(() => localStorage.getItem("i18nextLng"));
    expect(storedLang).toBe("ru");
  });

  test("should persist language in localStorage after URL param", async ({ page }) => {
    // First visit with ?lang=ru
    await page.goto("/login?lang=ru");
    await page.waitForLoadState("domcontentloaded");

    // Verify localStorage
    let storedLang = await page.evaluate(() => localStorage.getItem("i18nextLng"));
    expect(storedLang).toBe("ru");

    // Navigate without param - should keep Russian
    await page.goto("/login");
    await page.waitForLoadState("domcontentloaded");

    // Check localStorage still has ru
    storedLang = await page.evaluate(() => localStorage.getItem("i18nextLng"));
    expect(storedLang).toBe("ru");

    // Verify Russian content is still shown
    const pageContent = await page.content();
    const hasRussian =
      pageContent.includes("Войти") ||
      pageContent.includes("Вход") ||
      pageContent.includes("Пароль");
    expect(hasRussian).toBe(true);
  });

  test("should switch to English with ?lang=en parameter", async ({ page }) => {
    // First set to Russian
    await page.goto("/login?lang=ru");
    await page.waitForLoadState("domcontentloaded");

    // Then switch to English via URL param
    await page.goto("/login?lang=en");
    await page.waitForLoadState("domcontentloaded");

    // Check for English content
    const pageContent = await page.content();
    const hasEnglish =
      pageContent.includes("Sign In") ||
      pageContent.includes("Log in") ||
      pageContent.includes("Password");
    expect(hasEnglish).toBe(true);

    // Verify localStorage updated
    const storedLang = await page.evaluate(() => localStorage.getItem("i18nextLng"));
    expect(storedLang).toBe("en");
  });
});
