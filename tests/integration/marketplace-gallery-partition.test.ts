/**
 * Integration (Step 9, D-N8) — the storefront's partition-aware gallery facets against a
 * real migrated DB. The gallery splits into two disjoint, covering partitions:
 * Official (owned by `system-moira`) and Community (everyone else), so the storefront
 * chips can show a meaningful, non-redundant All / Official / Community split with counts.
 *
 * Verifies: getGalleryFacets returns all = official + community; the `community` filter
 * returns ONLY non-official listings; official + community filters partition the catalog;
 * and facet counts respect an active search.
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
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

const SYSTEM_MOIRA = "system-moira";
const AUTHOR = "author-1";

function makeGraph(name: string): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: `${name} flow` },
    nodes: [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
    ],
  } as unknown as WorkflowGraph;
}

describe("Marketplace gallery partition facets (Step 9, service integration)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
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

  /** Publish a listing owned by `userId` with the given title; returns the listing id. */
  async function publishFlow(userId: string, title: string): Promise<string> {
    const flow = await workflowRepo.save({
      graph: makeGraph(title),
      userId,
      visibility: "private",
    });
    const listing = await service.publish(userId, flow.id, { summary: title });
    return listing.id;
  }

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    const listingRepo = new MarketplaceListingRepository(db);
    workflowRepo = new WorkflowRepository(db);
    const sharingRepo = new WorkflowSharingRepository(db);
    workflowRepo.setSharedAccessChecker((wfId, uid) => sharingRepo.hasAccess(wfId, uid));

    service = new MarketplaceService(
      listingRepo,
      new LibraryEntryRepository(db),
      new MarketplaceReviewRepository(db),
      new MarketplaceEventRepository(db),
      workflowRepo,
      sharingRepo,
      new UserRepository(db),
      { isMarketplaceEnabled: () => true, isPaidEnabled: () => false },
    );

    seedUser(SYSTEM_MOIRA, "moira");
    seedUser(AUTHOR, "author");
  });

  afterEach(() => sqlite.close());

  it("facets partition the catalog: all = official + community", async () => {
    // 2 official (system-moira) + 3 community (author) listings.
    await publishFlow(SYSTEM_MOIRA, "Official One");
    await publishFlow(SYSTEM_MOIRA, "Official Two");
    await publishFlow(AUTHOR, "Community One");
    await publishFlow(AUTHOR, "Community Two");
    await publishFlow(AUTHOR, "Community Three");

    const facets = await service.getGalleryFacets({});
    expect(facets.all).toBe(5);
    expect(facets.official).toBe(2);
    expect(facets.community).toBe(3);
    expect(facets.official + facets.community).toBe(facets.all);
  });

  it("the community filter returns ONLY non-official listings (disjoint from official)", async () => {
    await publishFlow(SYSTEM_MOIRA, "Official One");
    await publishFlow(AUTHOR, "Community One");
    await publishFlow(AUTHOR, "Community Two");

    const community = await service.getGallery({ community: true });
    expect(community.total).toBe(2);
    expect(community.items.every((i) => i.publishedBy === AUTHOR)).toBe(true);

    const official = await service.getGallery({ official: true });
    expect(official.total).toBe(1);
    expect(official.items.every((i) => i.publishedBy === SYSTEM_MOIRA)).toBe(true);

    // The two partitions are disjoint and cover the whole catalog.
    const all = await service.getGallery({});
    expect(official.total + community.total).toBe(all.total);
  });

  it("facet counts respect an active search", async () => {
    await publishFlow(SYSTEM_MOIRA, "Research Official");
    await publishFlow(AUTHOR, "Research Community");
    await publishFlow(AUTHOR, "Unrelated Community");

    const facets = await service.getGalleryFacets({ search: "Research" });
    expect(facets.all).toBe(2);
    expect(facets.official).toBe(1);
    expect(facets.community).toBe(1);
  });
});
