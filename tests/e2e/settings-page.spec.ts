/**
 * Settings Page E2E Tests
 * Validates settings page with flat layout:
 * Profile, Security, Notifications, OAuth, Sessions — all on one page
 */

import { test, expect } from "./fixtures.js";
import { createTestUser, login, loginAsAdmin } from "./helpers/auth-helper.js";
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

  for (const [lang, tour, label, href] of [
    [
      "en",
      "Telegram setup",
      "Telegram setup in the documentation",
      "/docs/integration/telegram-setup/",
    ],
    [
      "ru",
      "Настройка Telegram",
      "Настройка Telegram в документации",
      "/ru/docs/integration/telegram-setup/",
    ],
  ] as const) {
    test(`the Telegram tour and the Telegram documentation are two distinctly named entries, the documentation in the reader's language (${lang})`, async ({
      page,
    }) => {
      await loginAsAdmin(page);
      await page.goto(`${BASE_URL}/settings?lang=${lang}`);
      const section = page.getByTestId("settings-section-dynamic");
      await expect(section).toBeVisible({ timeout: 5000 });

      await expect(page.getByTestId("telegram-guide-open")).toHaveText(tour);
      const docs = page.getByTestId("user-channel-telegram-docs-link");
      await expect(docs).toHaveText(label);
      await expect(docs).toHaveAttribute("href", href);
    });
  }

  test("the sessions list carries its title inside its own card", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/settings?lang=en`);
    const sessions = page.getByTestId("settings-section-sessions");
    await expect(
      sessions.getByRole("heading", { name: "Active Sessions", level: 3 }),
    ).toBeVisible();
    await expect(sessions.getByTestId("sessions-help")).toBeVisible();
    await expect(sessions.getByTestId(/^session-row-/).first()).toBeVisible();
    // The card's edge is the heading's container, so the heading sits inside it, not left of it.
    const card = await sessions.boundingBox();
    const heading = await sessions.getByRole("heading", { name: "Active Sessions" }).boundingBox();
    expect(heading!.x).toBeGreaterThan(card!.x + 8);
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
    // A user of its own: the shared admin's Telegram settings are changed by other tests and
    // suites, so its starting state would depend on which of them ran last.
    const email = `settings-toggle-${Date.now()}-${test.info().workerIndex}-${Math.random()
      .toString(36)
      .slice(2, 7)}@example.com`;
    await createTestUser(email, "ToggleUser123!", "Toggle User", true);
    await login(page, email, "ToggleUser123!");
    await page.goto(`${BASE_URL}/settings?lang=en`);

    const dynamicSection = page.getByTestId("settings-section-dynamic");
    await expect(dynamicSection).toBeVisible({ timeout: 5000 });
    await dynamicSection.scrollIntoViewIfNeeded();

    // A new user has notifications on and no bot yet: the channel needs setup.
    const state = page.getByTestId("communication-channel-telegram-state");
    const checkbox = page.getByTestId("user-channel-telegram-telegram.enabled-input");
    await expect(checkbox).toBeChecked();
    await expect(state).toHaveAttribute("data-state", "incomplete");

    await checkbox.click();
    const saveButton = page.getByTestId("user-channel-telegram-telegram.enabled-save");
    await expect(saveButton).toBeEnabled({ timeout: 5000 });
    await saveButton.click();
    await expect(saveButton).toBeDisabled({ timeout: 15000 });
    await expect(state).toHaveAttribute("data-state", "disabled");
    await expect(state).toHaveText("Disabled");

    // Reload and verify persisted
    await page.reload();
    await expect(page.getByTestId("settings-section-dynamic")).toBeVisible({ timeout: 5000 });
    await expect(
      page.getByTestId("user-channel-telegram-telegram.enabled-input"),
    ).not.toBeChecked();
    await expect(page.getByTestId("communication-channel-telegram-state")).toHaveAttribute(
      "data-state",
      "disabled",
    );
  });

  test("settings save and persist after reload", async ({ page }) => {
    test.slow();
    await loginAsAdmin(page);
    await page.waitForLoadState("domcontentloaded");

    await page.goto(`${BASE_URL}/settings`);
    await page.waitForLoadState("domcontentloaded");

    const nameInput = page.getByTestId("profile-name-input");
    await expect(nameInput).toBeVisible({ timeout: 5000 });

    const testValue = `TestName_${Date.now()}`;
    await nameInput.click();
    await nameInput.fill(testValue);

    await page.waitForSelector('button:has-text("Save Changes")', { timeout: 10000 });
    await page.click('button:has-text("Save Changes")');
    await expect(page.getByText("Profile updated successfully")).toBeVisible({ timeout: 10000 });

    // Reload and verify
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const nameAfterReload = page.getByTestId("profile-name-input");
    await expect(nameAfterReload).toBeVisible({ timeout: 5000 });
    await expect(nameAfterReload).toHaveValue(testValue);
  });
});
