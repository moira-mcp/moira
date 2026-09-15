/**
 * Unit tests for the playbook registry.
 *
 * A playbook is named, reusable behaviour text referenced from workflow nodes. These tests protect
 * the three things that make it a registry rather than another private store: its content lives in
 * the shared revision store (checked in the schema, not only in behaviour), its access follows the
 * central policy, and publishing is a sharing decision rather than an edit.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";
import { randomUUID } from "node:crypto";
import {
  AuditRepository,
  AuthorizationService,
  MAX_PLAYBOOK_SIZE,
  PlaybookRepository,
  PlaybookService,
  RESOURCE_TYPES,
  RevisionRepository,
  UserRepository,
} from "@mcp-moira/shared";
import * as schema from "../../../packages/shared/src/database/schema.js";

const OWNER = "playbook-owner";
const STRANGER = "playbook-stranger";

describe("playbook registry", () => {
  let sqlite: Database.Database;
  let db: BetterSQLite3Database<typeof schema>;
  let playbooks: PlaybookService;
  let revisions: RevisionRepository;

  /**
   * A user whose handle differs from its id on purpose: resolving an owner by id and resolving one
   * by handle are different branches, and a fixture where the two coincide cannot tell them apart.
   */
  function addUser(id: string): void {
    const now = new Date().toISOString();
    sqlite
      .prepare("INSERT INTO user (id, email, handle, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)")
      .run(id, `${id}@example.test`, `handle-of-${id}`, now, now);
  }

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: path.join(process.cwd(), "packages/web-backend/drizzle") });
    revisions = new RevisionRepository(db);
    playbooks = new PlaybookService(
      new PlaybookRepository(db),
      new AuditRepository(db),
      new AuthorizationService(db),
      new UserRepository(db),
    );
    addUser(OWNER);
    addUser(STRANGER);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("storage", () => {
    it("keeps playbook content in the shared revision store and nowhere else", async () => {
      const saved = await playbooks.save(OWNER, {
        slug: "review-standard",
        content: "Read the diff, not the summary.",
      });

      const stored = await revisions.list({
        entityType: RESOURCE_TYPES.playbook,
        entityId: saved.id,
      });
      expect(stored).toHaveLength(1);

      const tables = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%ersion%'")
        .all();
      expect(tables).toHaveLength(0);
    });

    it("writes a revision on every save and reads a past one back", async () => {
      await playbooks.save(OWNER, { slug: "tone", content: "First wording." });
      await playbooks.save(OWNER, { slug: "tone", content: "Second wording." });

      const current = await playbooks.get(OWNER, OWNER, "tone");
      const first = await playbooks.get(OWNER, OWNER, "tone", 1);

      expect(current?.content).toBe("Second wording.");
      expect(current?.revision).toBe(2);
      expect(first?.content).toBe("First wording.");
      expect(await playbooks.history(OWNER, OWNER, "tone")).toHaveLength(2);
    });

    it("restores a past revision as a new revision", async () => {
      await playbooks.save(OWNER, { slug: "tone", content: "Original." });
      await playbooks.save(OWNER, { slug: "tone", content: "Changed." });

      const restored = await playbooks.restore(OWNER, OWNER, "tone", 1);

      expect(restored?.revision).toBe(3);
      expect((await playbooks.get(OWNER, OWNER, "tone"))?.content).toBe("Original.");
      expect((await playbooks.get(OWNER, OWNER, "tone", 2))?.content).toBe("Changed.");
    });

    it("compares two revisions", async () => {
      await playbooks.save(OWNER, { slug: "tone", content: "line one\nline two\n" });
      await playbooks.save(OWNER, { slug: "tone", content: "line one\nline three\n" });

      const comparison = await playbooks.compare(OWNER, OWNER, "tone", 1, 2);

      expect(comparison?.parts.find((part) => part.added)?.value).toBe("line three\n");
      expect(comparison?.parts.find((part) => part.removed)?.value).toBe("line two\n");
    });

    it("removes the history together with the playbook", async () => {
      const saved = await playbooks.save(OWNER, { slug: "temporary", content: "text" });

      expect(await playbooks.remove(OWNER, OWNER, "temporary")).toBe(true);
      expect(
        await revisions.list({ entityType: RESOURCE_TYPES.playbook, entityId: saved.id }),
      ).toHaveLength(0);
    });

    it("refuses a name a workflow node could not reference", async () => {
      await expect(playbooks.save(OWNER, { slug: "No Spaces", content: "x" })).rejects.toThrow(
        /lower-case letters/,
      );
    });

    it("refuses content beyond the size a playbook may hold", async () => {
      await expect(
        playbooks.save(OWNER, { slug: "huge", content: "x".repeat(MAX_PLAYBOOK_SIZE + 1) }),
      ).rejects.toThrow(/at most/);
    });
  });

  describe("naming an owner", () => {
    it("accepts a handle and a user id, and refuses an unknown one", async () => {
      expect(await playbooks.resolveOwner(undefined, OWNER)).toBe(OWNER);
      expect(await playbooks.resolveOwner(`@handle-of-${OWNER}`, STRANGER)).toBe(OWNER);
      expect(await playbooks.resolveOwner(`handle-of-${OWNER}`, STRANGER)).toBe(OWNER);
      expect(await playbooks.resolveOwner(OWNER, STRANGER)).toBe(OWNER);
      expect(await playbooks.resolveOwner("nobody-at-all", STRANGER)).toBeNull();
    });
  });

  describe("access", () => {
    beforeEach(async () => {
      await playbooks.save(OWNER, { slug: "review-standard", content: "Owner's text." });
    });

    it("hides a private playbook from another user", async () => {
      expect(await playbooks.get(STRANGER, OWNER, "review-standard")).toBeNull();
    });

    it("shows a published playbook to another user", async () => {
      await playbooks.setVisibility(OWNER, OWNER, "review-standard", "public");

      const seen = await playbooks.get(STRANGER, OWNER, "review-standard");
      expect(seen?.content).toBe("Owner's text.");
    });

    it("still refuses a stranger to change a published playbook", async () => {
      await playbooks.setVisibility(OWNER, OWNER, "review-standard", "public");

      await expect(
        playbooks.save(STRANGER, {
          ownerId: OWNER,
          slug: "review-standard",
          content: "Rewritten by somebody else.",
        }),
      ).rejects.toThrow(/belongs to another user/);
    });

    it("lets an editing grant change the text but not publish it", async () => {
      const target = await playbooks.get(OWNER, OWNER, "review-standard");
      sqlite
        .prepare(
          "INSERT INTO accessGrant (id, resourceType, resourceId, userId, groupId, level, grantedBy, grantedAt)" +
            " VALUES (?, 'playbook', ?, ?, NULL, 'edit', ?, ?)",
        )
        .run(randomUUID(), target!.id, STRANGER, OWNER, Date.now());

      const saved = await playbooks.save(STRANGER, {
        ownerId: OWNER,
        slug: "review-standard",
        content: "Edited by the grantee.",
      });
      expect(saved.revision).toBe(2);

      await expect(
        playbooks.setVisibility(STRANGER, OWNER, "review-standard", "public"),
      ).rejects.toThrow(/Only the owner decides/);
    });

    it("keeps removal with the owner", async () => {
      await expect(playbooks.remove(STRANGER, OWNER, "review-standard")).rejects.toThrow(
        /Only the owner removes/,
      );
    });
  });
});
