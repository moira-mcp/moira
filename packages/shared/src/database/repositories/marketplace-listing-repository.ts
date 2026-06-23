/**
 * Marketplace Listing Repository — Drizzle queries for the public-gallery record.
 *
 * One listing per workflow (UNIQUE workflowId). Carries gallery metadata, moderation
 * state, denormalized counters, and the (inert) paid columns. The gallery query joins
 * `workflow` so it can enforce "listed AND public AND not deleted" — a listing whose
 * workflow was unpublished or deleted must not surface.
 */

import { eq, and, or, isNull, desc, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { marketplaceListing, workflow } from "../schema.js";
import type * as schema from "../schema.js";
import { v4 as uuidv4 } from "uuid";

/** A marketplace listing row as stored. */
export type MarketplaceListingRecord = typeof marketplaceListing.$inferSelect;

/** Fields accepted when creating a listing. */
export interface CreateListingInput {
  workflowId: string;
  publishedBy: string;
  title: string;
  summary?: string | null;
  category: string;
  tags?: string[];
  isPaid?: boolean;
  price?: number | null;
  currency?: string | null;
}

/** Gallery query filters (the advanced sort/search lands in a later step). */
export interface GalleryFilter {
  category?: string;
  limit?: number;
  offset?: number;
}

export class MarketplaceListingRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  /** Create a listing (status defaults to "listed"). Returns the stored row. */
  async create(input: CreateListingInput): Promise<MarketplaceListingRecord> {
    const now = new Date();
    const row = {
      id: uuidv4(),
      workflowId: input.workflowId,
      publishedBy: input.publishedBy,
      status: "listed",
      title: input.title,
      summary: input.summary ?? null,
      category: input.category,
      tags: JSON.stringify(input.tags ?? []),
      isPaid: input.isPaid ?? false,
      price: input.price ?? null,
      currency: input.currency ?? null,
      publishedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(marketplaceListing).values(row);
    const created = await this.getById(row.id);
    if (!created) {
      throw new Error(`Failed to create marketplace listing ${row.id}`);
    }
    return created;
  }

  /** Get a listing by its id. */
  async getById(id: string): Promise<MarketplaceListingRecord | null> {
    const [row] = await this.db
      .select()
      .from(marketplaceListing)
      .where(eq(marketplaceListing.id, id))
      .limit(1);
    return row ?? null;
  }

  /** Get the listing for a given workflow (one-to-one). */
  async getByWorkflowId(workflowId: string): Promise<MarketplaceListingRecord | null> {
    const [row] = await this.db
      .select()
      .from(marketplaceListing)
      .where(eq(marketplaceListing.workflowId, workflowId))
      .limit(1);
    return row ?? null;
  }

  /** Delete the listing for a workflow. Returns true if a row was removed. */
  async deleteByWorkflowId(workflowId: string): Promise<boolean> {
    const result = await this.db
      .delete(marketplaceListing)
      .where(eq(marketplaceListing.workflowId, workflowId));
    return result.changes > 0;
  }

  /**
   * Gallery query: listings that are `status='listed'` AND whose workflow is
   * `visibility='public'` AND not soft-deleted. Newest first.
   */
  async listGallery(filter: GalleryFilter = {}): Promise<MarketplaceListingRecord[]> {
    const conditions = [
      eq(marketplaceListing.status, "listed"),
      eq(workflow.visibility, "public"),
      or(eq(workflow.deleted, false), isNull(workflow.deleted)),
    ];
    if (filter.category) {
      conditions.push(eq(marketplaceListing.category, filter.category));
    }

    const rows = await this.db
      .select()
      .from(marketplaceListing)
      .innerJoin(workflow, eq(marketplaceListing.workflowId, workflow.id))
      .where(and(...conditions))
      .orderBy(desc(marketplaceListing.publishedAt))
      .limit(filter.limit ?? 100)
      .offset(filter.offset ?? 0);

    // innerJoin yields { marketplaceListing, workflow }; return only the listing.
    return rows.map((r) => r.marketplaceListing);
  }

  /**
   * Increment the install counter (a flow was added to a library). Atomic
   * read-modify-write in SQL so concurrent adds do not lose updates.
   */
  async incrementInstallCount(listingId: string): Promise<void> {
    await this.db
      .update(marketplaceListing)
      .set({ installCount: sql`${marketplaceListing.installCount} + 1`, updatedAt: new Date() })
      .where(eq(marketplaceListing.id, listingId));
  }

  /** Increment the start counter (a flow was started from the listing). Atomic. */
  async incrementStartCount(listingId: string): Promise<void> {
    await this.db
      .update(marketplaceListing)
      .set({ startCount: sql`${marketplaceListing.startCount} + 1`, updatedAt: new Date() })
      .where(eq(marketplaceListing.id, listingId));
  }

  /** Increment the view counter (a listing detail was viewed). Atomic. */
  async incrementViewCount(listingId: string): Promise<void> {
    await this.db
      .update(marketplaceListing)
      .set({ viewCount: sql`${marketplaceListing.viewCount} + 1`, updatedAt: new Date() })
      .where(eq(marketplaceListing.id, listingId));
  }
}
