/**
 * Unit tests for MarketplaceEventRepository — append-only record, trending
 * ranking by recent activity, type filter, and nullable userId.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import * as schema from "../../../packages/shared/src/database/schema.js";
import { MarketplaceEventRepository } from "@mcp-moira/shared";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

describe("MarketplaceEventRepository", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let repo: MarketplaceEventRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });
    repo = new MarketplaceEventRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  it("records events (including a null userId) and lists them", async () => {
    await repo.record({ listingId: "L1", userId: "u1", type: "view" });
    await repo.record({ listingId: "L1", type: "install" }); // anonymous
    const events = await repo.listByListing("L1");
    expect(events).toHaveLength(2);
    expect(events.some((e) => e.userId === null)).toBe(true);
  });

  it("ranks trending by event count, highest first", async () => {
    for (const type of ["view", "install", "start"] as const) {
      await repo.record({ listingId: "hot", type });
    }
    await repo.record({ listingId: "cold", type: "view" });

    const trending = await repo.trending({ sinceMs: 0 });
    expect(trending[0]).toEqual({ listingId: "hot", score: 3 });
    expect(trending[1]).toEqual({ listingId: "cold", score: 1 });
  });

  it("filters trending by event type", async () => {
    await repo.record({ listingId: "L1", type: "start" });
    await repo.record({ listingId: "L1", type: "view" });
    await repo.record({ listingId: "L2", type: "view" });

    const byStart = await repo.trending({ sinceMs: 0, types: ["start"] });
    expect(byStart).toEqual([{ listingId: "L1", score: 1 }]);
  });

  it("excludes events older than the window", async () => {
    await repo.record({ listingId: "L1", type: "view" });
    // Window starts in the future → nothing qualifies.
    const trending = await repo.trending({ sinceMs: Date.now() + 60_000 });
    expect(trending).toHaveLength(0);
  });
});
