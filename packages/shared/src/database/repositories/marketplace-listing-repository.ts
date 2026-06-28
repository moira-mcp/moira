/**
 * Marketplace Listing Repository — Drizzle queries for the public-gallery record.
 *
 * One listing per workflow (UNIQUE workflowId). Carries gallery metadata, moderation
 * state, denormalized counters, and the (inert) paid columns. The gallery query joins
 * `workflow` so it can enforce "listed AND public AND not deleted" — a listing whose
 * workflow was unpublished or deleted must not surface.
 */

import { eq, and, or, isNull, desc, sql, like, inArray, notInArray, count } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { marketplaceListing, workflow, user } from "../schema.js";
import type * as schema from "../schema.js";
import { v4 as uuidv4 } from "uuid";
import { OFFICIAL_OWNER_IDS } from "../../marketplace/official.js";

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
  /** Restrict to verified listings (the trust badge — may include verified community flows). */
  verified?: boolean;
  /**
   * Restrict to the OFFICIAL set: listings owned by a system/official account
   * ({@link OFFICIAL_OWNER_IDS}). This is the canonical "Official" gallery filter and
   * mirrors the library's owner-based `official` notion, independent of the `verified`
   * trust badge.
   */
  official?: boolean;
  /**
   * Restrict to the COMMUNITY set: listings NOT owned by an official account — the
   * complement of {@link official}. `official` and `community` partition the gallery
   * (official ⊎ community = all), powering the storefront's partition-aware chips.
   */
  community?: boolean;
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

  /**
   * Create a listing (status defaults to "listed"). Returns the stored row.
   *
   * Low-level primitive: it does NOT set `workflow.visibility` and so does NOT enforce
   * the publication invariant (`listed ⟹ public & !deleted`). Production publish goes
   * through {@link publishCoupled}, which writes visibility + status atomically. Use this
   * directly only in tests/admin tooling where the coupling is handled separately.
   */
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

  /**
   * Set the listing status (low-level primitive; e.g. moderation transitions).
   *
   * NOTE: this writes only `status` and does NOT touch `workflow.visibility`. It does
   * NOT enforce the publication invariant (`listed ⟹ public & !deleted`). Setting a
   * listing back to `listed` MUST go through {@link publishCoupled} (or be gated by the
   * service, as `setListingStatus` does) so visibility and status stay consistent.
   */
  async setStatus(listingId: string, status: string): Promise<MarketplaceListingRecord | null> {
    await this.db
      .update(marketplaceListing)
      .set({ status, updatedAt: new Date() })
      .where(eq(marketplaceListing.id, listingId));
    return this.getById(listingId);
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

  // ===== Publication coupling (the single owning path for the invariant) =====
  //
  // Invariant: a `status='listed'` listing ALWAYS references a public, non-deleted
  // workflow. `workflow.visibility` and `marketplaceListing.status` are two columns in
  // two tables, so they can only stay consistent if every transition that touches the
  // pairing writes BOTH atomically. These methods are that single path; callers must use
  // them (not raw updateVisibility + setStatus) to publish/unpublish so the pairing can
  // never split. (The legal `public + no/unlisted listing` state is unaffected — only
  // the listed↔visibility coupling is enforced.)

  /**
   * Publish atomically: set the workflow public AND create (or re-list) its listing in a
   * single transaction. `existingListingId` re-lists a kept (unlisted/removed) row;
   * omit it to create a fresh listing. Returns the resulting listing row.
   */
  async publishCoupled(input: {
    workflowId: string;
    publishedBy: string;
    title: string;
    summary?: string | null;
    category: string;
    tags?: string[];
    existingListingId?: string | null;
  }): Promise<MarketplaceListingRecord> {
    const now = new Date();
    const id = input.existingListingId ?? uuidv4();
    this.db.transaction((tx) => {
      tx.update(workflow)
        .set({ visibility: "public", updatedAt: now })
        .where(eq(workflow.id, input.workflowId))
        .run();
      if (input.existingListingId) {
        tx.update(marketplaceListing)
          .set({
            status: "listed",
            title: input.title,
            summary: input.summary ?? null,
            category: input.category,
            tags: JSON.stringify(input.tags ?? []),
            updatedAt: now,
          })
          .where(eq(marketplaceListing.id, input.existingListingId))
          .run();
      } else {
        tx.insert(marketplaceListing)
          .values({
            id,
            workflowId: input.workflowId,
            publishedBy: input.publishedBy,
            status: "listed",
            title: input.title,
            summary: input.summary ?? null,
            category: input.category,
            tags: JSON.stringify(input.tags ?? []),
            isPaid: false,
            price: null,
            currency: null,
            publishedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
    });
    const saved = await this.getById(id);
    if (!saved) {
      throw new Error(`Failed to publish listing for workflow ${input.workflowId}`);
    }
    return saved;
  }

  /**
   * Unpublish atomically: set the listing `unlisted` AND the workflow private in a single
   * transaction (the listing row is kept for history/reviews). Returns the updated row.
   */
  async unpublishCoupled(input: {
    listingId: string;
    workflowId: string;
  }): Promise<MarketplaceListingRecord | null> {
    const now = new Date();
    this.db.transaction((tx) => {
      tx.update(marketplaceListing)
        .set({ status: "unlisted", updatedAt: now })
        .where(eq(marketplaceListing.id, input.listingId))
        .run();
      tx.update(workflow)
        .set({ visibility: "private", updatedAt: now })
        .where(eq(workflow.id, input.workflowId))
        .run();
    });
    return this.getById(input.listingId);
  }

  /**
   * Unlist any `listed` listing for a workflow without touching its visibility — used
   * when the workflow is deleted (a deleted workflow must not keep a listed listing).
   * Returns true if a row was unlisted. Idempotent.
   */
  async unlistForWorkflow(workflowId: string): Promise<boolean> {
    const result = await this.db
      .update(marketplaceListing)
      .set({ status: "unlisted", updatedAt: new Date() })
      .where(
        and(eq(marketplaceListing.workflowId, workflowId), eq(marketplaceListing.status, "listed")),
      );
    return result.changes > 0;
  }

  /**
   * Startup repair: unlist every `listed` listing whose workflow is private or
   * soft-deleted, converging any pre-existing rows that violate the invariant. Returns
   * the number of listings repaired.
   *
   * NOTE: `scripts/run-migrations.ts` runs an equivalent raw-SQL repair at boot — keep the
   * two predicates (`status='listed'` AND workflow private/deleted) in sync if either changes.
   */
  async repairInconsistentListings(): Promise<number> {
    const offenders = await this.db
      .select({ id: marketplaceListing.id })
      .from(marketplaceListing)
      .innerJoin(workflow, eq(marketplaceListing.workflowId, workflow.id))
      .where(
        and(
          eq(marketplaceListing.status, "listed"),
          or(eq(workflow.visibility, "private"), eq(workflow.deleted, true)),
        ),
      );
    if (offenders.length === 0) return 0;
    const ids = offenders.map((o) => o.id);
    await this.db
      .update(marketplaceListing)
      .set({ status: "unlisted", updatedAt: new Date() })
      .where(inArray(marketplaceListing.id, ids));
    return ids.length;
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
  if (filter.verified === true) {
    conditions.push(eq(marketplaceListing.verified, true));
  }
  if (filter.official === true) {
    conditions.push(inArray(marketplaceListing.publishedBy, [...OFFICIAL_OWNER_IDS]));
  }
  if (filter.community === true) {
    conditions.push(notInArray(marketplaceListing.publishedBy, [...OFFICIAL_OWNER_IDS]));
  }
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
