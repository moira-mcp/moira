/**
 * Integration tests for the official-flows gallery seed (Step 19): the idempotent
 * `publishOfficialFlows` routine and the owner-based `official` gallery filter (distinct
 * from the separate `verified` trust filter), run at the service level against a real
 * migrated DB.
 *
 * Setup mirrors the other marketplace integration tests: in-memory sqlite + the real
 * Drizzle migrations + real repositories + a MarketplaceService with the marketplace
 * feature enabled. `system-moira` owns a handful of public bundled flows (with slugs
 * matching real catalog slugs so each maps to a known category); a normal user owns one
 * community flow published the ordinary way (listed but unverified).
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
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
  officialFlowCategory,
} from "@mcp-moira/shared";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

const OFFICIAL_OWNER = "system-moira";
const ADMIN = "system-admin";
const COMMUNITY_USER = "community-1";

/** Official flow slugs to seed, each mapping to a distinct category (incl. an `other`). */
const OFFICIAL_SLUGS = [
  "quick-task", // development
  "verified-research", // research
  "content-creation", // content
  "data-analysis", // data
  "telegram-setup", // other
] as const;

describe("Marketplace official flows (service integration)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let listingRepo: MarketplaceListingRepository;
  let workflowRepo: WorkflowRepository;
  let eventRepo: MarketplaceEventRepository;
  let service: MarketplaceService;

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

  /** Save a private workflow under an owner with an explicit slug. */
  async function saveFlow(userId: string, slug: string): Promise<string> {
    const wf = await workflowRepo.save({
      graph: {
        metadata: { name: slug, version: "1.0.0", description: `${slug} description` },
        nodes: [],
      },
      userId,
      slug,
      visibility: "private",
    });
    return wf.id;
  }

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    listingRepo = new MarketplaceListingRepository(db);
    workflowRepo = new WorkflowRepository(db);
    eventRepo = new MarketplaceEventRepository(db);
    const sharingRepo = new WorkflowSharingRepository(db);
    const userRepo = new UserRepository(db);
    workflowRepo.setSharedAccessChecker((wfId, uid) => sharingRepo.hasAccess(wfId, uid));

    service = new MarketplaceService(
      listingRepo,
      new LibraryEntryRepository(db),
      new MarketplaceReviewRepository(db),
      eventRepo,
      workflowRepo,
      sharingRepo,
      userRepo,
      { isMarketplaceEnabled: () => true, isPaidEnabled: () => false },
    );

    seedUser(OFFICIAL_OWNER, "moira");
    seedUser(ADMIN, "admin");
    seedUser(COMMUNITY_USER, "community");

    // Official bundled flows (owned by system-moira, not yet listed).
    for (const slug of OFFICIAL_SLUGS) {
      await saveFlow(OFFICIAL_OWNER, slug);
    }

    // One community flow, published the ordinary way → listed but unverified.
    const communityId = await saveFlow(COMMUNITY_USER, "community-flow");
    await service.publish(COMMUNITY_USER, communityId, { category: "productivity" });
  });

  afterEach(() => sqlite.close());

  describe("publishOfficialFlows", () => {
    it("publishes + verifies every official flow with the mapped category", async () => {
      const result = await service.publishOfficialFlows(OFFICIAL_OWNER);

      expect(result.total).toBe(OFFICIAL_SLUGS.length);
      expect(result.published).toBe(OFFICIAL_SLUGS.length);
      expect(result.verified).toBe(OFFICIAL_SLUGS.length);

      for (const slug of OFFICIAL_SLUGS) {
        const workflowId = await workflowRepo.resolveSlug(slug, OFFICIAL_OWNER);
        expect(workflowId).toBeTruthy();
        const listing = await listingRepo.getByWorkflowId(workflowId!);
        expect(listing).not.toBeNull();
        expect(listing!.status).toBe("listed");
        expect(listing!.verified).toBe(true);
        expect(listing!.verifiedBy).toBe(OFFICIAL_OWNER);
        expect(listing!.publishedBy).toBe(OFFICIAL_OWNER);
        expect(listing!.category).toBe(officialFlowCategory(slug));
      }

      // Distinct categories were actually assigned (not all "other").
      expect(officialFlowCategory("quick-task")).toBe("development");
      expect(officialFlowCategory("telegram-setup")).toBe("other");
    });

    it("is idempotent: a second run publishes/verifies nothing and creates no duplicates", async () => {
      const first = await service.publishOfficialFlows(OFFICIAL_OWNER);
      expect(first.published).toBe(OFFICIAL_SLUGS.length);

      const listingsAfterFirst = await db.select().from(schema.marketplaceListing);

      const second = await service.publishOfficialFlows(OFFICIAL_OWNER);
      expect(second.total).toBe(OFFICIAL_SLUGS.length);
      expect(second.published).toBe(0);
      expect(second.verified).toBe(0);

      const listingsAfterSecond = await db.select().from(schema.marketplaceListing);
      // No new rows; exactly one listing per workflow (official set + the community flow).
      expect(listingsAfterSecond.length).toBe(listingsAfterFirst.length);
      expect(listingsAfterSecond.length).toBe(OFFICIAL_SLUGS.length + 1);

      // Everything still listed + verified for the official set.
      for (const slug of OFFICIAL_SLUGS) {
        const workflowId = await workflowRepo.resolveSlug(slug, OFFICIAL_OWNER);
        const listing = await listingRepo.getByWorkflowId(workflowId!);
        expect(listing!.status).toBe("listed");
        expect(listing!.verified).toBe(true);
      }
    });
  });

  describe("gallery Official (owner-based) filter vs verified trust filter", () => {
    it("the Official filter returns exactly the official-owned set and excludes the community listing", async () => {
      await service.publishOfficialFlows(OFFICIAL_OWNER);

      // Unfiltered: official set + the community flow are all listed/public.
      const all = await service.getGallery();
      expect(all.total).toBe(OFFICIAL_SLUGS.length + 1);
      expect(all.items.some((i) => i.title === "community-flow")).toBe(true);

      // Official filter: only the official-owned listings (owner-based, mirrors the
      // library's isOfficialOwner notion).
      const official = await service.getGallery({ official: true });
      expect(official.total).toBe(OFFICIAL_SLUGS.length);
      expect(official.items.length).toBe(OFFICIAL_SLUGS.length);
      expect(official.items.every((i) => i.publishedBy === OFFICIAL_OWNER)).toBe(true);
      expect(official.items.every((i) => i.verified === true)).toBe(true); // published as verified
      expect(official.items.some((i) => i.title === "community-flow")).toBe(false);
      expect(official.items.map((i) => i.title).sort()).toEqual([...OFFICIAL_SLUGS].sort());
    });

    it("an admin-verified COMMUNITY flow joins the verified trust filter but NOT the Official filter", async () => {
      await service.publishOfficialFlows(OFFICIAL_OWNER);

      // An admin grants the verified trust badge to the community flow (Step 5 allows
      // verifying any listing). This must NOT make it "Official".
      const communityId = await workflowRepo.resolveSlug("community-flow", COMMUNITY_USER);
      const community = await listingRepo.getByWorkflowId(communityId!);
      await listingRepo.setVerified(community!.id, true, ADMIN);

      // Official filter (owner-based) STILL excludes the community flow → exactly the
      // official-owned set, independent of the verified badge.
      const officialPage = await service.getGallery({ official: true });
      expect(officialPage.total).toBe(OFFICIAL_SLUGS.length);
      expect(officialPage.items.every((i) => i.publishedBy === OFFICIAL_OWNER)).toBe(true);
      expect(officialPage.items.some((i) => i.title === "community-flow")).toBe(false);

      // Verified trust filter now INCLUDES the community flow (it is verified) alongside
      // the official set — proving the two filters are distinct predicates.
      const verifiedPage = await service.getGallery({ verified: true });
      expect(verifiedPage.total).toBe(OFFICIAL_SLUGS.length + 1);
      expect(verifiedPage.items.some((i) => i.title === "community-flow")).toBe(true);
    });

    it("distinguishes an official listing from a community one via owner + verified flags", async () => {
      await service.publishOfficialFlows(OFFICIAL_OWNER);

      const officialId = await workflowRepo.resolveSlug("quick-task", OFFICIAL_OWNER);
      const official = await listingRepo.getByWorkflowId(officialId!);
      const communityId = await workflowRepo.resolveSlug("community-flow", COMMUNITY_USER);
      const community = await listingRepo.getByWorkflowId(communityId!);

      expect(official!.verified).toBe(true);
      expect(official!.publishedBy).toBe(OFFICIAL_OWNER);
      expect(community!.verified).toBe(false);
      expect(community!.publishedBy).toBe(COMMUNITY_USER);
    });

    it("applies the Official gate on the trending sort path (excludes the community listing)", async () => {
      await service.publishOfficialFlows(OFFICIAL_OWNER);

      const officialId = await workflowRepo.resolveSlug("quick-task", OFFICIAL_OWNER);
      const official = await listingRepo.getByWorkflowId(officialId!);
      const communityId = await workflowRepo.resolveSlug("community-flow", COMMUNITY_USER);
      const community = await listingRepo.getByWorkflowId(communityId!);

      // Recent activity for both so the trending ranking surfaces them (trending ranks by
      // install/start events in the window, then applies the in-memory gallery filter).
      await eventRepo.record({ listingId: official!.id, type: "install" });
      await eventRepo.record({ listingId: community!.id, type: "install" });

      // Trending without the Official filter → both the official and community listings rank.
      const trendingAll = await service.getGallery({ sort: "trending" });
      const trendingIds = trendingAll.items.map((i) => i.id);
      expect(trendingIds).toContain(official!.id);
      expect(trendingIds).toContain(community!.id);

      // Trending + official → the in-memory matchesGalleryFilter owner gate drops the
      // community listing, leaving only the official-owned one.
      const trendingOfficial = await service.getGallery({ sort: "trending", official: true });
      const officialIds = trendingOfficial.items.map((i) => i.id);
      expect(officialIds).toContain(official!.id);
      expect(officialIds).not.toContain(community!.id);
      expect(trendingOfficial.items.every((i) => i.publishedBy === OFFICIAL_OWNER)).toBe(true);
    });
  });
});
