/**
 * Unit tests for MarketplaceListingRepository — create/get/delete, the gallery
 * predicate (listed AND public AND not deleted), and the install counter.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import * as schema from "../../../packages/shared/src/database/schema.js";
import { MarketplaceListingRepository } from "@mcp-moira/shared";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

describe("MarketplaceListingRepository", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let repo: MarketplaceListingRepository;

  function seedWorkflow(id: string, visibility: "public" | "private", deleted = false): void {
    const now = new Date();
    db.insert(schema.workflow)
      .values({
        id,
        userId: "owner-1",
        slug: id,
        name: id,
        version: "1.0.0",
        graph: "{}",
        visibility,
        deleted,
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
    repo = new MarketplaceListingRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("creates a listing with sane defaults and reads it back", async () => {
    seedWorkflow("wf-1", "public");
    const listing = await repo.create({
      workflowId: "wf-1",
      publishedBy: "owner-1",
      title: "Flow",
      category: "development",
      tags: ["a", "b"],
    });

    expect(listing.status).toBe("listed");
    expect(listing.installCount).toBe(0);
    expect(listing.isPaid).toBe(false);
    expect(JSON.parse(listing.tags)).toEqual(["a", "b"]);

    expect((await repo.getById(listing.id))?.id).toBe(listing.id);
    expect((await repo.getByWorkflowId("wf-1"))?.id).toBe(listing.id);
  });

  it("deletes a listing by workflow id", async () => {
    seedWorkflow("wf-1", "public");
    await repo.create({
      workflowId: "wf-1",
      publishedBy: "owner-1",
      title: "Flow",
      category: "other",
    });

    expect(await repo.deleteByWorkflowId("wf-1")).toBe(true);
    expect(await repo.getByWorkflowId("wf-1")).toBeNull();
    expect(await repo.deleteByWorkflowId("wf-1")).toBe(false);
  });

  it("gallery returns only listed + public + non-deleted flows", async () => {
    seedWorkflow("wf-public", "public");
    seedWorkflow("wf-private", "private");
    seedWorkflow("wf-deleted", "public", true);

    await repo.create({
      workflowId: "wf-public",
      publishedBy: "o",
      title: "Public",
      category: "other",
    });
    await repo.create({
      workflowId: "wf-private",
      publishedBy: "o",
      title: "Private",
      category: "other",
    });
    await repo.create({
      workflowId: "wf-deleted",
      publishedBy: "o",
      title: "Deleted",
      category: "other",
    });

    const gallery = await repo.listGallery();
    const ids = gallery.map((l) => l.workflowId);
    expect(ids).toEqual(["wf-public"]);
  });

  it("filters the gallery by category", async () => {
    seedWorkflow("wf-dev", "public");
    seedWorkflow("wf-research", "public");
    await repo.create({
      workflowId: "wf-dev",
      publishedBy: "o",
      title: "Dev",
      category: "development",
    });
    await repo.create({
      workflowId: "wf-research",
      publishedBy: "o",
      title: "Res",
      category: "research",
    });

    const dev = await repo.listGallery({ category: "development" });
    expect(dev.map((l) => l.workflowId)).toEqual(["wf-dev"]);
  });

  it("increments the install counter", async () => {
    seedWorkflow("wf-1", "public");
    const listing = await repo.create({
      workflowId: "wf-1",
      publishedBy: "o",
      title: "Flow",
      category: "other",
    });

    await repo.incrementInstallCount(listing.id);
    await repo.incrementInstallCount(listing.id);
    expect((await repo.getById(listing.id))?.installCount).toBe(2);
  });
});
