/**
 * Unit tests for LockService
 * Tests PIN generation, validation, audit trail
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import * as schema from "../../../packages/shared/src/database/schema.js";
import { LockService, LockNotFoundError, AuditAction, isHashedPin } from "@mcp-moira/shared";
import { LockRepository } from "../../../packages/shared/src/database/repositories/lock-repository.js";
import { AuditRepository } from "../../../packages/shared/src/database/repositories/audit-repository.js";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

const TEST_USER_ID = "test-lock-user-001";
const TEST_EXECUTION_ID = "test-execution-001";
const TEST_NODE_ID = "gate-node-1";

describe("LockService", () => {
  let db: BetterSQLite3Database<typeof schema>;
  let sqlite: Database.Database;
  let lockRepo: LockRepository;
  let auditRepo: AuditRepository;
  let lockService: LockService;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite, { schema });
    sqlite.exec("PRAGMA foreign_keys = OFF");
    migrate(db, { migrationsFolder: MIGRATIONS_PATH });

    // Create test user
    const now = new Date().toISOString();
    db.insert(schema.user)
      .values({
        id: TEST_USER_ID,
        name: "Test Lock User",
        email: "lock-test@example.com",
        emailVerified: true,
        handle: "lock-tester",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    lockRepo = new LockRepository(db);
    auditRepo = new AuditRepository(db);
    lockService = new LockService(lockRepo, auditRepo);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe("createLock", () => {
    it("should create a lock and return a 6-digit PIN", async () => {
      const result = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Approval required",
        lockedBy: TEST_USER_ID,
      });

      expect(result.lockId).toBeDefined();
      expect(result.pin).toMatch(/^\d{6}$/);
    });

    it("should store lock in repository", async () => {
      const result = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Gate check",
        lockedBy: TEST_USER_ID,
      });

      const lock = await lockService.getLock(result.lockId);
      expect(lock).not.toBeNull();
      expect(lock!.executionId).toBe(TEST_EXECUTION_ID);
      expect(lock!.nodeId).toBe(TEST_NODE_ID);
      expect(lock!.status).toBe("active");
    });

    it("should log LOCK_CREATE audit event", async () => {
      await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Audit test",
        lockedBy: TEST_USER_ID,
      });

      const audits = db.select().from(schema.auditLog).all();
      expect(audits.length).toBe(1);
      expect(audits[0].action).toBe(AuditAction.LOCK_CREATE);
      expect(audits[0].resource).toBe("execution");
      expect(audits[0].resourceId).toBe(TEST_EXECUTION_ID);
    });
  });

  describe("validatePin", () => {
    it("should unlock with correct PIN", async () => {
      const { lockId, pin } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Unlock test",
        lockedBy: TEST_USER_ID,
      });

      const result = await lockService.validatePin(lockId, pin);
      expect(result.valid).toBe(true);
      expect(result.lockStatus).toBe("unlocked");

      const lock = await lockService.getLock(lockId);
      expect(lock!.status).toBe("unlocked");
      expect(lock!.unlockedAt).toBeInstanceOf(Date);
    });

    it("should return active status with wrong PIN", async () => {
      const { lockId } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Wrong PIN test",
        lockedBy: TEST_USER_ID,
      });

      const result = await lockService.validatePin(lockId, "000000");
      expect(result.valid).toBe(false);
      expect(result.lockStatus).toBe("active");
    });

    it("should throw LockNotFoundError for unknown lock", async () => {
      await expect(lockService.validatePin("nonexistent", "123456")).rejects.toThrow(
        LockNotFoundError,
      );
    });

    it("should return invalid for already-unlocked lock", async () => {
      const { lockId, pin } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Double unlock test",
        lockedBy: TEST_USER_ID,
      });

      await lockService.validatePin(lockId, pin); // unlock

      const result = await lockService.validatePin(lockId, pin);
      expect(result.valid).toBe(false);
      expect(result.lockStatus).toBe("unlocked");
    });

    it("should log audit events for unlock and failed attempts", async () => {
      const { lockId, pin } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Audit trail test",
        lockedBy: TEST_USER_ID,
      });

      await lockService.validatePin(lockId, "000000"); // fail
      await lockService.validatePin(lockId, pin); // unlock

      const audits = db
        .select()
        .from(schema.auditLog)
        .all()
        .map((a) => a.action);

      expect(audits).toContain(AuditAction.LOCK_CREATE);
      expect(audits).toContain(AuditAction.LOCK_ATTEMPT_FAIL);
      expect(audits).toContain(AuditAction.LOCK_UNLOCK);
    });
  });

  describe("getActiveLock", () => {
    it("should return active lock for execution", async () => {
      const { lockId } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Active lock test",
        lockedBy: TEST_USER_ID,
      });

      const active = await lockService.getActiveLock(TEST_EXECUTION_ID);
      expect(active).not.toBeNull();
      expect(active!.id).toBe(lockId);
    });

    it("should return null when no active lock exists", async () => {
      const active = await lockService.getActiveLock("nonexistent-execution");
      expect(active).toBeNull();
    });

    it("should return null after lock is unlocked", async () => {
      const { lockId, pin } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Unlock then check",
        lockedBy: TEST_USER_ID,
      });

      await lockService.validatePin(lockId, pin);

      const active = await lockService.getActiveLock(TEST_EXECUTION_ID);
      expect(active).toBeNull();
    });
  });

  describe("listLocks", () => {
    it("should return all locks for an execution", async () => {
      // Create and unlock one lock, then create another
      const { lockId, pin } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: "node-1",
        reason: "First lock",
        lockedBy: TEST_USER_ID,
      });
      await lockService.validatePin(lockId, pin);

      await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: "node-2",
        reason: "Second lock",
        lockedBy: TEST_USER_ID,
      });

      const locks = await lockService.listLocks(TEST_EXECUTION_ID);
      expect(locks.length).toBe(2);
    });
  });

  describe("PIN storage", () => {
    it("should store PIN hashed, not in plain text", async () => {
      const { lockId, pin } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "PIN storage test",
        lockedBy: TEST_USER_ID,
      });

      const lock = await lockService.getLock(lockId);
      // Stored value is the scrypt hash, never the plaintext PIN.
      expect(lock!.pin).not.toBe(pin);
      expect(isHashedPin(lock!.pin)).toBe(true);

      // The correct PIN still unlocks (verified against the hash).
      const result = await lockService.validatePin(lockId, pin);
      expect(result.valid).toBe(true);
    });

    it("should generate unique PINs for different locks", async () => {
      const pins = new Set<string>();
      for (let i = 0; i < 10; i++) {
        const { pin } = await lockService.createLock({
          executionId: `exec-${i}`,
          nodeId: TEST_NODE_ID,
          reason: `Lock ${i}`,
          lockedBy: TEST_USER_ID,
        });
        pins.add(pin);
      }
      // With 6 digits and 10 samples, collisions are extremely unlikely
      expect(pins.size).toBeGreaterThanOrEqual(8);
    });
  });

  describe("unlockByApproval", () => {
    it("should unlock a lock by execution ID prefix", async () => {
      const { lockId } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Needs approval",
        lockedBy: TEST_USER_ID,
      });

      // Use first 8 chars as prefix (matching Telegram callback format)
      const prefix = TEST_EXECUTION_ID.substring(0, 8);
      const nodePrefix = TEST_NODE_ID.substring(0, 12);

      const result = await lockService.unlockByApproval(prefix, nodePrefix);

      expect(result.lock.id).toBe(lockId);
      expect(result.lock.executionId).toBe(TEST_EXECUTION_ID);

      // Verify lock is unlocked
      const lock = await lockService.getLock(lockId);
      expect(lock!.status).toBe("unlocked");
      expect(lock!.unlockedAt).toBeDefined();
    });

    it("should throw LockNotFoundError for non-matching prefix", async () => {
      await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Needs approval",
        lockedBy: TEST_USER_ID,
      });

      await expect(
        lockService.unlockByApproval("nonexist", TEST_NODE_ID.substring(0, 12)),
      ).rejects.toThrow(LockNotFoundError);
    });

    it("should throw LockNotFoundError for mismatched node prefix", async () => {
      await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Needs approval",
        lockedBy: TEST_USER_ID,
      });

      const prefix = TEST_EXECUTION_ID.substring(0, 8);

      await expect(lockService.unlockByApproval(prefix, "wrong-node-pr")).rejects.toThrow(
        LockNotFoundError,
      );
    });

    it("should create audit log with telegram_approval method", async () => {
      await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Needs approval",
        lockedBy: TEST_USER_ID,
      });

      const prefix = TEST_EXECUTION_ID.substring(0, 8);
      const nodePrefix = TEST_NODE_ID.substring(0, 12);
      await lockService.unlockByApproval(prefix, nodePrefix);

      // Find the unlock audit entry
      const auditLogs = await auditRepo.list({
        action: AuditAction.LOCK_UNLOCK,
        resourceId: TEST_EXECUTION_ID,
      });
      expect(auditLogs.length).toBeGreaterThanOrEqual(1);
      const unlockLog = auditLogs[0];
      expect(unlockLog).toBeDefined();

      const metadata = JSON.parse(unlockLog!.metadata || "{}");
      expect(metadata.method).toBe("telegram_approval");
    });
  });
});
