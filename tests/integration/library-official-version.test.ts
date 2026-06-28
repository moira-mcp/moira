/**
 * Integration: the "Official" badge is PROVENANCE-based (defect D-N6) and the library
 * projection carries a top-level version + updatedAt (defects D-N1/D-N7).
 *
 * - Official ⟺ owned by the official catalog account `system-moira`. A flow owned by
 *   `system-admin` (the self-host operator's login) is NOT official — previously the
 *   operator's own/imported flows were falsely badged Official.
 * - getLibrary items expose `version` (from graph metadata) and `updatedAt` so the SPA can
 *   show a version + updated meta line and tell otherwise-identical rows apart.
 *
 * Service-level against a real migrated DB.
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

function graph(name: string, version: string): WorkflowGraph {
  return {
    metadata: { name, version, description: `${name} description` },
    nodes: [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
    ],
  } as unknown as WorkflowGraph;
}

describe("Library Official provenance + version projection (D-N6/D-N1/D-N7)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let workflowRepo: WorkflowRepository;
  let libraryRepo: LibraryEntryRepository;
  let marketplace: MarketplaceService;

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

    workflowRepo = new WorkflowRepository(db);
    libraryRepo = new LibraryEntryRepository(db);
    const sharingRepo = new WorkflowSharingRepository(db);
    workflowRepo.setSharedAccessChecker((wfId, uid) => sharingRepo.hasAccess(wfId, uid));

    marketplace = new MarketplaceService(
      new MarketplaceListingRepository(db),
      libraryRepo,
      new MarketplaceReviewRepository(db),
      new MarketplaceEventRepository(db),
      workflowRepo,
      sharingRepo,
      new UserRepository(db),
      { isMarketplaceEnabled: () => true, isPaidEnabled: () => false },
    );

    seedUser("system-moira", "moira");
    seedUser("system-admin", "admin");
    seedUser("user-1", "alice");
  });

  afterEach(() => sqlite.close());

  it("a flow owned by system-admin (the operator) is NOT official", async () => {
    // The self-host operator logs in as system-admin; their own flow must not be Official.
    const saved = await workflowRepo.save({
      graph: graph("Operator Flow", "1.0.0"),
      userId: "system-admin",
      slug: "operator-flow",
      visibility: "private",
    });

    const lib = await marketplace.getLibrary("system-admin");
    const item = lib.find((i) => i.workflowId === saved.id);
    expect(item).toBeDefined();
    expect(item!.official).toBe(false);
  });

  it("a flow owned by system-moira (the official catalog account) IS official", async () => {
    const saved = await workflowRepo.save({
      graph: graph("Official Base Flow", "2.1.0"),
      userId: "system-moira",
      slug: "official-base-flow",
      visibility: "public",
    });
    // user-1 has it as an added library entry (the seeded-base-flow shape).
    await libraryRepo.add({
      userId: "user-1",
      workflowId: saved.id,
      source: "added",
      kind: "reference",
      listingId: null,
    });

    const lib = await marketplace.getLibrary("user-1");
    const item = lib.find((i) => i.workflowId === saved.id);
    expect(item).toBeDefined();
    expect(item!.official).toBe(true);
    expect(item!.origin).toBe("added");
  });

  it("a regular user's own flow is not official and carries version + updatedAt", async () => {
    const saved = await workflowRepo.save({
      graph: graph("My Flow", "3.4.5"),
      userId: "user-1",
      slug: "my-flow",
      visibility: "private",
    });

    const lib = await marketplace.getLibrary("user-1");
    const item = lib.find((i) => i.workflowId === saved.id);
    expect(item).toBeDefined();
    expect(item!.official).toBe(false);
    expect(item!.version).toBe("3.4.5");
    expect(typeof item!.updatedAt).toBe("number");
    expect(item!.updatedAt).toBeGreaterThan(0);
  });

  it("every library item exposes a version matching its graph metadata", async () => {
    await workflowRepo.save({
      graph: graph("Versioned A", "1.2.3"),
      userId: "user-1",
      slug: "versioned-a",
      visibility: "private",
    });
    await workflowRepo.save({
      graph: graph("Versioned B", "9.9.9"),
      userId: "user-1",
      slug: "versioned-b",
      visibility: "private",
    });

    const lib = await marketplace.getLibrary("user-1");
    const a = lib.find((i) => i.slug === "versioned-a");
    const b = lib.find((i) => i.slug === "versioned-b");
    expect(a!.version).toBe("1.2.3");
    expect(b!.version).toBe("9.9.9");
    // The two same-shaped rows are distinguishable by version (D-N7).
    expect(a!.version).not.toBe(b!.version);
  });
});
