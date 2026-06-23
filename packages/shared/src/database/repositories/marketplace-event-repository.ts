/**
 * Marketplace Event Repository — append-only analytics signals for listings.
 *
 * Powers trending (recent-activity ranking) beyond the denormalized counters on
 * the listing. Events are never updated or deleted.
 */

import { eq, and, gte, inArray, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { marketplaceEvent } from "../schema.js";
import type * as schema from "../schema.js";
import { v4 as uuidv4 } from "uuid";

/** An event row as stored. */
export type MarketplaceEventRecord = typeof marketplaceEvent.$inferSelect;

/** Analytics signal types. */
export type MarketplaceEventType = "view" | "install" | "start" | "rate";

export interface RecordEventInput {
  listingId: string;
  userId?: string | null;
  type: MarketplaceEventType;
}

/** Options for the trending query. */
export interface TrendingOptions {
  /** Only count events at-or-after this epoch-ms (the recent-activity window). */
  sinceMs: number;
  /** Max listings to return. */
  limit?: number;
  /** Restrict to these event types (default: all). */
  types?: MarketplaceEventType[];
}

/** A trending entry: a listing id and its recent-activity score. */
export interface TrendingEntry {
  listingId: string;
  score: number;
}

export class MarketplaceEventRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /** Append an event (at = now). */
  async record(input: RecordEventInput): Promise<void> {
    await this.db.insert(marketplaceEvent).values({
      id: uuidv4(),
      listingId: input.listingId,
      userId: input.userId ?? null,
      type: input.type,
      at: new Date(),
    });
  }

  /**
   * Listings ranked by recent-activity score (event count in the window),
   * highest first.
   */
  async trending(options: TrendingOptions): Promise<TrendingEntry[]> {
    const conditions = [gte(marketplaceEvent.at, new Date(options.sinceMs))];
    if (options.types && options.types.length > 0) {
      conditions.push(inArray(marketplaceEvent.type, options.types));
    }
    const rows = await this.db
      .select({
        listingId: marketplaceEvent.listingId,
        score: sql<number>`COUNT(*)`,
      })
      .from(marketplaceEvent)
      .where(and(...conditions))
      .groupBy(marketplaceEvent.listingId)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(options.limit ?? 50);
    return rows.map((r) => ({ listingId: r.listingId, score: Number(r.score) }));
  }

  /** All events for a listing (newest first) — for analytics/inspection. */
  async listByListing(listingId: string): Promise<MarketplaceEventRecord[]> {
    return this.db
      .select()
      .from(marketplaceEvent)
      .where(eq(marketplaceEvent.listingId, listingId))
      .orderBy(sql`${marketplaceEvent.at} DESC`);
  }
}
