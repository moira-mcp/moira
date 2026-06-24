/**
 * Unit tests for the MarketplaceService viewer-annotation capability
 * (getGalleryAnnotated / getDetailByReferenceAnnotated): each gallery/detail item is
 * annotated with `inLibrary` (the viewer has it in their library) and `isOwn` (the
 * viewer published it), for owner / non-owner-with-library-entry / anonymous viewers.
 *
 * DB-backed unit test (in-memory SQLite + migrations), mirroring the setup in
 * tests/unit/shared/marketplace-service.test.ts.
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
} from "@mcp-moira/shared";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

const AUTHOR = "author-1";
const CONSUMER = "consumer-1";
const STRANGER = "stranger-1";

describe("MarketplaceService viewer annotation", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let listingRepo: MarketplaceListingRepository;
  let libraryRepo: LibraryEntryRepository;
  let workflowRepo: WorkflowRepository;
  let sharingRepo: WorkflowSharingRepository;
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

  async function createWorkflow(userId: string, name: string): Promise<{ id: string; slug: string }> {
    return workflowRepo.save({
      graph: { metadata: { name, version: "1.0.0", description: `${name} desc` }, nodes: [] },
      userId,
      visibility: "private",
    });
  }

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    listingRepo = new MarketplaceListingRepository(db);
    libraryRepo = new LibraryEntryRepository(db);
    const reviewRepo = new MarketplaceReviewRepository(db);
    const eventRepo = new MarketplaceEventRepository(db);
    workflowRepo = new WorkflowRepository(db);
    sharingRepo = new WorkflowSharingRepository(db);
    const userRepo = new UserRepository(db);
    workflowRepo.setSharedAccessChecker((wfId, uid) => sharingRepo.hasAccess(wfId, uid));

    seedUser(AUTHOR, "author");
    seedUser(CONSUMER, "consumer");
    seedUser(STRANGER, "stranger");

    service = new MarketplaceService(
      listingRepo,
      libraryRepo,
      reviewRepo,
      eventRepo,
      workflowRepo,
      sharingRepo,
      userRepo,
      {
        isMarketplaceEnabled: () => true,
        isPaidEnabled: () => false,
        coreProvider: () => [],
      },
    );
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("getGalleryAnnotated", () => {
    it("annotates isOwn=true for the publishing owner", async () => {
      const wf = await createWorkflow(AUTHOR, "Owned Flow");
      await service.publish(AUTHOR, wf.id);

      const page = await service.getGalleryAnnotated({}, AUTHOR);
      const item = page.items.find((i) => i.workflowId === wf.id);
      expect(item).toBeDefined();
      expect(item?.isOwn).toBe(true);
      expect(item?.inLibrary).toBe(false); // own flows are not stored library entries
    });

    it("annotates inLibrary=true for a non-owner who added it", async () => {
      const wf = await createWorkflow(AUTHOR, "Added Flow");
      const listing = await service.publish(AUTHOR, wf.id);
      await service.add(CONSUMER, listing.id);

      const page = await service.getGalleryAnnotated({}, CONSUMER);
      const item = page.items.find((i) => i.workflowId === wf.id);
      expect(item?.isOwn).toBe(false);
      expect(item?.inLibrary).toBe(true);
    });

    it("annotates both false for a stranger who neither owns nor added it", async () => {
      const wf = await createWorkflow(AUTHOR, "Public Flow");
      await service.publish(AUTHOR, wf.id);

      const page = await service.getGalleryAnnotated({}, STRANGER);
      const item = page.items.find((i) => i.workflowId === wf.id);
      expect(item?.isOwn).toBe(false);
      expect(item?.inLibrary).toBe(false);
    });

    it("annotates both false for an anonymous viewer (null id)", async () => {
      const wf = await createWorkflow(AUTHOR, "Anon Flow");
      await service.publish(AUTHOR, wf.id);

      const page = await service.getGalleryAnnotated({}, null);
      const item = page.items.find((i) => i.workflowId === wf.id);
      expect(item?.isOwn).toBe(false);
      expect(item?.inLibrary).toBe(false);
    });

    it("preserves the gallery pagination metadata", async () => {
      const wf = await createWorkflow(AUTHOR, "Flow");
      await service.publish(AUTHOR, wf.id);
      const page = await service.getGalleryAnnotated({ limit: 10, offset: 0 }, null);
      expect(page.total).toBe(1);
      expect(page.limit).toBe(10);
      expect(page.sort).toBe("recent");
    });
  });

  describe("getDetailByReferenceAnnotated", () => {
    it("annotates isOwn=true for the owner", async () => {
      const wf = await createWorkflow(AUTHOR, "Detail Flow");
      await service.publish(AUTHOR, wf.id);

      const detail = await service.getDetailByReferenceAnnotated(`author/${wf.slug}`, AUTHOR);
      expect(detail.isOwn).toBe(true);
      expect(detail.inLibrary).toBe(false);
      expect(detail.workflowId).toBe(wf.id);
    });

    it("annotates inLibrary=true for a non-owner who added it", async () => {
      const wf = await createWorkflow(AUTHOR, "Detail Flow");
      const listing = await service.publish(AUTHOR, wf.id);
      await service.add(CONSUMER, listing.id);

      const detail = await service.getDetailByReferenceAnnotated(`author/${wf.slug}`, CONSUMER);
      expect(detail.isOwn).toBe(false);
      expect(detail.inLibrary).toBe(true);
    });

    it("annotates both false for an anonymous viewer", async () => {
      const wf = await createWorkflow(AUTHOR, "Detail Flow");
      await service.publish(AUTHOR, wf.id);

      const detail = await service.getDetailByReferenceAnnotated(`author/${wf.slug}`, null);
      expect(detail.isOwn).toBe(false);
      expect(detail.inLibrary).toBe(false);
      // Detail data still resolved for the anonymous viewer.
      expect(detail.workflow.metadata.name).toBe("Detail Flow");
      expect(detail.ownerHandle).toBe("author");
    });
  });
});
