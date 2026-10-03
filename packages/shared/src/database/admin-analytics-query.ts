import { ValidationError } from "../errors/index.js";
import type { AnalyticsQuery, AnalyticsRange } from "../types/admin-analytics.js";

const ranges: readonly AnalyticsRange[] = [
  "15m",
  "30m",
  "hour",
  "day",
  "today",
  "week",
  "month",
  "year",
  "all",
];

/** Canonical bounded user selection for analytics exclusions and management lookups. */
export function parseUserIdSelection(value: unknown): string[] {
  if (typeof value !== "string" || value.length > 20100)
    throw new ValidationError("User IDs must be a comma-separated list");
  const userIds = value === "" ? [] : value.split(",").map((id) => id.trim());
  if (userIds.length > 100 || userIds.some((id) => !id || id.length > 200))
    throw new ValidationError("At most 100 nonempty user IDs are allowed");
  return [...new Set(userIds)].sort();
}

/** One interpretation for every user-analytics read, including explicit empty exclusions. */
export function parseAnalyticsQuery(
  query: Record<string, unknown>,
  defaultRange: AnalyticsRange = "month",
  defaultLimit = 6,
): AnalyticsQuery {
  const range = query.range ?? defaultRange;
  if (typeof range !== "string" || !ranges.includes(range as AnalyticsRange))
    throw new ValidationError("Invalid analytics range");
  const excluded = query.excludeUserIds;
  let exclusions: AnalyticsQuery["exclusions"] = { mode: "default-admins" };
  if (excluded !== undefined) {
    exclusions = { mode: "custom", userIds: parseUserIdSelection(excluded) };
  }
  function integer(key: string, fallback: number, maximum: number): number {
    const raw = query[key];
    if (raw === undefined) return fallback;
    if (
      typeof raw !== "string" ||
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) > maximum ||
      (key === "limit" && Number(raw) < 1)
    )
      throw new ValidationError(`Invalid analytics ${key}`);
    return Number(raw);
  }
  return {
    range: range as AnalyticsRange,
    exclusions,
    limit: integer("limit", defaultLimit, 100),
    offset: integer("offset", 0, Number.MAX_SAFE_INTEGER),
  };
}

export function analyticsBounds(
  range: AnalyticsRange,
  now: number,
): { startAt: number; endAt: number } {
  const durations: Partial<Record<AnalyticsRange, number>> = {
    "15m": 900000,
    "30m": 1800000,
    hour: 3600000,
    day: 86400000,
    week: 604800000,
    month: 2592000000,
    year: 31536000000,
  };
  const startAt =
    range === "all"
      ? 0
      : range === "today"
        ? Math.floor(now / 86400000) * 86400000
        : now - durations[range]!;
  return { startAt, endAt: now };
}
