/**
 * Integration: editing a published flow must not silently unpublish it (defect D-C),
 * and an explicit public→private transition on a flow with an ACTIVE listing must be
 * rejected rather than silently orphaning the listing.
 *
 * Exercised at the service level against a real migrated DB: WorkflowService.save
 * (the path behind both the HTTP POST /api/workflows and the MCP `manage` edit
 * actions) now inherits the current visibility when the field is omitted, and the
 * injected active-listing checker blocks a public→private transition that would
 * orphan a `status='listed'` marketplace listing. The storefront export-by-reference
 * (getDetailByReference) is used as the "is it still served" probe — it requires the
 * underlying flow to be public, exactly as the gallery does.
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
} from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");
const OWNER = "owner-1";
const OWNER_HANDLE = "owner";

function graph(name: string, version: string): WorkflowGraph {
  return {
    metadata: { name, version, description: `${name} description` },
    nodes: [
      { id: "start", type: "start", connections: { default: "end" } },
      { id: "end", type: "end" },
    ],
  } as unknown as WorkflowGraph;
}

describe("Workflow visibility vs marketplace listing (service integration)", () => {
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
    // Same wiring the service factory performs in production.
    workflowService.setActiveListingChecker(async (workflowId) => {
      const listing = await listingRepo.getByWorkflowId(workflowId);
      return !!listing && listing.status === "listed";
    });

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

    seedUser(OWNER, OWNER_HANDLE);
  });

  afterEach(() => sqlite.close());

  /** Create a private flow, then publish it (→ public + listed). Returns its id+slug. */
  async function publishedFlow(name: string): Promise<{ id: string; slug: string }> {
    const created = await workflowService.save({
      graph: graph(name, "1.0.0"),
      userId: OWNER,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      visibility: "private",
      isUpdate: false,
    });
    await marketplace.publish(OWNER, created.id);
    return created;
  }

  it("editing a published flow WITHOUT a visibility field keeps it public and listed (D-C)", async () => {
    const flow = await publishedFlow("Edit Keeps Public");

    // Edit content (new version) omitting visibility — the regression path.
    await workflowService.save({
      graph: { ...graph("Edit Keeps Public", "2.0.0"), id: flow.id },
      userId: OWNER,
      isUpdate: true,
    });

    // Flow stayed public; listing still listed; storefront still serves the new version.
    const info = await workflowRepo.getFullInfo(flow.id, OWNER);
    expect(info!.visibility).toBe("public");
    expect(info!.workflow.metadata.version).toBe("2.0.0");

    const listing = await listingRepo.getByWorkflowId(flow.id);
    expect(listing!.status).toBe("listed");

    const detail = await marketplace.getDetailByReference(`${OWNER_HANDLE}/${flow.slug}`, OWNER);
    expect(detail.workflow.metadata.version).toBe("2.0.0");
  });

  it("editing a private flow WITHOUT a visibility field keeps it private", async () => {
    const created = await workflowService.save({
      graph: graph("Stays Private", "1.0.0"),
      userId: OWNER,
      slug: "stays-private",
      visibility: "private",
      isUpdate: false,
    });

    await workflowService.save({
      graph: { ...graph("Stays Private", "1.1.0"), id: created.id },
      userId: OWNER,
      isUpdate: true,
    });

    const info = await workflowRepo.getFullInfo(created.id, OWNER);
    expect(info!.visibility).toBe("private");
    expect(info!.workflow.metadata.version).toBe("1.1.0");
  });

  it("an EXPLICIT private on a listed flow via save() is rejected and leaves it public+listed", async () => {
    const flow = await publishedFlow("Explicit Private Save");

    await expect(
      workflowService.save({
        graph: { ...graph("Explicit Private Save", "1.0.0"), id: flow.id },
        userId: OWNER,
        visibility: "private",
        isUpdate: true,
      }),
    ).rejects.toBeInstanceOf(WorkflowListedCannotGoPrivateError);

    const info = await workflowRepo.getFullInfo(flow.id, OWNER);
    expect(info!.visibility).toBe("public");
    const listing = await listingRepo.getByWorkflowId(flow.id);
    expect(listing!.status).toBe("listed");
  });

  it("an EXPLICIT private on a listed flow via updateVisibility is rejected", async () => {
    const flow = await publishedFlow("Explicit Private Toggle");

    await expect(
      workflowService.updateVisibility(flow.id, OWNER, "private"),
    ).rejects.toBeInstanceOf(WorkflowListedCannotGoPrivateError);

    const info = await workflowRepo.getFullInfo(flow.id, OWNER);
    expect(info!.visibility).toBe("public");
    expect((await listingRepo.getByWorkflowId(flow.id))!.status).toBe("listed");
  });

  it("unpublish is the non-silent path: it makes the flow private and unlists atomically", async () => {
    const flow = await publishedFlow("Unpublish Path");

    await marketplace.unpublish(OWNER, flow.id);

    const info = await workflowRepo.getFullInfo(flow.id, OWNER);
    expect(info!.visibility).toBe("private");
    expect((await listingRepo.getByWorkflowId(flow.id))!.status).toBe("unlisted");

    // After unpublish there is no active listing, so a content edit is unconstrained
    // and the flow stays private (inherited).
    await workflowService.save({
      graph: { ...graph("Unpublish Path", "2.0.0"), id: flow.id },
      userId: OWNER,
      isUpdate: true,
    });
    expect((await workflowRepo.getFullInfo(flow.id, OWNER))!.visibility).toBe("private");
  });

  it("explicit public republish flow: making a private flow public is allowed", async () => {
    const created = await workflowService.save({
      graph: graph("Go Public", "1.0.0"),
      userId: OWNER,
      slug: "go-public",
      visibility: "private",
      isUpdate: false,
    });

    const ok = await workflowService.updateVisibility(created.id, OWNER, "public");
    expect(ok).toBe(true);
    expect((await workflowRepo.getFullInfo(created.id, OWNER))!.visibility).toBe("public");
  });
});
