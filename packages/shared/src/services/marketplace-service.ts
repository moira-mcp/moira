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
import { readWorkflowCatalog } from "./workflow-catalog.js";
import { parseWorkflowReference } from "../validation/slug-handle.js";
import {
  MarketplaceDisabledError,
  ListingNotFoundError,
  WorkflowNotFoundError,
  UserNotFoundError,
  WorkflowAlreadyListedError,
  ListingAccessDeniedError,
  ListingNotAccessibleError,
  LibraryEntryNotFoundError,
  SelfRatingError,
  InvalidRatingError,
  PaidListingsDisabledError,
  InvalidListingStatusError,
} from "../errors/domain-errors.js";

/** Legal moderation statuses for a listing (admin status transitions are validated against this). */
export const MARKETPLACE_LISTING_STATUSES = [
  "listed",
  "unlisted",
  "pending",
  "rejected",
  "removed",
] as const;
export type MarketplaceListingStatus = (typeof MARKETPLACE_LISTING_STATUSES)[number];

/** Where a library item came from. */
export type LibraryOrigin = "core" | "own" | "added" | "shared";

/** A resolved library item (what the library resolver returns per flow). */
export interface LibraryItem {
  origin: LibraryOrigin;
  /** Workflow id; null for a bundled core flow that has no per-user DB row. */
  workflowId: string | null;
  slug: string;
  name: string;
  /** Owner handle (for building a `handle/slug` start reference); null for core flows. */
  ownerHandle: string | null;
  /** For `added` items: reference (live) vs copy (frozen). */
  kind?: "reference" | "copy";
  /** For `added` items: the listing it came from. */
  listingId?: string | null;
  workflow: WorkflowGraph;
}

/** Library source filter (for `getLibrary`): a single origin, or every origin. */
export type LibrarySourceFilter = LibraryOrigin | "all";

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
  /** Paid fields — rejected while the `paidWorkflows` feature is disabled. */
  isPaid?: boolean;
  price?: number | null;
  tier?: string | null;
}

/** Owner-editable listing fields (PATCH). */
export interface UpdateListingOptions {
  title?: string;
  summary?: string | null;
  category?: string;
  tags?: string[];
}

/** Result of an entitlement check: free/owner are accessible; paid is gated. */
export interface EntitlementResult {
  hasAccess: boolean;
  reason: "free" | "owner" | "paid-coming-soon" | "purchase-required";
}

/** Result of adopting a listing into the library (install). */
export interface InstallResult {
  entry: LibraryEntryRecord;
  startRef: string;
}

/** Options for sharing a workflow by link. */
export interface ShareOptions {
  /** Grant a specific user direct access; omit to create an invite link instead. */
  userHandle?: string;
}

/** Result of a share: either a direct grant or a generated invite link token. */
export interface ShareResult {
  sharedWithHandle?: string;
  inviteToken?: string;
  expiresAt?: number;
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
  /** Owner handle for the start reference (`moira` for the public system owner). */
  ownerHandle?: string | null;
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
    this.assertNoPaidFields(options);

    const ownership = await this.workflowRepo.getOwnership(workflowId);
    if (!ownership.exists || !ownership.id) {
      throw new WorkflowNotFoundError(workflowId);
    }
    if (ownership.ownerId !== userId) {
      throw new ListingAccessDeniedError(workflowId, "publish");
    }

    // A workflow may carry at most one listing. A currently-listed row blocks
    // re-publishing; an unlisted/removed row is re-listed (its history is kept).
    const existing = await this.listingRepo.getByWorkflowId(workflowId);
    if (existing && existing.status === "listed") {
      throw new WorkflowAlreadyListedError(workflowId);
    }

    await this.workflowRepo.updateVisibility(workflowId, userId, "public");

    const info = await this.workflowRepo.getFullInfo(workflowId, userId);
    const title = options.title ?? info?.metadata.name ?? ownership.name ?? "Untitled workflow";
    const summary = options.summary ?? info?.metadata.description ?? null;
    const category = normalizeMarketplaceCategory(options.category);
    const tags = options.tags ?? info?.metadata.tags ?? [];

    if (existing) {
      const relisted = await this.listingRepo.relist(existing.id, {
        title,
        summary,
        category,
        tags,
      });
      if (!relisted) {
        throw new ListingNotFoundError(existing.id);
      }
      return relisted;
    }

    return this.listingRepo.create({
      workflowId,
      publishedBy: userId,
      title,
      summary,
      category,
      tags,
    });
  }

  /**
   * Unpublish: set the listing `unlisted` (the row is kept so reviews/counters/history
   * survive) and make the workflow private again. Owner only; idempotent.
   */
  async unpublish(userId: string, workflowId: string): Promise<void> {
    this.assertEnabled();

    const listing = await this.listingRepo.getByWorkflowId(workflowId);
    if (!listing) {
      throw new ListingNotFoundError(workflowId, "workflowId");
    }
    if (listing.publishedBy !== userId) {
      throw new ListingAccessDeniedError(workflowId, "unpublish");
    }

    await this.listingRepo.setStatus(listing.id, "unlisted");
    await this.workflowRepo.updateVisibility(workflowId, userId, "private");
  }

  /** Unpublish by listing id (authed HTTP path). Owner only; idempotent. */
  async unpublishById(userId: string, listingId: string): Promise<void> {
    this.assertEnabled();
    const listing = await this.requireExistingListing(listingId);
    if (listing.publishedBy !== userId) {
      throw new ListingAccessDeniedError(listingId, "unpublish");
    }
    await this.listingRepo.setStatus(listing.id, "unlisted");
    await this.workflowRepo.updateVisibility(listing.workflowId, userId, "private");
  }

  /** Reject paid publish fields while the `paidWorkflows` feature is disabled. */
  private assertNoPaidFields(options: PublishOptions): void {
    const wantsPaid = options.isPaid === true || options.price != null || options.tier != null;
    if (wantsPaid && !this.isPaidEnabled()) {
      throw new PaidListingsDisabledError();
    }
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
  private async resolveListedRef(reference: string): Promise<{
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

  /**
   * Resolve a listing detail by listing id (authed callers use the id, not the
   * `handle/slug`). The caller must be able to access the workflow (public, or the
   * owner). Used as the publish/PATCH response and by owner-facing reads.
   */
  async getDetailById(listingId: string, currentUserId: string): Promise<ListingDetail> {
    this.assertEnabled();
    const listing = await this.listingRepo.getById(listingId);
    if (!listing) {
      throw new ListingNotFoundError(listingId);
    }
    const info = await this.workflowRepo.getFullInfo(listing.workflowId, currentUserId);
    if (!info) {
      throw new ListingNotFoundError(listingId);
    }
    return {
      listing,
      workflowId: listing.workflowId,
      workflow: info.workflow,
      ownerHandle: info.ownerHandle,
      startRef: `${info.ownerHandle}/${info.slug}`,
      entitlement: this.canAccess(listing),
    };
  }

  // ===== Owner listing management =====

  /** Listings published by the user (any status), for the owner dashboard. */
  async getMyListings(userId: string): Promise<MarketplaceListingRecord[]> {
    this.assertEnabled();
    return this.listingRepo.listByPublisher(userId);
  }

  /** Apply owner metadata edits to a listing. Owner only. */
  async updateListing(
    userId: string,
    listingId: string,
    options: UpdateListingOptions,
  ): Promise<MarketplaceListingRecord> {
    this.assertEnabled();
    const listing = await this.requireExistingListing(listingId);
    if (listing.publishedBy !== userId) {
      throw new ListingAccessDeniedError(listingId, "manage");
    }
    const patch: UpdateListingOptions = { ...options };
    if (options.category !== undefined) {
      patch.category = normalizeMarketplaceCategory(options.category);
    }
    const updated = await this.listingRepo.updateMetadata(listingId, patch);
    if (!updated) {
      throw new ListingNotFoundError(listingId);
    }
    return updated;
  }

  /**
   * Entitlement for the current user: the listing's owner and free listings are
   * always accessible; paid listings are gated ("coming soon" while selling is off).
   */
  async getEntitlement(userId: string, listingId: string): Promise<EntitlementResult> {
    this.assertEnabled();
    const listing = await this.requireListedListing(listingId);
    if (listing.publishedBy === userId) {
      return { hasAccess: true, reason: "owner" };
    }
    const decision = this.canAccess(listing);
    return { hasAccess: decision.accessible, reason: decision.reason };
  }

  /**
   * Adopt a listing into the user's library as a live reference and return the
   * `handle/slug` start reference (so the caller can `start()` it). Bumps
   * `installCount` (via `add`). Idempotent.
   */
  async install(userId: string, listingId: string): Promise<InstallResult> {
    this.assertEnabled();
    const listing = await this.requireListedListing(listingId);
    const entry = await this.add(userId, listingId);
    return { entry, startRef: await this.referenceOf(listing) };
  }

  // ===== Admin moderation =====

  /** Grant the verified badge. Admin only. */
  async verifyListing(adminId: string, listingId: string): Promise<MarketplaceListingRecord> {
    this.assertEnabled();
    await this.requireExistingListing(listingId);
    const updated = await this.listingRepo.setVerified(listingId, true, adminId);
    if (!updated) {
      throw new ListingNotFoundError(listingId);
    }
    return updated;
  }

  /** Revoke the verified badge. Admin only. */
  async unverifyListing(listingId: string): Promise<MarketplaceListingRecord> {
    this.assertEnabled();
    await this.requireExistingListing(listingId);
    const updated = await this.listingRepo.setVerified(listingId, false, null);
    if (!updated) {
      throw new ListingNotFoundError(listingId);
    }
    return updated;
  }

  /** Set the featured flag. Admin only. */
  async setListingFeatured(
    listingId: string,
    featured: boolean,
  ): Promise<MarketplaceListingRecord> {
    this.assertEnabled();
    await this.requireExistingListing(listingId);
    const updated = await this.listingRepo.setFeatured(listingId, featured);
    if (!updated) {
      throw new ListingNotFoundError(listingId);
    }
    return updated;
  }

  /** Moderation queue: listings in a given status (default `pending`). Admin only. */
  async getModerationQueue(status = "pending"): Promise<MarketplaceListingRecord[]> {
    this.assertEnabled();
    return this.listingRepo.listByStatus(status);
  }

  /** Transition a listing's moderation status (approve/reject). Admin only. */
  async setListingStatus(listingId: string, status: string): Promise<MarketplaceListingRecord> {
    this.assertEnabled();
    if (!(MARKETPLACE_LISTING_STATUSES as readonly string[]).includes(status)) {
      throw new InvalidListingStatusError(status, MARKETPLACE_LISTING_STATUSES);
    }
    await this.requireExistingListing(listingId);
    const updated = await this.listingRepo.setStatus(listingId, status);
    if (!updated) {
      throw new ListingNotFoundError(listingId);
    }
    return updated;
  }

  // ===== Share-by-link (reuses workflowAccess / workflowInvite) =====

  /**
   * Share a workflow privately. With `userHandle`, grants that user direct access
   * (appears as "shared" in their library). Without it, creates an invite link the
   * owner can hand out. Owner only. Reuses the existing access/invite mechanism — no
   * marketplace listing is created.
   */
  async share(
    ownerId: string,
    workflowId: string,
    options: ShareOptions = {},
  ): Promise<ShareResult> {
    this.assertEnabled();
    const ownership = await this.workflowRepo.getOwnership(workflowId);
    if (!ownership.exists || !ownership.id) {
      throw new WorkflowNotFoundError(workflowId);
    }
    if (ownership.ownerId !== ownerId) {
      throw new ListingAccessDeniedError(workflowId, "manage");
    }

    if (options.userHandle) {
      const targetUserId = await this.userRepo.resolveHandle(options.userHandle);
      if (!targetUserId) {
        throw new UserNotFoundError(options.userHandle);
      }
      await this.sharingRepo.grantAccess(workflowId, targetUserId, ownerId);
      return { sharedWithHandle: options.userHandle };
    }

    const invite = await this.sharingRepo.createInvite({ workflowId, createdBy: ownerId });
    return { inviteToken: invite.token, expiresAt: invite.expiresAt };
  }

  /**
   * Fire-and-forget: if the started workflow (by id, slug, or `handle/slug`) is a
   * listed flow, record a `start` analytics signal. Never throws — telemetry must not
   * break the start path.
   */
  async recordStartForReference(identifier: string, userId?: string | null): Promise<void> {
    try {
      let workflowId = identifier;
      if (identifier.includes("/")) {
        const parsed = parseWorkflowReference(identifier);
        if (!parsed) return;
        const ownerId = await this.userRepo.resolveHandle(parsed.handle);
        if (!ownerId) return;
        const resolved = await this.workflowRepo.resolveSlug(parsed.slug, ownerId);
        if (!resolved) return;
        workflowId = resolved;
      }
      const listing = await this.listingRepo.getByWorkflowId(workflowId);
      if (listing && listing.status === "listed") {
        await this.recordStart(listing.id, userId ?? null);
      }
    } catch {
      // Telemetry: swallow — a missing listing or unresolved reference is a no-op.
    }
  }

  /** Build the `handle/slug` reference for a listing's workflow. */
  private async referenceOf(listing: MarketplaceListingRecord): Promise<string> {
    const info = await this.workflowRepo.getFullInfo(listing.workflowId, listing.publishedBy);
    const profiles = await this.userRepo.getPublicProfilesByIds([listing.publishedBy]);
    const handle = profiles.get(listing.publishedBy)?.handle;
    if (!info || !handle) {
      throw new ListingNotFoundError(listing.id);
    }
    return `${handle}/${info.slug}`;
  }

  /** Fetch a listing of any status, or throw ListingNotFoundError. */
  private async requireExistingListing(listingId: string): Promise<MarketplaceListingRecord> {
    const listing = await this.listingRepo.getById(listingId);
    if (!listing) {
      throw new ListingNotFoundError(listingId);
    }
    return listing;
  }

  // ===== Library resolver =====

  /**
   * Compose the user's library: core ∪ own ∪ added ∪ shared. Deduplicated by
   * workflowId (own wins over added wins over shared). Arbitrary public flows the
   * user has not added/owned/shared are NOT included.
   *
   * The library is a LOCAL concept and does NOT require the marketplace store to be
   * enabled (self-host still returns core + own + shared). `assertEnabled` gates only
   * the store actions (search/info/add/publish/rate/share), not library resolution.
   *
   * `source` optionally restricts the result to a single origin (or "all").
   */
  async getLibrary(userId: string, source: LibrarySourceFilter = "all"): Promise<LibraryItem[]> {
    const include = (origin: LibraryOrigin): boolean => source === "all" || source === origin;
    const items: LibraryItem[] = [];
    const seenWorkflowIds = new Set<string>();

    // core — bundled flows, available to everyone (resolved by slug, not stored per user).
    if (include("core")) {
      for (const core of this.coreProvider()) {
        items.push({
          origin: "core",
          workflowId: core.workflowId,
          slug: core.slug,
          name: core.name,
          ownerHandle: core.ownerHandle ?? null,
          workflow: core.workflow,
        });
      }
    }

    // own — workflows the user owns. list() also surfaces public/shared flows for
    // discovery, so restrict to genuinely owned ones (accessType === "owner").
    const own = await this.workflowRepo.list(userId);
    for (const w of own.filter((w) => w.accessType === "owner")) {
      seenWorkflowIds.add(w.id);
      if (!include("own")) continue;
      items.push({
        origin: "own",
        workflowId: w.id,
        slug: w.slug,
        name: w.metadata.name,
        ownerHandle: w.ownerHandle,
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
      if (!include("added")) continue;
      items.push({
        origin: "added",
        workflowId: entry.workflowId,
        slug: info.slug,
        name: info.metadata.name,
        ownerHandle: info.ownerHandle,
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
      if (!include("shared")) continue;
      items.push({
        origin: "shared",
        workflowId: sharedId,
        slug: info.slug,
        name: info.metadata.name,
        ownerHandle: info.ownerHandle,
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

/** Handle of the public system owner — core flows are referenced as `moira/<slug>`. */
const SYSTEM_PUBLIC_OWNER = "system-moira";
const SYSTEM_PUBLIC_HANDLE = "moira";

/**
 * Default core provider: the bundled PUBLIC system flows from the on-disk catalog.
 * Only `system-moira` (public) flows are core for everyone — `system-admin` flows are
 * private. The catalog's on-disk graph id is NOT the installed DB id, so cores carry no
 * `workflowId`; they are started by their `moira/<slug>` reference instead.
 */
function defaultCoreProvider(): CoreFlow[] {
  return readWorkflowCatalog()
    .filter((entry) => entry.owner === SYSTEM_PUBLIC_OWNER)
    .map((entry) => {
      const graph = entry.graph as unknown as WorkflowGraph;
      return {
        workflowId: null,
        slug: entry.slug,
        name: graph.metadata?.name ?? entry.slug,
        ownerHandle: SYSTEM_PUBLIC_HANDLE,
        workflow: graph,
      };
    });
}
