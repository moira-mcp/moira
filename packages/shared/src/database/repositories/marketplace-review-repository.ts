/**
 * Marketplace Review Repository — per-user star ratings + optional text for a
 * listing. At most one review per (listing, user); editing replaces it. Writing a
 * review recomputes the listing's denormalized `ratingAvg`/`ratingCount` from the
 * canonical review set inside a single transaction, so the aggregate never drifts.
 */

import { eq, and, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { marketplaceReview, marketplaceListing } from "../schema.js";
import type * as schema from "../schema.js";
import { v4 as uuidv4 } from "uuid";

/** A review row as stored. */
export type MarketplaceReviewRecord = typeof marketplaceReview.$inferSelect;

/** Recomputed listing rating aggregate. */
export interface RatingAggregate {
  ratingAvg: number;
  ratingCount: number;
}

export interface UpsertReviewInput {
  listingId: string;
  userId: string;
  stars: number;
  reviewText?: string | null;
}

/** Aggregate the AVG/COUNT for a listing's reviews (rounded helper not needed — real column). */
const AGG_AVG = sql<number>`COALESCE(AVG(${marketplaceReview.stars}), 0)`;
const AGG_COUNT = sql<number>`COUNT(*)`;

export class MarketplaceReviewRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /**
   * Insert or replace the user's review for a listing and recompute the listing's
   * rating aggregate, transactionally. Returns the stored review + the new aggregate.
   */
  async upsertAndRecompute(
    input: UpsertReviewInput,
  ): Promise<{ review: MarketplaceReviewRecord; aggregate: RatingAggregate }> {
    const { listingId, userId, stars, reviewText = null } = input;
    // better-sqlite3 transactions are synchronous — use .run()/.get() inside.
    return this.db.transaction((tx) => {
      const now = new Date();
      tx.insert(marketplaceReview)
        .values({
          id: uuidv4(),
          listingId,
          userId,
          stars,
          reviewText,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [marketplaceReview.listingId, marketplaceReview.userId],
          set: { stars, reviewText, updatedAt: now },
        })
        .run();

      const agg = tx
        .select({ avg: AGG_AVG, count: AGG_COUNT })
        .from(marketplaceReview)
        .where(eq(marketplaceReview.listingId, listingId))
        .get();
      const aggregate: RatingAggregate = {
        ratingAvg: agg?.avg ?? 0,
        ratingCount: agg?.count ?? 0,
      };
      tx.update(marketplaceListing)
        .set({
          ratingAvg: aggregate.ratingAvg,
          ratingCount: aggregate.ratingCount,
          updatedAt: now,
        })
        .where(eq(marketplaceListing.id, listingId))
        .run();

      const review = tx
        .select()
        .from(marketplaceReview)
        .where(
          and(eq(marketplaceReview.listingId, listingId), eq(marketplaceReview.userId, userId)),
        )
        .get() as MarketplaceReviewRecord;

      return { review, aggregate };
    });
  }

  /**
   * Delete the user's review for a listing and recompute the aggregate.
   * Returns the new aggregate, or null if there was no review to delete.
   */
  async deleteAndRecompute(listingId: string, userId: string): Promise<RatingAggregate | null> {
    return this.db.transaction((tx) => {
      const result = tx
        .delete(marketplaceReview)
        .where(
          and(eq(marketplaceReview.listingId, listingId), eq(marketplaceReview.userId, userId)),
        )
        .run();
      if (result.changes === 0) return null;

      const agg = tx
        .select({ avg: AGG_AVG, count: AGG_COUNT })
        .from(marketplaceReview)
        .where(eq(marketplaceReview.listingId, listingId))
        .get();
      const aggregate: RatingAggregate = {
        ratingAvg: agg?.avg ?? 0,
        ratingCount: agg?.count ?? 0,
      };
      tx.update(marketplaceListing)
        .set({
          ratingAvg: aggregate.ratingAvg,
          ratingCount: aggregate.ratingCount,
          updatedAt: new Date(),
        })
        .where(eq(marketplaceListing.id, listingId))
        .run();
      return aggregate;
    });
  }

  /** The user's review for a listing, if any. */
  async getByListingAndUser(
    listingId: string,
    userId: string,
  ): Promise<MarketplaceReviewRecord | null> {
    const [row] = await this.db
      .select()
      .from(marketplaceReview)
      .where(and(eq(marketplaceReview.listingId, listingId), eq(marketplaceReview.userId, userId)))
      .limit(1);
    return row ?? null;
  }

  /** All reviews for a listing (newest first). */
  async listByListing(listingId: string): Promise<MarketplaceReviewRecord[]> {
    return this.db
      .select()
      .from(marketplaceReview)
      .where(eq(marketplaceReview.listingId, listingId))
      .orderBy(sql`${marketplaceReview.createdAt} DESC`);
  }
}
