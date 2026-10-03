import { describe, expect, test } from "@jest/globals";
import {
  classifyExecutionOutcome,
  executionStopCapability,
  resolveOverviewQuery,
  type OverviewQueryInput,
} from "@mcp-moira/shared/execution-management";

describe("execution management meaning", () => {
  test.each([
    [{ status: "completed" }, "completed"],
    [{ status: "completed", errors: [{ errorType: "handler" }] }, "completed-with-refusals"],
    [{ status: "completed", errors: [{ errorType: "degradation" }] }, "completed"],
    [
      { status: "completed", stopReason: "Changed scope", errors: [{ errorType: "handler" }] },
      "stopped",
    ],
    [{ status: "running", stopReason: "" }, "stopped"],
    [{ status: "failed", errors: [{ errorType: "handler" }] }, "other"],
    [{ status: "waiting" }, "active"],
  ] as const)("%j retains genuine completion/refusal/stop distinction", (input, outcome) => {
    expect(classifyExecutionOutcome(input)).toBe(outcome);
  });

  test("recent selection is relative to the request, while long-idle clears its lower bound", () => {
    const now = Date.UTC(2026, 9, 3, 12);
    const base = { userId: "owner" };
    expect(resolveOverviewQuery(base, now)).toMatchObject({
      status: "active",
      sort: "activity",
      activeSince: now - 7 * 86_400_000,
      now,
      effectiveTime: { kind: "period", period: "7d" },
    });
    expect(resolveOverviewQuery({ ...base, idle: "30d" }, now)).toMatchObject({
      activeSince: undefined,
      activeUntil: undefined,
      idleSince: now - 30 * 86_400_000,
      effectiveTime: { kind: "idle", idle: "30d" },
    });
    expect(resolveOverviewQuery({ ...base, activeFrom: 7, activeTo: 9 }, now)).toMatchObject({
      activeSince: 7,
      activeUntil: 9,
      effectiveTime: { kind: "range", activeFrom: 7, activeTo: 9 },
    });
  });

  test.each([
    { period: "7d", idle: "30d" },
    { period: "30d", activeTo: 9 },
    { idle: "1h", activeFrom: 7 },
    { activeFrom: 9, activeTo: 7 },
  ] as Omit<OverviewQueryInput, "userId">[])("contradictory or inverted %j is refused", (input) => {
    expect(() => resolveOverviewQuery({ userId: "owner", ...input }, 100)).toThrow(RangeError);
  });

  test("foreign ownership, terminal state and in-flight generation remain distinct", () => {
    const active = { status: "running", revision: 3, userId: "owner", hasExecutingAttempt: false };
    expect(executionStopCapability(active, "owner")).toEqual({ available: true, revision: 3 });
    expect(executionStopCapability({ ...active, stopReason: "" }, "owner")).toEqual({
      available: false,
      revision: 3,
      reason: "terminal",
    });
    expect(executionStopCapability({ ...active, status: "completed" }, "admin")).toEqual({
      available: false,
      revision: 3,
      reason: "not-owner",
    });
    expect(
      executionStopCapability(
        { ...active, status: "completed", hasExecutingAttempt: true },
        "owner",
      ),
    ).toEqual({ available: false, revision: 3, reason: "terminal" });
    expect(executionStopCapability({ ...active, hasExecutingAttempt: true }, "owner")).toEqual({
      available: false,
      revision: 3,
      reason: "in-flight",
    });
    expect(executionStopCapability({ ...active, revision: null }, "owner")).toEqual({
      available: false,
      revision: null,
      reason: "unavailable",
    });
  });
});
