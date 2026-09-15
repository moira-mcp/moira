/**
 * Unit tests for the shared revision store and the two consumers unit 1 moves onto it.
 *
 * The store is what makes "one history for every versioned entity" true, so these tests protect
 * three things: that a revision, once written, is never rewritten; that a bounded history drops the
 * oldest revisions rather than reusing numbers; and that the store is where note and global-setting
 * content actually lands, which is the observation that distinguishes a real move from a second
 * implementation added alongside the old one.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { readFileSync } from "fs";
import {
  AuditRepository,
  GlobalSettingsRepository,
  GlobalSettingsService,
  MAX_GLOBAL_SETTING_REVISIONS,
  NoteRepository,
  REVISION_ENTITY_TYPES,
  RevisionRepository,
} from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";

describe("shared revision store", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let revisions: RevisionRepository;

  const ADMIN_ID = "admin-user-1";
  const OTHER_ADMIN_ID = "admin-user-2";
  const target = { entityType: REVISION_ENTITY_TYPES.playbook, entityId: "playbook-1" } as const;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
    revisions = new RevisionRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("appending", () => {
    it("numbers revisions from one and increases by one per append", async () => {
      const first = await revisions.append({ ...target, content: "one" });
      const second = await revisions.append({ ...target, content: "two" });
      const third = await revisions.append({ ...target, content: "three" });

      expect([first.revision, second.revision, third.revision]).toEqual([1, 2, 3]);
      expect((await revisions.latest(target))?.content).toBe("three");
    });

    it("leaves an existing revision untouched when a newer one is written", async () => {
      await revisions.append({ ...target, content: "original", authorId: ADMIN_ID });
      await revisions.append({ ...target, content: "replacement", authorId: OTHER_ADMIN_ID });

      const stored = await revisions.get(target, 1);
      expect(stored?.content).toBe("original");
      expect(stored?.authorId).toBe(ADMIN_ID);
    });

    it("records the byte size of the content rather than its character count", async () => {
      const appended = await revisions.append({ ...target, content: "дом" });
      expect(appended.size).toBe(6);
    });

    it("keeps separate histories for the same id under different entity types", async () => {
      await revisions.append({
        entityType: REVISION_ENTITY_TYPES.note,
        entityId: "shared-id",
        content: "note content",
      });
      const settingRevision = await revisions.append({
        entityType: REVISION_ENTITY_TYPES.globalSetting,
        entityId: "shared-id",
        content: "setting content",
      });

      expect(settingRevision.revision).toBe(1);
    });
  });

  describe("bounded history", () => {
    it("drops the oldest revisions and never reuses a number", async () => {
      for (let i = 1; i <= 5; i++) {
        await revisions.append({ ...target, content: `value ${i}`, maxRevisions: 3 });
      }

      const history = await revisions.list(target);
      expect(history.map((entry) => entry.revision)).toEqual([5, 4, 3]);
      expect(await revisions.get(target, 1)).toBeNull();

      const next = await revisions.append({ ...target, content: "value 6", maxRevisions: 3 });
      expect(next.revision).toBe(6);
    });

    it("keeps every revision when no limit is given", async () => {
      for (let i = 1; i <= 4; i++) {
        await revisions.append({ ...target, content: `value ${i}` });
      }
      expect(await revisions.list(target)).toHaveLength(4);
    });
  });

  describe("listing", () => {
    it("returns newest first with a truncated preview instead of the content", async () => {
      await revisions.append({ ...target, content: "short" });
      await revisions.append({ ...target, content: "x".repeat(150) });

      const [newest, oldest] = await revisions.list(target);
      expect(newest.revision).toBe(2);
      expect(newest.preview).toBe(`${"x".repeat(100)}...`);
      expect(oldest.preview).toBe("short");
    });

    it("removes the whole history of one entity and leaves others alone", async () => {
      await revisions.append({ ...target, content: "doomed" });
      await revisions.append({
        entityType: REVISION_ENTITY_TYPES.playbook,
        entityId: "playbook-2",
        content: "kept",
      });

      await revisions.deleteHistory(target);

      expect(await revisions.list(target)).toHaveLength(0);
      expect(
        await revisions.list({
          entityType: REVISION_ENTITY_TYPES.playbook,
          entityId: "playbook-2",
        }),
      ).toHaveLength(1);
    });

    it("compares two revisions as unchanged, added and removed lines", async () => {
      await revisions.append({ ...target, content: "first line\nsecond line\n" });
      await revisions.append({ ...target, content: "first line\nsecond line changed\n" });

      const comparison = await revisions.compare(target, 1, 2);

      expect(comparison).not.toBeNull();
      expect(comparison!.parts.filter((part) => !part.added && !part.removed)[0].value).toBe(
        "first line\n",
      );
      expect(comparison!.parts.find((part) => part.added)?.value).toBe("second line changed\n");
      expect(comparison!.parts.find((part) => part.removed)?.value).toBe("second line\n");
    });

    it("reports nothing to compare when a revision is missing", async () => {
      await revisions.append({ ...target, content: "only one" });
      expect(await revisions.compare(target, 1, 7)).toBeNull();
    });

    it("sums the stored size of a history", async () => {
      await revisions.append({ ...target, content: "abc" });
      await revisions.append({ ...target, content: "de" });
      expect(await revisions.totalSize(target)).toBe(5);
    });
  });

  describe("notes as a consumer", () => {
    it("stores note content in the shared store instead of a private history table", async () => {
      const notes = new NoteRepository(db);
      const saved = await notes.save({ userId: "user-1", key: "my-note", value: "first" });

      const stored = await revisions.list({
        entityType: REVISION_ENTITY_TYPES.note,
        entityId: saved.id,
      });

      expect(stored).toHaveLength(1);
      expect(
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
          .get("noteVersion"),
      ).toBeUndefined();
    });

    it("removes a note's revisions when the note is hard deleted", async () => {
      const notes = new NoteRepository(db);
      const saved = await notes.save({ userId: "user-1", key: "temporary", value: "content" });
      await notes.hardDelete("temporary", "user-1");

      expect(
        await revisions.list({ entityType: REVISION_ENTITY_TYPES.note, entityId: saved.id }),
      ).toHaveLength(0);
    });
  });

  describe("global settings as a consumer", () => {
    let settings: GlobalSettingsService;

    beforeEach(async () => {
      settings = new GlobalSettingsService(
        new GlobalSettingsRepository(db),
        new AuditRepository(db),
        revisions,
      );
      await settings.create(
        {
          key: "site.title",
          value: "Moira",
          type: "string",
          label: "Site title",
          description: null,
          category: "general",
        },
        ADMIN_ID,
      );
    });

    it("records who changed a setting and what it became", async () => {
      await settings.setValue("site.title", "Moira Production", OTHER_ADMIN_ID);

      const history = await settings.getHistory("site.title");
      expect(history.map((entry) => entry.authorId)).toEqual([OTHER_ADMIN_ID, ADMIN_ID]);
      expect(await settings.getRevisionValue("site.title", 1)).toEqual({ value: "Moira" });
      expect(await settings.getRevisionValue("site.title", 2)).toEqual({
        value: "Moira Production",
      });
    });

    it("restores a past value as a new revision rather than rewinding the history", async () => {
      await settings.setValue("site.title", "Renamed", OTHER_ADMIN_ID);

      const restored = await settings.restoreRevision("site.title", 1, OTHER_ADMIN_ID);

      expect(restored).toBe(true);
      expect(await settings.getValue("site.title")).toBe("Moira");
      expect(await settings.getHistory("site.title")).toHaveLength(3);
      expect(await settings.getRevisionValue("site.title", 2)).toEqual({ value: "Renamed" });
    });

    it("restores a cleared value as no value rather than as an empty string", async () => {
      await settings.setValue("site.title", null, ADMIN_ID);
      await settings.setValue("site.title", "Filled in again", ADMIN_ID);

      expect(await settings.restoreRevision("site.title", 2, ADMIN_ID)).toBe(true);
      expect(await settings.getValue("site.title")).toBeNull();
      expect(await settings.getRevisionValue("site.title", 2)).toEqual({ value: null });
    });

    it("compares two past values of a setting", async () => {
      await settings.setValue("site.title", "Moira Production", OTHER_ADMIN_ID);

      const comparison = await settings.compareRevisions("site.title", 1, 2);

      expect(comparison?.parts.find((part) => part.added)?.value).toBe("Moira Production");
      expect(comparison?.parts.find((part) => part.removed)?.value).toBe("Moira");
    });

    it("refuses to restore a revision that is not stored", async () => {
      expect(await settings.restoreRevision("site.title", 99, ADMIN_ID)).toBe(false);
      expect(await settings.getValue("site.title")).toBe("Moira");
    });

    it("keeps a bounded tail of past values", async () => {
      for (let i = 0; i < MAX_GLOBAL_SETTING_REVISIONS + 3; i++) {
        await settings.setValue("site.title", `title ${i}`, ADMIN_ID);
      }

      const history = await settings.getHistory("site.title");
      expect(history).toHaveLength(MAX_GLOBAL_SETTING_REVISIONS);
      expect(history[0].revision).toBe(MAX_GLOBAL_SETTING_REVISIONS + 4);
    });
  });
});

describe("migration onto the shared revision store", () => {
  const migrationsFolder = path.join(process.cwd(), "packages/web-backend/drizzle");

  /**
   * Applies migration files in journal order, continuing from where the previous call stopped, so a
   * test can put data in place at one point in the history and then run the migration under test.
   */
  function migrationRunner(sqlite: Database.Database): (upToTag: string) => void {
    const journal = JSON.parse(
      readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf-8"),
    ) as { entries: Array<{ tag: string }> };
    let next = 0;

    return (upToTag: string) => {
      while (next < journal.entries.length) {
        const entry = journal.entries[next];
        next += 1;
        const sql = readFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), "utf-8");
        for (const statement of sql.split("--> statement-breakpoint")) {
          const trimmed = statement.trim();
          if (trimmed) sqlite.exec(trimmed);
        }
        if (entry.tag === upToTag) return;
      }
      throw new Error(`Migration ${upToTag} not found after the ones already applied`);
    };
  }

  it("carries existing note versions over with their numbers, content and times", () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = OFF");
    const applyMigrationsUpTo = migrationRunner(sqlite);
    applyMigrationsUpTo("0026_workflow_revision");

    const createdAt = 1_700_000_000_000;
    sqlite
      .prepare(
        "INSERT INTO note (id, userId, key, tags, size, currentVersion, createdAt, updatedAt)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("note-1", "user-1", "recipe", "[]", 5, 2, createdAt, createdAt);
    for (const [id, version, value, size, when] of [
      ["v1", 1, "older", 5, createdAt],
      ["v2", 2, "newer", 5, createdAt + 1000],
    ] as const) {
      sqlite
        .prepare(
          "INSERT INTO noteVersion (id, noteId, version, value, size, createdAt)" +
            " VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(id, "note-1", version, value, size, when);
    }

    applyMigrationsUpTo("0032_entity_revisions");

    const migrated = sqlite
      .prepare(
        "SELECT revision, content, size, authorId, createdAt FROM entityRevision" +
          " WHERE entityType = 'note' AND entityId = 'note-1' ORDER BY revision",
      )
      .all() as Array<{
      revision: number;
      content: string;
      size: number;
      authorId: string | null;
      createdAt: number;
    }>;

    expect(migrated).toEqual([
      { revision: 1, content: "older", size: 5, authorId: "user-1", createdAt },
      { revision: 2, content: "newer", size: 5, authorId: "user-1", createdAt: createdAt + 1000 },
    ]);
    expect(
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='noteVersion'")
        .get(),
    ).toBeUndefined();

    sqlite.close();
  });
});
