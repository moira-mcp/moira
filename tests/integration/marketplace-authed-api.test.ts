/**
 * Integration tests for the authed + admin marketplace surface (service level, against
 * a real migrated DB): publish/re-list/unpublish, owner metadata edits, my-listings,
 * install (adopt) → library, fork → independent copy, share-by-link → recipient
 * library, entitlement (owner/free/paid-coming-soon), paid-publish rejection, and the
 * admin moderation actions (verify/feature/status).
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import * as schema from "../../packages/shared/src/database/schema.js";
import {
  MarketplaceService,
  MarketplaceListingRepository,
  LibraryEntryRepository,
  MarketplaceReviewRepository,
  MarketplaceEventRepository,
  WorkflowRepository,
  WorkflowSharingRepository,
  UserRepository,
  ListingAccessDeniedError,
  PaidListingsDisabledError,
  InvalidListingStatusError,
} from "@mcp-moira/shared";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");
const AUTHOR = "author-1";
const CONSUMER = "consumer-1";

describe("Marketplace authed + admin API (service integration)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let listingRepo: MarketplaceListingRepository;
  let workflowRepo: WorkflowRepository;
  let sharingRepo: WorkflowSharingRepository;
  let service: MarketplaceService;
  let paidEnabled: boolean;

  function seedUser(id: string, handle: string): void {
    const now = new Date().toISOString();
    db.insert(schema.user)
      .values({
        id,
        name: `${handle} name`,
        email: `${handle}@example.com`,
        emailVerified: true,
        handle,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  async function makeWorkflow(userId: string, name: string): Promise<{ id: string; slug: string }> {
    const wf = await workflowRepo.save({
      graph: { metadata: { name, version: "1.0.0", description: `${name} desc` }, nodes: [] },
      userId,
      visibility: "private",
    });
    return { id: wf.id, slug: wf.slug };
  }

  async function publishFlow(
    name: string,
    opts: { category?: string; tags?: string[] } = {},
  ): Promise<{ listingId: string; slug: string; workflowId: string }> {
    const wf = await makeWorkflow(AUTHOR, name);
    const listing = await service.publish(AUTHOR, wf.id, opts);
    return { listingId: listing.id, slug: wf.slug, workflowId: wf.id };
  }

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    listingRepo = new MarketplaceListingRepository(db);
    workflowRepo = new WorkflowRepository(db);
    sharingRepo = new WorkflowSharingRepository(db);
    const userRepo = new UserRepository(db);
    workflowRepo.setSharedAccessChecker((wfId, uid) => sharingRepo.hasAccess(wfId, uid));
    paidEnabled = false;

    service = new MarketplaceService(
      listingRepo,
      new LibraryEntryRepository(db),
      new MarketplaceReviewRepository(db),
      new MarketplaceEventRepository(db),
      workflowRepo,
      sharingRepo,
      userRepo,
      {
        isMarketplaceEnabled: () => true,
        isPaidEnabled: () => paidEnabled,
        coreProvider: () => [],
      },
    );

    seedUser(AUTHOR, "author");
    seedUser(CONSUMER, "consumer");
  });

  afterEach(() => sqlite.close());

  describe("publish / unpublish / re-list", () => {
    it("publishes a workflow to a listed, public listing", async () => {
      const flow = await publishFlow("Publishable", { category: "development" });
      const listing = await listingRepo.getById(flow.listingId);
      expect(listing?.status).toBe("listed");
      expect(listing?.category).toBe("development");
      expect((await workflowRepo.getOwnership(flow.workflowId)).visibility).toBe("public");
    });

    it("unpublish keeps the row as unlisted and makes the workflow private", async () => {
      const flow = await publishFlow("Unpub");
      await service.unpublishById(AUTHOR, flow.listingId);
      const listing = await listingRepo.getById(flow.listingId);
      expect(listing?.status).toBe("unlisted");
      expect((await workflowRepo.getOwnership(flow.workflowId)).visibility).toBe("private");
    });

    it("rejects unpublish by a non-owner", async () => {
      const flow = await publishFlow("Guarded");
      await expect(service.unpublishById(CONSUMER, flow.listingId)).rejects.toBeInstanceOf(
        ListingAccessDeniedError,
      );
    });
  });

  describe("owner metadata edits", () => {
    it("applies title/category edits for the owner", async () => {
      const flow = await publishFlow("Editable");
      const updated = await service.updateListing(AUTHOR, flow.listingId, {
        title: "Renamed",
        category: "research",
      });
      expect(updated.title).toBe("Renamed");
      expect(updated.category).toBe("research");
    });

    it("rejects edits by a non-owner", async () => {
      const flow = await publishFlow("Locked");
      await expect(
        service.updateListing(CONSUMER, flow.listingId, { title: "Hijack" }),
      ).rejects.toBeInstanceOf(ListingAccessDeniedError);
    });

    it("lists the owner's listings including unlisted ones", async () => {
      const a = await publishFlow("Mine A");
      const b = await publishFlow("Mine B");
      await service.unpublishById(AUTHOR, b.listingId);
      const mine = await service.getMyListings(AUTHOR);
      expect(mine.map((l) => l.id).sort()).toEqual([a.listingId, b.listingId].sort());
      expect(mine.find((l) => l.id === b.listingId)?.status).toBe("unlisted");
    });
  });

  describe("install (adopt) / fork / library", () => {
    it("install adopts a reference and returns the start reference", async () => {
      const flow = await publishFlow("Adoptable");
      const result = await service.install(CONSUMER, flow.listingId);
      expect(result.startRef).toBe(`author/${flow.slug}`);
      expect(result.entry.kind).toBe("reference");
      expect((await listingRepo.getById(flow.listingId))?.installCount).toBe(1);

      const library = await service.getLibrary(CONSUMER);
      expect(library.some((i) => i.workflowId === flow.workflowId && i.origin === "added")).toBe(
        true,
      );
    });

    it("fork creates an independent owned copy in the library", async () => {
      const flow = await publishFlow("Forkable");
      const forked = await service.fork(CONSUMER, flow.listingId);
      expect(forked.workflowId).not.toBe(flow.workflowId);
      expect((await workflowRepo.getOwnership(forked.workflowId)).ownerId).toBe(CONSUMER);

      // The fork is a real owned workflow → surfaces in the library as 'own' (own wins
      // over the libraryEntry(copy) it also writes); the original is untouched.
      const library = await service.getLibrary(CONSUMER);
      const entry = library.find((i) => i.workflowId === forked.workflowId);
      expect(entry?.origin).toBe("own");
      expect((await workflowRepo.getOwnership(flow.workflowId)).ownerId).toBe(AUTHOR);
    });
  });

  describe("share-by-link → recipient library", () => {
    it("a workflowAccess grant surfaces the flow as 'shared' in the recipient's library", async () => {
      const wf = await makeWorkflow(AUTHOR, "Shared Flow");
      await sharingRepo.grantAccess(wf.id, CONSUMER, AUTHOR);
      const library = await service.getLibrary(CONSUMER);
      const shared = library.find((i) => i.workflowId === wf.id);
      expect(shared?.origin).toBe("shared");
    });
  });

  describe("entitlement", () => {
    it("returns owner for the publisher and free for everyone else", async () => {
      const flow = await publishFlow("Entitled");
      expect(await service.getEntitlement(AUTHOR, flow.listingId)).toEqual({
        hasAccess: true,
        reason: "owner",
      });
      expect(await service.getEntitlement(CONSUMER, flow.listingId)).toEqual({
        hasAccess: true,
        reason: "free",
      });
    });

    it("gates a paid listing to 'paid-coming-soon' while selling is off", async () => {
      const flow = await publishFlow("PaidFlow");
      // Mark the listing paid directly (publish refuses paid fields while the flag is off).
      await db
        .update(schema.marketplaceListing)
        .set({ isPaid: true, price: 500 })
        .where(eq(schema.marketplaceListing.id, flow.listingId))
        .run();
      expect(await service.getEntitlement(CONSUMER, flow.listingId)).toEqual({
        hasAccess: false,
        reason: "paid-coming-soon",
      });
    });
  });

  describe("paid publish rejection", () => {
    it("rejects publishing with paid fields while the flag is off", async () => {
      const wf = await makeWorkflow(AUTHOR, "WantsPaid");
      await expect(
        service.publish(AUTHOR, wf.id, { isPaid: true, price: 999 }),
      ).rejects.toBeInstanceOf(PaidListingsDisabledError);
    });

    it("allows paid fields once selling is enabled", async () => {
      paidEnabled = true;
      const wf = await makeWorkflow(AUTHOR, "PaidOk");
      const listing = await service.publish(AUTHOR, wf.id, { isPaid: true, price: 999 });
      expect(listing.status).toBe("listed");
    });
  });

  describe("admin moderation", () => {
    it("verify sets the badge and unverify clears it", async () => {
      const flow = await publishFlow("Trusted");
      const verified = await service.verifyListing("admin-1", flow.listingId);
      expect(verified.verified).toBe(true);
      expect(verified.verifiedBy).toBe("admin-1");
      const cleared = await service.unverifyListing(flow.listingId);
      expect(cleared.verified).toBe(false);
      expect(cleared.verifiedBy).toBeNull();
    });

    it("sets the featured flag", async () => {
      const flow = await publishFlow("Featured");
      const featured = await service.setListingFeatured(flow.listingId, true);
      expect(featured.featured).toBe(true);
    });

    it("returns the moderation queue by status and transitions status", async () => {
      const flow = await publishFlow("Moderated");
      await service.setListingStatus(flow.listingId, "pending");
      const queue = await service.getModerationQueue("pending");
      expect(queue.map((l) => l.id)).toContain(flow.listingId);
    });

    it("rejects a status transition to an unknown value", async () => {
      const flow = await publishFlow("BadStatus");
      await expect(service.setListingStatus(flow.listingId, "garbage")).rejects.toBeInstanceOf(
        InvalidListingStatusError,
      );
    });
  });
});
