/**
 * Integration (Step 8) — two data-hygiene defects, against a real migrated DB:
 *
 *   D-N4 (slug freed on delete): the `(userId, slug)` unique index must NOT keep a
 *   deleted workflow's slug permanently reserved. Deleting a flow and then creating a
 *   new flow with the same slug must succeed. Restoring a deleted flow assigns a fresh
 *   valid slug (the original may have been reused).
 *
 *   D-N5 (self-install guard): a listing's own author cannot install/adopt their own
 *   listing (it would inflate the install/trending counters); the attempt is rejected
 *   and the install counter is unaffected. Forking your own listing is allowed (an
 *   independent copy) but likewise does not inflate the counter; a non-author install
 *   and fork DO increment it.
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
  SelfInstallError,
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

const AUTHOR = "author-1";
const USER = "user-1";

function makeGraph(name: string): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: `${name} flow` },
    nodes: [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
    ],
  } as unknown as WorkflowGraph;
}

describe("Marketplace slug-freed-on-delete + self-install guard (Step 8)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let listingRepo: MarketplaceListingRepository;
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

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    listingRepo = new MarketplaceListingRepository(db);
    const libraryRepo = new LibraryEntryRepository(db);
    workflowRepo = new WorkflowRepository(db);
    const sharingRepo = new WorkflowSharingRepository(db);
    const userRepo = new UserRepository(db);
    workflowRepo.setSharedAccessChecker((wfId, uid) => sharingRepo.hasAccess(wfId, uid));

    service = new MarketplaceService(
      listingRepo,
      libraryRepo,
      new MarketplaceReviewRepository(db),
      new MarketplaceEventRepository(db),
      workflowRepo,
      sharingRepo,
      userRepo,
      {
        isMarketplaceEnabled: () => true,
        isPaidEnabled: () => false,
      },
    );

    seedUser(AUTHOR, "author");
    seedUser(USER, "user");
  });

  afterEach(() => sqlite.close());

  // ===== D-N4: slug freed on delete =====

  it("frees the slug on delete so the same slug can be reused", async () => {
    const first = await workflowRepo.save({
      graph: makeGraph("Reusable"),
      userId: USER,
      slug: "reusable-slug",
      visibility: "private",
    });
    expect(first.slug).toBe("reusable-slug");

    const deleted = await workflowRepo.softDelete(first.id, USER);
    expect(deleted).toBe(true);

    // Re-creating a flow with the same slug must succeed (today it would conflict).
    const second = await workflowRepo.save({
      graph: makeGraph("Reusable Again"),
      userId: USER,
      slug: "reusable-slug",
      visibility: "private",
    });
    expect(second.slug).toBe("reusable-slug");
    expect(second.id).not.toBe(first.id);

    // The two rows are distinct: the live one owns the slug, the deleted one was freed.
    expect(await workflowRepo.slugExists("reusable-slug", USER)).toBe(true);
    expect(await workflowRepo.slugExists("reusable-slug", USER, second.id)).toBe(false);
  });

  it("repairFreedSlugs frees legacy deleted rows so a reserved slug becomes reusable", async () => {
    // Simulate a row soft-deleted BEFORE the freed-slug enforcement shipped: it still holds
    // its original slug, so the (userId, slug) unique index keeps it reserved.
    const now = Date.now();
    db.insert(schema.workflow)
      .values({
        id: "legacy-deleted-id",
        userId: USER,
        slug: "legacy-slug",
        name: "Legacy",
        version: "1.0.0",
        graph: JSON.stringify(makeGraph("Legacy")),
        visibility: "private",
        deleted: true,
        deletedAt: new Date(now),
        createdAt: new Date(now),
        updatedAt: new Date(now),
      } as typeof schema.workflow.$inferInsert)
      .run();

    // Before repair the slug is still reserved at the DB level: re-creating it must fail.
    // (We assert via an explicit try/catch boolean rather than `.rejects.toThrow()` — the
    // latter matches on the rejection's Error prototype, which is unreliable across jest's
    // per-worker better-sqlite3 native-addon realms in the full parallel suite.)
    let reusedBeforeRepair = false;
    try {
      await workflowRepo.save({
        graph: makeGraph("New Legacy"),
        userId: USER,
        slug: "legacy-slug",
        visibility: "private",
      });
      reusedBeforeRepair = true;
    } catch {
      // expected: the legacy deleted row still holds the slug at the unique index.
    }
    expect(reusedBeforeRepair).toBe(false);

    const repaired = await workflowRepo.repairFreedSlugs();
    expect(repaired).toBe(1);

    // After repair the slug is free and reuse succeeds.
    const recreated = await workflowRepo.save({
      graph: makeGraph("New Legacy"),
      userId: USER,
      slug: "legacy-slug",
      visibility: "private",
    });
    expect(recreated.slug).toBe("legacy-slug");

    // Idempotent: a second run touches nothing (already-freed rows are skipped).
    expect(await workflowRepo.repairFreedSlugs()).toBe(0);
  });

  it("restore assigns a fresh unique slug when the original was reused", async () => {
    const original = await workflowRepo.save({
      graph: makeGraph("Restore Me"),
      userId: USER,
      slug: "restore-me",
      visibility: "private",
    });
    await workflowRepo.softDelete(original.id, USER);

    // Someone re-took the freed slug.
    const replacement = await workflowRepo.save({
      graph: makeGraph("Took The Slug"),
      userId: USER,
      slug: "restore-me",
      visibility: "private",
    });

    const restored = await workflowRepo.restore(original.id, USER);
    expect(restored).toBe(true);

    // The restored flow must NOT collide with the replacement; it gets a fresh slug.
    const restoredInfo = await workflowRepo.getFullInfo(original.id, USER);
    expect(restoredInfo).not.toBeNull();
    expect(restoredInfo!.slug).not.toBe("restore-me");
    expect(restoredInfo!.slug).not.toBe(replacement.slug);
    // Both flows are now live with distinct slugs.
    const replacementInfo = await workflowRepo.getFullInfo(replacement.id, USER);
    expect(replacementInfo!.slug).toBe("restore-me");
  });

  // ===== D-N5: self-install guard =====

  async function publishAuthorListing(): Promise<{ listingId: string }> {
    const flow = await workflowRepo.save({
      graph: makeGraph("Author Flow"),
      userId: AUTHOR,
      visibility: "private",
    });
    const listing = await service.publish(AUTHOR, flow.id);
    return { listingId: listing.id };
  }

  it("rejects the author installing their own listing and leaves the counter untouched", async () => {
    const { listingId } = await publishAuthorListing();
    expect((await listingRepo.getById(listingId))!.installCount).toBe(0);

    await expect(service.install(AUTHOR, listingId)).rejects.toBeInstanceOf(SelfInstallError);

    // Counter not inflated by the owner; no library entry created for the author.
    expect((await listingRepo.getById(listingId))!.installCount).toBe(0);
  });

  it("counts a non-author install but not the author's own", async () => {
    const { listingId } = await publishAuthorListing();

    await service.install(USER, listingId);
    expect((await listingRepo.getById(listingId))!.installCount).toBe(1);

    await expect(service.install(AUTHOR, listingId)).rejects.toBeInstanceOf(SelfInstallError);
    expect((await listingRepo.getById(listingId))!.installCount).toBe(1);
  });

  it("allows the author to fork their own listing without inflating the counter", async () => {
    const { listingId } = await publishAuthorListing();

    // Self-fork is allowed (an independent private copy) but is not counted.
    const selfFork = await service.fork(AUTHOR, listingId);
    expect(selfFork.workflowId).toBeTruthy();
    expect((await listingRepo.getById(listingId))!.installCount).toBe(0);

    // A non-author fork DOES count.
    await service.fork(USER, listingId);
    expect((await listingRepo.getById(listingId))!.installCount).toBe(1);
  });
});
