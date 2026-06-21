/**
 * Unit tests for NoteRepository
 * Tests CRUD operations, versioning, soft delete, and quota tracking
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  NoteRepository,
  MAX_VERSIONS_PER_NOTE,
  MAX_NOTE_SIZE,
  MAX_USER_TOTAL_SIZE,
} from "@mcp-moira/shared";
import path from "path";

// Import all schema tables for drizzle
import * as schema from "../../../packages/shared/src/database/schema.js";

describe("NoteRepository", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let repository: NoteRepository;
  let sqlite: Database.Database;

  const TEST_USER_ID = "test-user-123";
  const TEST_USER_ID_2 = "test-user-456";

  beforeEach(() => {
    // Create in-memory database for each test
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });

    // Disable foreign key enforcement for isolated testing
    sqlite.exec("PRAGMA foreign_keys = OFF");

    // Run migrations
    const migrationsPath = path.join(process.cwd(), "packages/web-backend/drizzle");
    migrate(db, { migrationsFolder: migrationsPath });

    repository = new NoteRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("constants", () => {
    it("exports MAX_VERSIONS_PER_NOTE as 50", () => {
      expect(MAX_VERSIONS_PER_NOTE).toBe(50);
    });

    it("exports MAX_NOTE_SIZE as 100KB", () => {
      expect(MAX_NOTE_SIZE).toBe(100 * 1024);
    });

    it("exports MAX_USER_TOTAL_SIZE as 1MB", () => {
      expect(MAX_USER_TOTAL_SIZE).toBe(1024 * 1024);
    });
  });

  describe("save and getByKey", () => {
    it("creates a new note", async () => {
      const result = await repository.save({
        userId: TEST_USER_ID,
        key: "my-note",
        value: "Hello, World!",
        tags: ["greeting"],
      });

      expect(result.id).toBeDefined();
      expect(result.version).toBe(1);

      const note = await repository.getByKey("my-note", TEST_USER_ID);
      expect(note).not.toBeNull();
      expect(note?.key).toBe("my-note");
      expect(note?.value).toBe("Hello, World!");
      expect(note?.tags).toEqual(["greeting"]);
      expect(note?.version).toBe(1);
    });

    it("updates existing note and increments version", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "my-note",
        value: "Version 1",
      });

      const result = await repository.save({
        userId: TEST_USER_ID,
        key: "my-note",
        value: "Version 2",
      });

      expect(result.version).toBe(2);

      const note = await repository.getByKey("my-note", TEST_USER_ID);
      expect(note?.value).toBe("Version 2");
      expect(note?.version).toBe(2);
    });

    it("creates note without tags", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "no-tags",
        value: "Content",
      });

      const note = await repository.getByKey("no-tags", TEST_USER_ID);
      expect(note?.tags).toEqual([]);
    });

    it("calculates size correctly", async () => {
      const content = "Hello, World! 🌍"; // Contains multibyte characters
      await repository.save({
        userId: TEST_USER_ID,
        key: "size-test",
        value: content,
      });

      const note = await repository.getByKey("size-test", TEST_USER_ID);
      expect(note?.size).toBe(Buffer.byteLength(content, "utf8"));
    });

    it("returns null for non-existent note", async () => {
      const note = await repository.getByKey("non-existent", TEST_USER_ID);
      expect(note).toBeNull();
    });

    it("enforces user isolation - user A cannot see user B's note", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "private-note",
        value: "Secret content",
      });

      const note = await repository.getByKey("private-note", TEST_USER_ID_2);
      expect(note).toBeNull();
    });

    it("allows same key for different users", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "shared-key",
        value: "User 1 content",
      });

      await repository.save({
        userId: TEST_USER_ID_2,
        key: "shared-key",
        value: "User 2 content",
      });

      const note1 = await repository.getByKey("shared-key", TEST_USER_ID);
      const note2 = await repository.getByKey("shared-key", TEST_USER_ID_2);

      expect(note1?.value).toBe("User 1 content");
      expect(note2?.value).toBe("User 2 content");
    });
  });

  describe("getByKeyWithVersion", () => {
    it("retrieves specific version", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "versioned",
        value: "Version 1",
      });

      await repository.save({
        userId: TEST_USER_ID,
        key: "versioned",
        value: "Version 2",
      });

      await repository.save({
        userId: TEST_USER_ID,
        key: "versioned",
        value: "Version 3",
      });

      const v1 = await repository.getByKeyWithVersion("versioned", TEST_USER_ID, 1);
      const v2 = await repository.getByKeyWithVersion("versioned", TEST_USER_ID, 2);
      const v3 = await repository.getByKeyWithVersion("versioned", TEST_USER_ID, 3);

      expect(v1?.value).toBe("Version 1");
      expect(v2?.value).toBe("Version 2");
      expect(v3?.value).toBe("Version 3");
    });

    it("returns null for non-existent version", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "single-version",
        value: "Content",
      });

      const note = await repository.getByKeyWithVersion("single-version", TEST_USER_ID, 999);
      expect(note).toBeNull();
    });

    it("returns null for non-existent note", async () => {
      const note = await repository.getByKeyWithVersion("non-existent", TEST_USER_ID, 1);
      expect(note).toBeNull();
    });
  });

  describe("getHistory", () => {
    it("returns version history", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "history-test",
        value: "Version 1",
      });

      await repository.save({
        userId: TEST_USER_ID,
        key: "history-test",
        value: "Version 2 with longer content",
      });

      const history = await repository.getHistory("history-test", TEST_USER_ID);

      expect(history).toHaveLength(2);
      // Ordered by version DESC
      expect(history[0].version).toBe(2);
      expect(history[1].version).toBe(1);
      expect(history[0].preview).toContain("Version 2");
      expect(history[1].preview).toContain("Version 1");
    });

    it("returns empty array for non-existent note", async () => {
      const history = await repository.getHistory("non-existent", TEST_USER_ID);
      expect(history).toEqual([]);
    });

    it("includes preview truncated at 100 characters", async () => {
      const longContent = "A".repeat(200);
      await repository.save({
        userId: TEST_USER_ID,
        key: "long-content",
        value: longContent,
      });

      const history = await repository.getHistory("long-content", TEST_USER_ID);
      expect(history[0].preview.length).toBeLessThanOrEqual(103); // 100 + "..."
      expect(history[0].preview).toContain("...");
    });
  });

  describe("version cleanup", () => {
    it("keeps only MAX_VERSIONS_PER_NOTE versions", async () => {
      const key = "many-versions";

      // Create MAX_VERSIONS_PER_NOTE + 10 versions
      for (let i = 1; i <= MAX_VERSIONS_PER_NOTE + 10; i++) {
        await repository.save({
          userId: TEST_USER_ID,
          key,
          value: `Version ${i}`,
        });
      }

      const history = await repository.getHistory(key, TEST_USER_ID);
      expect(history).toHaveLength(MAX_VERSIONS_PER_NOTE);

      // Should have latest versions (highest numbers)
      expect(history[0].version).toBe(MAX_VERSIONS_PER_NOTE + 10);
      expect(history[MAX_VERSIONS_PER_NOTE - 1].version).toBe(11); // Oldest kept version
    });
  });

  describe("list", () => {
    beforeEach(async () => {
      // Create test notes
      await repository.save({
        userId: TEST_USER_ID,
        key: "note-alpha",
        value: "Alpha content",
        tags: ["finance", "weekly"],
      });

      await repository.save({
        userId: TEST_USER_ID,
        key: "note-beta",
        value: "Beta content",
        tags: ["finance"],
      });

      await repository.save({
        userId: TEST_USER_ID,
        key: "note-gamma",
        value: "Gamma content",
        tags: ["research"],
      });

      // Another user's note
      await repository.save({
        userId: TEST_USER_ID_2,
        key: "other-user-note",
        value: "Other content",
        tags: ["finance"],
      });
    });

    it("lists all notes for user", async () => {
      const result = await repository.list({ userId: TEST_USER_ID });

      expect(result.notes).toHaveLength(3);
      expect(result.total).toBe(3);
    });

    it("filters by tag", async () => {
      const result = await repository.list({ userId: TEST_USER_ID, tag: "finance" });

      expect(result.notes).toHaveLength(2);
      expect(result.notes.map((n) => n.key).sort()).toEqual(["note-alpha", "note-beta"]);
    });

    it("filters by key search", async () => {
      const result = await repository.list({ userId: TEST_USER_ID, keySearch: "alpha" });

      expect(result.notes).toHaveLength(1);
      expect(result.notes[0].key).toBe("note-alpha");
    });

    it("returns allTags for autocomplete", async () => {
      const result = await repository.list({ userId: TEST_USER_ID });

      expect(result.allTags.sort()).toEqual(["finance", "research", "weekly"]);
    });

    it("enforces user isolation in list", async () => {
      const result = await repository.list({ userId: TEST_USER_ID_2 });

      expect(result.notes).toHaveLength(1);
      expect(result.notes[0].key).toBe("other-user-note");
    });

    it("supports pagination", async () => {
      const page1 = await repository.list({ userId: TEST_USER_ID, limit: 2, offset: 0 });
      const page2 = await repository.list({ userId: TEST_USER_ID, limit: 2, offset: 2 });

      expect(page1.notes).toHaveLength(2);
      expect(page1.total).toBe(3);
      expect(page2.notes).toHaveLength(1);
      expect(page2.total).toBe(3);
    });

    it("includes preview in list items", async () => {
      const result = await repository.list({ userId: TEST_USER_ID });

      const alphaNote = result.notes.find((n) => n.key === "note-alpha");
      expect(alphaNote?.preview).toContain("Alpha content");
    });
  });

  describe("softDelete", () => {
    it("soft deletes a note", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "to-delete",
        value: "Content",
      });

      const deleted = await repository.softDelete("to-delete", TEST_USER_ID);
      expect(deleted).toBe(true);

      // Note should not be visible
      const note = await repository.getByKey("to-delete", TEST_USER_ID);
      expect(note).toBeNull();
    });

    it("returns false for non-existent note", async () => {
      const deleted = await repository.softDelete("non-existent", TEST_USER_ID);
      expect(deleted).toBe(false);
    });

    it("returns false if already deleted", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "to-delete",
        value: "Content",
      });

      await repository.softDelete("to-delete", TEST_USER_ID);
      const deleted = await repository.softDelete("to-delete", TEST_USER_ID);

      expect(deleted).toBe(false);
    });

    it("preserves data for audit trail", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "soft-deleted",
        value: "Preserved content",
      });

      await repository.softDelete("soft-deleted", TEST_USER_ID);

      // Can restore
      const restored = await repository.restore("soft-deleted", TEST_USER_ID);
      expect(restored).toBe(true);

      const note = await repository.getByKey("soft-deleted", TEST_USER_ID);
      expect(note?.value).toBe("Preserved content");
    });

    it("enforces user isolation", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "protected",
        value: "Content",
      });

      // Other user cannot delete
      const deleted = await repository.softDelete("protected", TEST_USER_ID_2);
      expect(deleted).toBe(false);

      // Original user can still see it
      const note = await repository.getByKey("protected", TEST_USER_ID);
      expect(note).not.toBeNull();
    });
  });

  describe("restore", () => {
    it("restores a soft-deleted note", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "to-restore",
        value: "Content",
      });

      await repository.softDelete("to-restore", TEST_USER_ID);
      const restored = await repository.restore("to-restore", TEST_USER_ID);

      expect(restored).toBe(true);

      const note = await repository.getByKey("to-restore", TEST_USER_ID);
      expect(note).not.toBeNull();
    });

    it("returns false for non-deleted note", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "not-deleted",
        value: "Content",
      });

      const restored = await repository.restore("not-deleted", TEST_USER_ID);
      expect(restored).toBe(false);
    });

    it("returns false for non-existent note", async () => {
      const restored = await repository.restore("non-existent", TEST_USER_ID);
      expect(restored).toBe(false);
    });
  });

  describe("hardDelete", () => {
    it("permanently deletes a note and all versions", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "permanent-delete",
        value: "Version 1",
      });

      await repository.save({
        userId: TEST_USER_ID,
        key: "permanent-delete",
        value: "Version 2",
      });

      const deleted = await repository.hardDelete("permanent-delete", TEST_USER_ID);
      expect(deleted).toBe(true);

      // Note is gone
      const note = await repository.getByKey("permanent-delete", TEST_USER_ID);
      expect(note).toBeNull();

      // Cannot restore
      const restored = await repository.restore("permanent-delete", TEST_USER_ID);
      expect(restored).toBe(false);
    });

    it("returns false for non-existent note", async () => {
      const deleted = await repository.hardDelete("non-existent", TEST_USER_ID);
      expect(deleted).toBe(false);
    });
  });

  describe("getStats", () => {
    it("returns correct statistics", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "note-1",
        value: "Content 1",
      });

      await repository.save({
        userId: TEST_USER_ID,
        key: "note-2",
        value: "Content 2",
      });

      const stats = await repository.getStats(TEST_USER_ID);

      expect(stats.totalNotes).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.limit).toBe(MAX_USER_TOTAL_SIZE);
      // usedPercent may be 0 due to rounding when content is tiny vs 1MB limit
      expect(stats.usedPercent).toBeGreaterThanOrEqual(0);
      expect(stats.usedPercent).toBeLessThan(1);
    });

    it("returns zero for user with no notes", async () => {
      const stats = await repository.getStats(TEST_USER_ID);

      expect(stats.totalNotes).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(stats.usedPercent).toBe(0);
    });

    it("excludes soft-deleted notes from stats", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "active",
        value: "Active content",
      });

      await repository.save({
        userId: TEST_USER_ID,
        key: "deleted",
        value: "Deleted content",
      });

      await repository.softDelete("deleted", TEST_USER_ID);

      const stats = await repository.getStats(TEST_USER_ID);
      expect(stats.totalNotes).toBe(1);
    });
  });

  describe("getTotalSize", () => {
    it("returns total size of user's notes", async () => {
      const content1 = "Hello";
      const content2 = "World!";

      await repository.save({
        userId: TEST_USER_ID,
        key: "note-1",
        value: content1,
      });

      await repository.save({
        userId: TEST_USER_ID,
        key: "note-2",
        value: content2,
      });

      const totalSize = await repository.getTotalSize(TEST_USER_ID);
      const expectedSize =
        Buffer.byteLength(content1, "utf8") + Buffer.byteLength(content2, "utf8");

      expect(totalSize).toBe(expectedSize);
    });

    it("excludes soft-deleted notes", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "active",
        value: "Active",
      });

      await repository.save({
        userId: TEST_USER_ID,
        key: "deleted",
        value: "Deleted",
      });

      await repository.softDelete("deleted", TEST_USER_ID);

      const totalSize = await repository.getTotalSize(TEST_USER_ID);
      expect(totalSize).toBe(Buffer.byteLength("Active", "utf8"));
    });
  });

  describe("keyExists", () => {
    it("returns true for existing key", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "existing",
        value: "Content",
      });

      const exists = await repository.keyExists("existing", TEST_USER_ID);
      expect(exists).toBe(true);
    });

    it("returns false for non-existing key", async () => {
      const exists = await repository.keyExists("non-existing", TEST_USER_ID);
      expect(exists).toBe(false);
    });

    it("returns false for soft-deleted key", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "deleted-key",
        value: "Content",
      });

      await repository.softDelete("deleted-key", TEST_USER_ID);

      const exists = await repository.keyExists("deleted-key", TEST_USER_ID);
      expect(exists).toBe(false);
    });

    it("enforces user isolation", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "user1-key",
        value: "Content",
      });

      const exists = await repository.keyExists("user1-key", TEST_USER_ID_2);
      expect(exists).toBe(false);
    });
  });

  describe("saveBatch", () => {
    it("saves multiple notes in a batch", async () => {
      const results = await repository.saveBatch(TEST_USER_ID, [
        { key: "batch-1", value: "Content 1", tags: ["batch"] },
        { key: "batch-2", value: "Content 2", tags: ["batch"] },
        { key: "batch-3", value: "Content 3" },
      ]);

      expect(results).toHaveLength(3);
      expect(results[0].key).toBe("batch-1");
      expect(results[1].key).toBe("batch-2");
      expect(results[2].key).toBe("batch-3");

      const list = await repository.list({ userId: TEST_USER_ID });
      expect(list.notes).toHaveLength(3);
    });

    it("updates existing notes in batch", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "existing-batch",
        value: "Original",
      });

      const results = await repository.saveBatch(TEST_USER_ID, [
        { key: "existing-batch", value: "Updated" },
        { key: "new-batch", value: "New" },
      ]);

      expect(results[0].version).toBe(2); // Updated
      expect(results[1].version).toBe(1); // New

      const existing = await repository.getByKey("existing-batch", TEST_USER_ID);
      expect(existing?.value).toBe("Updated");
    });
  });

  describe("save restores soft-deleted note", () => {
    it("restores note when saving to soft-deleted key", async () => {
      await repository.save({
        userId: TEST_USER_ID,
        key: "to-restore-via-save",
        value: "Original",
      });

      await repository.softDelete("to-restore-via-save", TEST_USER_ID);

      // Verify it's deleted
      let note = await repository.getByKey("to-restore-via-save", TEST_USER_ID);
      expect(note).toBeNull();

      // Save to same key should restore
      await repository.save({
        userId: TEST_USER_ID,
        key: "to-restore-via-save",
        value: "Restored content",
      });

      note = await repository.getByKey("to-restore-via-save", TEST_USER_ID);
      expect(note).not.toBeNull();
      expect(note?.value).toBe("Restored content");
    });
  });
});
