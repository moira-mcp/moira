/**
 * Integration Tests - WorkflowSharingService
 * Tests the sharing service business logic with real database
 *
 * Test scenarios:
 * - Create invite: ownership validation, token generation, audit logging
 * - Accept invite: validation, access granting, self-invite prevention
 * - Revoke access/invite: ownership checks
 * - Access integration: shared workflows accessible via resolveSlugWithAccess
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "@jest/globals";
import {
  getDatabase,
  closeDatabase,
  WorkflowRepository,
  WorkflowSharingRepository,
  AuditRepository,
  getSqliteInstance,
} from "@mcp-moira/shared";
import { WorkflowSharingService } from "@mcp-moira/shared";
import {
  InviteNotFoundError,
  InviteExpiredError,
  InviteAlreadyUsedError,
  SelfInviteError,
  AccessAlreadyExistsError,
  AccessNotFoundError,
  WorkflowNotFoundError,
  WorkflowAccessDeniedError,
} from "@mcp-moira/shared";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "@mcp-moira/shared";

describe("WorkflowSharingService", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sharingRepo: WorkflowSharingRepository;
  let workflowRepo: WorkflowRepository;
  let auditRepo: AuditRepository;
  let service: WorkflowSharingService;

  // Test data
  const OWNER_ID = "test-owner-sharing-service";
  const RECIPIENT_ID = "test-recipient-sharing-service";
  const OTHER_USER_ID = "test-other-user-sharing-service";
  let testWorkflowId: string;
  let testWorkflowSlug: string;

  beforeAll(() => {
    const sqlite = getSqliteInstance();
    // Create test users (required for FK constraints)
    const insertUser = sqlite.prepare(`
      INSERT OR IGNORE INTO user (id, email, handle, name, emailVerified, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, 1, datetime('now'), datetime('now'))
    `);
    insertUser.run(OWNER_ID, "owner@test-sharing.com", "test-owner-sharing", "Test Owner");
    insertUser.run(
      RECIPIENT_ID,
      "recipient@test-sharing.com",
      "test-recipient-sharing",
      "Test Recipient",
    );
    insertUser.run(
      OTHER_USER_ID,
      "other@test-sharing.com",
      "test-other-sharing",
      "Test Other User",
    );
  });

  afterAll(() => {
    const sqlite = getSqliteInstance();
    // Cleanup test users (cascades to workflows, invites, access)
    sqlite
      .prepare("DELETE FROM user WHERE id IN (?, ?, ?)")
      .run(OWNER_ID, RECIPIENT_ID, OTHER_USER_ID);
    closeDatabase();
  });

  beforeEach(() => {
    db = getDatabase();
    sharingRepo = new WorkflowSharingRepository(db);
    workflowRepo = new WorkflowRepository(db);
    auditRepo = new AuditRepository(db);

    // Wire up shared access checker
    workflowRepo.setSharedAccessChecker((workflowId, userId) =>
      sharingRepo.hasAccess(workflowId, userId),
    );

    service = new WorkflowSharingService(
      sharingRepo,
      workflowRepo,
      auditRepo,
      "https://test.moira.ai",
    );

    // Create test workflow
    testWorkflowId = `test-workflow-sharing-${Date.now()}`;
    testWorkflowSlug = `test-slug-sharing-${Date.now()}`;
    const sqlite = getSqliteInstance();
    sqlite
      .prepare(
        `
      INSERT INTO workflow (id, userId, slug, name, version, graph, visibility, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        testWorkflowId,
        OWNER_ID,
        testWorkflowSlug,
        "Test Sharing Workflow",
        "1.0.0",
        JSON.stringify({
          id: testWorkflowId,
          metadata: { name: "Test", version: "1.0.0", description: "Test" },
          nodes: [],
        }),
        "private",
        Date.now(),
        Date.now(),
      );
  });

  afterEach(() => {
    // Cleanup test workflow and related data
    const sqlite = getSqliteInstance();
    sqlite.prepare("DELETE FROM workflowAccess WHERE workflowId = ?").run(testWorkflowId);
    sqlite.prepare("DELETE FROM workflowInvite WHERE workflowId = ?").run(testWorkflowId);
    sqlite.prepare("DELETE FROM workflow WHERE id = ?").run(testWorkflowId);
  });

  // ===== Create Invite Tests =====

  describe("createInvite", () => {
    test("creates invite for owned workflow", async () => {
      const result = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });

      expect(result.invite).toBeDefined();
      expect(result.invite.workflowId).toBe(testWorkflowId);
      expect(result.invite.createdBy).toBe(OWNER_ID);
      expect(result.invite.token).toHaveLength(32);
      expect(result.inviteUrl).toBe(`https://test.moira.ai/invites/${result.invite.token}`);
      expect(result.invite.expiresAt).toBeGreaterThan(Date.now());
      expect(result.invite.usedAt).toBeNull();
    });

    test("throws WorkflowNotFoundError for non-existent workflow", async () => {
      await expect(
        service.createInvite({
          workflowId: "non-existent-workflow",
          userId: OWNER_ID,
        }),
      ).rejects.toThrow(WorkflowNotFoundError);
    });

    test("throws WorkflowAccessDeniedError when non-owner tries to create invite", async () => {
      await expect(
        service.createInvite({
          workflowId: testWorkflowId,
          userId: RECIPIENT_ID,
        }),
      ).rejects.toThrow(WorkflowAccessDeniedError);
    });

    test("allows custom TTL", async () => {
      const customTtl = 24 * 60 * 60 * 1000; // 1 day
      const result = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
        ttlMs: customTtl,
      });

      const now = Date.now();
      // Should expire in approximately 1 day (with some tolerance)
      expect(result.invite.expiresAt).toBeGreaterThan(now + customTtl - 1000);
      expect(result.invite.expiresAt).toBeLessThan(now + customTtl + 1000);
    });
  });

  // ===== Accept Invite Tests =====

  describe("acceptInvite", () => {
    let inviteToken: string;

    beforeEach(async () => {
      const result = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      inviteToken = result.invite.token;
    });

    test("grants access when accepting valid invite", async () => {
      const result = await service.acceptInvite({
        token: inviteToken,
        userId: RECIPIENT_ID,
      });

      expect(result.accessId).toBeDefined();
      expect(result.workflowId).toBe(testWorkflowId);
      expect(result.ownerHandle).toBe("test-owner-sharing");
      expect(result.slug).toBe(testWorkflowSlug);

      // Verify access was granted
      const hasAccess = await service.hasAccess(testWorkflowId, RECIPIENT_ID);
      expect(hasAccess).toBe(true);
    });

    test("throws InviteNotFoundError for invalid token", async () => {
      await expect(
        service.acceptInvite({
          token: "invalid-token-12345678901234567890",
          userId: RECIPIENT_ID,
        }),
      ).rejects.toThrow(InviteNotFoundError);
    });

    test("throws InviteAlreadyUsedError when invite is already used", async () => {
      // First acceptance
      await service.acceptInvite({
        token: inviteToken,
        userId: RECIPIENT_ID,
      });

      // Second acceptance should fail
      await expect(
        service.acceptInvite({
          token: inviteToken,
          userId: OTHER_USER_ID,
        }),
      ).rejects.toThrow(InviteAlreadyUsedError);
    });

    test("throws SelfInviteError when owner tries to accept own invite", async () => {
      await expect(
        service.acceptInvite({
          token: inviteToken,
          userId: OWNER_ID,
        }),
      ).rejects.toThrow(SelfInviteError);
    });

    test("throws AccessAlreadyExistsError when user already has access", async () => {
      // First acceptance
      await service.acceptInvite({
        token: inviteToken,
        userId: RECIPIENT_ID,
      });

      // Create another invite
      const result2 = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });

      // Second acceptance by same user should fail
      await expect(
        service.acceptInvite({
          token: result2.invite.token,
          userId: RECIPIENT_ID,
        }),
      ).rejects.toThrow(AccessAlreadyExistsError);
    });

    test("throws InviteExpiredError for expired invite", async () => {
      // Create expired invite directly in DB
      const expiredToken = "expired-token-123456789012345678";
      const sqlite = getSqliteInstance();
      sqlite
        .prepare(
          `
        INSERT INTO workflowInvite (id, workflowId, createdBy, token, expiresAt, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          `expired-invite-${Date.now()}`,
          testWorkflowId,
          OWNER_ID,
          expiredToken,
          Date.now() - 1000, // Expired 1 second ago
          Date.now() - 10000,
        );

      await expect(
        service.acceptInvite({
          token: expiredToken,
          userId: RECIPIENT_ID,
        }),
      ).rejects.toThrow(InviteExpiredError);
    });
  });

  // ===== Revoke Invite Tests =====

  describe("revokeInvite", () => {
    let inviteId: string;

    beforeEach(async () => {
      const result = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      inviteId = result.invite.id;
    });

    test("owner can revoke invite", async () => {
      await expect(
        service.revokeInvite({
          inviteId,
          userId: OWNER_ID,
        }),
      ).resolves.toBeUndefined();

      // Verify invite is deleted
      const invites = await service.listInvites({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      expect(invites.invites.find((i) => i.id === inviteId)).toBeUndefined();
    });

    test("throws InviteNotFoundError for non-existent invite", async () => {
      await expect(
        service.revokeInvite({
          inviteId: "non-existent-invite",
          userId: OWNER_ID,
        }),
      ).rejects.toThrow(InviteNotFoundError);
    });

    test("throws WorkflowAccessDeniedError when non-owner tries to revoke", async () => {
      await expect(
        service.revokeInvite({
          inviteId,
          userId: RECIPIENT_ID,
        }),
      ).rejects.toThrow(WorkflowAccessDeniedError);
    });
  });

  // ===== Revoke Access Tests =====

  describe("revokeAccess", () => {
    beforeEach(async () => {
      // Create invite and accept it
      const result = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      await service.acceptInvite({
        token: result.invite.token,
        userId: RECIPIENT_ID,
      });
    });

    test("owner can revoke user access", async () => {
      await expect(
        service.revokeAccess({
          workflowId: testWorkflowId,
          targetUserId: RECIPIENT_ID,
          userId: OWNER_ID,
        }),
      ).resolves.toBeUndefined();

      // Verify access was revoked
      const hasAccess = await service.hasAccess(testWorkflowId, RECIPIENT_ID);
      expect(hasAccess).toBe(false);
    });

    test("throws AccessNotFoundError when revoking non-existent access", async () => {
      await expect(
        service.revokeAccess({
          workflowId: testWorkflowId,
          targetUserId: OTHER_USER_ID, // Never had access
          userId: OWNER_ID,
        }),
      ).rejects.toThrow(AccessNotFoundError);
    });

    test("throws WorkflowAccessDeniedError when non-owner tries to revoke", async () => {
      await expect(
        service.revokeAccess({
          workflowId: testWorkflowId,
          targetUserId: RECIPIENT_ID,
          userId: OTHER_USER_ID, // Not the owner
        }),
      ).rejects.toThrow(WorkflowAccessDeniedError);
    });
  });

  // ===== List Operations Tests =====

  describe("listInvites", () => {
    test("lists active invites for workflow", async () => {
      // Create multiple invites
      await service.createInvite({ workflowId: testWorkflowId, userId: OWNER_ID });
      await service.createInvite({ workflowId: testWorkflowId, userId: OWNER_ID });

      const result = await service.listInvites({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });

      expect(result.invites.length).toBe(2);
      expect(result.total).toBe(2);
    });

    test("throws WorkflowAccessDeniedError when non-owner lists invites", async () => {
      await expect(
        service.listInvites({
          workflowId: testWorkflowId,
          userId: RECIPIENT_ID,
        }),
      ).rejects.toThrow(WorkflowAccessDeniedError);
    });
  });

  describe("listAccess", () => {
    test("lists users with access to workflow", async () => {
      // Grant access to two users
      const invite1 = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      await service.acceptInvite({ token: invite1.invite.token, userId: RECIPIENT_ID });

      const invite2 = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      await service.acceptInvite({ token: invite2.invite.token, userId: OTHER_USER_ID });

      const result = await service.listAccess({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });

      expect(result.accesses.length).toBe(2);
      expect(result.total).toBe(2);
      const userIds = result.accesses.map((a) => a.userId);
      expect(userIds).toContain(RECIPIENT_ID);
      expect(userIds).toContain(OTHER_USER_ID);
    });

    test("throws WorkflowAccessDeniedError when non-owner lists access", async () => {
      await expect(
        service.listAccess({
          workflowId: testWorkflowId,
          userId: RECIPIENT_ID,
        }),
      ).rejects.toThrow(WorkflowAccessDeniedError);
    });
  });

  // ===== Access Integration Tests =====

  describe("shared access integration with WorkflowRepository", () => {
    test("resolveSlugWithAccess returns workflow ID for user with shared access", async () => {
      // Grant access
      const invite = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      await service.acceptInvite({ token: invite.invite.token, userId: RECIPIENT_ID });

      // Should now be able to resolve the workflow
      const resolvedId = await workflowRepo.resolveSlugWithAccess(
        testWorkflowSlug,
        OWNER_ID,
        RECIPIENT_ID,
      );

      expect(resolvedId).toBe(testWorkflowId);
    });

    test("resolveSlugWithAccess returns null for user without access", async () => {
      // No shared access granted
      const resolvedId = await workflowRepo.resolveSlugWithAccess(
        testWorkflowSlug,
        OWNER_ID,
        RECIPIENT_ID,
      );

      expect(resolvedId).toBeNull();
    });

    test("owner always has access", async () => {
      const resolvedId = await workflowRepo.resolveSlugWithAccess(
        testWorkflowSlug,
        OWNER_ID,
        OWNER_ID,
      );

      expect(resolvedId).toBe(testWorkflowId);
    });

    test("access is revoked correctly", async () => {
      // Grant access
      const invite = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      await service.acceptInvite({ token: invite.invite.token, userId: RECIPIENT_ID });

      // Verify access
      let resolvedId = await workflowRepo.resolveSlugWithAccess(
        testWorkflowSlug,
        OWNER_ID,
        RECIPIENT_ID,
      );
      expect(resolvedId).toBe(testWorkflowId);

      // Revoke access
      await service.revokeAccess({
        workflowId: testWorkflowId,
        targetUserId: RECIPIENT_ID,
        userId: OWNER_ID,
      });

      // Verify access revoked
      resolvedId = await workflowRepo.resolveSlugWithAccess(
        testWorkflowSlug,
        OWNER_ID,
        RECIPIENT_ID,
      );
      expect(resolvedId).toBeNull();
    });
  });

  // ===== get() Method Access Tests (Step 6 fix verification) =====

  describe("get() method shared access integration", () => {
    test("get() returns workflow for user with shared access via UUID", async () => {
      // Grant access via invite
      const invite = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      await service.acceptInvite({ token: invite.invite.token, userId: RECIPIENT_ID });

      // Should now be able to get the workflow by UUID
      const workflow = await workflowRepo.get(testWorkflowId, RECIPIENT_ID);

      expect(workflow).not.toBeNull();
      expect(workflow?.id).toBe(testWorkflowId);
    });

    test("get() returns null for user without shared access", async () => {
      // No shared access granted - private workflow
      const workflow = await workflowRepo.get(testWorkflowId, RECIPIENT_ID);

      expect(workflow).toBeNull();
    });

    test("get() returns workflow for owner", async () => {
      const workflow = await workflowRepo.get(testWorkflowId, OWNER_ID);

      expect(workflow).not.toBeNull();
      expect(workflow?.id).toBe(testWorkflowId);
    });

    test("get() access is revoked correctly", async () => {
      // Grant access
      const invite = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      await service.acceptInvite({ token: invite.invite.token, userId: RECIPIENT_ID });

      // Verify access via get()
      let workflow = await workflowRepo.get(testWorkflowId, RECIPIENT_ID);
      expect(workflow).not.toBeNull();

      // Revoke access
      await service.revokeAccess({
        workflowId: testWorkflowId,
        targetUserId: RECIPIENT_ID,
        userId: OWNER_ID,
      });

      // Verify access revoked via get()
      workflow = await workflowRepo.get(testWorkflowId, RECIPIENT_ID);
      expect(workflow).toBeNull();
    });

    test("get() and getFullInfo() have consistent access behavior", async () => {
      // Grant access
      const invite = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      await service.acceptInvite({ token: invite.invite.token, userId: RECIPIENT_ID });

      // Both methods should return the workflow
      const workflowFromGet = await workflowRepo.get(testWorkflowId, RECIPIENT_ID);
      const workflowInfo = await workflowRepo.getFullInfo(testWorkflowId, RECIPIENT_ID);

      expect(workflowFromGet).not.toBeNull();
      expect(workflowInfo).not.toBeNull();
      expect(workflowFromGet?.id).toBe(workflowInfo?.id);
      expect(workflowInfo?.accessType).toBe("shared");
    });

    test("get() returns workflow for public visibility without shared access", async () => {
      // Make workflow public
      const sqlite = getSqliteInstance();
      sqlite.prepare("UPDATE workflow SET visibility = 'public' WHERE id = ?").run(testWorkflowId);

      // Should be accessible without shared access
      const workflow = await workflowRepo.get(testWorkflowId, RECIPIENT_ID);

      expect(workflow).not.toBeNull();
      expect(workflow?.id).toBe(testWorkflowId);
    });
  });

  // ===== Audit Logging Tests =====

  describe("audit logging", () => {
    test("createInvite logs audit event", async () => {
      const before = Date.now();
      await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });

      const logs = await auditRepo.list({
        userId: OWNER_ID,
        action: "sharing:invite_create",
        limit: 1,
      });

      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].resourceId).toBe(testWorkflowId);
      expect(logs[0].createdAt).toBeGreaterThanOrEqual(before);
    });

    test("acceptInvite logs audit event", async () => {
      const invite = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });

      await service.acceptInvite({
        token: invite.invite.token,
        userId: RECIPIENT_ID,
      });

      const logs = await auditRepo.list({
        userId: RECIPIENT_ID,
        action: "sharing:invite_accept",
        limit: 1,
      });

      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].resourceId).toBe(testWorkflowId);
    });

    test("revokeAccess logs audit event", async () => {
      const invite = await service.createInvite({
        workflowId: testWorkflowId,
        userId: OWNER_ID,
      });
      await service.acceptInvite({ token: invite.invite.token, userId: RECIPIENT_ID });

      await service.revokeAccess({
        workflowId: testWorkflowId,
        targetUserId: RECIPIENT_ID,
        userId: OWNER_ID,
      });

      const logs = await auditRepo.list({
        userId: OWNER_ID,
        action: "sharing:access_revoke",
        limit: 1,
      });

      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0].resourceId).toBe(testWorkflowId);
    });
  });
});
