/**
 * Marketplace Listing Repository — Drizzle queries for the public-gallery record.
 *
 * One listing per workflow (UNIQUE workflowId). Carries gallery metadata, moderation
 * state, denormalized counters, and the (inert) paid columns. The gallery query joins
 * `workflow` so it can enforce "listed AND public AND not deleted" — a listing whose
 * workflow was unpublished or deleted must not surface.
 */

import { eq, and, or, isNull, desc, sql, like, inArray, count } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { marketplaceListing, workflow, user } from "../schema.js";
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

/** Gallery sort order. */
export type GallerySort = "recent" | "rating" | "installs";

/** Gallery query filters. */
export interface GalleryFilter {
  /** Free-text match against title/summary. */
  search?: string;
  category?: string;
  /** Match a single free-form tag. */
  tag?: string;
  /** Sort order (default: recent). Note: "trending" is computed in the service. */
  sort?: GallerySort;
  limit?: number;
  offset?: number;
}

/** A gallery row: the listing plus its owner handle and workflow slug (for linking). */
export type GalleryItem = MarketplaceListingRecord & {
  ownerHandle: string | null;
  slug: string;
};

/** Owner-editable listing metadata (PATCH). Undefined fields are left unchanged. */
export interface UpdateListingMetadata {
  title?: string;
  summary?: string | null;
  category?: string;
  tags?: string[];
}

/** A minimal public reference (for the sitemap). */
export interface PublicListingRef {
  ownerHandle: string | null;
  slug: string;
  title: string;
  updatedAt: Date;
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

  /**
   * Hard-delete the listing for a workflow. Returns true if a row was removed.
   * Note: unpublish is a SOFT delete (`setStatus('unlisted')`, row kept for history);
   * this is the hard-delete primitive, retained for admin/data-removal use.
   */
  async deleteByWorkflowId(workflowId: string): Promise<boolean> {
    const result = await this.db
      .delete(marketplaceListing)
      .where(eq(marketplaceListing.workflowId, workflowId));
    return result.changes > 0;
  }

  /**
   * Gallery query: listings that are `status='listed'` AND whose workflow is
   * `visibility='public'` AND not soft-deleted, with optional search/category/tag
   * filters and sort. Returns enriched items (owner handle + workflow slug).
   */
  async listGallery(filter: GalleryFilter = {}): Promise<GalleryItem[]> {
    const orderBy =
      filter.sort === "rating"
        ? [desc(marketplaceListing.ratingAvg), desc(marketplaceListing.ratingCount)]
        : filter.sort === "installs"
          ? [desc(marketplaceListing.installCount)]
          : [desc(marketplaceListing.publishedAt)];

    const rows = await this.db
      .select({
        listing: marketplaceListing,
        slug: workflow.slug,
        ownerHandle: user.handle,
      })
      .from(marketplaceListing)
      .innerJoin(workflow, eq(marketplaceListing.workflowId, workflow.id))
      .leftJoin(user, eq(marketplaceListing.publishedBy, user.id))
      .where(and(...galleryConditions(filter)))
      .orderBy(...orderBy)
      .limit(filter.limit ?? 50)
      .offset(filter.offset ?? 0);

    return rows.map((r) => ({ ...r.listing, slug: r.slug, ownerHandle: r.ownerHandle }));
  }

  /** Total gallery rows matching a filter (for pagination). */
  async countGallery(filter: GalleryFilter = {}): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(marketplaceListing)
      .innerJoin(workflow, eq(marketplaceListing.workflowId, workflow.id))
      .where(and(...galleryConditions(filter)));
    return row?.total ?? 0;
  }

  /**
   * Enriched gallery items for a set of listing ids, restricted to listed + public +
   * not-deleted. Order is not guaranteed (the caller re-orders, e.g. by trending rank).
   */
  async getGalleryItemsByIds(ids: string[]): Promise<GalleryItem[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select({
        listing: marketplaceListing,
        slug: workflow.slug,
        ownerHandle: user.handle,
      })
      .from(marketplaceListing)
      .innerJoin(workflow, eq(marketplaceListing.workflowId, workflow.id))
      .leftJoin(user, eq(marketplaceListing.publishedBy, user.id))
      .where(and(inArray(marketplaceListing.id, ids), ...galleryConditions()));
    return rows.map((r) => ({ ...r.listing, slug: r.slug, ownerHandle: r.ownerHandle }));
  }

  /** Minimal references for every publicly listed flow (for the sitemap). */
  async listPublicRefs(limit = 50000): Promise<PublicListingRef[]> {
    const rows = await this.db
      .select({
        slug: workflow.slug,
        ownerHandle: user.handle,
        title: marketplaceListing.title,
        updatedAt: marketplaceListing.updatedAt,
      })
      .from(marketplaceListing)
      .innerJoin(workflow, eq(marketplaceListing.workflowId, workflow.id))
      .leftJoin(user, eq(marketplaceListing.publishedBy, user.id))
      .where(and(...galleryConditions()))
      .orderBy(desc(marketplaceListing.updatedAt))
      .limit(limit);
    return rows.map((r) => ({
      ownerHandle: r.ownerHandle,
      slug: r.slug,
      title: r.title,
      updatedAt: r.updatedAt,
    }));
  }

  // Counters are denormalized analytics, NOT content edits: they intentionally do
  // NOT bump `updatedAt`. `updatedAt` is the listing's content-modified timestamp and
  // feeds the sitemap `<lastmod>`; letting view/install/start traffic move it would
  // corrupt the freshness signal (and create a crawl→view→lastmod feedback loop).

  /**
   * Increment the install counter (a flow was added to a library). Atomic
   * read-modify-write in SQL so concurrent adds do not lose updates.
   */
  async incrementInstallCount(listingId: string): Promise<void> {
    await this.db
      .update(marketplaceListing)
      .set({ installCount: sql`${marketplaceListing.installCount} + 1` })
      .where(eq(marketplaceListing.id, listingId));
  }

  /** Increment the start counter (a flow was started from the listing). Atomic. */
  async incrementStartCount(listingId: string): Promise<void> {
    await this.db
      .update(marketplaceListing)
      .set({ startCount: sql`${marketplaceListing.startCount} + 1` })
      .where(eq(marketplaceListing.id, listingId));
  }

  /** Increment the view counter (a listing detail was viewed). Atomic. */
  async incrementViewCount(listingId: string): Promise<void> {
    await this.db
      .update(marketplaceListing)
      .set({ viewCount: sql`${marketplaceListing.viewCount} + 1` })
      .where(eq(marketplaceListing.id, listingId));
  }

  // ===== Owner / moderation mutations =====

  /** Listings published by a user (any status), newest first (owner dashboard). */
  async listByPublisher(userId: string): Promise<MarketplaceListingRecord[]> {
    return this.db
      .select()
      .from(marketplaceListing)
      .where(eq(marketplaceListing.publishedBy, userId))
      .orderBy(desc(marketplaceListing.createdAt));
  }

  /** Listings in a given moderation status, newest first. */
  async listByStatus(status: string): Promise<MarketplaceListingRecord[]> {
    return this.db
      .select()
      .from(marketplaceListing)
      .where(eq(marketplaceListing.status, status))
      .orderBy(desc(marketplaceListing.createdAt));
  }

  /** Apply owner metadata edits (content change → bumps `updatedAt`). Returns the row. */
  async updateMetadata(
    listingId: string,
    patch: UpdateListingMetadata,
  ): Promise<MarketplaceListingRecord | null> {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.summary !== undefined) set.summary = patch.summary;
    if (patch.category !== undefined) set.category = patch.category;
    if (patch.tags !== undefined) set.tags = JSON.stringify(patch.tags);
    await this.db.update(marketplaceListing).set(set).where(eq(marketplaceListing.id, listingId));
    return this.getById(listingId);
  }

  /** Set the listing status (e.g. listed → unlisted on unpublish; moderation transitions). */
  async setStatus(listingId: string, status: string): Promise<MarketplaceListingRecord | null> {
    await this.db
      .update(marketplaceListing)
      .set({ status, updatedAt: new Date() })
      .where(eq(marketplaceListing.id, listingId));
    return this.getById(listingId);
  }

  /** Re-list a previously unlisted/removed listing, refreshing its metadata. */
  async relist(
    listingId: string,
    patch: UpdateListingMetadata,
  ): Promise<MarketplaceListingRecord | null> {
    return this.updateMetadata(listingId, patch).then(() => this.setStatus(listingId, "listed"));
  }

  /** Grant or revoke the verified badge (admin). Sets verifiedAt/By when granting. */
  async setVerified(
    listingId: string,
    verified: boolean,
    verifiedBy: string | null,
  ): Promise<MarketplaceListingRecord | null> {
    await this.db
      .update(marketplaceListing)
      .set({
        verified,
        verifiedBy: verified ? verifiedBy : null,
        verifiedAt: verified ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(marketplaceListing.id, listingId));
    return this.getById(listingId);
  }

  /** Set the featured flag (admin). */
  async setFeatured(
    listingId: string,
    featured: boolean,
  ): Promise<MarketplaceListingRecord | null> {
    await this.db
      .update(marketplaceListing)
      .set({ featured, updatedAt: new Date() })
      .where(eq(marketplaceListing.id, listingId));
    return this.getById(listingId);
  }
}

/**
 * Shared WHERE for gallery/sitemap queries: listed + public + not-deleted, plus the
 * optional search/category/tag filters. Assumes the `workflow` table is joined.
 */
function galleryConditions(filter: GalleryFilter = {}) {
  const conditions = [
    eq(marketplaceListing.status, "listed"),
    eq(workflow.visibility, "public"),
    or(eq(workflow.deleted, false), isNull(workflow.deleted)),
  ];
  if (filter.category) {
    conditions.push(eq(marketplaceListing.category, filter.category));
  }
  if (filter.search) {
    const q = `%${filter.search}%`;
    conditions.push(or(like(marketplaceListing.title, q), like(marketplaceListing.summary, q)));
  }
  if (filter.tag) {
    // tags is a JSON string array, e.g. ["a","b"]; match the quoted token.
    conditions.push(like(marketplaceListing.tags, `%"${filter.tag}"%`));
  }
  return conditions;
}
