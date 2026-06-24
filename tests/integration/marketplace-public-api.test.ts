/**
 * Integration tests for the public marketplace read surface (service level, against a
 * real migrated DB): gallery search/category/tag/sort/pagination, reviews-with-authors,
 * sitemap references, and purchase-gated export (free succeeds, paid denied).
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
  ListingNotAccessibleError,
  ListingNotFoundError,
} from "@mcp-moira/shared";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");
const AUTHOR = "author-1";
const CONSUMER = "consumer-1";

describe("Marketplace public read API (service integration)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let listingRepo: MarketplaceListingRepository;
  let eventRepo: MarketplaceEventRepository;
  let workflowRepo: WorkflowRepository;
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

  async function publishFlow(
    name: string,
    opts: { category?: string; tags?: string[] } = {},
  ): Promise<{ listingId: string; slug: string; workflowId: string }> {
    const wf = await workflowRepo.save({
      graph: { metadata: { name, version: "1.0.0", description: `${name} desc` }, nodes: [] },
      userId: AUTHOR,
      visibility: "private",
    });
    const listing = await service.publish(AUTHOR, wf.id, {
      category: opts.category,
      tags: opts.tags,
    });
    return { listingId: listing.id, slug: wf.slug, workflowId: wf.id };
  }

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    listingRepo = new MarketplaceListingRepository(db);
    eventRepo = new MarketplaceEventRepository(db);
    workflowRepo = new WorkflowRepository(db);
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
      { isMarketplaceEnabled: () => true, isPaidEnabled: () => false, coreProvider: () => [] },
    );

    seedUser(AUTHOR, "author");
    seedUser(CONSUMER, "consumer");
  });

  afterEach(() => sqlite.close());

  describe("gallery filtering / pagination", () => {
    it("returns only listed/public flows with the total count", async () => {
      await publishFlow("Alpha", { category: "development" });
      await publishFlow("Beta", { category: "research" });
      // A private workflow with no listing must not appear.
      await workflowRepo.save({
        graph: { metadata: { name: "Hidden", version: "1.0.0", description: "x" }, nodes: [] },
        userId: AUTHOR,
        visibility: "private",
      });

      const page = await service.getGallery();
      expect(page.total).toBe(2);
      expect(page.items.length).toBe(2);
      expect(page.items.every((i) => i.ownerHandle === "author")).toBe(true);
    });

    it("filters by category", async () => {
      await publishFlow("Dev Flow", { category: "development" });
      await publishFlow("Research Flow", { category: "research" });
      const page = await service.getGallery({ category: "development" });
      expect(page.items.map((i) => i.title)).toEqual(["Dev Flow"]);
      expect(page.total).toBe(1);
    });

    it("filters by free-text search over title/summary", async () => {
      await publishFlow("Unique Searchable Title");
      await publishFlow("Another Flow");
      const page = await service.getGallery({ search: "searchable" });
      expect(page.items.map((i) => i.title)).toEqual(["Unique Searchable Title"]);
    });

    it("filters by tag", async () => {
      await publishFlow("Tagged", { tags: ["ml", "nlp"] });
      await publishFlow("Untagged", { tags: ["other"] });
      const page = await service.getGallery({ tag: "nlp" });
      expect(page.items.map((i) => i.title)).toEqual(["Tagged"]);
    });

    it("paginates with limit/offset over a stable total", async () => {
      await publishFlow("One");
      await publishFlow("Two");
      await publishFlow("Three");

      const first = await service.getGallery({ limit: 2, offset: 0 });
      expect(first.items.length).toBe(2);
      expect(first.total).toBe(3);

      const second = await service.getGallery({ limit: 2, offset: 2 });
      expect(second.items.length).toBe(1);
      expect(second.total).toBe(3);
    });
  });

  describe("gallery sort", () => {
    it("sorts by rating (highest first)", async () => {
      const low = await publishFlow("Low Rated");
      const high = await publishFlow("High Rated");
      await service.rate(CONSUMER, low.listingId, 2);
      await service.rate(CONSUMER, high.listingId, 5);

      const page = await service.getGallery({ sort: "rating" });
      expect(page.items[0].title).toBe("High Rated");
    });

    it("sorts by installs (most first)", async () => {
      const few = await publishFlow("Few Installs");
      const many = await publishFlow("Many Installs");
      await service.add(CONSUMER, many.listingId); // install++

      const page = await service.getGallery({ sort: "installs" });
      expect(page.items[0].title).toBe("Many Installs");
      expect(page.items.map((i) => i.title)).toContain("Few Installs");
    });

    it("sorts by trending (recent install/start activity), excluding view-only", async () => {
      const hot = await publishFlow("Hot");
      const cold = await publishFlow("Cold");
      const viewed = await publishFlow("Viewed Only");
      await eventRepo.record({ listingId: hot.listingId, type: "start" });
      await eventRepo.record({ listingId: hot.listingId, type: "install" });
      await eventRepo.record({ listingId: cold.listingId, type: "start" });
      await eventRepo.record({ listingId: viewed.listingId, type: "view" });

      const page = await service.getGallery({ sort: "trending" });
      const titles = page.items.map((i) => i.title);
      expect(titles).toEqual(["Hot", "Cold"]); // viewed-only excluded; hot before cold
    });
  });

  describe("categories", () => {
    it("returns the fixed category set", () => {
      const categories = service.getCategories();
      expect(categories.length).toBeGreaterThan(0);
      expect(categories.some((c) => c.id === "development")).toBe(true);
      expect(categories[categories.length - 1].id).toBe("other");
    });
  });

  describe("reviews with authors", () => {
    it("resolves the author handle/name and does not expose userId", async () => {
      const flow = await publishFlow("Reviewed");
      await service.rate(CONSUMER, flow.listingId, 4, "nice");

      const reviews = await service.getReviewsWithAuthors(flow.listingId);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].stars).toBe(4);
      expect(reviews[0].reviewText).toBe("nice");
      expect(reviews[0].authorHandle).toBe("consumer");
      expect(reviews[0].authorName).toBe("consumer name");
      expect(reviews[0]).not.toHaveProperty("userId");
    });

    it("resolves reviews by handle/slug without fetching the workflow graph", async () => {
      const flow = await publishFlow("RefReviewed");
      await service.rate(CONSUMER, flow.listingId, 5, "great ref");

      const reviews = await service.getReviewsByReference(`author/${flow.slug}`);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].stars).toBe(5);
      expect(reviews[0].authorHandle).toBe("consumer");
      expect(reviews[0]).not.toHaveProperty("userId");
    });

    it("rejects reviews for an unknown reference", async () => {
      await expect(service.getReviewsByReference("author/nope")).rejects.toBeInstanceOf(
        ListingNotFoundError,
      );
    });
  });

  describe("sitemap references", () => {
    it("lists every published flow with handle + slug", async () => {
      const a = await publishFlow("Map A");
      await publishFlow("Map B");

      const refs = await service.getSitemapRefs();
      expect(refs.length).toBe(2);
      expect(refs.every((r) => r.ownerHandle === "author")).toBe(true);
      expect(refs.some((r) => r.slug === a.slug)).toBe(true);
    });

    it("does not move updatedAt (sitemap lastmod) when a view is recorded", async () => {
      const flow = await publishFlow("Fresh");
      const before = (await listingRepo.getById(flow.listingId))?.updatedAt;

      await service.recordView(flow.listingId, null);

      const after = await listingRepo.getById(flow.listingId);
      expect(after?.viewCount).toBe(1); // counter still moves
      expect(after?.updatedAt).toEqual(before); // but content-modified timestamp does not
    });
  });

  describe("detail by reference", () => {
    it("resolves a listed public flow by handle/slug", async () => {
      const flow = await publishFlow("Detail");
      const detail = await service.getDetailByReference(`author/${flow.slug}`, "__anonymous__");
      expect(detail.listing.id).toBe(flow.listingId);
      expect(detail.workflow.metadata.name).toBe("Detail");
      // Render fields the SSR pages / Web UI consume (Steps 7/8).
      expect(detail.ownerHandle).toBe("author");
      expect(detail.startRef).toBe(`author/${flow.slug}`);
      expect(detail.entitlement).toEqual({ accessible: true, reason: "free" });
    });

    it("rejects an unknown reference", async () => {
      await expect(
        service.getDetailByReference("author/nope", "__anonymous__"),
      ).rejects.toBeInstanceOf(ListingNotFoundError);
    });
  });

  describe("purchase-gated export", () => {
    it("exports a free flow's workflow definition", async () => {
      const flow = await publishFlow("Free Export");
      const result = await service.exportListing(`author/${flow.slug}`, "__anonymous__");
      expect(result.listing.id).toBe(flow.listingId);
      expect(result.workflow.metadata.name).toBe("Free Export");
    });

    it("denies export of a paid flow while selling is off", async () => {
      // Publish a flow, then mark its listing paid directly (publish creates free listings).
      const wf = await workflowRepo.save({
        graph: { metadata: { name: "Paid", version: "1.0.0", description: "p" }, nodes: [] },
        userId: AUTHOR,
        visibility: "private",
      });
      await workflowRepo.updateVisibility(wf.id, AUTHOR, "public");
      await listingRepo.create({
        workflowId: wf.id,
        publishedBy: AUTHOR,
        title: "Paid",
        category: "development",
        isPaid: true,
        price: 500,
        currency: "USD",
      });

      await expect(
        service.exportListing(`author/${wf.slug}`, "__anonymous__"),
      ).rejects.toBeInstanceOf(ListingNotAccessibleError);
    });
  });
});
