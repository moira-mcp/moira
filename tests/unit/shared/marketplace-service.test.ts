/**
 * Unit tests for MarketplaceService — publish/unpublish, the library resolver
 * (core ∪ own ∪ added ∪ shared), add/remove/fork, reference-auto-update vs
 * fork-frozen, exclusion of arbitrary public flows, and the canAccess seam.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import * as schema from "../../../packages/shared/src/database/schema.js";
import {
  MarketplaceService,
  MarketplaceListingRepository,
  LibraryEntryRepository,
  MarketplaceReviewRepository,
  MarketplaceEventRepository,
  WorkflowRepository,
  WorkflowSharingRepository,
  UserRepository,
  MarketplaceDisabledError,
  ListingAccessDeniedError,
  WorkflowAlreadyListedError,
  ListingNotAccessibleError,
  LibraryEntryNotFoundError,
  ListingNotFoundError,
  SelfRatingError,
  InvalidRatingError,
} from "@mcp-moira/shared";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

const AUTHOR = "author-1";
const CONSUMER = "consumer-1";

describe("MarketplaceService", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let listingRepo: MarketplaceListingRepository;
  let libraryRepo: LibraryEntryRepository;
  let reviewRepo: MarketplaceReviewRepository;
  let eventRepo: MarketplaceEventRepository;
  let workflowRepo: WorkflowRepository;
  let sharingRepo: WorkflowSharingRepository;
  let userRepo: UserRepository;
  let service: MarketplaceService;

  function seedUser(id: string, handle: string): void {
    const now = new Date().toISOString();
    db.insert(schema.user)
      .values({
        id,
        name: handle,
        email: `${handle}@example.com`,
        emailVerified: true,
        handle,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  /** Create a workflow owned by `userId`; returns { id, slug }. */
  async function createWorkflow(
    userId: string,
    name: string,
  ): Promise<{ id: string; slug: string }> {
    return workflowRepo.save({
      graph: {
        metadata: { name, version: "1.0.0", description: `${name} description` },
        nodes: [],
      },
      userId,
      visibility: "private",
    });
  }

  function makeService(
    overrides: {
      isMarketplaceEnabled?: () => boolean;
      isPaidEnabled?: () => boolean;
    } = {},
  ): MarketplaceService {
    return new MarketplaceService(
      listingRepo,
      libraryRepo,
      reviewRepo,
      eventRepo,
      workflowRepo,
      sharingRepo,
      userRepo,
      {
        isMarketplaceEnabled: overrides.isMarketplaceEnabled ?? (() => true),
        isPaidEnabled: overrides.isPaidEnabled ?? (() => false),
      },
    );
  }

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    listingRepo = new MarketplaceListingRepository(db);
    libraryRepo = new LibraryEntryRepository(db);
    reviewRepo = new MarketplaceReviewRepository(db);
    eventRepo = new MarketplaceEventRepository(db);
    workflowRepo = new WorkflowRepository(db);
    sharingRepo = new WorkflowSharingRepository(db);
    userRepo = new UserRepository(db);
    workflowRepo.setSharedAccessChecker((wfId, uid) => sharingRepo.hasAccess(wfId, uid));

    seedUser(AUTHOR, "author");
    seedUser(CONSUMER, "consumer");

    service = makeService();
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("publish / unpublish", () => {
    it("creates a listing and makes the workflow public", async () => {
      const wf = await createWorkflow(AUTHOR, "My Flow");
      const listing = await service.publish(AUTHOR, wf.id, { category: "development" });

      expect(listing.workflowId).toBe(wf.id);
      expect(listing.status).toBe("listed");
      expect(listing.publishedBy).toBe(AUTHOR);
      expect(listing.category).toBe("development");
      expect(listing.title).toBe("My Flow");

      const ownership = await workflowRepo.getOwnership(wf.id);
      expect(ownership.visibility).toBe("public");
    });

    it("normalizes an unknown category to 'other'", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      const listing = await service.publish(AUTHOR, wf.id, { category: "nonsense" });
      expect(listing.category).toBe("other");
    });

    it("rejects publish by a non-owner", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      await expect(service.publish(CONSUMER, wf.id)).rejects.toBeInstanceOf(
        ListingAccessDeniedError,
      );
    });

    it("rejects publishing the same workflow twice", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      await service.publish(AUTHOR, wf.id);
      await expect(service.publish(AUTHOR, wf.id)).rejects.toBeInstanceOf(
        WorkflowAlreadyListedError,
      );
    });

    it("throws when the marketplace is disabled", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      const disabled = makeService({ isMarketplaceEnabled: () => false });
      await expect(disabled.publish(AUTHOR, wf.id)).rejects.toBeInstanceOf(
        MarketplaceDisabledError,
      );
    });

    it("unpublish unlists the listing (row kept) and makes the workflow private", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      await service.publish(AUTHOR, wf.id);
      await service.unpublish(AUTHOR, wf.id);

      const listing = await listingRepo.getByWorkflowId(wf.id);
      expect(listing?.status).toBe("unlisted"); // row kept for history, not deleted
      const ownership = await workflowRepo.getOwnership(wf.id);
      expect(ownership.visibility).toBe("private");
    });

    it("re-publishing an unlisted workflow re-lists the kept row", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      const first = await service.publish(AUTHOR, wf.id);
      await service.unpublish(AUTHOR, wf.id);

      const second = await service.publish(AUTHOR, wf.id, { category: "development" });
      expect(second.id).toBe(first.id); // same row re-listed
      expect(second.status).toBe("listed");
      expect(second.category).toBe("development");
    });

    it("rejects unpublish by a non-owner", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      await service.publish(AUTHOR, wf.id);
      await expect(service.unpublish(CONSUMER, wf.id)).rejects.toBeInstanceOf(
        ListingAccessDeniedError,
      );
    });
  });

  describe("add / library resolver", () => {
    it("adds a listing as a live reference and increments installs", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      const listing = await service.publish(AUTHOR, wf.id);

      const entry = await service.add(CONSUMER, listing.id);
      expect(entry.source).toBe("added");
      expect(entry.kind).toBe("reference");
      expect(entry.workflowId).toBe(wf.id);

      const updated = await listingRepo.getById(listing.id);
      expect(updated?.installCount).toBe(1);
    });

    it("add is idempotent (no duplicate library entry)", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      const listing = await service.publish(AUTHOR, wf.id);
      await service.add(CONSUMER, listing.id);
      await service.add(CONSUMER, listing.id);
      const entries = await libraryRepo.listByUser(CONSUMER);
      expect(entries.length).toBe(1);
    });

    it("library returns own + added but EXCLUDES arbitrary public flows", async () => {
      // author publishes two flows; consumer adds only one.
      const added = await createWorkflow(AUTHOR, "Added Flow");
      const arbitrary = await createWorkflow(AUTHOR, "Arbitrary Public Flow");
      const addedListing = await service.publish(AUTHOR, added.id);
      await service.publish(AUTHOR, arbitrary.id); // public, but consumer does NOT add it

      const ownFlow = await createWorkflow(CONSUMER, "Consumer Own Flow");
      await service.add(CONSUMER, addedListing.id);

      const library = await service.getLibrary(CONSUMER);
      const ids = library.map((i) => i.workflowId);

      expect(ids).toContain(ownFlow.id); // own
      expect(ids).toContain(added.id); // added
      expect(ids).not.toContain(arbitrary.id); // arbitrary public excluded

      const ownItem = library.find((i) => i.workflowId === ownFlow.id);
      expect(ownItem?.origin).toBe("own");
      const addedItem = library.find((i) => i.workflowId === added.id);
      expect(addedItem?.origin).toBe("added");
      expect(addedItem?.kind).toBe("reference");
    });

    it("includes shared flows via the existing sharing mechanism", async () => {
      const shared = await createWorkflow(AUTHOR, "Shared Flow");
      const invite = await sharingRepo.createInvite({ workflowId: shared.id, createdBy: AUTHOR });
      await sharingRepo.acceptInvite({ token: invite.token, userId: CONSUMER });

      const library = await service.getLibrary(CONSUMER);
      const sharedItem = library.find((i) => i.workflowId === shared.id);
      expect(sharedItem).toBeDefined();
      expect(sharedItem?.origin).toBe("shared");
    });
  });

  describe("fork (independent frozen copy)", () => {
    it("creates an independent private workflow owned by the forker", async () => {
      const wf = await createWorkflow(AUTHOR, "Source Flow");
      const listing = await service.publish(AUTHOR, wf.id);

      const fork = await service.fork(CONSUMER, listing.id);
      expect(fork.workflowId).not.toBe(wf.id);

      const ownership = await workflowRepo.getOwnership(fork.workflowId);
      expect(ownership.ownerId).toBe(CONSUMER);
      expect(ownership.visibility).toBe("private");

      const provenance = await libraryRepo.getByUserAndWorkflow(CONSUMER, fork.workflowId);
      expect(provenance?.kind).toBe("copy");
      expect(provenance?.listingId).toBe(listing.id);
    });

    it("reference auto-updates to the author's latest while a fork stays frozen", async () => {
      const wf = await createWorkflow(AUTHOR, "V1");
      const listing = await service.publish(AUTHOR, wf.id);

      await service.add(CONSUMER, listing.id); // reference
      const fork = await service.fork(CONSUMER, listing.id); // copy

      // Author edits the source workflow to V2 (same id → update).
      await workflowRepo.save({
        graph: {
          id: wf.id,
          metadata: { name: "V2", version: "2.0.0", description: "edited" },
          nodes: [],
        },
        userId: AUTHOR,
        slug: wf.slug,
        visibility: "public",
      });

      const referenceResolved = await workflowRepo.getFullInfo(wf.id, CONSUMER);
      const forkResolved = await workflowRepo.getFullInfo(fork.workflowId, CONSUMER);

      expect(referenceResolved?.metadata.name).toBe("V2"); // live reference auto-updates
      expect(forkResolved?.metadata.name).toBe("V1"); // fork is a frozen snapshot
    });
  });

  describe("remove", () => {
    it("removes an added flow from the library", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      const listing = await service.publish(AUTHOR, wf.id);
      await service.add(CONSUMER, listing.id);

      await service.remove(CONSUMER, wf.id);
      expect(await libraryRepo.getByUserAndWorkflow(CONSUMER, wf.id)).toBeNull();
    });

    it("throws when removing a flow that is not in the library", async () => {
      await expect(service.remove(CONSUMER, "missing-workflow")).rejects.toBeInstanceOf(
        LibraryEntryNotFoundError,
      );
    });
  });

  describe("canAccess seam", () => {
    it("free listings are accessible", async () => {
      const wf = await createWorkflow(AUTHOR, "Free Flow");
      const listing = await service.publish(AUTHOR, wf.id);
      const decision = service.canAccess(listing);
      expect(decision).toEqual({ accessible: true, reason: "free" });
    });

    it("paid listings resolve to 'coming soon' while selling is off", async () => {
      const wf = await createWorkflow(AUTHOR, "Paid Flow");
      const listing = await listingRepo.create({
        workflowId: wf.id,
        publishedBy: AUTHOR,
        title: "Paid Flow",
        category: "development",
        isPaid: true,
        price: 500,
        currency: "USD",
      });
      const decision = service.canAccess(listing);
      expect(decision).toEqual({ accessible: false, reason: "paid-coming-soon" });
    });

    it("add of a paid listing is rejected while selling is off", async () => {
      const wf = await createWorkflow(AUTHOR, "Paid Flow");
      const listing = await listingRepo.create({
        workflowId: wf.id,
        publishedBy: AUTHOR,
        title: "Paid Flow",
        category: "development",
        isPaid: true,
        price: 500,
        currency: "USD",
      });
      await expect(service.add(CONSUMER, listing.id)).rejects.toBeInstanceOf(
        ListingNotAccessibleError,
      );
    });
  });

  describe("detail by reference", () => {
    it("resolves a listed flow by handle/slug", async () => {
      const wf = await createWorkflow(AUTHOR, "Detail Flow");
      const listing = await service.publish(AUTHOR, wf.id);

      const detail = await service.getDetailByReference(`author/${wf.slug}`, CONSUMER);
      expect(detail.listing.id).toBe(listing.id);
      expect(detail.workflowId).toBe(wf.id);
      expect(detail.workflow?.metadata.name).toBe("Detail Flow");
    });

    it("does not resolve a listing whose workflow is no longer public", async () => {
      const wf = await createWorkflow(AUTHOR, "Detail Flow");
      await service.publish(AUTHOR, wf.id);
      // Stale listing: workflow made private without removing the listing row.
      await workflowRepo.updateVisibility(wf.id, AUTHOR, "private");
      await expect(
        service.getDetailByReference(`author/${wf.slug}`, CONSUMER),
      ).rejects.toBeInstanceOf(ListingNotFoundError);
    });
  });

  describe("ratings / reviews", () => {
    const RATER = "rater-1";
    beforeEach(() => seedUser(RATER, "rater"));

    async function publishFlow(): Promise<string> {
      const wf = await createWorkflow(AUTHOR, "Rated Flow");
      const listing = await service.publish(AUTHOR, wf.id);
      return listing.id;
    }

    it("records a review and recomputes the listing aggregate", async () => {
      const listingId = await publishFlow();
      const result = await service.rate(CONSUMER, listingId, 4, "solid");

      expect(result.review.stars).toBe(4);
      expect(result.review.reviewText).toBe("solid");
      expect(result.ratingAvg).toBe(4); // returned aggregate (no re-query needed)
      expect(result.ratingCount).toBe(1);
      const listing = await listingRepo.getById(listingId);
      expect(listing?.ratingCount).toBe(1);
      expect(listing?.ratingAvg).toBe(4);
    });

    it("removeReview is idempotent when the user has no review", async () => {
      const listingId = await publishFlow();
      await expect(service.removeReview(CONSUMER, listingId)).resolves.toBeUndefined();
    });

    it("replaces an existing review (one editable review per user)", async () => {
      const listingId = await publishFlow();
      await service.rate(CONSUMER, listingId, 2);
      await service.rate(CONSUMER, listingId, 5);

      const reviews = await service.getReviews(listingId);
      expect(reviews.length).toBe(1);
      expect(reviews[0].stars).toBe(5);
      const listing = await listingRepo.getById(listingId);
      expect(listing?.ratingCount).toBe(1);
      expect(listing?.ratingAvg).toBe(5);
    });

    it("averages ratings across users", async () => {
      const listingId = await publishFlow();
      await service.rate(CONSUMER, listingId, 5);
      await service.rate(RATER, listingId, 3);

      const listing = await listingRepo.getById(listingId);
      expect(listing?.ratingCount).toBe(2);
      expect(listing?.ratingAvg).toBe(4); // (5 + 3) / 2
    });

    it("rejects the author rating their own listing", async () => {
      const listingId = await publishFlow();
      await expect(service.rate(AUTHOR, listingId, 5)).rejects.toBeInstanceOf(SelfRatingError);
    });

    it("rejects an out-of-range rating", async () => {
      const listingId = await publishFlow();
      await expect(service.rate(CONSUMER, listingId, 0)).rejects.toBeInstanceOf(InvalidRatingError);
      await expect(service.rate(CONSUMER, listingId, 6)).rejects.toBeInstanceOf(InvalidRatingError);
    });

    it("removing a review recomputes the aggregate back to zero", async () => {
      const listingId = await publishFlow();
      await service.rate(CONSUMER, listingId, 5);
      await service.removeReview(CONSUMER, listingId);

      const listing = await listingRepo.getById(listingId);
      expect(listing?.ratingCount).toBe(0);
      expect(listing?.ratingAvg).toBe(0);
      expect(await service.getReviews(listingId)).toHaveLength(0);
    });

    it("records a 'rate' analytics event", async () => {
      const listingId = await publishFlow();
      await service.rate(CONSUMER, listingId, 4);
      const events = await eventRepo.listByListing(listingId);
      expect(events.some((e) => e.type === "rate" && e.userId === CONSUMER)).toBe(true);
    });
  });

  describe("analytics events / counters", () => {
    it("add records an install event and increments the counter", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      const listing = await service.publish(AUTHOR, wf.id);
      await service.add(CONSUMER, listing.id);

      const events = await eventRepo.listByListing(listing.id);
      expect(events.filter((e) => e.type === "install").length).toBe(1);
      expect((await listingRepo.getById(listing.id))?.installCount).toBe(1);
    });

    it("recordView and recordStart bump events + counters", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      const listing = await service.publish(AUTHOR, wf.id);

      await service.recordView(listing.id, CONSUMER);
      await service.recordStart(listing.id, CONSUMER);

      const updated = await listingRepo.getById(listing.id);
      expect(updated?.viewCount).toBe(1);
      expect(updated?.startCount).toBe(1);
      const types = (await eventRepo.listByListing(listing.id)).map((e) => e.type);
      expect(types).toContain("view");
      expect(types).toContain("start");
    });
  });

  describe("trending", () => {
    it("orders listings by recent activity (most events first)", async () => {
      const hot = await createWorkflow(AUTHOR, "Hot Flow");
      const cold = await createWorkflow(AUTHOR, "Cold Flow");
      const hotListing = await service.publish(AUTHOR, hot.id);
      const coldListing = await service.publish(AUTHOR, cold.id);

      // Trending counts install/start signals only (view is excluded). Hot gets two,
      // cold gets one, so hot ranks first and cold still appears.
      await eventRepo.record({ listingId: hotListing.id, userId: CONSUMER, type: "start" });
      await eventRepo.record({ listingId: hotListing.id, userId: CONSUMER, type: "install" });
      await eventRepo.record({ listingId: hotListing.id, userId: CONSUMER, type: "view" });
      await eventRepo.record({ listingId: coldListing.id, userId: CONSUMER, type: "start" });

      const trending = await service.getTrending();
      const ids = trending.map((l) => l.id);
      expect(ids).toContain(hotListing.id);
      expect(ids).toContain(coldListing.id);
      expect(ids.indexOf(hotListing.id)).toBeLessThan(ids.indexOf(coldListing.id));
    });

    it("excludes view-only listings from trending (install/start signals only)", async () => {
      const viewed = await createWorkflow(AUTHOR, "Viewed Flow");
      const viewedListing = await service.publish(AUTHOR, viewed.id);
      await eventRepo.record({ listingId: viewedListing.id, userId: CONSUMER, type: "view" });

      const trending = await service.getTrending();
      expect(trending.map((l) => l.id)).not.toContain(viewedListing.id);
    });
  });
});
