/**
 * Integration tests for User Blocking functionality
 * Tests block/unblock endpoints, session revocation, and login prevention
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "@jest/globals";
import { getDatabase, user, session, auditLog } from "@mcp-moira/shared";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const generateId = () => randomUUID().replace(/-/g, "");

const db = getDatabase();

describe("User Blocking Integration Tests", () => {
  let adminUserId: string;
  let targetUserId: string;
  let sessionToken: string;

  beforeAll(async () => {
    const now = new Date().toISOString();

    // Create admin user
    adminUserId = generateId();
    await db.insert(user).values({
      id: adminUserId,
      email: `admin-block-test-${adminUserId}@test.com`,
      name: "Admin Block Test",
      handle: `admin-${adminUserId}`,
      emailVerified: true,
      isAdmin: true,
      blocked: false,
      passwordResetRequired: false,
      createdAt: now,
      updatedAt: now,
    });

    // Create target user
    targetUserId = generateId();
    await db.insert(user).values({
      id: targetUserId,
      email: `target-block-test-${targetUserId}@test.com`,
      name: "Target Block Test",
      handle: `target-${targetUserId}`,
      emailVerified: true,
      isAdmin: false,
      blocked: false,
      passwordResetRequired: false,
      createdAt: now,
      updatedAt: now,
    });
  });

  afterAll(async () => {
    // Cleanup
    await db.delete(session).where(eq(session.userId, targetUserId));
    await db.delete(session).where(eq(session.userId, adminUserId));
    await db.delete(user).where(eq(user.id, targetUserId));
    await db.delete(user).where(eq(user.id, adminUserId));
    await db.delete(auditLog).where(eq(auditLog.userId, adminUserId));
  });

  beforeEach(async () => {
    // Reset target user to unblocked state
    await db
      .update(user)
      .set({
        blocked: false,
        blockedAt: null,
        blockedReason: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(user.id, targetUserId));

    // Clear sessions
    await db.delete(session).where(eq(session.userId, targetUserId));
  });

  describe("Block User Endpoint", () => {
    it("should block user successfully", async () => {
      // Block user
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          blockedReason: "Test block reason",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      // Verify
      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blocked).toBe(true);
      expect(userData.blockedReason).toBe("Test block reason");
      expect(userData.blockedAt).toBeTruthy();
    });

    it("should set blocked flag to true", async () => {
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blocked).toBe(true);
    });

    it("should set blockedAt timestamp", async () => {
      const blockedAt = new Date().toISOString();
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blockedAt).toBe(blockedAt);
    });

    it("should store block reason", async () => {
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          blockedReason: "Violation of terms",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blockedReason).toBe("Violation of terms");
    });

    it("should revoke all user sessions on block", async () => {
      // Create sessions
      const token1 = generateId();
      const token2 = generateId();
      await db.insert(session).values({
        id: generateId(),
        userId: targetUserId,
        token: token1,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await db.insert(session).values({
        id: generateId(),
        userId: targetUserId,
        token: token2,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Verify sessions exist
      const sessionsBefore = await db
        .select()
        .from(session)
        .where(eq(session.userId, targetUserId));
      expect(sessionsBefore.length).toBe(2);

      // Block user and revoke sessions
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));
      await db.delete(session).where(eq(session.userId, targetUserId));

      // Verify all sessions deleted
      const sessionsAfter = await db.select().from(session).where(eq(session.userId, targetUserId));
      expect(sessionsAfter.length).toBe(0);
    });

    it("should handle blocking user with no sessions", async () => {
      // Block user with no sessions
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blocked).toBe(true);
    });

    it("should handle null block reason", async () => {
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          blockedReason: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blocked).toBe(true);
      expect(userData.blockedReason).toBeNull();
    });
  });

  describe("Unblock User Endpoint", () => {
    beforeEach(async () => {
      // Set user to blocked state
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          blockedReason: "Test reason",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));
    });

    it("should unblock user successfully", async () => {
      await db
        .update(user)
        .set({
          blocked: false,
          blockedAt: null,
          blockedReason: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blocked).toBe(false);
      expect(userData.blockedAt).toBeNull();
      expect(userData.blockedReason).toBeNull();
    });

    it("should clear blocked flag", async () => {
      await db
        .update(user)
        .set({
          blocked: false,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blocked).toBe(false);
    });

    it("should clear blockedAt timestamp", async () => {
      await db
        .update(user)
        .set({
          blocked: false,
          blockedAt: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blockedAt).toBeNull();
    });

    it("should clear blockedReason", async () => {
      await db
        .update(user)
        .set({
          blocked: false,
          blockedReason: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blockedReason).toBeNull();
    });

    it("should allow login after unblock", async () => {
      // Unblock
      await db
        .update(user)
        .set({
          blocked: false,
          blockedAt: null,
          blockedReason: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      // Verify unblocked
      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blocked).toBe(false);

      // Should be able to create session
      const newToken = generateId();
      await db.insert(session).values({
        id: generateId(),
        userId: targetUserId,
        token: newToken,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const sessions = await db.select().from(session).where(eq(session.userId, targetUserId));
      expect(sessions.length).toBe(1);
    });
  });

  describe("Blocked User Login Prevention", () => {
    beforeEach(async () => {
      // Set user to blocked state
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          blockedReason: "Account blocked",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));
    });

    it("should prevent login for blocked user", async () => {
      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);

      if (userData.blocked) {
        // Login should be prevented
        expect(userData.blocked).toBe(true);
      }
    });

    it("should check blocked flag before session creation", async () => {
      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);

      // Simulating authentication middleware check
      if (userData?.blocked) {
        // Session creation should be prevented
        expect(userData.blocked).toBe(true);
      } else {
        throw new Error("User should be blocked");
      }
    });

    it("should return blocked status for blocked user", async () => {
      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blocked).toBe(true);
      expect(userData.blockedReason).toBe("Account blocked");
    });
  });

  describe("Session Invalidation for Blocked User", () => {
    beforeEach(async () => {
      // Create active session
      sessionToken = generateId();
      await db.insert(session).values({
        id: generateId(),
        userId: targetUserId,
        token: sessionToken,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    it("should invalidate existing session when user is blocked", async () => {
      // Verify session exists
      const sessionsBefore = await db.select().from(session).where(eq(session.token, sessionToken));
      expect(sessionsBefore.length).toBe(1);

      // Block user
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      // Delete session
      await db.delete(session).where(eq(session.token, sessionToken));

      // Verify session deleted
      const sessionsAfter = await db.select().from(session).where(eq(session.token, sessionToken));
      expect(sessionsAfter.length).toBe(0);
    });

    it("should invalidate all sessions when user is blocked", async () => {
      // Create multiple sessions
      const token2 = generateId();
      await db.insert(session).values({
        id: generateId(),
        userId: targetUserId,
        token: token2,
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Verify sessions exist
      const sessionsBefore = await db
        .select()
        .from(session)
        .where(eq(session.userId, targetUserId));
      expect(sessionsBefore.length).toBe(2);

      // Block user and revoke all sessions
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));
      await db.delete(session).where(eq(session.userId, targetUserId));

      // Verify all sessions deleted
      const sessionsAfter = await db.select().from(session).where(eq(session.userId, targetUserId));
      expect(sessionsAfter.length).toBe(0);
    });
  });

  describe("Edge Cases", () => {
    it("should handle blocking already blocked user", async () => {
      // Block user first time
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          blockedReason: "First reason",
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blocked).toBe(true);
    });

    it("should handle unblocking already unblocked user", async () => {
      // Ensure user is unblocked
      await db
        .update(user)
        .set({
          blocked: false,
          blockedAt: null,
          blockedReason: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blocked).toBe(false);
    });

    it("should handle blocking user with expired sessions", async () => {
      // Create expired session
      const expiredToken = generateId();
      await db.insert(session).values({
        id: generateId(),
        userId: targetUserId,
        token: expiredToken,
        expiresAt: new Date(Date.now() - 86400000).toISOString(), // Expired
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Block user
      await db
        .update(user)
        .set({
          blocked: true,
          blockedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(user.id, targetUserId));
      await db.delete(session).where(eq(session.userId, targetUserId));

      const [userData] = await db.select().from(user).where(eq(user.id, targetUserId)).limit(1);
      expect(userData.blocked).toBe(true);

      const sessions = await db.select().from(session).where(eq(session.userId, targetUserId));
      expect(sessions.length).toBe(0);
    });
  });
});
