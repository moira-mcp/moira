/**
 * Marketplace Service — publish/unpublish, the public gallery, detail resolution,
 * the library resolver (core ∪ own ∪ added ∪ shared), add/remove/fork, and the
 * `canAccess` seam (free accessible; paid gated to a "coming soon" decision while
 * selling is off).
 *
 * Library composition (what the agent ultimately sees as its list()):
 *   - core   — bundled system flows (resolved from the on-disk catalog), available to everyone.
 *   - own    — workflows the user owns (`workflow.userId = me`).
 *   - added  — marketplace flows the user added: kind=reference (live pointer to the
 *              author's workflow, auto-updates) or kind=copy (an independent fork).
 *   - shared — flows shared with the user via the existing invite/access mechanism.
 * Core/own are resolved implicitly and are never stored in `libraryEntry`.
 */

import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import type { WorkflowRepository } from "../database/repositories/workflow-repository.js";
import type { WorkflowSharingRepository } from "../database/repositories/workflow-sharing-repository.js";
import type { UserRepository } from "../database/repositories/user-repository.js";
import type {
  MarketplaceListingRepository,
  MarketplaceListingRecord,
  GalleryFilter,
  GalleryItem,
  PublicListingRef,
} from "../database/repositories/marketplace-listing-repository.js";
import { MARKETPLACE_CATEGORIES, normalizeMarketplaceCategory } from "../marketplace/constants.js";
import type {
  LibraryEntryRepository,
  LibraryEntryRecord,
} from "../database/repositories/library-entry-repository.js";
import type {
  MarketplaceReviewRepository,
  MarketplaceReviewRecord,
} from "../database/repositories/marketplace-review-repository.js";
import type {
  MarketplaceEventRepository,
  MarketplaceEventType,
} from "../database/repositories/marketplace-event-repository.js";
import { isMarketplaceEnabled as defaultIsMarketplaceEnabled } from "../config/env.js";
import { readWorkflowCatalog, isSystemOwner } from "./workflow-catalog.js";
import { parseWorkflowReference } from "../validation/slug-handle.js";
import {
  MarketplaceDisabledError,
  ListingNotFoundError,
  WorkflowNotFoundError,
  WorkflowAlreadyListedError,
  ListingAccessDeniedError,
  ListingNotAccessibleError,
  LibraryEntryNotFoundError,
  SelfRatingError,
  InvalidRatingError,
} from "../errors/domain-errors.js";

/** Where a library item came from. */
export type LibraryOrigin = "core" | "own" | "added" | "shared";

/** A resolved library item (what the library resolver returns per flow). */
export interface LibraryItem {
  origin: LibraryOrigin;
  /** Workflow id; null for a bundled core flow that has no per-user DB row. */
  workflowId: string | null;
  slug: string;
  name: string;
  /** For `added` items: reference (live) vs copy (frozen). */
  kind?: "reference" | "copy";
  /** For `added` items: the listing it came from. */
  listingId?: string | null;
  workflow: WorkflowGraph;
}

/** Result of a `canAccess` check. Reason vocabulary matches the design API contract. */
export interface AccessDecision {
  accessible: boolean;
  reason: "free" | "paid-coming-soon" | "purchase-required";
}

/** Result of `rate`: the stored review plus the recomputed listing aggregate. */
export interface RateResult {
  review: MarketplaceReviewRecord;
  ratingAvg: number;
  ratingCount: number;
}

/** Gallery sort options (adds `trending` over the repo's SQL sorts). */
export type GallerySortOption = "recent" | "rating" | "installs" | "trending";

/** Public gallery query parameters. */
export interface GalleryQuery {
  search?: string;
  category?: string;
  tag?: string;
  sort?: GallerySortOption;
  limit?: number;
  offset?: number;
}

/** A page of gallery results with pagination metadata. */
export interface GalleryPage {
  items: GalleryItem[];
  total: number;
  limit: number;
  offset: number;
  sort: GallerySortOption;
}

/** A public review with the author's handle/name resolved (userId not exposed). */
export interface ReviewWithAuthor {
  id: string;
  stars: number;
  reviewText: string | null;
  authorHandle: string | null;
  authorName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Result of a purchase-gated export. */
export interface ExportResult {
  listing: MarketplaceListingRecord;
  workflow: WorkflowGraph;
}

/** Recent-activity window for the trending sort (7 days). */
const TRENDING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Upper bound on gallery offset — caps deep-paging cost on the public surface. */
const MAX_GALLERY_OFFSET = 10_000;

/**
 * Detail view: the listing, its resolved workflow graph, and the render fields the
 * SSR pages (Step 7) and Web UI (Step 8) consume — the owner handle, the `handle/slug`
 * start reference, and the access decision (free vs paid-coming-soon).
 */
export interface ListingDetail {
  listing: MarketplaceListingRecord;
  workflowId: string;
  workflow: WorkflowGraph;
  ownerHandle: string;
  startRef: string;
  entitlement: AccessDecision;
}

/** Metadata overrides accepted at publish time. */
export interface PublishOptions {
  title?: string;
  summary?: string | null;
  category?: string;
  tags?: string[];
}

/** Injectable feature predicates + core provider (defaults wire to the real ones). */
export interface MarketplaceServiceOptions {
  isMarketplaceEnabled?: () => boolean;
  isPaidEnabled?: () => boolean;
  /** Provides the bundled "core" flows. Default reads the on-disk system catalog. */
  coreProvider?: () => CoreFlow[];
}

/** A bundled core flow as exposed to the library resolver. */
export interface CoreFlow {
  workflowId: string | null;
  slug: string;
  name: string;
  workflow: WorkflowGraph;
}

export class MarketplaceService {
  private readonly isMarketplaceEnabled: () => boolean;
  private readonly isPaidEnabled: () => boolean;
  private readonly coreProvider: () => CoreFlow[];

  constructor(
    private listingRepo: MarketplaceListingRepository,
    private libraryRepo: LibraryEntryRepository,
    private reviewRepo: MarketplaceReviewRepository,
    private eventRepo: MarketplaceEventRepository,
    private workflowRepo: WorkflowRepository,
    private sharingRepo: WorkflowSharingRepository,
    private userRepo: UserRepository,
    options: MarketplaceServiceOptions = {},
  ) {
    this.isMarketplaceEnabled = options.isMarketplaceEnabled ?? defaultIsMarketplaceEnabled;
    this.isPaidEnabled = options.isPaidEnabled ?? (() => false);
    this.coreProvider = options.coreProvider ?? defaultCoreProvider;
  }

  // ===== Publish / Unpublish =====

  /**
   * Publish a workflow: set it public and create its listing. Only the owner may
   * publish; a workflow may be listed once.
   */
  async publish(
    userId: string,
    workflowId: string,
    options: PublishOptions = {},
  ): Promise<MarketplaceListingRecord> {
    this.assertEnabled();

    const ownership = await this.workflowRepo.getOwnership(workflowId);
    if (!ownership.exists || !ownership.id) {
      throw new WorkflowNotFoundError(workflowId);
    }
    if (ownership.ownerId !== userId) {
      throw new ListingAccessDeniedError(workflowId, "publish");
    }
    if (await this.listingRepo.getByWorkflowId(workflowId)) {
      throw new WorkflowAlreadyListedError(workflowId);
    }

    await this.workflowRepo.updateVisibility(workflowId, userId, "public");

    const info = await this.workflowRepo.getFullInfo(workflowId, userId);
    const title = options.title ?? info?.metadata.name ?? ownership.name ?? "Untitled workflow";
    const summary = options.summary ?? info?.metadata.description ?? null;
    const category = normalizeMarketplaceCategory(options.category);
    const tags = options.tags ?? info?.metadata.tags ?? [];

    return this.listingRepo.create({
      workflowId,
      publishedBy: userId,
      title,
      summary,
      category,
      tags,
    });
  }

  /** Unpublish: delete the listing and make the workflow private again. Owner only. */
  async unpublish(userId: string, workflowId: string): Promise<void> {
    this.assertEnabled();

    const listing = await this.listingRepo.getByWorkflowId(workflowId);
    if (!listing) {
      throw new ListingNotFoundError(workflowId, "workflowId");
    }
    if (listing.publishedBy !== userId) {
      throw new ListingAccessDeniedError(workflowId, "unpublish");
    }

    await this.listingRepo.deleteByWorkflowId(workflowId);
    await this.workflowRepo.updateVisibility(workflowId, userId, "private");
  }

  // ===== Gallery / Detail =====

  /**
   * Public gallery with search/category/tag filters, sort (recent/rating/installs/
   * trending) and pagination. Returns the page items + the total matching count.
   */
  async getGallery(query: GalleryQuery = {}): Promise<GalleryPage> {
    this.assertEnabled();
    const limit = clamp(query.limit ?? 24, 1, 100);
    // Clamp offset so an unauthenticated caller cannot force deep-paging scans.
    const offset = clamp(query.offset ?? 0, 0, MAX_GALLERY_OFFSET);
    const category = query.category ? normalizeMarketplaceCategory(query.category) : undefined;
    const filter: GalleryFilter = { search: query.search, category, tag: query.tag };
    const sort: GallerySortOption = query.sort ?? "recent";

    if (sort === "trending") {
      // Rank by recent install/start activity, then apply the gallery filters and
      // paginate over the trending set.
      const ranked = await this.eventRepo.trending({
        sinceMs: Date.now() - TRENDING_WINDOW_MS,
        limit: 500,
        types: ["install", "start"],
      });
      const rank = new Map(ranked.map((e, i) => [e.listingId, i]));
      const all = await this.listingRepo.getGalleryItemsByIds(ranked.map((e) => e.listingId));
      const matched = all
        .filter((item) => matchesGalleryFilter(item, filter))
        .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
      return {
        items: matched.slice(offset, offset + limit),
        total: matched.length,
        limit,
        offset,
        sort,
      };
    }

    const items = await this.listingRepo.listGallery({ ...filter, sort, limit, offset });
    const total = await this.listingRepo.countGallery(filter);
    return { items, total, limit, offset, sort };
  }

  /** The fixed category set (id + label), for the public categories endpoint. */
  getCategories(): ReadonlyArray<{ id: string; label: string }> {
    return MARKETPLACE_CATEGORIES;
  }

  /**
   * Reviews for a listed flow resolved by `handle/slug` (graph-free: reviews never
   * need the workflow definition, so this avoids parsing it on the public hot path).
   */
  async getReviewsByReference(reference: string): Promise<ReviewWithAuthor[]> {
    const { listing, workflowId } = await this.resolveListedRef(reference);
    const ownership = await this.workflowRepo.getOwnership(workflowId);
    if (ownership.visibility !== "public") {
      throw new ListingNotFoundError(reference);
    }
    return this.getReviewsWithAuthors(listing.id);
  }

  /** Reviews for a listing with author handle/name resolved (no userId exposed). */
  async getReviewsWithAuthors(listingId: string): Promise<ReviewWithAuthor[]> {
    this.assertEnabled();
    const reviews = await this.reviewRepo.listByListing(listingId);
    const profiles = await this.userRepo.getPublicProfilesByIds([
      ...new Set(reviews.map((r) => r.userId)),
    ]);
    return reviews.map((r) => {
      const profile = profiles.get(r.userId);
      return {
        id: r.id,
        stars: r.stars,
        reviewText: r.reviewText,
        authorHandle: profile?.handle ?? null,
        authorName: profile?.name ?? null,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  /** Minimal references for every publicly listed flow (for the sitemap). */
  async getSitemapRefs(): Promise<PublicListingRef[]> {
    this.assertEnabled();
    return this.listingRepo.listPublicRefs();
  }

  /**
   * Purchase-gated export: resolve a listed/public flow by `handle/slug` and return
   * its workflow definition for download. Free flows are exportable; paid flows are
   * denied unless accessible (entitlement) — currently "coming soon" while selling is off.
   */
  async exportListing(reference: string, currentUserId: string): Promise<ExportResult> {
    const detail = await this.getDetailByReference(reference, currentUserId);
    if (!detail.entitlement.accessible) {
      throw new ListingNotAccessibleError(detail.listing.id, detail.entitlement.reason);
    }
    return { listing: detail.listing, workflow: detail.workflow };
  }

  /** Resolve a listing detail by `handle/slug`. Throws if no listed flow matches. */
  async getDetailByReference(reference: string, currentUserId: string): Promise<ListingDetail> {
    const { parsed, workflowId, listing } = await this.resolveListedRef(reference);
    // One read fetches visibility + the graph together (no separate getOwnership +
    // get). getFullInfo returns null unless the caller may access the flow; require
    // public so a stale listing on a now-private workflow is not detail-resolvable
    // (predicate parity with the gallery), even when the caller is the owner.
    const info = await this.workflowRepo.getFullInfo(workflowId, currentUserId);
    if (!info || info.visibility !== "public") {
      throw new ListingNotFoundError(reference);
    }
    return {
      listing,
      workflowId,
      workflow: info.workflow,
      ownerHandle: parsed.handle,
      startRef: reference,
      entitlement: this.canAccess(listing),
    };
  }

  /**
   * Resolve a `handle/slug` reference to its listed listing without fetching the
   * workflow graph. Shared prefix for detail/reviews/export. Throws
   * ListingNotFoundError unless a `status='listed'` listing exists for the flow.
   */
  private async resolveListedRef(
    reference: string,
  ): Promise<{
    parsed: { handle: string; slug: string };
    workflowId: string;
    listing: MarketplaceListingRecord;
  }> {
    this.assertEnabled();
    const parsed = parseWorkflowReference(reference);
    if (!parsed) {
      throw new ListingNotFoundError(reference);
    }
    const ownerId = await this.userRepo.resolveHandle(parsed.handle);
    if (!ownerId) {
      throw new ListingNotFoundError(reference);
    }
    const workflowId = await this.workflowRepo.resolveSlug(parsed.slug, ownerId);
    if (!workflowId) {
      throw new ListingNotFoundError(reference);
    }
    const listing = await this.listingRepo.getByWorkflowId(workflowId);
    if (!listing || listing.status !== "listed") {
      throw new ListingNotFoundError(reference);
    }
    return { parsed, workflowId, listing };
  }

  // ===== Library resolver =====

  /**
   * Compose the user's library: core ∪ own ∪ added ∪ shared. Deduplicated by
   * workflowId (own wins over added wins over shared). Arbitrary public flows the
   * user has not added/owned/shared are NOT included.
   */
  async getLibrary(userId: string): Promise<LibraryItem[]> {
    this.assertEnabled();

    const items: LibraryItem[] = [];
    const seenWorkflowIds = new Set<string>();

    // core — bundled flows, available to everyone (resolved by slug, not stored per user).
    for (const core of this.coreProvider()) {
      items.push({
        origin: "core",
        workflowId: core.workflowId,
        slug: core.slug,
        name: core.name,
        workflow: core.workflow,
      });
    }

    // own — workflows the user owns. list() also surfaces public/shared flows for
    // discovery, so restrict to genuinely owned ones (accessType === "owner").
    const own = await this.workflowRepo.list(userId);
    for (const w of own.filter((w) => w.accessType === "owner")) {
      seenWorkflowIds.add(w.id);
      items.push({
        origin: "own",
        workflowId: w.id,
        slug: w.slug,
        name: w.metadata.name,
        workflow: w.workflow,
      });
    }

    // added — marketplace flows in the library (reference resolves the author's
    // LATEST version; copy is the user's own frozen workflow row).
    const entries = await this.libraryRepo.listByUser(userId);
    for (const entry of entries.filter((e) => e.source === "added")) {
      if (seenWorkflowIds.has(entry.workflowId)) continue;
      const info = await this.workflowRepo.getFullInfo(entry.workflowId, userId);
      if (!info) continue; // author deleted/unpublished — skip silently
      seenWorkflowIds.add(entry.workflowId);
      items.push({
        origin: "added",
        workflowId: entry.workflowId,
        slug: info.slug,
        name: info.metadata.name,
        kind: entry.kind as "reference" | "copy",
        listingId: entry.listingId,
        workflow: info.workflow,
      });
    }

    // shared — flows shared via the existing invite/access mechanism.
    const sharedIds = await this.sharingRepo.listUserAccess(userId);
    for (const sharedId of sharedIds) {
      if (seenWorkflowIds.has(sharedId)) continue;
      const info = await this.workflowRepo.getFullInfo(sharedId, userId);
      if (!info) continue;
      seenWorkflowIds.add(sharedId);
      items.push({
        origin: "shared",
        workflowId: sharedId,
        slug: info.slug,
        name: info.metadata.name,
        workflow: info.workflow,
      });
    }

    return items;
  }

  // ===== Add / Remove / Fork =====

  /** Add a listing to the user's library as a live reference (auto-updates). */
  async add(userId: string, listingId: string): Promise<LibraryEntryRecord> {
    this.assertEnabled();

    const listing = await this.requireListedListing(listingId);
    this.assertAccessible(listing);

    const existing = await this.libraryRepo.getByUserAndWorkflow(userId, listing.workflowId);
    if (existing) {
      return existing; // idempotent
    }

    const entry = await this.libraryRepo.add({
      userId,
      workflowId: listing.workflowId,
      source: "added",
      kind: "reference",
      listingId,
    });
    await this.listingRepo.incrementInstallCount(listingId);
    await this.eventRepo.record({ listingId, userId, type: "install" });
    return entry;
  }

  /** Remove a flow from the user's library. */
  async remove(userId: string, workflowId: string): Promise<void> {
    this.assertEnabled();
    const removed = await this.libraryRepo.remove(userId, workflowId);
    if (!removed) {
      throw new LibraryEntryNotFoundError(workflowId);
    }
  }

  /**
   * Fork a listing: copy the author's workflow into an independent, private
   * workflow owned by the user (a frozen snapshot — no auto-update), and record it
   * in the library as kind=copy.
   */
  async fork(userId: string, listingId: string): Promise<{ workflowId: string; slug: string }> {
    this.assertEnabled();

    const listing = await this.requireListedListing(listingId);
    this.assertAccessible(listing);

    const sourceGraph = await this.workflowRepo.get(listing.workflowId, userId);
    if (!sourceGraph) {
      throw new WorkflowNotFoundError(listing.workflowId);
    }

    // Deep clone, drop the id so save() assigns a fresh one (independent row).
    const clone = JSON.parse(JSON.stringify(sourceGraph)) as WorkflowGraph;
    delete clone.id;
    const baseName = clone.metadata?.name ?? "forked-workflow";
    const slug = await this.workflowRepo.generateUniqueSlug(userId, baseName);
    const saved = await this.workflowRepo.save({
      graph: clone,
      userId,
      slug,
      visibility: "private",
    });

    await this.libraryRepo.add({
      userId,
      workflowId: saved.id,
      source: "added",
      kind: "copy",
      listingId,
    });
    await this.listingRepo.incrementInstallCount(listingId);
    await this.eventRepo.record({ listingId, userId, type: "install" });
    return { workflowId: saved.id, slug: saved.slug };
  }

  // ===== Ratings / reviews =====

  /**
   * Rate (and optionally review) a listing. One editable review per user; the
   * author cannot rate their own listing. Recomputes the listing's rating
   * aggregate transactionally and records a `rate` analytics event. Returns the
   * review plus the new aggregate (so callers need not re-query the listing).
   */
  async rate(
    userId: string,
    listingId: string,
    stars: number,
    reviewText?: string | null,
  ): Promise<RateResult> {
    this.assertEnabled();

    if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
      throw new InvalidRatingError(stars);
    }
    const listing = await this.requireListedListing(listingId);
    if (listing.publishedBy === userId) {
      throw new SelfRatingError();
    }

    const { review, aggregate } = await this.reviewRepo.upsertAndRecompute({
      listingId,
      userId,
      stars,
      reviewText: reviewText ?? null,
    });
    await this.eventRepo.record({ listingId, userId, type: "rate" });
    return { review, ratingAvg: aggregate.ratingAvg, ratingCount: aggregate.ratingCount };
  }

  /**
   * Remove the user's review and recompute the aggregate. Idempotent: a no-op
   * (does not throw) when the user has no review for the listing.
   */
  async removeReview(userId: string, listingId: string): Promise<void> {
    this.assertEnabled();
    await this.reviewRepo.deleteAndRecompute(listingId, userId);
  }

  /** All reviews for a listing (newest first). */
  async getReviews(listingId: string): Promise<MarketplaceReviewRecord[]> {
    this.assertEnabled();
    return this.reviewRepo.listByListing(listingId);
  }

  // ===== Analytics events / counters =====
  // recordView/recordStart are fire-and-forget telemetry emitted FROM already-gated
  // action sites (a resolved detail view / a started flow); they intentionally skip
  // assertEnabled() so analytics never blocks or fails the user-facing action.

  /** Record a listing-detail view (event + counter). */
  async recordView(listingId: string, userId?: string | null): Promise<void> {
    await this.recordSignal(listingId, userId, "view");
  }

  /** Record that a flow was started from the listing (event + counter). */
  async recordStart(listingId: string, userId?: string | null): Promise<void> {
    await this.recordSignal(listingId, userId, "start");
  }

  /**
   * Trending listings: those with the most recent activity in the window, ranked
   * highest first. Trending is derived from recent INSTALL and START signals
   * (per the design) — view/rate noise is excluded. Only currently-listed listings
   * are returned.
   */
  async getTrending(
    options: { windowMs?: number; limit?: number } = {},
  ): Promise<MarketplaceListingRecord[]> {
    this.assertEnabled();
    const windowMs = options.windowMs ?? 7 * 24 * 60 * 60 * 1000; // 7 days
    const limit = options.limit ?? 20;
    const entries = await this.eventRepo.trending({
      sinceMs: Date.now() - windowMs,
      limit,
      types: ["install", "start"],
    });

    const listings: MarketplaceListingRecord[] = [];
    for (const entry of entries) {
      const listing = await this.listingRepo.getById(entry.listingId);
      if (listing && listing.status === "listed") {
        listings.push(listing);
      }
    }
    return listings;
  }

  // ===== Access seam =====

  /**
   * Whether the user may obtain this listing. Free listings are always accessible.
   * Paid listings are gated: while selling is off they resolve to a "coming soon"
   * decision; once selling is on, access is entitlement-based (resolved elsewhere).
   */
  canAccess(listing: MarketplaceListingRecord): AccessDecision {
    if (!listing.isPaid) {
      return { accessible: true, reason: "free" };
    }
    if (!this.isPaidEnabled()) {
      return { accessible: false, reason: "paid-coming-soon" };
    }
    return { accessible: false, reason: "purchase-required" };
  }

  // ===== Internals =====

  private assertEnabled(): void {
    if (!this.isMarketplaceEnabled()) {
      throw new MarketplaceDisabledError();
    }
  }

  private async requireListedListing(listingId: string): Promise<MarketplaceListingRecord> {
    const listing = await this.listingRepo.getById(listingId);
    if (!listing || listing.status !== "listed") {
      throw new ListingNotFoundError(listingId);
    }
    return listing;
  }

  /** Append an analytics event and bump the matching denormalized counter. */
  private async recordSignal(
    listingId: string,
    userId: string | null | undefined,
    type: Extract<MarketplaceEventType, "view" | "start">,
  ): Promise<void> {
    await this.eventRepo.record({ listingId, userId, type });
    if (type === "view") {
      await this.listingRepo.incrementViewCount(listingId);
    } else {
      await this.listingRepo.incrementStartCount(listingId);
    }
  }

  private assertAccessible(listing: MarketplaceListingRecord): void {
    const decision = this.canAccess(listing);
    if (!decision.accessible) {
      throw new ListingNotAccessibleError(listing.id, decision.reason);
    }
  }
}

/** Clamp a number into [min, max]. */
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

/** In-memory gallery filter (used for the trending path, post-ranking). */
function matchesGalleryFilter(item: GalleryItem, filter: GalleryFilter): boolean {
  if (filter.category && item.category !== filter.category) return false;
  if (filter.search) {
    const q = filter.search.toLowerCase();
    const haystack = `${item.title} ${item.summary ?? ""}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (filter.tag) {
    let tags: string[] = [];
    try {
      tags = JSON.parse(item.tags) as string[];
    } catch {
      tags = [];
    }
    if (!tags.includes(filter.tag)) return false;
  }
  return true;
}

/** Default core provider: bundled system flows from the on-disk catalog. */
function defaultCoreProvider(): CoreFlow[] {
  return readWorkflowCatalog()
    .filter((entry) => isSystemOwner(entry.owner))
    .map((entry) => {
      const graph = entry.graph as unknown as WorkflowGraph;
      return {
        workflowId: typeof graph.id === "string" ? graph.id : null,
        slug: entry.slug,
        name: graph.metadata?.name ?? entry.slug,
        workflow: graph,
      };
    });
}
