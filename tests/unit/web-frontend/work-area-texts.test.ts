/**
 * @jest-environment jsdom
 *
 * The texts the home work area builds from data: relative times in the interface language (they
 * were English in a Russian interface), and the ready-to-say prompt — the authored one for a
 * universal flow of the system owner, none for any other flow, which gets the template from its
 * name instead; and names interpolated into texts read as written.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import i18n from "../../../packages/web-frontend/src/i18n";
import { formatRelativeTime } from "../../../packages/web-frontend/src/components/cards/format-utils";
import { promptKey } from "../../../packages/web-frontend/src/components/onboarding/recommended";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("relative time", () => {
  test.each([
    ["en", 0, "just now"],
    ["en", 5 * 60_000, "5m ago"],
    ["en", 3 * 3_600_000, "3h ago"],
    ["ru", 0, "только что"],
    ["ru", 5 * 60_000, "5 мин назад"],
    ["ru", 2 * 86_400_000, "2 дн назад"],
  ] as const)("in %s, %i ms ago reads %s", async (language, ago, text) => {
    await i18n.changeLanguage(language);
    expect(formatRelativeTime(Date.now() - ago)).toBe(text);
  });
});

describe("ready-to-say prompt", () => {
  test("a universal flow of the system owner has an authored prompt, in both languages", async () => {
    const key = promptKey("moira", "quick-task");
    expect(key).toBe("onboarding.universal.quickTask.prompt");
    expect(i18n.t(key!)).toMatch(/Quick Task/);
    await i18n.changeLanguage("ru");
    expect(i18n.t(key!)).toMatch(/Мойре/);
  });

  test.each([
    ["someone", "quick-task"],
    ["moira", "example-simple-steps"],
    [null, "quick-task"],
  ])("owner %s, slug %s has no authored prompt", (owner, slug) => {
    expect(promptKey(owner, slug)).toBeNull();
  });
});

describe("interpolated names", () => {
  test("a name with an apostrophe reads as written, not as an HTML entity", () => {
    // React escapes what it renders; i18n escaping it again showed `&#39;`
    expect(
      i18n.t("pages.dashboard.work.inProgress.atStep", { step: "Gather the week's results" }),
    ).toBe("At: Gather the week's results");
  });
});
