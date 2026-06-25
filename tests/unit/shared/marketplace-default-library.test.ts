/**
 * Unit tests for the default-library seeding (Step 17): MarketplaceService.
 * seedDefaultLibrary seeds the curated official base flows (owned by system-moira)
 * into a user's library as live references — independent of the marketplace feature
 * flag, idempotent, and tolerant of base slugs not installed on the instance. The
 * getLibrary resolver marks official-owned flows `official:true` and lists a seeded
 * base flow exactly once (core claims the workflow id, so the seeded `added` entry is
 * not double-listed).
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
  OFFICIAL_BASE_FLOW_SLUGS,
  type CoreFlow,
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

const SYSTEM_MOIRA = "system-moira";
const USER = "user-1";

// Install a strict subset of the base set so the "tolerates a missing slug" path is
// exercised: at least one base slug is intentionally NOT installed on this instance.
const INSTALLED_SLUGS = OFFICIAL_BASE_FLOW_SLUGS.slice(0, OFFICIAL_BASE_FLOW_SLUGS.length - 1);
const MISSING_SLUG = OFFICIAL_BASE_FLOW_SLUGS[OFFICIAL_BASE_FLOW_SLUGS.length - 1];

describe("MarketplaceService.seedDefaultLibrary (Step 17)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let listingRepo: MarketplaceListingRepository;
  let libraryRepo: LibraryEntryRepository;
  let reviewRepo: MarketplaceReviewRepository;
  let eventRepo: MarketplaceEventRepository;
  let workflowRepo: WorkflowRepository;
  let sharingRepo: WorkflowSharingRepository;
  let userRepo: UserRepository;

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

  function makeGraph(slug: string): WorkflowGraph {
    return {
      metadata: { name: `Flow ${slug}`, version: "1.0.0", description: `${slug} flow` },
      nodes: [
        { id: "start", type: "start", connections: { default: "end" } },
        { id: "end", type: "end" },
      ],
    } as unknown as WorkflowGraph;
  }

  /** Install a public flow owned by system-moira with the given slug; returns its id. */
  async function installSystemFlow(slug: string): Promise<string> {
    const saved = await workflowRepo.save({
      graph: makeGraph(slug),
      userId: SYSTEM_MOIRA,
      slug,
      visibility: "public",
    });
    return saved.id;
  }

  /** A coreProvider returning the installed base flows as core (workflowId resolved by slug). */
  function coreProviderForInstalled(): CoreFlow[] {
    return INSTALLED_SLUGS.map((slug) => ({
      workflowId: null,
      slug,
      name: `Flow ${slug}`,
      ownerHandle: "moira",
      workflow: makeGraph(slug),
    }));
  }

  function makeService(
    overrides: {
      isMarketplaceEnabled?: () => boolean;
      coreProvider?: () => CoreFlow[];
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
        isPaidEnabled: () => false,
        // No bundled flows by default — seeding must not depend on the core provider.
        coreProvider: overrides.coreProvider ?? (() => []),
      },
    );
  }

  beforeEach(async () => {
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

    seedUser(SYSTEM_MOIRA, "moira");
    seedUser(USER, "user");

    // Install only the subset — MISSING_SLUG is deliberately absent.
    for (const slug of INSTALLED_SLUGS) {
      await installSystemFlow(slug);
    }
  });

  afterEach(() => {
    sqlite.close();
  });

  it("seeds a live reference for each installed official base slug", async () => {
    const service = makeService();

    const { seeded } = await service.seedDefaultLibrary(USER);
    expect(seeded).toBe(INSTALLED_SLUGS.length);

    // Each installed base flow is a reference entry in the user's library.
    for (const slug of INSTALLED_SLUGS) {
      const workflowId = await workflowRepo.resolveSlug(slug, SYSTEM_MOIRA);
      expect(workflowId).not.toBeNull();
      const entry = await libraryRepo.getByUserAndWorkflow(USER, workflowId!);
      expect(entry).not.toBeNull();
      expect(entry!.source).toBe("added");
      expect(entry!.kind).toBe("reference");
      expect(entry!.listingId).toBeNull();
    }
  });

  it("tolerates a base slug that is not installed (skips it, no throw)", async () => {
    const service = makeService();

    await service.seedDefaultLibrary(USER);

    // The uninstalled base slug resolves to nothing and produces no library entry.
    const missingId = await workflowRepo.resolveSlug(MISSING_SLUG, SYSTEM_MOIRA);
    expect(missingId).toBeNull();
    // Only the installed subset was seeded.
    const entries = await libraryRepo.listByUser(USER);
    expect(entries).toHaveLength(INSTALLED_SLUGS.length);
  });

  it("is idempotent — a second call adds nothing", async () => {
    const service = makeService();

    const first = await service.seedDefaultLibrary(USER);
    expect(first.seeded).toBe(INSTALLED_SLUGS.length);

    const second = await service.seedDefaultLibrary(USER);
    expect(second.seeded).toBe(0);

    const entries = await libraryRepo.listByUser(USER);
    expect(entries).toHaveLength(INSTALLED_SLUGS.length);
  });

  it("does not depend on the marketplace feature flag (works when disabled)", async () => {
    const service = makeService({ isMarketplaceEnabled: () => false });

    const { seeded } = await service.seedDefaultLibrary(USER);
    expect(seeded).toBe(INSTALLED_SLUGS.length);
    const entries = await libraryRepo.listByUser(USER);
    expect(entries).toHaveLength(INSTALLED_SLUGS.length);
  });

  it("does not seed base flows into the system owner's own library", async () => {
    const service = makeService();

    const { seeded } = await service.seedDefaultLibrary(SYSTEM_MOIRA);
    expect(seeded).toBe(0);
    const entries = await libraryRepo.listByUser(SYSTEM_MOIRA);
    expect(entries).toHaveLength(0);
  });

  it("getLibrary marks the seeded base flows official:true", async () => {
    const service = makeService({ coreProvider: coreProviderForInstalled });
    await service.seedDefaultLibrary(USER);

    const library = await service.getLibrary(USER);
    for (const slug of INSTALLED_SLUGS) {
      const item = library.find((i) => i.slug === slug);
      expect(item).toBeDefined();
      expect(item!.official).toBe(true);
    }
  });

  it("lists a seeded base flow exactly once (no core + added duplication)", async () => {
    const service = makeService({ coreProvider: coreProviderForInstalled });
    await service.seedDefaultLibrary(USER);

    const library = await service.getLibrary(USER);
    for (const slug of INSTALLED_SLUGS) {
      const workflowId = await workflowRepo.resolveSlug(slug, SYSTEM_MOIRA);
      const matches = library.filter((i) => i.workflowId === workflowId);
      // Core claims the workflow id, so the seeded `added` entry is deduped away.
      expect(matches).toHaveLength(1);
      expect(matches[0].origin).toBe("core");
    }
  });

  it("marks a non-official owned flow official:false", async () => {
    // A flow the user owns themselves is not official.
    await workflowRepo.save({
      graph: makeGraph("my-own-flow"),
      userId: USER,
      slug: "my-own-flow",
      visibility: "private",
    });
    const service = makeService();

    const library = await service.getLibrary(USER);
    const own = library.find((i) => i.slug === "my-own-flow");
    expect(own).toBeDefined();
    expect(own!.origin).toBe("own");
    expect(own!.official).toBe(false);
  });
});
