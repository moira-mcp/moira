import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./schema.js";
import type { AnalyticsSeriesWindow } from "../types/admin-analytics.js";

export const MAX_ANALYTICS_SERIES_BUCKETS = 366;

/** Window counts are computed over the complete grouped result before SQL restricts transfer. */
export function boundedAnalyticsSeries<T extends { date: string }>(
  db: BetterSQLite3Database<typeof schema>,
  grouped: SQL,
  granularity: AnalyticsSeriesWindow["granularity"] = "daily",
): { points: T[]; window: AnalyticsSeriesWindow } {
  const rows = db.all<T & { observedBuckets: number }>(
    sql`SELECT series.*, count(*) OVER() AS observedBuckets FROM (${grouped}) series ORDER BY date DESC LIMIT ${MAX_ANALYTICS_SERIES_BUCKETS}`,
  );
  const points = rows
    .map(({ observedBuckets: _count, ...point }) => point as unknown as T)
    .reverse();
  const totalBuckets = rows[0]?.observedBuckets ?? 0;
  return {
    points,
    window: {
      granularity,
      limit: MAX_ANALYTICS_SERIES_BUCKETS,
      totalBuckets,
      limited: totalBuckets > points.length,
      firstDate: points[0]?.date ?? null,
      lastDate: points.at(-1)?.date ?? null,
    },
  };
}
