/**
 * Unit tests for NoteService
 * Tests validation, quota enforcement, and audit logging
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import * as schema from "../../../packages/shared/src/database/schema.js";
import {
  NoteRepository,
  AuditRepository,
  MAX_NOTE_SIZE,
  MAX_USER_TOTAL_SIZE,
  NoteService,
  NoteNotFoundError,
  InvalidNoteKeyError,
  InvalidTagError,
  TooManyTagsError,
  NoteSizeExceededError,
  QuotaExceededError,
  NoteVersionNotFoundError,
  validateNoteKey,
  validateTag,
  validateTags,
  NOTE_KEY_MAX_LENGTH,
  MAX_TAG_LENGTH,
  AuditAction,
} from "@mcp-moira/shared";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

const TEST_USER_ID = "test-user-service-123";
const TEST_USER_ID_2 = "test-user-service-456";

describe("NoteService", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let noteRepo: NoteRepository;
  let auditRepo: AuditRepository;
  let noteService: NoteService;

  beforeEach(() => {
    // Create in-memory database for each test
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });

    // Disable foreign key enforcement for isolated testing
    sqlite.exec("PRAGMA foreign_keys = OFF");

    // Run migrations to create tables
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    // Create test users - user table uses text for timestamps, handle is required
    const now = new Date().toISOString();
    db.insert(schema.user)
      .values([
        {
          id: TEST_USER_ID,
          email: "service-test@example.com",
          name: "Service Test User",
          handle: "service-test-user",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: TEST_USER_ID_2,
          email: "service-test2@example.com",
          name: "Service Test User 2",
          handle: "service-test-user-2",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    noteRepo = new NoteRepository(db);
    auditRepo = new AuditRepository(db);
    noteService = new NoteService(noteRepo, auditRepo);
  });

  afterEach(() => {
    sqlite?.close();
  });

  // ===== Validation Function Tests =====

  describe("validateNoteKey", () => {
    it("accepts valid keys", () => {
      expect(validateNoteKey("a").valid).toBe(true);
      expect(validateNoteKey("my-key").valid).toBe(true);
      expect(validateNoteKey("my_key").valid).toBe(true);
      expect(validateNoteKey("MyKey123").valid).toBe(true);
      expect(validateNoteKey("key-with_mixed-123").valid).toBe(true);
      expect(validateNoteKey("a".repeat(100)).valid).toBe(true);
    });

    it("rejects empty key", () => {
      const result = validateNoteKey("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("required");
    });

    it("rejects key exceeding max length", () => {
      const result = validateNoteKey("a".repeat(101));
      expect(result.valid).toBe(false);
      expect(result.error).toContain(`${NOTE_KEY_MAX_LENGTH}`);
    });

    it("rejects keys with invalid characters", () => {
      expect(validateNoteKey("key with space").valid).toBe(false);
      expect(validateNoteKey("key.with.dots").valid).toBe(false);
      expect(validateNoteKey("key/slash").valid).toBe(false);
      expect(validateNoteKey("key@symbol").valid).toBe(false);
    });
  });

  describe("validateTag", () => {
    it("accepts valid tags", () => {
      expect(validateTag("a").valid).toBe(true);
      expect(validateTag("my tag").valid).toBe(true);
      expect(validateTag("Tag 123!").valid).toBe(true);
      expect(validateTag("a".repeat(50)).valid).toBe(true);
    });

    it("rejects empty tag", () => {
      const result = validateTag("");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("required");
    });

    it("rejects tag exceeding max length", () => {
      const result = validateTag("a".repeat(51));
      expect(result.valid).toBe(false);
      expect(result.error).toContain(`${MAX_TAG_LENGTH}`);
    });
  });

  describe("validateTags", () => {
    it("accepts valid tags array", () => {
      expect(validateTags(["tag1", "tag2"]).valid).toBe(true);
      expect(validateTags([]).valid).toBe(true);
      expect(validateTags(Array(10).fill("tag")).valid).toBe(true);
    });

    it("rejects too many tags", () => {
      const result = validateTags(Array(11).fill("tag"));
      expect(result.valid).toBe(false);
      expect(result.error).toContain("10");
    });
  });

  // ===== Service Method Tests =====

  describe("save", () => {
    it("creates new note with audit log", async () => {
      const result = await noteService.save(TEST_USER_ID, {
        key: "test-key",
        value: "test content",
        tags: ["tag1"],
      });

      expect(result.id).toBeDefined();
      expect(result.version).toBe(1);

      // Verify note was saved
      const note = await noteService.get(TEST_USER_ID, "test-key");
      expect(note.value).toBe("test content");
      expect(note.tags).toEqual(["tag1"]);

      // Verify audit log - list returns array directly
      const auditLogs = await auditRepo.list({ action: AuditAction.NOTE_CREATE });
      expect(auditLogs.length).toBe(1);
      expect(auditLogs[0].resourceId).toBe("test-key");
    });

    it("updates existing note with audit log", async () => {
      await noteService.save(TEST_USER_ID, { key: "test-key", value: "v1" });
      const result = await noteService.save(TEST_USER_ID, { key: "test-key", value: "v2" });

      expect(result.version).toBe(2);

      // Verify audit log has both create and update
      const createLogs = await auditRepo.list({ action: AuditAction.NOTE_CREATE });
      const updateLogs = await auditRepo.list({ action: AuditAction.NOTE_UPDATE });
      expect(createLogs.length).toBe(1);
      expect(updateLogs.length).toBe(1);
    });

    it("throws InvalidNoteKeyError for invalid key", async () => {
      await expect(
        noteService.save(TEST_USER_ID, { key: "invalid key!", value: "content" }),
      ).rejects.toThrow(InvalidNoteKeyError);
    });

    it("throws TooManyTagsError when exceeding tag limit", async () => {
      await expect(
        noteService.save(TEST_USER_ID, {
          key: "test-key",
          value: "content",
          tags: Array(11).fill("tag"),
        }),
      ).rejects.toThrow(TooManyTagsError);
    });

    it("throws InvalidTagError for invalid tag", async () => {
      await expect(
        noteService.save(TEST_USER_ID, {
          key: "test-key",
          value: "content",
          tags: ["valid", "a".repeat(51)],
        }),
      ).rejects.toThrow(InvalidTagError);
    });

    it("throws NoteSizeExceededError for oversized content", async () => {
      const bigContent = "x".repeat(MAX_NOTE_SIZE + 1);
      await expect(
        noteService.save(TEST_USER_ID, { key: "test-key", value: bigContent }),
      ).rejects.toThrow(NoteSizeExceededError);
    });

    it("throws QuotaExceededError when user quota exceeded", async () => {
      // Fill up most of the quota
      const largeContent = "x".repeat(MAX_NOTE_SIZE - 100);
      await noteService.save(TEST_USER_ID, { key: "note1", value: largeContent });
      await noteService.save(TEST_USER_ID, { key: "note2", value: largeContent });
      await noteService.save(TEST_USER_ID, { key: "note3", value: largeContent });
      await noteService.save(TEST_USER_ID, { key: "note4", value: largeContent });
      await noteService.save(TEST_USER_ID, { key: "note5", value: largeContent });
      await noteService.save(TEST_USER_ID, { key: "note6", value: largeContent });
      await noteService.save(TEST_USER_ID, { key: "note7", value: largeContent });
      await noteService.save(TEST_USER_ID, { key: "note8", value: largeContent });
      await noteService.save(TEST_USER_ID, { key: "note9", value: largeContent });
      await noteService.save(TEST_USER_ID, { key: "note10", value: largeContent });

      // Try to add more
      await expect(
        noteService.save(TEST_USER_ID, { key: "note11", value: largeContent }),
      ).rejects.toThrow(QuotaExceededError);
    });

    it("allows update that doesn't exceed quota", async () => {
      // Create a note that uses significant space
      const content = "x".repeat(50000);
      await noteService.save(TEST_USER_ID, { key: "test-key", value: content });

      // Updating with same size should work even if close to quota
      const result = await noteService.save(TEST_USER_ID, { key: "test-key", value: content });
      expect(result.version).toBe(2);
    });
  });

  describe("get", () => {
    it("returns note by key", async () => {
      await noteService.save(TEST_USER_ID, { key: "my-key", value: "content", tags: ["t1"] });
      const note = await noteService.get(TEST_USER_ID, "my-key");
      expect(note.key).toBe("my-key");
      expect(note.value).toBe("content");
      expect(note.tags).toEqual(["t1"]);
    });

    it("throws NoteNotFoundError for missing key", async () => {
      await expect(noteService.get(TEST_USER_ID, "missing")).rejects.toThrow(NoteNotFoundError);
    });
  });

  describe("getOrNull", () => {
    it("returns null for missing key", async () => {
      const note = await noteService.getOrNull(TEST_USER_ID, "missing");
      expect(note).toBeNull();
    });
  });

  describe("getWithVersion", () => {
    it("returns specific version", async () => {
      await noteService.save(TEST_USER_ID, { key: "key", value: "v1" });
      await noteService.save(TEST_USER_ID, { key: "key", value: "v2" });
      await noteService.save(TEST_USER_ID, { key: "key", value: "v3" });

      const note = await noteService.getWithVersion(TEST_USER_ID, "key", 2);
      expect(note.value).toBe("v2");
      expect(note.version).toBe(2);
    });

    it("throws NoteNotFoundError for missing note", async () => {
      await expect(noteService.getWithVersion(TEST_USER_ID, "missing", 1)).rejects.toThrow(
        NoteNotFoundError,
      );
    });

    it("throws NoteVersionNotFoundError for missing version", async () => {
      await noteService.save(TEST_USER_ID, { key: "key", value: "v1" });
      await expect(noteService.getWithVersion(TEST_USER_ID, "key", 999)).rejects.toThrow(
        NoteVersionNotFoundError,
      );
    });
  });

  describe("getHistory", () => {
    it("returns version history", async () => {
      await noteService.save(TEST_USER_ID, { key: "key", value: "v1" });
      await noteService.save(TEST_USER_ID, { key: "key", value: "v2" });
      await noteService.save(TEST_USER_ID, { key: "key", value: "v3" });

      const history = await noteService.getHistory(TEST_USER_ID, "key");
      expect(history).toHaveLength(3);
      expect(history[0].version).toBe(3); // Newest first
      expect(history[2].version).toBe(1);
    });

    it("throws NoteNotFoundError for missing note", async () => {
      await expect(noteService.getHistory(TEST_USER_ID, "missing")).rejects.toThrow(
        NoteNotFoundError,
      );
    });
  });

  describe("list", () => {
    it("lists user notes", async () => {
      await noteService.save(TEST_USER_ID, { key: "key1", value: "v1" });
      await noteService.save(TEST_USER_ID, { key: "key2", value: "v2" });

      const result = await noteService.list(TEST_USER_ID);
      expect(result.total).toBe(2);
      expect(result.notes.map((n) => n.key).sort()).toEqual(["key1", "key2"]);
    });

    it("filters by tag", async () => {
      await noteService.save(TEST_USER_ID, { key: "key1", value: "v1", tags: ["work"] });
      await noteService.save(TEST_USER_ID, { key: "key2", value: "v2", tags: ["personal"] });

      const result = await noteService.list(TEST_USER_ID, { tag: "work" });
      expect(result.total).toBe(1);
      expect(result.notes[0].key).toBe("key1");
    });
  });

  describe("getStats", () => {
    it("returns user statistics", async () => {
      await noteService.save(TEST_USER_ID, { key: "key1", value: "content1" });
      await noteService.save(TEST_USER_ID, { key: "key2", value: "content2" });

      const stats = await noteService.getStats(TEST_USER_ID);
      expect(stats.totalNotes).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.limit).toBe(MAX_USER_TOTAL_SIZE);
      expect(stats.usedPercent).toBeLessThan(1);
    });
  });

  describe("delete", () => {
    it("soft deletes note with audit log", async () => {
      await noteService.save(TEST_USER_ID, { key: "key", value: "content" });
      await noteService.delete(TEST_USER_ID, "key");

      // Note should not be accessible
      await expect(noteService.get(TEST_USER_ID, "key")).rejects.toThrow(NoteNotFoundError);

      // Verify audit log
      const logs = await auditRepo.list({ action: AuditAction.NOTE_DELETE });
      expect(logs.length).toBe(1);
    });

    it("throws NoteNotFoundError for missing note", async () => {
      await expect(noteService.delete(TEST_USER_ID, "missing")).rejects.toThrow(NoteNotFoundError);
    });
  });

  describe("restore", () => {
    it("restores soft-deleted note with audit log", async () => {
      await noteService.save(TEST_USER_ID, { key: "key", value: "content" });
      await noteService.delete(TEST_USER_ID, "key");
      await noteService.restore(TEST_USER_ID, "key");

      // Note should be accessible again
      const note = await noteService.get(TEST_USER_ID, "key");
      expect(note.value).toBe("content");

      // Verify audit log
      const logs = await auditRepo.list({ action: AuditAction.NOTE_RESTORE });
      expect(logs.length).toBe(1);
    });

    it("throws NoteNotFoundError if note not deleted", async () => {
      await expect(noteService.restore(TEST_USER_ID, "missing")).rejects.toThrow(NoteNotFoundError);
    });
  });

  describe("hardDelete", () => {
    it("permanently deletes note with audit log", async () => {
      await noteService.save(TEST_USER_ID, { key: "key", value: "content" });
      await noteService.hardDelete(TEST_USER_ID, "key");

      // Note should be gone completely
      await expect(noteService.get(TEST_USER_ID, "key")).rejects.toThrow(NoteNotFoundError);
      // Also can't restore
      await expect(noteService.restore(TEST_USER_ID, "key")).rejects.toThrow(NoteNotFoundError);

      // Verify audit log
      const logs = await auditRepo.list({ action: AuditAction.NOTE_HARD_DELETE });
      expect(logs.length).toBe(1);
    });

    it("throws NoteNotFoundError for missing note", async () => {
      await expect(noteService.hardDelete(TEST_USER_ID, "missing")).rejects.toThrow(
        NoteNotFoundError,
      );
    });
  });

  describe("exists", () => {
    it("returns true for existing note", async () => {
      await noteService.save(TEST_USER_ID, { key: "key", value: "content" });
      expect(await noteService.exists(TEST_USER_ID, "key")).toBe(true);
    });

    it("returns false for missing note", async () => {
      expect(await noteService.exists(TEST_USER_ID, "missing")).toBe(false);
    });
  });

  describe("saveBatch", () => {
    it("saves multiple notes with individual audit logs", async () => {
      const result = await noteService.saveBatch(TEST_USER_ID, [
        { key: "key1", value: "v1" },
        { key: "key2", value: "v2", tags: ["tag"] },
      ]);

      expect(result).toHaveLength(2);
      expect(result[0].key).toBe("key1");
      expect(result[1].key).toBe("key2");

      // Verify audit logs
      const logs = await auditRepo.list({ action: AuditAction.NOTE_CREATE });
      expect(logs.length).toBe(2);
    });

    it("validates all notes before saving any", async () => {
      // Save first note
      await noteService.save(TEST_USER_ID, { key: "existing", value: "v1" });

      // Try batch with invalid key - should fail without saving valid ones
      await expect(
        noteService.saveBatch(TEST_USER_ID, [
          { key: "valid-key", value: "v1" },
          { key: "invalid key!", value: "v2" },
        ]),
      ).rejects.toThrow(InvalidNoteKeyError);

      // valid-key should not exist
      expect(await noteService.exists(TEST_USER_ID, "valid-key")).toBe(false);
    });

    it("checks total quota for batch", async () => {
      // Fill up most of the quota
      const largeContent = "x".repeat(MAX_NOTE_SIZE - 100);
      for (let i = 0; i < 9; i++) {
        await noteService.save(TEST_USER_ID, { key: `note${i}`, value: largeContent });
      }

      // Batch that would exceed quota
      await expect(
        noteService.saveBatch(TEST_USER_ID, [
          { key: "batch1", value: largeContent },
          { key: "batch2", value: largeContent },
        ]),
      ).rejects.toThrow(QuotaExceededError);
    });
  });

  // ===== User Isolation Tests =====

  describe("user isolation", () => {
    it("cannot access other user's notes", async () => {
      await noteService.save(TEST_USER_ID, { key: "my-key", value: "secret" });
      await expect(noteService.get(TEST_USER_ID_2, "my-key")).rejects.toThrow(NoteNotFoundError);
    });

    it("same key can exist for different users", async () => {
      await noteService.save(TEST_USER_ID, { key: "shared-key", value: "user1" });
      await noteService.save(TEST_USER_ID_2, { key: "shared-key", value: "user2" });

      const note1 = await noteService.get(TEST_USER_ID, "shared-key");
      const note2 = await noteService.get(TEST_USER_ID_2, "shared-key");

      expect(note1.value).toBe("user1");
      expect(note2.value).toBe("user2");
    });

    it("quota is per-user", async () => {
      // Fill up test user's quota
      const largeContent = "x".repeat(MAX_NOTE_SIZE - 100);
      for (let i = 0; i < 10; i++) {
        await noteService.save(TEST_USER_ID, { key: `note${i}`, value: largeContent });
      }

      // Other user should still be able to save
      const result = await noteService.save(TEST_USER_ID_2, { key: "note", value: largeContent });
      expect(result.version).toBe(1);
    });
  });
});
