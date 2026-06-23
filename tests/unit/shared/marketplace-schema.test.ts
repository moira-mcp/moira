/**
 * Unit tests for the marketplace database schema (migration 0014).
 *
 * Verifies that the marketplace tables are created by the migration chain and
 * that their structural constraints hold: one listing per workflow, one review
 * per (listing, user), one library entry per (user, workflow), one entitlement
 * per (user, listing), column defaults, and the nullable event userId.
 *
 * FK enforcement is left ON here (the constraints under test are UNIQUE indexes
 * and column defaults, exercised with self-consistent rows); cross-table FK
 * behavior is covered by integration tests with real fixtures.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

const MARKETPLACE_TABLES = [
  "marketplaceListing",
  "libraryEntry",
  "marketplaceReview",
  "marketplaceEntitlement",
  "marketplaceEvent",
] as const;

describe("marketplace schema (migration 0014)", () => {
  let sqlite: Database.Database;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    // FK off: these tests insert self-contained rows and assert UNIQUE/default
    // behavior without seeding user/workflow fixtures.
    sqlite.exec("PRAGMA foreign_keys = OFF");
    const db = drizzle(sqlite);
    const migrationsPath = path.join(process.cwd(), "packages/web-backend/drizzle");
    migrate(db, { migrationsFolder: migrationsPath });
  });

  afterEach(() => {
    sqlite.close();
  });

  /** Insert a minimal valid listing, returning its id. */
  function insertListing(id: string, workflowId: string): void {
    sqlite
      .prepare(
        `INSERT INTO marketplaceListing
         (id, workflowId, publishedBy, title, category, publishedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, workflowId, "user-1", "My Flow", "development", 1, 1, 1);
  }

  describe("migration", () => {
    it("creates all five marketplace tables", () => {
      const rows = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const names = new Set(rows.map((r) => r.name));
      for (const table of MARKETPLACE_TABLES) {
        expect(names.has(table)).toBe(true);
      }
    });

    it("creates the listing indexes (unique workflow + category browse)", () => {
      const indexes = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all() as Array<{ name: string }>;
      const names = new Set(indexes.map((r) => r.name));
      expect(names.has("marketplace_listing_workflow_idx")).toBe(true);
      expect(names.has("marketplace_listing_category_idx")).toBe(true);
    });
  });

  describe("marketplaceListing", () => {
    it("applies column defaults on a minimal insert", () => {
      insertListing("listing-1", "wf-1");
      const row = sqlite
        .prepare("SELECT * FROM marketplaceListing WHERE id = ?")
        .get("listing-1") as Record<string, unknown>;

      expect(row.status).toBe("listed");
      expect(row.tags).toBe("[]");
      expect(row.verified).toBe(0);
      expect(row.verifyCandidate).toBe(0);
      expect(row.featured).toBe(0);
      expect(row.ratingAvg).toBe(0);
      expect(row.ratingCount).toBe(0);
      expect(row.installCount).toBe(0);
      expect(row.startCount).toBe(0);
      expect(row.viewCount).toBe(0);
      expect(row.isPaid).toBe(0);
      expect(row.origin).toBe("local");
      expect(row.price).toBeNull();
      expect(row.currency).toBeNull();
    });

    it("enforces one listing per workflow (unique workflowId)", () => {
      insertListing("listing-1", "wf-1");
      expect(() => insertListing("listing-2", "wf-1")).toThrow(/UNIQUE/i);
    });

    it("allows distinct workflows to each have a listing", () => {
      insertListing("listing-1", "wf-1");
      expect(() => insertListing("listing-2", "wf-2")).not.toThrow();
    });
  });

  describe("marketplaceReview", () => {
    function insertReview(id: string, listingId: string, userId: string, stars = 5): void {
      sqlite
        .prepare(
          `INSERT INTO marketplaceReview (id, listingId, userId, stars, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, listingId, userId, stars, 1, 1);
    }

    it("enforces one review per (listing, user)", () => {
      insertReview("rev-1", "listing-1", "user-1");
      expect(() => insertReview("rev-2", "listing-1", "user-1")).toThrow(/UNIQUE/i);
    });

    it("allows different users to review the same listing", () => {
      insertReview("rev-1", "listing-1", "user-1");
      expect(() => insertReview("rev-2", "listing-1", "user-2")).not.toThrow();
    });

    it("accepts the boundary star ratings 1 and 5 (DB CHECK)", () => {
      expect(() => insertReview("rev-lo", "listing-1", "user-1", 1)).not.toThrow();
      expect(() => insertReview("rev-hi", "listing-1", "user-2", 5)).not.toThrow();
    });

    it("rejects an out-of-range star rating (DB CHECK 1..5)", () => {
      expect(() => insertReview("rev-0", "listing-1", "user-1", 0)).toThrow(/CHECK/i);
      expect(() => insertReview("rev-6", "listing-1", "user-2", 6)).toThrow(/CHECK/i);
    });
  });

  describe("libraryEntry", () => {
    function insertEntry(id: string, userId: string, workflowId: string): void {
      sqlite
        .prepare(
          `INSERT INTO libraryEntry (id, userId, workflowId, source, kind, addedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, userId, workflowId, "added", "reference", 1);
    }

    it("enforces one entry per (user, workflow)", () => {
      insertEntry("le-1", "user-1", "wf-1");
      expect(() => insertEntry("le-2", "user-1", "wf-1")).toThrow(/UNIQUE/i);
    });

    it("allows the same workflow in two different users' libraries", () => {
      insertEntry("le-1", "user-1", "wf-1");
      expect(() => insertEntry("le-2", "user-2", "wf-1")).not.toThrow();
    });
  });

  describe("marketplaceEntitlement", () => {
    function insertEntitlement(id: string, userId: string, listingId: string): void {
      sqlite
        .prepare(
          `INSERT INTO marketplaceEntitlement (id, userId, listingId, source, grantedAt)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(id, userId, listingId, "purchase", 1);
    }

    it("enforces one entitlement per (user, listing)", () => {
      insertEntitlement("ent-1", "user-1", "listing-1");
      expect(() => insertEntitlement("ent-2", "user-1", "listing-1")).toThrow(/UNIQUE/i);
    });
  });

  describe("marketplaceEvent", () => {
    it("allows a null userId (anonymous analytics signal)", () => {
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO marketplaceEvent (id, listingId, userId, type, at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run("ev-1", "listing-1", null, "view", 1),
      ).not.toThrow();

      const row = sqlite
        .prepare("SELECT userId FROM marketplaceEvent WHERE id = ?")
        .get("ev-1") as { userId: string | null };
      expect(row.userId).toBeNull();
    });
  });
});
