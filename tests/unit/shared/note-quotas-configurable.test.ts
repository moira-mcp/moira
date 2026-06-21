/**
 * Unit tests: note quotas are configurable via global settings.
 *
 * Verifies NoteService reads notes.max_note_size_kb / notes.max_user_total_kb /
 * notes.max_versions from GlobalSettingsService when present, and falls back to
 * the hardcoded defaults when the settings are absent.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import {
  NoteRepository,
  AuditRepository,
  NoteService,
  NoteSizeExceededError,
  QuotaExceededError,
} from "@mcp-moira/shared";
import type { GlobalSettingsService } from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");
const USER = "note-quota-user";

/** GlobalSettingsService stub returning canned values per key. */
function settingsStub(values: Record<string, string | null>): GlobalSettingsService {
  return {
    getValue: jest
      .fn<(key: string) => Promise<unknown>>()
      .mockImplementation(async (key: string) => values[key] ?? null),
  } as unknown as GlobalSettingsService;
}

describe("Configurable note quotas", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let noteRepo: NoteRepository;
  let auditRepo: AuditRepository;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });
    const now = new Date().toISOString();
    db.insert(schema.user)
      .values({
        id: USER,
        email: "note-quota@example.com",
        name: "Note Quota User",
        handle: "note-quota-user",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    noteRepo = new NoteRepository(db);
    auditRepo = new AuditRepository(db);
  });

  afterEach(() => sqlite.close());

  it("rejects a note larger than the configured per-note size", async () => {
    // 1 KB limit from settings; a 2 KB note must be rejected.
    const service = new NoteService(
      noteRepo,
      auditRepo,
      settingsStub({ "notes.max_note_size_kb": "1" }),
    );
    const big = "x".repeat(2 * 1024);
    await expect(service.save(USER, { key: "k", value: big })).rejects.toBeInstanceOf(
      NoteSizeExceededError,
    );
  });

  it("allows a note within the configured per-note size", async () => {
    const service = new NoteService(
      noteRepo,
      auditRepo,
      settingsStub({ "notes.max_note_size_kb": "10" }),
    );
    const ok = "x".repeat(5 * 1024);
    const res = await service.save(USER, { key: "k", value: ok });
    expect(res.id).toBeTruthy();
  });

  it("enforces the configured total-per-user quota across notes", async () => {
    // 2 KB total quota; two ~1.5 KB notes exceed it.
    const service = new NoteService(
      noteRepo,
      auditRepo,
      settingsStub({ "notes.max_user_total_kb": "2", "notes.max_note_size_kb": "100" }),
    );
    await service.save(USER, { key: "a", value: "x".repeat(1536) });
    await expect(service.save(USER, { key: "b", value: "x".repeat(1536) })).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
  });

  it("falls back to hardcoded defaults when settings are absent", async () => {
    // No GlobalSettingsService → default 100 KB per note allows a 50 KB note.
    const service = new NoteService(noteRepo, auditRepo);
    const res = await service.save(USER, { key: "k", value: "x".repeat(50 * 1024) });
    expect(res.id).toBeTruthy();
  });

  it("ignores a garbage / non-positive setting and uses the hardcoded default", async () => {
    // Admin typo (non-numeric or 0/negative) must NOT silently disable the limit:
    // fall back to the 100 KB default, so a 200 KB note is still rejected.
    const service = new NoteService(
      noteRepo,
      auditRepo,
      settingsStub({ "notes.max_note_size_kb": "not-a-number" }),
    );
    await expect(
      service.save(USER, { key: "k", value: "x".repeat(200 * 1024) }),
    ).rejects.toBeInstanceOf(NoteSizeExceededError);
  });

  it("keeps only the configured number of versions", async () => {
    const service = new NoteService(
      noteRepo,
      auditRepo,
      settingsStub({ "notes.max_versions": "3" }),
    );
    // 5 saves → 5 versions created, cleanup keeps the newest 3.
    for (let i = 0; i < 5; i++) {
      await service.save(USER, { key: "vk", value: `v${i}` });
    }
    const versions = await noteRepo.getHistory("vk", USER);
    expect(versions.length).toBe(3);
  });
});
