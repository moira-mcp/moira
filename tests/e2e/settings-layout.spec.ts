/**
 * The Settings page's task tabs retain the sections they select; a legacy deep link reveals its
 * section once the data has loaded; help and
 * tutorials that open with words in the reader's language; and the codespace auto-pause preference
 * saved through the settings API.
 */

import { test, expect, type Page } from "./fixtures.js";
import { loginAsAdmin } from "./helpers/auth-helper.js";
import { getTestBaseUrl } from "../utils/test-config.js";

const BASE_URL = getTestBaseUrl();

const SECTIONS = [
  ["account", "settings-section-profile"],
  ["security", "settings-section-security"],
  ["notifications", "settings-section-dynamic"],
  ["integrations-github", "settings-section-integrations"],
  ["connected-apps", "settings-section-oauth"],
  ["api-tokens", "settings-section-api-tokens"],
  ["preferences", "settings-section-preferences"],
] as const;
const TAB_FOR_SECTION: Record<string, string> = {
  account: "account",
  security: "security",
  notifications: "notifications",
  "integrations-github": "development",
  "connected-apps": "access",
  "api-tokens": "access",
  preferences: "preferences",
};

async function openSettings(page: Page, suffix = "") {
  await page.goto(`${BASE_URL}/settings${suffix}`);
  await expect(page.getByTestId("settings-flat-layout")).toBeVisible();
}

test.describe("Settings page structure", () => {
  test("six task tabs retain every settings section and reveal the chosen task", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await openSettings(page, "?lang=en");

    for (const [, testId] of SECTIONS) {
      await expect(page.getByTestId(testId)).toBeAttached();
    }
    await expect(page.getByTestId("settings-nav").getByRole("tab")).toHaveCount(6);
    // Picking a section brings that section into view and marks it as the one being read.
    for (const [id, testId] of [...SECTIONS].reverse()) {
      const tab = TAB_FOR_SECTION[id];
      await page.getByTestId(`settings-nav-${tab}`).click();
      if (id === "integrations-github")
        await page.getByRole("tab", { name: "GitHub connection", exact: true }).click();
      await page.getByTestId(testId).scrollIntoViewIfNeeded();
      await expect(page.getByTestId(testId)).toBeInViewport();
      await expect(page.getByTestId(`settings-nav-${tab}`)).toHaveAttribute(
        "aria-selected",
        "true",
      );
    }
  });

  test("a link to the GitHub section lands on it and highlights it after the data loads", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/settings?lang=en#integrations-github`);
    const github = page.locator("#integrations-github");
    await expect(github).toHaveAttribute("data-highlighted", "true");
    await expect(github).toBeInViewport();
    // The look-alike this rejects: the anchor present but the page still at its top.
    await expect(page.getByTestId("settings-section-profile")).not.toBeInViewport();
    await expect(page.getByTestId("github-codespace-settings")).toBeInViewport();
  });

  test("narrow screens select accessible tabs without widening the page", async ({ page }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page, "?lang=en");
    await expect(page.getByTestId("settings-nav")).toBeVisible();
    // The chip row scrolls on its own; it must not widen the page past the screen.
    const overflow = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("main#main-content")!;
      return main.scrollWidth - main.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByTestId("settings-nav-access").click();
    await page.getByTestId("settings-section-api-tokens").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("settings-section-api-tokens")).toBeInViewport();
    await expect(page.getByTestId("settings-nav")).toBeInViewport();
  });

  for (const [lang, helpTitle, tourTitle, tourStep] of [
    ["en", "When to use an API token", "The Settings page", "Jump between sections"],
    ["ru", "Когда нужен API-токен", "Страница настроек", "Переход между разделами"],
  ] as const) {
    test(`help and the page tour open with localized words (${lang})`, async ({ page }) => {
      await loginAsAdmin(page);
      await openSettings(page, `?lang=${lang}`);
      await page.getByTestId("settings-nav-access").click();

      await page.getByTestId("api-tokens-help").click();
      await expect(page.getByTestId("api-tokens-help-content")).toContainText(helpTitle);
      await expect(page.getByTestId("api-tokens-help-content")).toContainText("Bearer");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("api-tokens-help-content")).toBeHidden();

      await page.getByTestId("guide-open").click();
      const card = page.getByTestId("guide-card");
      await expect(card).toContainText(tourTitle);
      await expect(card).toContainText(tourStep);
      await page.getByTestId("guide-next").click();
      await expect(card).toHaveAttribute("data-guide-step", "account");
      // The step lights the section it explains.
      await expect(page.getByTestId("settings-section-profile")).toHaveAttribute(
        "data-guide",
        "settings.account",
      );
      await expect(page.getByTestId("guide-spotlight")).toHaveAttribute(
        "data-guide-anchor",
        "settings.account",
      );
      await page.getByTestId("guide-close").click();
      await expect(card).toBeHidden();
      expect(new URL(page.url()).searchParams.has("guide")).toBe(false);
    });
  }

  test("the GitHub setup guide walks the section's cards", async ({ page }) => {
    await loginAsAdmin(page);
    await openSettings(page, "?lang=en#integrations-github");
    await page.getByTestId("github-guide-open").click();
    await expect(page.getByTestId("guide-card")).toContainText("Three steps to connect");
    await expect(page.getByTestId("guide-spotlight")).toHaveAttribute(
      "data-guide-anchor",
      "settings.github-steps",
    );
  });
});

test.describe("Codespace auto-pause preference", () => {
  test("switching auto-pause and choosing a timeout persist through the settings API", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await openSettings(page, "?lang=en#integrations-github");
    await page.getByRole("tab", { name: "GitHub Codespaces", exact: true }).click();
    const card = page.getByTestId("codespace-auto-pause");
    await card.scrollIntoViewIfNeeded();
    await expect(card).toContainText("Only agent activity through Moira counts");

    const toggle = page.getByTestId("codespace-auto-pause-switch");
    const timeout = page.getByTestId("codespace-auto-pause-timeout");
    await expect(toggle).toHaveAttribute("aria-checked", "true");

    try {
      await timeout.click();
      await page.getByRole("option", { name: "45 minutes" }).click();
      await expect(page.getByText("Automatic pause setting saved").first()).toBeVisible();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await expect(timeout).toBeDisabled();

      const stored = await page.evaluate(async () => {
        const response = await fetch("/api/settings", { credentials: "include" });
        return (await response.json()).data as Record<string, unknown>;
      });
      expect(stored["codespaces.auto_stop_enabled"]).toBe(false);
      expect(stored["codespaces.idle_timeout_minutes"]).toBe(45);

      await page.reload();
      await expect(page.getByTestId("codespace-auto-pause-switch")).toHaveAttribute(
        "aria-checked",
        "false",
      );
      await expect(page.getByTestId("codespace-auto-pause-timeout")).toContainText("45 minutes");
    } finally {
      // Leave the shared admin account as it was for the other specs.
      await page.evaluate(async () => {
        await fetch("/api/settings", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            "codespaces.auto_stop_enabled": true,
            "codespaces.idle_timeout_minutes": 30,
          }),
        });
      });
    }
  });
});
