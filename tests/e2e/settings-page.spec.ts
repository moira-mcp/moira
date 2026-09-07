/**
 * Settings Page E2E Tests
 * Validates settings page with flat layout:
 * Profile, Security, Notifications, OAuth, Sessions — all on one page
 */

import { test, expect } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";
const BASE_URL = getTestBaseUrl();

test.describe("Settings Page — Flat Layout", () => {
  test("settings page loads with all sections visible", async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector('h1:has-text("Settings")');

    const layout = page.getByTestId("settings-flat-layout");
    await expect(layout).toBeVisible();

    // All sections visible on one page
    await expect(page.getByTestId("settings-section-profile")).toBeVisible();
    await expect(page.getByTestId("settings-section-security")).toBeVisible();
    await expect(page.getByTestId("settings-section-oauth")).toBeVisible();
    await expect(page.getByTestId("settings-section-sessions")).toBeVisible();
  });

  test("all sections are scrollable on one page", async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector('h1:has-text("Settings")');

    // Scroll to bottom sections
    const sessionsSection = page.getByTestId("settings-section-sessions");
    await sessionsSection.scrollIntoViewIfNeeded();
    await expect(sessionsSection).toBeVisible();

    // Scroll back to profile
    const profileSection = page.getByTestId("settings-section-profile");
    await profileSection.scrollIntoViewIfNeeded();
    await expect(profileSection).toBeVisible();
  });

  test("notification settings render inside the Telegram channel card", async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector('h1:has-text("Settings")');

    const dynamicSection = page.getByTestId("settings-section-dynamic");
    await expect(dynamicSection).toBeVisible({ timeout: 5000 });
    await dynamicSection.scrollIntoViewIfNeeded();
    const channel = page.getByTestId("communication-channel-telegram");
    await expect(channel).toBeVisible();
    await expect(channel.getByText("Telegram", { exact: true })).toBeVisible();
    await expect(
      page.locator('[data-testid="user-channel-telegram-telegram.bot_token"]'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="user-channel-telegram-telegram.enabled"]'),
    ).toBeVisible();
  });

  test("encrypted fields display as masked", async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector('h1:has-text("Settings")');

    const dynamicSection = page.getByTestId("settings-section-dynamic");
    await expect(dynamicSection).toBeVisible({ timeout: 5000 });
    await dynamicSection.scrollIntoViewIfNeeded();
    const botTokenInput = page.locator(
      '[data-testid="user-channel-telegram-telegram.bot_token-input"]',
    );
    await expect(botTokenInput).toBeVisible();
    await expect(botTokenInput).toHaveAttribute("placeholder", "••••••••");
  });

  test("boolean toggle works correctly", async ({ page }) => {
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector('h1:has-text("Settings")');

    const dynamicSection = page.getByTestId("settings-section-dynamic");
    await expect(dynamicSection).toBeVisible({ timeout: 5000 });
    await dynamicSection.scrollIntoViewIfNeeded();

    const checkbox = page.locator('[data-testid="user-channel-telegram-telegram.enabled-input"]');
    await expect(checkbox).toBeVisible();
    const initialState = await checkbox.isChecked();

    // Toggle
    await checkbox.click();

    const saveButton = page.locator('[data-testid="user-channel-telegram-telegram.enabled-save"]');
    await expect(saveButton).toBeEnabled({ timeout: 5000 });
    await saveButton.click();
    await expect(saveButton).toBeDisabled({ timeout: 15000 });
    await expect(
      page
        .getByTestId("communication-channel-telegram")
        .getByText(initialState ? "Disabled" : "Setup required", { exact: true }),
    ).toBeVisible({ timeout: 5000 });

    // Reload and verify persisted
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector('h1:has-text("Settings")');

    const section = page.getByTestId("settings-section-dynamic");
    await expect(section).toBeVisible({ timeout: 5000 });
    await section.scrollIntoViewIfNeeded();

    const checkboxAfter = page.locator(
      '[data-testid="user-channel-telegram-telegram.enabled-input"]',
    );
    await expect(checkboxAfter).toBeVisible();
    const finalState = await checkboxAfter.isChecked();
    expect(finalState).toBe(!initialState);
  });

  test("settings save and persist after reload", async ({ page }) => {
    test.slow();
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("domcontentloaded");

    // Profile section is at the top, find Name input
    const nameInput = page.locator('input[type="text"]').first();
    await expect(nameInput).toBeVisible({ timeout: 5000 });

    const testValue = `TestName_${Date.now()}`;
    await nameInput.click();
    await nameInput.fill(testValue);

    await page.waitForSelector('button:has-text("Save Changes")', { timeout: 10000 });
    await page.click('button:has-text("Save Changes")');
    await expect(page.locator("text=/success|updated/i")).toBeVisible({ timeout: 10000 });

    // Reload and verify
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const nameAfterReload = page.locator('input[type="text"]').first();
    await expect(nameAfterReload).toBeVisible({ timeout: 5000 });
    await expect(nameAfterReload).toHaveValue(testValue);
  });
});
