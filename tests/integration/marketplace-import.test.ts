/**
 * Integration: the offline file-import path (Step 16) at the service level, against a
 * real migrated DB. importFromFile saves the supplied graph as an independent private
 * workflow OWNED by the importer plus a library copy entry, with NO cloud call (no
 * listing, no install event). It is gated by the local marketplace feature exactly
 * like fork/install. The imported workflow is a standard owned row (the same shape
 * fork produces), so it is runnable from the user's library.
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
  MarketplaceDisabledError,
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");
const IMPORTER = "importer-1";

const SAMPLE_GRAPH: WorkflowGraph = {
  id: "source-id-should-be-dropped",
  metadata: { name: "Imported Flow", version: "1.0.0", description: "An offline-imported flow" },
  nodes: [
    { id: "start", type: "start", connections: { default: "end" } },
    { id: "end", type: "end" },
  ],
} as unknown as WorkflowGraph;

describe("Marketplace file import (service integration)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let listingRepo: MarketplaceListingRepository;
  let libraryRepo: LibraryEntryRepository;
  let eventRepo: MarketplaceEventRepository;
  let workflowRepo: WorkflowRepository;
  let marketplaceEnabled: boolean;
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

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    listingRepo = new MarketplaceListingRepository(db);
    libraryRepo = new LibraryEntryRepository(db);
    eventRepo = new MarketplaceEventRepository(db);
    workflowRepo = new WorkflowRepository(db);
    const sharingRepo = new WorkflowSharingRepository(db);
    const userRepo = new UserRepository(db);
    workflowRepo.setSharedAccessChecker((wfId, uid) => sharingRepo.hasAccess(wfId, uid));
    marketplaceEnabled = true;

    service = new MarketplaceService(
      listingRepo,
      libraryRepo,
      new MarketplaceReviewRepository(db),
      eventRepo,
      workflowRepo,
      sharingRepo,
      userRepo,
      {
        isMarketplaceEnabled: () => marketplaceEnabled,
        isPaidEnabled: () => false,
      },
    );

    seedUser(IMPORTER, "importer");
  });

  afterEach(() => sqlite.close());

  it("saves an independent private workflow owned by the importer with a fresh id", async () => {
    const result = await service.importFromFile(IMPORTER, SAMPLE_GRAPH);

    expect(result.name).toBe("Imported Flow");
    expect(result.workflowId).not.toBe("source-id-should-be-dropped");
    expect(result.slug).toBeTruthy();

    const info = await workflowRepo.getFullInfo(result.workflowId, IMPORTER);
    expect(info).not.toBeNull();
    expect(info!.visibility).toBe("private");
    expect(info!.userId).toBe(IMPORTER);
    // The graph round-trips intact (so it is runnable, not a stub).
    expect(info!.workflow.nodes.map((n) => n.id).sort()).toEqual(["end", "start"]);
  });

  it("records a library copy entry (source=added, kind=copy, no listing provenance)", async () => {
    const result = await service.importFromFile(IMPORTER, SAMPLE_GRAPH);

    const entry = await libraryRepo.getByUserAndWorkflow(IMPORTER, result.workflowId);
    expect(entry).not.toBeNull();
    expect(entry!.source).toBe("added");
    expect(entry!.kind).toBe("copy");
    expect(entry!.listingId).toBeNull();
  });

  it("surfaces the imported flow in the user's library (deduped to origin=own)", async () => {
    const result = await service.importFromFile(IMPORTER, SAMPLE_GRAPH);

    const library = await service.getLibrary(IMPORTER);
    const item = library.find((i) => i.workflowId === result.workflowId);
    expect(item).toBeDefined();
    // Owned + library-copy entry → the dedup lists it once, as the owner's own flow.
    expect(item!.origin).toBe("own");
  });

  it("makes NO cloud call — creates no listing and no install event", async () => {
    await service.importFromFile(IMPORTER, SAMPLE_GRAPH);

    // No listing row was created by an import (no publish/cloud path).
    const listings = db.select().from(schema.marketplaceListing).all();
    expect(listings).toHaveLength(0);
    // No marketplace analytics event was recorded (install events belong to adopt/fork).
    const events = db.select().from(schema.marketplaceEvent).all();
    expect(events).toHaveLength(0);
  });

  it("is gated by the local marketplace feature (throws when disabled)", async () => {
    marketplaceEnabled = false;
    await expect(service.importFromFile(IMPORTER, SAMPLE_GRAPH)).rejects.toBeInstanceOf(
      MarketplaceDisabledError,
    );
  });

  it("imports independent copies on repeated import (distinct workflow ids)", async () => {
    const a = await service.importFromFile(IMPORTER, SAMPLE_GRAPH);
    const b = await service.importFromFile(IMPORTER, SAMPLE_GRAPH);
    expect(a.workflowId).not.toBe(b.workflowId);
    expect(a.slug).not.toBe(b.slug);
  });
});
