/**
 * Unit tests for LibraryEntryRepository — add/get/list/remove.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import * as schema from "../../../packages/shared/src/database/schema.js";
import { LibraryEntryRepository } from "@mcp-moira/shared";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

describe("LibraryEntryRepository", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let repo: LibraryEntryRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });
    repo = new LibraryEntryRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("adds an entry and reads it back by (user, workflow)", async () => {
    const entry = await repo.add({
      userId: "user-1",
      workflowId: "wf-1",
      source: "added",
      kind: "reference",
      listingId: "listing-1",
    });
    expect(entry.source).toBe("added");
    expect(entry.kind).toBe("reference");
    expect(entry.listingId).toBe("listing-1");

    const found = await repo.getByUserAndWorkflow("user-1", "wf-1");
    expect(found?.id).toBe(entry.id);
  });

  it("lists all entries for a user", async () => {
    await repo.add({ userId: "user-1", workflowId: "wf-1", source: "added", kind: "reference" });
    await repo.add({ userId: "user-1", workflowId: "wf-2", source: "shared", kind: "reference" });
    await repo.add({ userId: "user-2", workflowId: "wf-3", source: "added", kind: "copy" });

    const entries = await repo.listByUser("user-1");
    expect(entries.map((e) => e.workflowId).sort()).toEqual(["wf-1", "wf-2"]);
  });

  it("removes an entry and reports whether a row was removed", async () => {
    await repo.add({ userId: "user-1", workflowId: "wf-1", source: "added", kind: "reference" });

    expect(await repo.remove("user-1", "wf-1")).toBe(true);
    expect(await repo.getByUserAndWorkflow("user-1", "wf-1")).toBeNull();
    expect(await repo.remove("user-1", "wf-1")).toBe(false);
  });
});
