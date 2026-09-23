/**
 * The Settings page's structure as a reader meets it: seven sections, always mounted, reached from
 * the in-page navigation; a deep link that lands on its section once the data has loaded; help and
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

async function openSettings(page: Page, suffix = "") {
  await page.goto(`${BASE_URL}/settings${suffix}`);
  await expect(page.getByTestId("settings-flat-layout")).toBeVisible();
}

test.describe("Settings page structure", () => {
  test("all seven sections are mounted and each is reached from the navigation", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await openSettings(page, "?lang=en");

    for (const [, testId] of SECTIONS) {
      await expect(page.getByTestId(testId)).toBeAttached();
    }
    // Picking a section brings that section into view and marks it as the one being read.
    for (const [id, testId] of [...SECTIONS].reverse()) {
      await page.getByTestId(`settings-nav-${id}`).click();
      await expect(page.getByTestId(testId)).toBeInViewport();
      await expect(page.getByTestId(`settings-nav-${id}`)).toHaveAttribute(
        "aria-current",
        "location",
      );
    }
  });

  test("a link to the GitHub section lands on it and highlights it after the data loads", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await page.goto(`${BASE_URL}/settings?lang=en#integrations-github`);
    const github = page.getByTestId("settings-section-integrations");
    await expect(github).toHaveAttribute("data-highlighted", "true");
    await expect(github).toBeInViewport();
    // The look-alike this rejects: the anchor present but the page still at its top.
    await expect(page.getByTestId("settings-section-profile")).not.toBeInViewport();
    await expect(page.getByTestId("github-codespace-settings")).toBeInViewport();
  });

  test("narrow screens reach sections through the chip row", async ({ page }) => {
    await loginAsAdmin(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openSettings(page, "?lang=en");
    await expect(page.getByTestId("settings-nav")).toBeHidden();
    // The chip row scrolls on its own; it must not widen the page past the screen.
    const overflow = await page.evaluate(() => {
      const main = document.querySelector<HTMLElement>("main#main-content")!;
      return main.scrollWidth - main.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByTestId("settings-nav-chip-api-tokens").click();
    await expect(page.getByTestId("settings-section-api-tokens")).toBeInViewport();
    await expect(page.getByTestId("settings-nav-chips")).toBeInViewport();
  });

  for (const [lang, helpTitle, tourTitle, tourStep] of [
    ["en", "When to use an API token", "Settings tour", "Jump between sections"],
    ["ru", "Когда нужен API-токен", "Обзор настроек", "Переход между разделами"],
  ] as const) {
    test(`help and the page tour open with localized words (${lang})`, async ({ page }) => {
      await loginAsAdmin(page);
      await openSettings(page, `?lang=${lang}`);

      await page.getByTestId("api-tokens-help").click();
      await expect(page.getByTestId("api-tokens-help-content")).toContainText(helpTitle);
      await expect(page.getByTestId("api-tokens-help-content")).toContainText("Bearer");
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("api-tokens-help-content")).toBeHidden();

      await page.getByTestId("settings-guide-open").click();
      const walkthrough = page.getByTestId("walkthrough");
      await expect(walkthrough).toContainText(tourTitle);
      await expect(walkthrough).toContainText(tourStep);
      await page.getByTestId("walkthrough-next").click();
      await expect(walkthrough).toHaveAttribute("data-guide-step", "account");
      // The step rings the section it explains.
      await expect(page.getByTestId("settings-section-profile")).toHaveAttribute(
        "data-guide-target",
        "account",
      );
      await page.getByTestId("walkthrough-close").click();
      await expect(walkthrough).toBeHidden();
      expect(new URL(page.url()).searchParams.has("tour")).toBe(false);
    });
  }

  test("the GitHub setup guide walks the section's cards", async ({ page }) => {
    await loginAsAdmin(page);
    await openSettings(page, "?lang=en");
    await page.getByTestId("github-guide-open").click();
    const walkthrough = page.getByTestId("walkthrough");
    await expect(walkthrough).toContainText("Three steps to connect");
    await expect(page.getByTestId("github-setup-steps")).toHaveAttribute(
      "data-guide-target",
      "steps",
    );
  });
});

test.describe("Codespace auto-pause preference", () => {
  test("switching auto-pause and choosing a timeout persist through the settings API", async ({
    page,
  }) => {
    await loginAsAdmin(page);
    await openSettings(page, "?lang=en#integrations-github");
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
