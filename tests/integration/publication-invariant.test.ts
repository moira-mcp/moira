/**
 * Integration: the publication invariant — a `status='listed'` listing ALWAYS references a
 * public, non-deleted workflow. visibility and listing status are coupled through one owning
 * path (publishCoupled/unpublishCoupled) and every other mutation path (edit, visibility
 * toggle, soft-delete, admin re-list) is blocked from producing the illegal `listed+private`
 * or `listed+deleted` state. A startup repair converges any pre-existing violations.
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
  AuditRepository,
  WorkflowService,
  WorkflowMutationService,
  WorkflowListedCannotGoPrivateError,
  WorkflowNotListableError,
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");
const OWNER = "owner-1";

function graph(name: string): WorkflowGraph {
  return {
    metadata: { name, version: "1.0.0", description: `${name} description` },
    nodes: [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
    ],
  } as unknown as WorkflowGraph;
}

describe("Publication invariant (listed ⟹ public + not deleted)", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let workflowRepo: WorkflowRepository;
  let listingRepo: MarketplaceListingRepository;
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
    const sharingRepo = new WorkflowSharingRepository(db);
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

    seedUser(OWNER, "owner");
  });

  afterEach(() => sqlite.close());

  async function createPrivate(name: string): Promise<string> {
    const r = await workflowService.save({
      graph: graph(name),
      userId: OWNER,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      visibility: "private",
      isUpdate: false,
    });
    return r.id;
  }

  it("publish couples visibility + listing atomically (public + listed)", async () => {
    const id = await createPrivate("Publish Couple");
    const listing = await marketplace.publish(OWNER, id);

    expect(listing.status).toBe("listed");
    expect((await workflowRepo.getFullInfo(id, OWNER))!.visibility).toBe("public");
  });

  it("unpublish couples visibility + listing atomically (private + unlisted)", async () => {
    const id = await createPrivate("Unpublish Couple");
    await marketplace.publish(OWNER, id);

    await marketplace.unpublish(OWNER, id);

    expect((await listingRepo.getByWorkflowId(id))!.status).toBe("unlisted");
    expect((await workflowRepo.getFullInfo(id, OWNER))!.visibility).toBe("private");
  });

  it("soft-deleting a published workflow unlists its listing (no listed+deleted)", async () => {
    const id = await createPrivate("Delete Unlists");
    await marketplace.publish(OWNER, id);

    expect(await workflowService.softDelete(id, OWNER)).toBe(true);

    // Listing row is kept but no longer listed; the workflow is gone.
    expect((await listingRepo.getByWorkflowId(id))!.status).toBe("unlisted");
    expect(await workflowRepo.getFullInfo(id, OWNER)).toBeNull();
  });

  it("making a listed flow private is rejected (no listed+private via visibility toggle)", async () => {
    const id = await createPrivate("Toggle Guard");
    await marketplace.publish(OWNER, id);

    await expect(workflowService.updateVisibility(id, OWNER, "private")).rejects.toBeInstanceOf(
      WorkflowListedCannotGoPrivateError,
    );
    expect((await listingRepo.getByWorkflowId(id))!.status).toBe("listed");
    expect((await workflowRepo.getFullInfo(id, OWNER))!.visibility).toBe("public");
  });

  it("admin cannot re-list a listing whose workflow is private (no listed+private via moderation)", async () => {
    const id = await createPrivate("Admin Relist Guard");
    await marketplace.publish(OWNER, id);
    await marketplace.unpublish(OWNER, id); // now private + unlisted
    const listing = await listingRepo.getByWorkflowId(id);

    await expect(marketplace.setListingStatus(listing!.id, "listed")).rejects.toBeInstanceOf(
      WorkflowNotListableError,
    );
    expect((await listingRepo.getByWorkflowId(id))!.status).toBe("unlisted");
  });

  it("startup repair unlists a pre-existing listed+private row and reports the count", async () => {
    // Simulate a legacy inconsistent row by writing the two columns independently via the
    // low-level repo primitives (bypassing the coupling), as old code could.
    const id = await createPrivate("Legacy Orphan");
    await listingRepo.create({
      workflowId: id,
      publishedBy: OWNER,
      title: "Legacy Orphan",
      category: "other",
    });
    // workflow is still private → listed + private = the illegal state.
    expect((await listingRepo.getByWorkflowId(id))!.status).toBe("listed");
    expect((await workflowRepo.getFullInfo(id, OWNER))!.visibility).toBe("private");

    const repaired = await listingRepo.repairInconsistentListings();
    expect(repaired).toBe(1);
    expect((await listingRepo.getByWorkflowId(id))!.status).toBe("unlisted");
  });

  it("startup repair leaves a consistent listed+public row untouched", async () => {
    const id = await createPrivate("Consistent");
    await marketplace.publish(OWNER, id);

    const repaired = await listingRepo.repairInconsistentListings();
    expect(repaired).toBe(0);
    expect((await listingRepo.getByWorkflowId(id))!.status).toBe("listed");
  });
});
