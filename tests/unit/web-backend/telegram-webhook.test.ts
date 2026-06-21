/**
 * Unit tests for Telegram webhook route
 * Tests callback_query parsing, lock operations, and error handling
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "path";

import * as schema from "../../../packages/shared/src/database/schema.js";
import { LockService } from "@mcp-moira/shared";
import { LockRepository } from "../../../packages/shared/src/database/repositories/lock-repository.js";
import { AuditRepository } from "../../../packages/shared/src/database/repositories/audit-repository.js";
import { parseApproveCallback } from "@mcp-moira/workflow-engine";

const MIGRATIONS_PATH = path.join(process.cwd(), "packages/web-backend/drizzle");

const TEST_USER_ID = "test-webhook-user-001";
const TEST_EXECUTION_ID = "abcd1234-5678-9012-3456-789012345678";
const TEST_NODE_ID = "gate-node-webhook-test";

describe("Telegram Webhook", () => {
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

    const now = new Date().toISOString();
    db.insert(schema.user)
      .values({
        id: TEST_USER_ID,
        name: "Test Webhook User",
        email: "webhook-test@example.com",
        emailVerified: true,
        handle: "webhook-tester",
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

  describe("parseApproveCallback", () => {
    it("should parse approve callback data", () => {
      const execPrefix = TEST_EXECUTION_ID.substring(0, 8);
      const nodePrefix = TEST_NODE_ID.substring(0, 12);
      const data = `a:${execPrefix}:${nodePrefix}`;

      const result = parseApproveCallback(data);

      expect(result).not.toBeNull();
      expect(result!.executionIdPrefix).toBe(execPrefix);
      expect(result!.nodeIdPrefix).toBe(nodePrefix);
    });

    it("should return null for reject prefix (no longer supported)", () => {
      const execPrefix = TEST_EXECUTION_ID.substring(0, 8);
      const nodePrefix = TEST_NODE_ID.substring(0, 12);
      const data = `r:${execPrefix}:${nodePrefix}`;

      const result = parseApproveCallback(data);
      expect(result).toBeNull();
    });

    it("should return null for unknown format", () => {
      expect(parseApproveCallback("unknown:data")).toBeNull();
      expect(parseApproveCallback("x:abc:def")).toBeNull();
      expect(parseApproveCallback("")).toBeNull();
    });

    it("should reject LIKE wildcard injection in prefixes (B1 fix)", () => {
      expect(parseApproveCallback("a:%:")).toBeNull();
      expect(parseApproveCallback("a:________:node")).toBeNull();
      expect(parseApproveCallback("a:%25%25%25:node")).toBeNull();
      expect(parseApproveCallback("a:abc:node")).toBeNull();
      expect(parseApproveCallback("a::")).toBeNull();
    });

    it("should reject nodeId prefix with invalid characters", () => {
      expect(parseApproveCallback("a:abcd1234:node<script>")).toBeNull();
      expect(parseApproveCallback("a:abcd1234:no de")).toBeNull();
    });
  });

  describe("Webhook callback → lock operations", () => {
    it("should unlock lock when approve callback received", async () => {
      const { lockId } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Approval gate",
        lockedBy: TEST_USER_ID,
      });

      const execPrefix = TEST_EXECUTION_ID.substring(0, 8);
      const nodePrefix = TEST_NODE_ID.substring(0, 12);

      const result = await lockService.unlockByApproval(execPrefix, nodePrefix);
      expect(result.lock.id).toBe(lockId);

      const lock = await lockService.getLock(lockId);
      expect(lock!.status).toBe("unlocked");
    });

    it("should find lock by 8-char executionId prefix", async () => {
      await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Test",
        lockedBy: TEST_USER_ID,
      });

      const lock = await lockRepo.getActiveByExecutionPrefix(TEST_EXECUTION_ID.substring(0, 8));
      expect(lock).not.toBeNull();
      expect(lock!.executionId).toBe(TEST_EXECUTION_ID);
    });

    it("should not find unlocked locks by prefix", async () => {
      const { lockId, pin } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Test",
        lockedBy: TEST_USER_ID,
      });

      // Unlock the lock
      await lockService.validatePin(lockId, pin);

      // Should not find the unlocked lock
      const lock = await lockRepo.getActiveByExecutionPrefix(TEST_EXECUTION_ID.substring(0, 8));
      expect(lock).toBeNull();
    });

    it("should reject LIKE wildcards at repository level (B1 fix)", async () => {
      await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Test",
        lockedBy: TEST_USER_ID,
      });

      const lockWildcard = await lockRepo.getActiveByExecutionPrefix("%");
      expect(lockWildcard).toBeNull();

      const lockShort = await lockRepo.getActiveByExecutionPrefix("ab%cd");
      expect(lockShort).toBeNull();
    });

    it("should find active lock by prefix without mutating (read-only lookup)", async () => {
      const { lockId } = await lockService.createLock({
        executionId: TEST_EXECUTION_ID,
        nodeId: TEST_NODE_ID,
        reason: "Approval gate",
        lockedBy: TEST_USER_ID,
      });

      const execPrefix = TEST_EXECUTION_ID.substring(0, 8);
      const nodePrefix = TEST_NODE_ID.substring(0, 12);

      const lock = await lockService.findActiveLockByPrefix(execPrefix, nodePrefix);
      expect(lock.id).toBe(lockId);
      expect(lock.status).toBe("active");

      // Verify the lock was NOT mutated (still active after lookup)
      const lockAfter = await lockService.getLock(lockId);
      expect(lockAfter!.status).toBe("active");
    });
  });
});
