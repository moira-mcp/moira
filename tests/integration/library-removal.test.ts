/**
 * Integration: origin-aware library removal (defect D-D). Previously remove() only
 * unlinked the library entry, which was a silent no-op for owned/imported/forked flows
 * because getLibrary re-surfaces owned rows — the caller got a "success" that removed
 * nothing. Removal is now origin-aware and reports what happened:
 *   - own (incl. imported/forked copies) → soft-delete the workflow (gone for real)
 *   - added (reference to another user's flow) → unlink the entry
 *   - shared → revoke the user's own access
 *
 * Service-level against a real migrated DB, with the owned-workflow remover wired to
 * WorkflowService.softDelete exactly as production does.
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
  AuditRepository,
  WorkflowService,
  WorkflowMutationService,
  LibraryEntryNotFoundError,
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");
const OWNER = "owner-1";
const CONSUMER = "consumer-1";

function graph(name: string): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: `${name} description` },
    nodes: [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
    ],
  } as unknown as WorkflowGraph;
}

describe("Origin-aware library removal (D-D)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let workflowRepo: WorkflowRepository;
  let listingRepo: MarketplaceListingRepository;
  let sharingRepo: WorkflowSharingRepository;
  let workflowService: WorkflowService;
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
    const auditRepo = new AuditRepository(db);
    const userRepo = new UserRepository(db);
    sharingRepo = new WorkflowSharingRepository(db);
    workflowRepo.setSharedAccessChecker((wfId, uid) => sharingRepo.hasAccess(wfId, uid));
    listingRepo = new MarketplaceListingRepository(db);

    const mutationService = new WorkflowMutationService(workflowRepo, auditRepo);
    workflowService = new WorkflowService(workflowRepo, auditRepo, userRepo);
    workflowService.setMutationService(mutationService);
    workflowService.setActiveListingChecker(async (wfId) => {
      const l = await listingRepo.getByWorkflowId(wfId);
      return !!l && l.status === "listed";
    });
    workflowService.setListingUnlister((wfId) => listingRepo.unlistForWorkflow(wfId));

    marketplace = new MarketplaceService(
      listingRepo,
      new LibraryEntryRepository(db),
      new MarketplaceReviewRepository(db),
      new MarketplaceEventRepository(db),
      workflowRepo,
      sharingRepo,
      userRepo,
      { isMarketplaceEnabled: () => true, isPaidEnabled: () => false },
    );
    marketplace.setOwnedWorkflowRemover((wfId, uid) => workflowService.softDelete(wfId, uid));

    seedUser(OWNER, "owner");
    seedUser(CONSUMER, "consumer");
  });

  afterEach(() => sqlite.close());

  const inLibrary = async (userId: string, workflowId: string): Promise<boolean> =>
    (await marketplace.getLibrary(userId)).some((i) => i.workflowId === workflowId);

  it("removing an imported (owned copy) flow actually deletes it from the library", async () => {
    // importFromFile creates an OWNED private copy + an 'added'/copy library entry — the
    // exact D-D shape where the old unlink-only remove was a no-op.
    const imported = await marketplace.importFromFile(CONSUMER, graph("Imported Copy"), {
      instance: "https://ext.example",
      workflowId: "ext-1",
    });
    expect(await inLibrary(CONSUMER, imported.workflowId)).toBe(true);

    const result = await marketplace.remove(CONSUMER, imported.workflowId);

    expect(result).toEqual({ origin: "own", action: "deleted" });
    expect(await inLibrary(CONSUMER, imported.workflowId)).toBe(false);
    expect(await workflowRepo.getFullInfo(imported.workflowId, CONSUMER)).toBeNull();
  });

  it("removing a plain owned flow deletes it (origin own)", async () => {
    const own = await workflowService.save({
      graph: graph("Plain Own"),
      userId: OWNER,
      slug: "plain-own",
      visibility: "private",
      isUpdate: false,
    });
    expect(await inLibrary(OWNER, own.id)).toBe(true);

    const result = await marketplace.remove(OWNER, own.id);
    expect(result).toEqual({ origin: "own", action: "deleted" });
    expect(await inLibrary(OWNER, own.id)).toBe(false);
  });

  it("removing a published owned flow deletes it AND unlists its listing (invariant)", async () => {
    const own = await workflowService.save({
      graph: graph("Published Own"),
      userId: OWNER,
      slug: "published-own",
      visibility: "private",
      isUpdate: false,
    });
    await marketplace.publish(OWNER, own.id);

    const result = await marketplace.remove(OWNER, own.id);
    expect(result).toEqual({ origin: "own", action: "deleted" });
    expect((await listingRepo.getByWorkflowId(own.id))!.status).toBe("unlisted");
    expect(await workflowRepo.getFullInfo(own.id, OWNER)).toBeNull();
  });

  it("removing an added reference unlinks it and leaves the original untouched", async () => {
    const own = await workflowService.save({
      graph: graph("Shared Listing"),
      userId: OWNER,
      slug: "shared-listing",
      visibility: "private",
      isUpdate: false,
    });
    const listing = await marketplace.publish(OWNER, own.id);
    await marketplace.install(CONSUMER, listing.id); // reference entry for the consumer
    expect(await inLibrary(CONSUMER, own.id)).toBe(true);

    const result = await marketplace.remove(CONSUMER, own.id);

    expect(result).toEqual({ origin: "added", action: "unlinked" });
    expect(await inLibrary(CONSUMER, own.id)).toBe(false);
    // The author's workflow + listing are untouched.
    expect(await workflowRepo.getFullInfo(own.id, OWNER)).not.toBeNull();
    expect((await listingRepo.getByWorkflowId(own.id))!.status).toBe("listed");
  });

  it("removing a shared flow revokes the user's own access", async () => {
    const own = await workflowService.save({
      graph: graph("Direct Share"),
      userId: OWNER,
      slug: "direct-share",
      visibility: "private",
      isUpdate: false,
    });
    await sharingRepo.grantAccess(own.id, CONSUMER, OWNER);
    expect(await inLibrary(CONSUMER, own.id)).toBe(true);

    const result = await marketplace.remove(CONSUMER, own.id);

    expect(result).toEqual({ origin: "shared", action: "revoked" });
    expect(await inLibrary(CONSUMER, own.id)).toBe(false);
    expect(await sharingRepo.hasAccess(own.id, CONSUMER)).toBe(false);
    // The owner still owns it.
    expect(await workflowRepo.getFullInfo(own.id, OWNER)).not.toBeNull();
  });

  it("removing a flow that is in no part of the library throws LibraryEntryNotFoundError", async () => {
    await expect(marketplace.remove(CONSUMER, "nonexistent-workflow")).rejects.toBeInstanceOf(
      LibraryEntryNotFoundError,
    );
  });
});
