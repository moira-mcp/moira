/**
 * Unit tests for WorkflowSharingRepository
 * Tests invite creation, acceptance, access management, and cleanup
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { WorkflowSharingRepository, DEFAULT_INVITE_TTL_MS, TOKEN_LENGTH } from "@mcp-moira/shared";
import path from "path";

// Import all schema tables for drizzle
import * as schema from "../../../packages/shared/src/database/schema.js";

describe("WorkflowSharingRepository", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let repository: WorkflowSharingRepository;
  let sqlite: Database.Database;

  const TEST_OWNER_ID = "owner-user-123";
  const TEST_RECIPIENT_ID = "recipient-user-456";
  const TEST_WORKFLOW_ID = "workflow-abc123";
  const TEST_WORKFLOW_ID_2 = "workflow-def456";

  beforeEach(() => {
    // Create in-memory database for each test
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });

    // Note: FK constraints are disabled for unit tests to allow testing repository logic
    // without creating full user/workflow fixtures. FK validation is covered by integration
    // tests which use the real database with constraints enabled.

    // Disable foreign key enforcement for isolated testing
    sqlite.exec("PRAGMA foreign_keys = OFF");

    // Run migrations
    const migrationsPath = path.join(process.cwd(), "packages/web-backend/drizzle");
    migrate(db, { migrationsFolder: migrationsPath });

    repository = new WorkflowSharingRepository(db);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("constants", () => {
    it("exports DEFAULT_INVITE_TTL_MS as 7 days", () => {
      expect(DEFAULT_INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("exports TOKEN_LENGTH as 32", () => {
      expect(TOKEN_LENGTH).toBe(32);
    });
  });

  describe("createInvite", () => {
    it("creates a new invite with correct structure", async () => {
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      expect(invite.id).toBeDefined();
      expect(invite.workflowId).toBe(TEST_WORKFLOW_ID);
      expect(invite.createdBy).toBe(TEST_OWNER_ID);
      expect(invite.token).toBeDefined();
      expect(invite.token.length).toBe(TOKEN_LENGTH);
      expect(invite.expiresAt).toBeGreaterThan(Date.now());
      expect(invite.usedAt).toBeNull();
      expect(invite.usedBy).toBeNull();
      expect(invite.createdAt).toBeLessThanOrEqual(Date.now());
      expect(invite.remainingMs).toBeGreaterThan(0);
    });

    it("creates unique tokens for each invite", async () => {
      const invite1 = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      const invite2 = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      expect(invite1.token).not.toBe(invite2.token);
    });

    it("respects custom TTL", async () => {
      const customTtl = 60 * 60 * 1000; // 1 hour
      const beforeCreate = Date.now();

      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
        ttlMs: customTtl,
      });

      const expectedExpiry = beforeCreate + customTtl;
      // Allow 1 second tolerance
      expect(invite.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 1000);
      expect(invite.expiresAt).toBeLessThanOrEqual(expectedExpiry + 1000);
    });

    it("uses default TTL when not specified", async () => {
      const beforeCreate = Date.now();

      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      const expectedExpiry = beforeCreate + DEFAULT_INVITE_TTL_MS;
      // Allow 1 second tolerance
      expect(invite.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 1000);
      expect(invite.expiresAt).toBeLessThanOrEqual(expectedExpiry + 1000);
    });

    it("generates URL-safe tokens", async () => {
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      // URL-safe base64 uses only alphanumeric, hyphen, and underscore
      expect(invite.token).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe("getInviteByToken", () => {
    it("retrieves invite by token", async () => {
      const created = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      const retrieved = await repository.getInviteByToken(created.token);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.token).toBe(created.token);
      expect(retrieved?.workflowId).toBe(TEST_WORKFLOW_ID);
    });

    it("returns null for non-existent token", async () => {
      const result = await repository.getInviteByToken("non-existent-token");
      expect(result).toBeNull();
    });
  });

  describe("getInviteById", () => {
    it("retrieves invite by ID", async () => {
      const created = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      const retrieved = await repository.getInviteById(created.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.token).toBe(created.token);
    });

    it("returns null for non-existent ID", async () => {
      const result = await repository.getInviteById("non-existent-id");
      expect(result).toBeNull();
    });
  });

  describe("listInvites", () => {
    beforeEach(async () => {
      // Create multiple invites for testing
      await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      // Create invite for different workflow
      await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID_2,
        createdBy: TEST_OWNER_ID,
      });
    });

    it("lists invites for a workflow", async () => {
      const result = await repository.listInvites({ workflowId: TEST_WORKFLOW_ID });

      expect(result.invites).toHaveLength(2);
      expect(result.total).toBe(2);
      result.invites.forEach((invite) => {
        expect(invite.workflowId).toBe(TEST_WORKFLOW_ID);
      });
    });

    it("returns empty for workflow with no invites", async () => {
      const result = await repository.listInvites({ workflowId: "no-invites-workflow" });

      expect(result.invites).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("supports pagination", async () => {
      const page1 = await repository.listInvites({
        workflowId: TEST_WORKFLOW_ID,
        limit: 1,
        offset: 0,
      });

      const page2 = await repository.listInvites({
        workflowId: TEST_WORKFLOW_ID,
        limit: 1,
        offset: 1,
      });

      expect(page1.invites).toHaveLength(1);
      expect(page1.total).toBe(2);
      expect(page2.invites).toHaveLength(1);
      expect(page2.total).toBe(2);
      expect(page1.invites[0].id).not.toBe(page2.invites[0].id);
    });

    it("filters active invites when activeOnly is true", async () => {
      // Create and use one invite
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });
      await repository.markInviteUsed(invite.id, TEST_RECIPIENT_ID);

      const allInvites = await repository.listInvites({ workflowId: TEST_WORKFLOW_ID });
      const activeOnly = await repository.listInvites({
        workflowId: TEST_WORKFLOW_ID,
        activeOnly: true,
      });

      expect(allInvites.total).toBe(3); // 2 from beforeEach + 1 used
      expect(activeOnly.total).toBe(2); // excludes used invite
    });

    it("orders by createdAt descending", async () => {
      const result = await repository.listInvites({ workflowId: TEST_WORKFLOW_ID });

      for (let i = 1; i < result.invites.length; i++) {
        expect(result.invites[i - 1].createdAt).toBeGreaterThanOrEqual(result.invites[i].createdAt);
      }
    });
  });

  describe("markInviteUsed", () => {
    it("marks invite as used", async () => {
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      const result = await repository.markInviteUsed(invite.id, TEST_RECIPIENT_ID);
      expect(result).toBe(true);

      const updated = await repository.getInviteById(invite.id);
      expect(updated?.usedAt).not.toBeNull();
      expect(updated?.usedBy).toBe(TEST_RECIPIENT_ID);
      expect(updated?.remainingMs).toBeNull();
    });

    it("returns false for already used invite", async () => {
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      await repository.markInviteUsed(invite.id, TEST_RECIPIENT_ID);
      const result = await repository.markInviteUsed(invite.id, "another-user");

      expect(result).toBe(false);
    });

    it("returns false for non-existent invite", async () => {
      const result = await repository.markInviteUsed("non-existent", TEST_RECIPIENT_ID);
      expect(result).toBe(false);
    });
  });

  describe("deleteInvite", () => {
    it("deletes an invite", async () => {
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      const deleted = await repository.deleteInvite(invite.id);
      expect(deleted).toBe(true);

      const retrieved = await repository.getInviteById(invite.id);
      expect(retrieved).toBeNull();
    });

    it("returns false for non-existent invite", async () => {
      const deleted = await repository.deleteInvite("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("deleteExpiredInvites", () => {
    it("deletes expired invites", async () => {
      // Create an already-expired invite (TTL = 0)
      // We need to manipulate the database directly for this test
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
        ttlMs: 1, // 1ms TTL
      });

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      const deleted = await repository.deleteExpiredInvites();
      expect(deleted).toBeGreaterThanOrEqual(1);

      const retrieved = await repository.getInviteById(invite.id);
      expect(retrieved).toBeNull();
    });

    it("does not delete non-expired invites", async () => {
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      await repository.deleteExpiredInvites();

      const retrieved = await repository.getInviteById(invite.id);
      expect(retrieved).not.toBeNull();
    });
  });

  describe("grantAccess", () => {
    it("grants access to a user", async () => {
      const accessId = await repository.grantAccess(
        TEST_WORKFLOW_ID,
        TEST_RECIPIENT_ID,
        TEST_OWNER_ID,
      );

      expect(accessId).toBeDefined();

      const hasAccess = await repository.hasAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID);
      expect(hasAccess).toBe(true);
    });

    it("stores invite reference when provided", async () => {
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      const accessId = await repository.grantAccess(
        TEST_WORKFLOW_ID,
        TEST_RECIPIENT_ID,
        TEST_OWNER_ID,
        invite.id,
      );

      const access = await repository.getAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID);
      expect(access?.inviteId).toBe(invite.id);
    });
  });

  describe("hasAccess", () => {
    it("returns true when user has access", async () => {
      await repository.grantAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID, TEST_OWNER_ID);

      const hasAccess = await repository.hasAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID);
      expect(hasAccess).toBe(true);
    });

    it("returns false when user does not have access", async () => {
      const hasAccess = await repository.hasAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID);
      expect(hasAccess).toBe(false);
    });

    it("returns false for different workflow", async () => {
      await repository.grantAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID, TEST_OWNER_ID);

      const hasAccess = await repository.hasAccess(TEST_WORKFLOW_ID_2, TEST_RECIPIENT_ID);
      expect(hasAccess).toBe(false);
    });
  });

  describe("getAccess", () => {
    it("returns access info with user details", async () => {
      // Note: In real tests with FK enabled, we'd need to insert user records
      // Here we test the structure with FK disabled
      await repository.grantAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID, TEST_OWNER_ID);

      const access = await repository.getAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID);

      expect(access).not.toBeNull();
      expect(access?.workflowId).toBe(TEST_WORKFLOW_ID);
      expect(access?.userId).toBe(TEST_RECIPIENT_ID);
      expect(access?.grantedBy).toBe(TEST_OWNER_ID);
      expect(access?.grantedAt).toBeLessThanOrEqual(Date.now());
    });

    it("returns null when no access exists", async () => {
      const access = await repository.getAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID);
      expect(access).toBeNull();
    });
  });

  describe("listAccess", () => {
    beforeEach(async () => {
      await repository.grantAccess(TEST_WORKFLOW_ID, "user-1", TEST_OWNER_ID);
      await repository.grantAccess(TEST_WORKFLOW_ID, "user-2", TEST_OWNER_ID);
      await repository.grantAccess(TEST_WORKFLOW_ID_2, "user-1", TEST_OWNER_ID);
    });

    it("lists users with access to a workflow", async () => {
      const result = await repository.listAccess({ workflowId: TEST_WORKFLOW_ID });

      expect(result.accesses).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("supports pagination", async () => {
      const page1 = await repository.listAccess({
        workflowId: TEST_WORKFLOW_ID,
        limit: 1,
        offset: 0,
      });

      const page2 = await repository.listAccess({
        workflowId: TEST_WORKFLOW_ID,
        limit: 1,
        offset: 1,
      });

      expect(page1.accesses).toHaveLength(1);
      expect(page1.total).toBe(2);
      expect(page2.accesses).toHaveLength(1);
      expect(page1.accesses[0].userId).not.toBe(page2.accesses[0].userId);
    });

    it("returns empty for workflow with no shared access", async () => {
      const result = await repository.listAccess({ workflowId: "no-access-workflow" });

      expect(result.accesses).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe("listUserAccess", () => {
    beforeEach(async () => {
      await repository.grantAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID, TEST_OWNER_ID);
      await repository.grantAccess(TEST_WORKFLOW_ID_2, TEST_RECIPIENT_ID, TEST_OWNER_ID);
    });

    it("lists all workflows a user has access to", async () => {
      const workflowIds = await repository.listUserAccess(TEST_RECIPIENT_ID);

      expect(workflowIds).toHaveLength(2);
      expect(workflowIds).toContain(TEST_WORKFLOW_ID);
      expect(workflowIds).toContain(TEST_WORKFLOW_ID_2);
    });

    it("returns empty array for user with no access", async () => {
      const workflowIds = await repository.listUserAccess("no-access-user");
      expect(workflowIds).toEqual([]);
    });
  });

  describe("revokeAccess", () => {
    it("revokes access for a user", async () => {
      await repository.grantAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID, TEST_OWNER_ID);

      const revoked = await repository.revokeAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID);
      expect(revoked).toBe(true);

      const hasAccess = await repository.hasAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID);
      expect(hasAccess).toBe(false);
    });

    it("returns false when no access exists", async () => {
      const revoked = await repository.revokeAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID);
      expect(revoked).toBe(false);
    });
  });

  describe("revokeAllAccess", () => {
    it("revokes all access for a workflow", async () => {
      await repository.grantAccess(TEST_WORKFLOW_ID, "user-1", TEST_OWNER_ID);
      await repository.grantAccess(TEST_WORKFLOW_ID, "user-2", TEST_OWNER_ID);
      await repository.grantAccess(TEST_WORKFLOW_ID, "user-3", TEST_OWNER_ID);

      const revoked = await repository.revokeAllAccess(TEST_WORKFLOW_ID);
      expect(revoked).toBe(3);

      const result = await repository.listAccess({ workflowId: TEST_WORKFLOW_ID });
      expect(result.total).toBe(0);
    });

    it("returns 0 when no access exists", async () => {
      const revoked = await repository.revokeAllAccess("no-access-workflow");
      expect(revoked).toBe(0);
    });
  });

  describe("acceptInvite", () => {
    it("accepts a valid invite and grants access", async () => {
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      const result = await repository.acceptInvite({
        token: invite.token,
        userId: TEST_RECIPIENT_ID,
      });

      expect(result).not.toBeNull();
      expect(result?.accessId).toBeDefined();
      expect(result?.workflowId).toBe(TEST_WORKFLOW_ID);
      expect(result?.inviteId).toBe(invite.id);

      // Verify access was granted
      const hasAccess = await repository.hasAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID);
      expect(hasAccess).toBe(true);

      // Verify invite was marked as used
      const usedInvite = await repository.getInviteById(invite.id);
      expect(usedInvite?.usedAt).not.toBeNull();
      expect(usedInvite?.usedBy).toBe(TEST_RECIPIENT_ID);
    });

    it("returns null for non-existent token", async () => {
      const result = await repository.acceptInvite({
        token: "non-existent-token",
        userId: TEST_RECIPIENT_ID,
      });

      expect(result).toBeNull();
    });

    it("returns null for already used invite", async () => {
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      // First acceptance
      await repository.acceptInvite({
        token: invite.token,
        userId: TEST_RECIPIENT_ID,
      });

      // Second acceptance attempt
      const result = await repository.acceptInvite({
        token: invite.token,
        userId: "another-user",
      });

      expect(result).toBeNull();
    });

    it("returns null for expired invite", async () => {
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
        ttlMs: 1, // 1ms TTL
      });

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 10));

      const result = await repository.acceptInvite({
        token: invite.token,
        userId: TEST_RECIPIENT_ID,
      });

      expect(result).toBeNull();
    });

    it("returns null if user already has access", async () => {
      // Grant access directly first
      await repository.grantAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID, TEST_OWNER_ID);

      // Create invite
      const invite = await repository.createInvite({
        workflowId: TEST_WORKFLOW_ID,
        createdBy: TEST_OWNER_ID,
      });

      // Try to accept invite
      const result = await repository.acceptInvite({
        token: invite.token,
        userId: TEST_RECIPIENT_ID,
      });

      expect(result).toBeNull();

      // Invite should not be marked as used
      const inviteStatus = await repository.getInviteById(invite.id);
      expect(inviteStatus?.usedAt).toBeNull();
    });
  });

  describe("user isolation", () => {
    it("access records are specific to user-workflow pairs", async () => {
      await repository.grantAccess(TEST_WORKFLOW_ID, "user-1", TEST_OWNER_ID);
      await repository.grantAccess(TEST_WORKFLOW_ID, "user-2", TEST_OWNER_ID);

      // User 1 has access
      expect(await repository.hasAccess(TEST_WORKFLOW_ID, "user-1")).toBe(true);

      // User 2 has access
      expect(await repository.hasAccess(TEST_WORKFLOW_ID, "user-2")).toBe(true);

      // User 3 does not have access
      expect(await repository.hasAccess(TEST_WORKFLOW_ID, "user-3")).toBe(false);

      // Revoke user 1's access
      await repository.revokeAccess(TEST_WORKFLOW_ID, "user-1");

      // User 1 no longer has access
      expect(await repository.hasAccess(TEST_WORKFLOW_ID, "user-1")).toBe(false);

      // User 2 still has access
      expect(await repository.hasAccess(TEST_WORKFLOW_ID, "user-2")).toBe(true);
    });

    it("unique constraint prevents duplicate access records", async () => {
      await repository.grantAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID, TEST_OWNER_ID);

      // Attempt to grant duplicate access should throw due to unique constraint
      let threw = false;
      try {
        await repository.grantAccess(TEST_WORKFLOW_ID, TEST_RECIPIENT_ID, TEST_OWNER_ID);
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    });
  });
});
