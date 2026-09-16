/**
 * The run page's two display helpers: durations as people read them, and who the run waits for.
 * Both are worded in the interface language, and an unmeasured duration must never read as "0 s" —
 * a run recorded before timestamps existed would otherwise claim every block was instant.
 */
import { describe, expect, test, beforeAll, afterAll } from "@jest/globals";
import i18n from "../../../packages/web-frontend/src/i18n";
import { formatDuration } from "../../../packages/web-frontend/src/components/run/duration.js";
import {
  blockStatusLabel,
  waitingLabel,
  waitingSuffix,
} from "../../../packages/web-frontend/src/components/run/waiting.js";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

afterAll(async () => {
  await i18n.changeLanguage("en");
});

describe("formatDuration", () => {
  test.each([
    ["nothing measured", null, "—"],
    ["an absent field", undefined, "—"],
    ["a broken number", Number.NaN, "—"],
    ["zero, which is measured", 0, "0 s"],
    ["under a minute", 12_000, "12 s"],
    ["a minute and seconds", 80_000, "1 min 20 s"],
    ["whole minutes", 120_000, "2 min"],
    ["hours with padded minutes", 7_500_000, "2 h 05 min"],
  ])("%s reads as %j → %j", (_case, ms, expected) => {
    expect(formatDuration(ms as number | null | undefined, i18n.t)).toBe(expected);
  });

  test("units are worded in the interface language", async () => {
    await i18n.changeLanguage("ru");
    expect(formatDuration(12_000, i18n.t)).toBe("12 с");
    expect(formatDuration(80_000, i18n.t)).toBe("1 мин 20 с");
    expect(formatDuration(null, i18n.t)).toBe("—");
    await i18n.changeLanguage("en");
  });
});

describe("waiting wording", () => {
  test("only a person waited for reads as waiting for you", () => {
    expect(waitingSuffix("user")).toBe("waiting");
    expect(waitingSuffix("agent")).toBe("waitingAgent");
    expect(waitingSuffix(null)).toBe("waitingAgent");
    expect(waitingLabel("user", i18n.t)).toBe("waiting for you");
    expect(waitingLabel("agent", i18n.t)).toBe("agent on the step");
    expect(waitingLabel(null, i18n.t)).toBe("agent on the step");
  });

  test("a block status is worded by the actor only while it waits", () => {
    expect(blockStatusLabel("waiting", "user", i18n.t)).toBe("waiting for you");
    expect(blockStatusLabel("waiting", "agent", i18n.t)).toBe("agent on the step");
    expect(blockStatusLabel("done", "user", i18n.t)).toBe("completed");
    expect(blockStatusLabel("active", "agent", i18n.t)).toBe("in progress");
  });

  test("both actors are worded in Russian too", async () => {
    await i18n.changeLanguage("ru");
    expect(waitingLabel("user", i18n.t)).toBe("ждёт вас");
    expect(waitingLabel("agent", i18n.t)).toBe("агент на шаге");
    await i18n.changeLanguage("en");
  });
});
