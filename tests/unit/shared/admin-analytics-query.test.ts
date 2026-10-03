import { describe, expect, test } from "@jest/globals";
import { analyticsBounds, parseAnalyticsQuery } from "@mcp-moira/shared";

describe("Analytics query boundaries", () => {
  test("distinguishes dynamic administrator exclusion from an explicitly empty custom choice", () => {
    expect(parseAnalyticsQuery({}).exclusions).toEqual({ mode: "default-admins" });
    expect(parseAnalyticsQuery({ excludeUserIds: "" }).exclusions).toEqual({
      mode: "custom",
      userIds: [],
    });
    expect(parseAnalyticsQuery({ excludeUserIds: " b,a,b " }).exclusions).toEqual({
      mode: "custom",
      userIds: ["a", "b"],
    });
  });
  test.each([
    { range: "invalid" },
    { range: ["week", "month"] },
    { excludeUserIds: ["a", "b"] },
    { excludeUserIds: "a,,b" },
    { excludeUserIds: "x".repeat(201) },
    { excludeUserIds: Array.from({ length: 101 }, (_, i) => String(i)).join(",") },
    { limit: "0" },
    { limit: "101" },
    { limit: "1.5" },
    { limit: ["1", "2"] },
    { offset: "-1" },
    { offset: "9007199254740992" },
  ])("rejects malformed request instead of broadening its selection: %j", (query) => {
    expect(() => parseAnalyticsQuery(query)).toThrow();
  });
  test("keeps rolling and calendar UTC boundaries exact and all-time starting at epoch", () => {
    const now = Date.UTC(2026, 8, 30, 12, 34, 56, 789);
    expect(analyticsBounds("30m", now)).toEqual({ startAt: now - 1800000, endAt: now });
    expect(analyticsBounds("today", now)).toEqual({ startAt: Date.UTC(2026, 8, 30), endAt: now });
    expect(analyticsBounds("all", now)).toEqual({ startAt: 0, endAt: now });
  });
});
