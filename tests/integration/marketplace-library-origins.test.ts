/**
 * Integration: the library origins + filter model (Step 18) at the service level,
 * against a real migrated DB. The "core" origin has been removed entirely — the
 * library is own ∪ added ∪ shared, deduped by workflowId. The curated official base
 * flows surface through the `added` branch (seeded `libraryEntry` source="added" rows
 * owned by system-moira, hence official:true). The single filterable set is
 * all | official | added | mine | shared.
 *
 * Verifies: no item ever carries origin "core"; the seeded base flows appear under
 * origin "added" with official:true; each filter returns the correct deduped subset;
 * an owned-and-listed flow appears exactly once; and with the marketplace feature
 * disabled the seeded base flows are still returned (library resolution is local).
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
  OFFICIAL_BASE_FLOW_SLUGS,
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

const SYSTEM_MOIRA = "system-moira";
const AUTHOR = "author-1";
const USER = "user-1";

// Two official base slugs are installed as system-moira public flows and seeded.
const BASE_SLUGS = OFFICIAL_BASE_FLOW_SLUGS.slice(0, 2);

function makeGraph(name: string): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: `${name} flow` },
    nodes: [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
    ],
  } as unknown as WorkflowGraph;
}

describe("Marketplace library origins + filter (Step 18, service integration)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let listingRepo: MarketplaceListingRepository;
  let libraryRepo: LibraryEntryRepository;
  let workflowRepo: WorkflowRepository;
  let sharingRepo: WorkflowSharingRepository;
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

  /** Install a public flow owned by system-moira with the given slug; returns its id. */
  async function installSystemFlow(slug: string): Promise<string> {
    const saved = await workflowRepo.save({
      graph: makeGraph(`Base ${slug}`),
      userId: SYSTEM_MOIRA,
      slug,
      visibility: "public",
    });
    return saved.id;
  }

  /** Create a private workflow owned by `userId`; returns its id + slug. */
  async function makeWorkflow(userId: string, name: string): Promise<{ id: string; slug: string }> {
    const wf = await workflowRepo.save({
      graph: makeGraph(name),
      userId,
      visibility: "private",
    });
    return { id: wf.id, slug: wf.slug };
  }

  beforeEach(async () => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    listingRepo = new MarketplaceListingRepository(db);
    libraryRepo = new LibraryEntryRepository(db);
    workflowRepo = new WorkflowRepository(db);
    sharingRepo = new WorkflowSharingRepository(db);
    const userRepo = new UserRepository(db);
    workflowRepo.setSharedAccessChecker((wfId, uid) => sharingRepo.hasAccess(wfId, uid));
    marketplaceEnabled = true;

    service = new MarketplaceService(
      listingRepo,
      libraryRepo,
      new MarketplaceReviewRepository(db),
      new MarketplaceEventRepository(db),
      workflowRepo,
      sharingRepo,
      userRepo,
      {
        isMarketplaceEnabled: () => marketplaceEnabled,
        isPaidEnabled: () => false,
      },
    );

    seedUser(SYSTEM_MOIRA, "moira");
    seedUser(AUTHOR, "author");
    seedUser(USER, "user");

    for (const slug of BASE_SLUGS) {
      await installSystemFlow(slug);
    }
  });

  afterEach(() => sqlite.close());

  /**
   * Build a representative library for USER:
   *   - seeded official base flows (added, official)
   *   - one owned flow that USER also published (own, deduped to exactly one)
   *   - one author flow USER installed (added, NOT official)
   *   - one author flow shared with USER (shared)
   * Returns the relevant ids for assertions.
   */
  async function buildLibrary(): Promise<{
    ownListedId: string;
    installedId: string;
    sharedId: string;
  }> {
    await service.seedDefaultLibrary(USER);

    // own + listed: USER owns a flow and publishes it (no library entry is written).
    const ownFlow = await makeWorkflow(USER, "User Own Listed");
    await service.publish(USER, ownFlow.id);

    // added (non-official): an author flow USER installs from the marketplace.
    const authorFlow = await makeWorkflow(AUTHOR, "Author Installable");
    const listing = await service.publish(AUTHOR, authorFlow.id);
    await service.install(USER, listing.id);

    // shared: an author flow shared directly with USER.
    const sharedFlow = await makeWorkflow(AUTHOR, "Author Shared");
    await sharingRepo.grantAccess(sharedFlow.id, USER, AUTHOR);

    return { ownListedId: ownFlow.id, installedId: authorFlow.id, sharedId: sharedFlow.id };
  }

  it("never returns an item with origin 'core'", async () => {
    await buildLibrary();
    const library = await service.getLibrary(USER);
    expect(library.length).toBeGreaterThan(0);
    // Every origin is one of the three real sources — "core" is gone entirely.
    expect(library.every((i) => ["own", "added", "shared"].includes(i.origin))).toBe(true);
    expect(library.some((i) => (i.origin as string) === "core")).toBe(false);
  });

  it("surfaces the seeded official base flows under origin 'added' with official:true", async () => {
    await buildLibrary();
    const library = await service.getLibrary(USER);
    for (const slug of BASE_SLUGS) {
      const item = library.find((i) => i.slug === slug);
      expect(item).toBeDefined();
      expect(item!.origin).toBe("added");
      expect(item!.official).toBe(true);
      expect(item!.ownerHandle).toBe("moira");
    }
  });

  it("lists an owned-and-listed flow exactly once (origin 'own')", async () => {
    const { ownListedId } = await buildLibrary();
    const library = await service.getLibrary(USER);
    const matches = library.filter((i) => i.workflowId === ownListedId);
    expect(matches).toHaveLength(1);
    expect(matches[0].origin).toBe("own");
    expect(matches[0].official).toBe(false);
  });

  it("each filter returns the correct deduped subset", async () => {
    const { ownListedId, installedId, sharedId } = await buildLibrary();

    const all = await service.getLibrary(USER, "all");
    const official = await service.getLibrary(USER, "official");
    const added = await service.getLibrary(USER, "added");
    const mine = await service.getLibrary(USER, "mine");
    const shared = await service.getLibrary(USER, "shared");

    // all = official-base (added) + installed (added) + own + shared.
    const baseCount = BASE_SLUGS.length;
    expect(all).toHaveLength(baseCount + 1 /* installed */ + 1 /* own */ + 1 /* shared */);

    // official = exactly the seeded base flows.
    expect(official.every((i) => i.official)).toBe(true);
    expect(official.every((i) => i.origin === "added")).toBe(true);
    expect(official).toHaveLength(baseCount);

    // added = base flows + the installed author flow (all origin "added").
    expect(added.every((i) => i.origin === "added")).toBe(true);
    expect(added).toHaveLength(baseCount + 1);
    expect(added.some((i) => i.workflowId === installedId)).toBe(true);

    // mine = the user's own flows only.
    expect(mine.every((i) => i.origin === "own")).toBe(true);
    expect(mine.map((i) => i.workflowId)).toContain(ownListedId);
    expect(mine.some((i) => i.workflowId === installedId)).toBe(false);

    // shared = the shared flow only.
    expect(shared.map((i) => i.workflowId)).toEqual([sharedId]);
    expect(shared[0].origin).toBe("shared");

    // The four filtered subsets partition `all` with no overlap and no loss.
    expect(mine.length + added.length + shared.length).toBe(all.length);
  });

  it("returns the seeded base flows even when the marketplace feature is disabled", async () => {
    await service.seedDefaultLibrary(USER);
    marketplaceEnabled = false;

    const library = await service.getLibrary(USER);
    for (const slug of BASE_SLUGS) {
      const item = library.find((i) => i.slug === slug);
      expect(item).toBeDefined();
      expect(item!.origin).toBe("added");
      expect(item!.official).toBe(true);
    }
  });
});
