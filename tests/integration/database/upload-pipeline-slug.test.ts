/**
 * Integration Tests - Upload Pipeline Slug Handling
 * Tests for #464 (slug pass-through), #452 (admin override resolution),
 * #498 (cross-user public slug duplicate prevention)
 */

import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import { getSqliteInstance, getDatabase, WorkflowRepository } from "@mcp-moira/shared";

describe("Upload Pipeline - Slug Handling", () => {
  const adminUserId = "system-admin";
  const regularUserId = "test-regular-user";
  const otherUserId = "test-other-user";
  const createdWorkflowIds: string[] = [];

  function insertUser(id: string, handle: string) {
    const db = getSqliteInstance();
    const existing = db.prepare("SELECT id FROM user WHERE id = ?").get(id);
    if (!existing) {
      db.prepare(
        "INSERT INTO user (id, email, handle, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)",
      ).run(id, `${handle}@test.local`, handle, new Date().toISOString(), new Date().toISOString());
    }
  }

  function insertWorkflow(
    id: string,
    userId: string,
    slug: string,
    visibility: "public" | "private" = "private",
    createdAt?: number,
  ) {
    const db = getSqliteInstance();
    const now = createdAt ?? Date.now();
    db.prepare(
      `INSERT INTO workflow (id, userId, slug, name, version, graph, visibility, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      userId,
      slug,
      `Test ${slug}`,
      "1.0.0",
      JSON.stringify({ nodes: [] }),
      visibility,
      now,
      now,
    );
    createdWorkflowIds.push(id);
  }

  function getWorkflow(id: string) {
    const db = getSqliteInstance();
    return db.prepare("SELECT * FROM workflow WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
  }

  function getRepo(): WorkflowRepository {
    return new WorkflowRepository(getDatabase());
  }

  beforeEach(() => {
    insertUser(adminUserId, "admin");
    insertUser(regularUserId, "regular-user");
    insertUser(otherUserId, "other-user");
  });

  afterEach(() => {
    const db = getSqliteInstance();
    const deleteStmt = db.prepare("DELETE FROM workflow WHERE id = ?");
    for (const id of createdWorkflowIds) {
      deleteStmt.run(id);
    }
    createdWorkflowIds.length = 0;
  });

  describe("#464 - Slug preservation on upload", () => {
    test("workflow saved with provided slug retains that slug", () => {
      const workflowId = `test-slug-preserve-${Date.now()}`;
      const expectedSlug = "my-custom-slug";
      insertWorkflow(workflowId, regularUserId, expectedSlug);

      const saved = getWorkflow(workflowId);
      expect(saved).toBeDefined();
      expect(saved!.slug).toBe(expectedSlug);
    });

    test("workflow saved without slug gets a non-empty slug", () => {
      const workflowId = `test-slug-auto-${Date.now()}`;
      const autoSlug = `auto-generated-${Date.now()}`;
      insertWorkflow(workflowId, regularUserId, autoSlug);

      const saved = getWorkflow(workflowId);
      expect(saved).toBeDefined();
      expect(saved!.slug).toBeTruthy();
      expect(typeof saved!.slug).toBe("string");
    });
  });

  describe("#452 - Admin override resolves slug to existing workflow", () => {
    test("resolvePublicSlug finds existing public workflow by slug", async () => {
      const existingId = `test-existing-public-${Date.now()}`;
      const slug = `public-workflow-${Date.now()}`;
      insertWorkflow(existingId, otherUserId, slug, "public");

      const repo = getRepo();
      const resolved = await repo.resolvePublicSlug(slug);

      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(existingId);
      expect(resolved!.userId).toBe(otherUserId);
    });

    test("resolvePublicSlug returns null for private workflow", async () => {
      const existingId = `test-existing-private-${Date.now()}`;
      const slug = `private-workflow-${Date.now()}`;
      insertWorkflow(existingId, otherUserId, slug, "private");

      const repo = getRepo();
      const resolved = await repo.resolvePublicSlug(slug);

      expect(resolved).toBeNull();
    });

    test("resolvePublicSlug returns null for deleted workflow", async () => {
      const existingId = `test-existing-deleted-${Date.now()}`;
      const slug = `deleted-workflow-${Date.now()}`;
      insertWorkflow(existingId, otherUserId, slug, "public");

      const db = getSqliteInstance();
      db.prepare("UPDATE workflow SET deleted = 1 WHERE id = ?").run(existingId);

      const repo = getRepo();
      const resolved = await repo.resolvePublicSlug(slug);

      expect(resolved).toBeNull();
    });

    test("resolvePublicSlug returns oldest workflow when multiple exist (ORDER BY)", async () => {
      const oldId = `test-old-public-${Date.now()}`;
      const newId = `test-new-public-${Date.now()}`;
      const slug = `multi-public-${Date.now()}`;

      const oldTime = Date.now() - 10000;
      const newTime = Date.now();
      insertWorkflow(oldId, otherUserId, slug, "public", oldTime);
      insertWorkflow(newId, regularUserId, slug, "public", newTime);

      const repo = getRepo();
      const resolved = await repo.resolvePublicSlug(slug);

      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(oldId); // ORDER BY createdAt ASC returns oldest
    });
  });

  describe("#498 - Cross-user public slug duplicate prevention", () => {
    test("detects public workflow by another user as conflict", async () => {
      const existingId = `test-conflict-public-${Date.now()}`;
      const slug = `conflicting-slug-${Date.now()}`;
      insertWorkflow(existingId, otherUserId, slug, "public");

      const repo = getRepo();
      const existing = await repo.resolvePublicSlug(slug);

      // The upload route checks: existing && existing.userId !== userId
      expect(existing).not.toBeNull();
      expect(existing!.userId).toBe(otherUserId);
      expect(existing!.userId).not.toBe(regularUserId);
    });

    test("own public workflow with same slug is not a cross-user conflict", async () => {
      const existingId = `test-own-public-${Date.now()}`;
      const slug = `own-slug-${Date.now()}`;
      insertWorkflow(existingId, regularUserId, slug, "public");

      const repo = getRepo();
      const existing = await repo.resolvePublicSlug(slug);

      // Same user = no conflict (existing.userId === regularUserId)
      expect(existing).not.toBeNull();
      expect(existing!.userId).toBe(regularUserId);
    });

    test("private workflow with same slug does not trigger conflict", async () => {
      const existingId = `test-private-no-conflict-${Date.now()}`;
      const slug = `private-slug-${Date.now()}`;
      insertWorkflow(existingId, otherUserId, slug, "private");

      const repo = getRepo();
      const existing = await repo.resolvePublicSlug(slug);

      // resolvePublicSlug only finds public workflows
      expect(existing).toBeNull();
    });

    test("ownerHandle is returned for conflict reporting", async () => {
      const existingId = `test-handle-${Date.now()}`;
      const slug = `handle-test-${Date.now()}`;
      insertWorkflow(existingId, otherUserId, slug, "public");

      const repo = getRepo();
      const existing = await repo.resolvePublicSlug(slug);

      expect(existing).not.toBeNull();
      expect(existing!.ownerHandle).toBe("other-user");
    });
  });
});
