/**
 * Lock Service - Business logic for execution locks with PIN generation
 * Block/unblock gate; the PIN is stored hashed (scrypt) and verified by hash.
 */

import { randomInt, randomUUID } from "crypto";
import { hashPin, verifyPin } from "../utils/pin-hash.js";
import type {
  LockRepository,
  LockRecord,
  LockStatus,
  PublicLockStatus,
} from "../database/repositories/lock-repository.js";
import type { AuditRepository } from "../database/repositories/audit-repository.js";
import { getAuditSource } from "../logging/context.js";
import { createLogger, Component } from "../logging/logger.js";
import { AuditAction } from "../audit/actions.js";

const PIN_LENGTH = 6;

export interface CreateLockOptions {
  executionId: string;
  nodeId: string;
  reason: string;
  lockedBy: string;
}

export interface CreateLockResult {
  lockId: string;
  pin: string;
}

export interface DeliveredLockResult {
  lockId: string;
}

export interface LockDeliverySecret {
  lockId: string;
  pin: string;
}

export interface ValidatePinResult {
  valid: boolean;
  lockStatus: LockStatus;
}

export class LockService {
  private logger = createLogger({ component: Component.Execution });

  constructor(
    private lockRepo: LockRepository,
    private auditRepo: AuditRepository,
    private pinGenerator: () => string = () => LockService.generatePin(),
  ) {}

  /**
   * Create a new execution lock with generated PIN
   */
  async createLock(options: CreateLockOptions): Promise<CreateLockResult> {
    const prepared = this.prepareLock();

    await this.lockRepo.create({
      id: prepared.lockId,
      executionId: options.executionId,
      nodeId: options.nodeId,
      reason: options.reason,
      lockedBy: options.lockedBy,
      // Store only the hash; the plaintext PIN is returned once to the caller.
      pin: prepared.pinHash,
      createdAt: prepared.createdAt,
    });

    await this.logLockCreated(options, prepared.lockId);

    this.logger.info("Execution lock created", {
      lockId: prepared.lockId,
      executionId: options.executionId,
      nodeId: options.nodeId,
    });

    return { lockId: prepared.lockId, pin: prepared.pin };
  }

  /**
   * Create a lock for an agent-reachable caller and expose the plaintext PIN only
   * to the trusted delivery callback. The lock is not active until delivery succeeds.
   */
  async createLockWithDelivery(
    options: CreateLockOptions,
    deliver: (secret: LockDeliverySecret) => Promise<void>,
  ): Promise<DeliveredLockResult> {
    const prepared = this.prepareLock();

    await this.lockRepo.create({
      id: prepared.lockId,
      executionId: options.executionId,
      nodeId: options.nodeId,
      reason: options.reason,
      lockedBy: options.lockedBy,
      pin: prepared.pinHash,
      status: "pending_delivery",
      createdAt: prepared.createdAt,
    });

    try {
      await deliver({ lockId: prepared.lockId, pin: prepared.pin });
      await this.logLockCreated(options, prepared.lockId);
      await this.lockRepo.updateStatus(prepared.lockId, "active");

      this.logger.info("Execution lock activated after trusted delivery", {
        lockId: prepared.lockId,
        executionId: options.executionId,
        nodeId: options.nodeId,
      });

      return { lockId: prepared.lockId };
    } catch (error) {
      try {
        await this.lockRepo.updateStatus(prepared.lockId, "delivery_failed");
      } catch {
        // The original pending state is also fail-closed: active queries ignore it.
        this.logger.error("Failed to mark trusted lock delivery attempt as failed", {
          lockId: prepared.lockId,
          executionId: options.executionId,
        });
      }
      throw error;
    }
  }

  /**
   * Validate PIN against lock (constant-time hash verification)
   */
  async validatePin(lockId: string, pin: string): Promise<ValidatePinResult> {
    const lock = await this.lockRepo.getById(lockId);
    if (!lock) {
      throw new LockNotFoundError(lockId);
    }

    if (lock.status !== "active") {
      return {
        valid: false,
        lockStatus: lock.status,
      };
    }

    const isValid = verifyPin(pin, lock.pin);

    if (isValid) {
      await this.lockRepo.updateStatus(lockId, "unlocked", { unlockedAt: new Date() });

      await this.auditRepo.log({
        userId: lock.lockedBy,
        action: AuditAction.LOCK_UNLOCK,
        resource: "execution",
        resourceId: lock.executionId,
        source: getAuditSource(),
        metadata: JSON.stringify({ lockId }),
      });

      this.logger.info("Execution lock unlocked via PIN", {
        lockId,
        executionId: lock.executionId,
      });

      return {
        valid: true,
        lockStatus: "unlocked",
      };
    }

    // Invalid PIN — log and return
    await this.auditRepo.log({
      userId: lock.lockedBy,
      action: AuditAction.LOCK_ATTEMPT_FAIL,
      resource: "execution",
      resourceId: lock.executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({ lockId }),
    });

    return {
      valid: false,
      lockStatus: "active",
    };
  }

  /**
   * Find active lock by execution/node prefix (read-only, no mutation)
   * Used by webhook handler to validate origin before mutating lock state
   */
  async findActiveLockByPrefix(
    executionIdPrefix: string,
    nodeIdPrefix: string,
  ): Promise<LockRecord> {
    const lock = await this.lockRepo.getActiveByExecutionPrefix(executionIdPrefix);
    if (!lock) {
      throw new LockNotFoundError(`prefix:${executionIdPrefix}`);
    }

    if (!lock.nodeId.startsWith(nodeIdPrefix)) {
      throw new LockNotFoundError(`prefix:${executionIdPrefix}:${nodeIdPrefix}`);
    }

    if (lock.status !== "active") {
      throw new LockNotActiveError(lock.id, lock.status);
    }

    return lock;
  }

  /**
   * Unlock lock via Telegram callback approval (no PIN required)
   * Uses executionId prefix to find the lock (Telegram callback_data is truncated)
   */
  async unlockByApproval(
    executionIdPrefix: string,
    nodeIdPrefix: string,
  ): Promise<{ lock: LockRecord }> {
    const lock = await this.lockRepo.getActiveByExecutionPrefix(executionIdPrefix);
    if (!lock) {
      throw new LockNotFoundError(`prefix:${executionIdPrefix}`);
    }

    if (!lock.nodeId.startsWith(nodeIdPrefix)) {
      throw new LockNotFoundError(`prefix:${executionIdPrefix}:${nodeIdPrefix}`);
    }

    if (lock.status !== "active") {
      throw new LockNotActiveError(lock.id, lock.status);
    }

    await this.lockRepo.updateStatus(lock.id, "unlocked", { unlockedAt: new Date() });

    await this.auditRepo.log({
      userId: lock.lockedBy,
      action: AuditAction.LOCK_UNLOCK,
      resource: "execution",
      resourceId: lock.executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        lockId: lock.id,
        method: "telegram_approval",
        executionIdPrefix,
        nodeIdPrefix,
      }),
    });

    this.logger.info("Execution lock unlocked via Telegram approval", {
      lockId: lock.id,
      executionId: lock.executionId,
    });

    return { lock };
  }

  /**
   * Get lock status
   */
  async getLock(lockId: string): Promise<LockRecord | null> {
    return await this.lockRepo.getById(lockId);
  }

  /**
   * Get active lock for an execution
   */
  async getActiveLock(executionId: string): Promise<(LockRecord & { status: "active" }) | null> {
    return await this.lockRepo.getActiveByExecution(executionId);
  }

  /**
   * List all locks for an execution
   */
  async listLocks(executionId: string): Promise<Array<LockRecord & { status: PublicLockStatus }>> {
    const locks = await this.lockRepo.listByExecution(executionId);
    return locks.filter(
      (lock): lock is LockRecord & { status: PublicLockStatus } =>
        lock.status === "active" || lock.status === "unlocked",
    );
  }

  /**
   * Get set of execution IDs that have active locks
   */
  async getActiveExecutionIds(): Promise<Set<string>> {
    return await this.lockRepo.getActiveExecutionIds();
  }

  // --- Private helpers ---

  /**
   * Generate a numeric PIN of PIN_LENGTH digits
   */
  private static generatePin(): string {
    const min = Math.pow(10, PIN_LENGTH - 1); // 100000
    const max = Math.pow(10, PIN_LENGTH) - 1; // 999999
    return String(randomInt(min, max + 1));
  }

  private prepareLock(): {
    lockId: string;
    pin: string;
    pinHash: string;
    createdAt: Date;
  } {
    const pin = this.pinGenerator();
    if (!/^\d{6}$/.test(pin)) {
      throw new Error("Lock PIN generator must return exactly six digits");
    }
    return {
      lockId: randomUUID(),
      pin,
      pinHash: hashPin(pin),
      createdAt: new Date(),
    };
  }

  private async logLockCreated(options: CreateLockOptions, lockId: string): Promise<void> {
    await this.auditRepo.log({
      userId: options.lockedBy,
      action: AuditAction.LOCK_CREATE,
      resource: "execution",
      resourceId: options.executionId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        lockId,
        nodeId: options.nodeId,
        reason: options.reason,
      }),
    });
  }

  /**
   * Admin override unlock — unlocks without PIN
   */
  async adminUnlock(lockId: string, adminUserId: string): Promise<void> {
    const lock = await this.lockRepo.getById(lockId);

    if (!lock) {
      throw new LockNotFoundError(lockId);
    }

    if (lock.status !== "active") {
      throw new LockNotActiveError(lockId, lock.status);
    }

    await this.lockRepo.updateStatus(lockId, "unlocked", {
      unlockedAt: new Date(),
    });

    await this.auditRepo.log({
      userId: adminUserId,
      action: AuditAction.ADMIN_UNLOCK,
      resource: "lock",
      resourceId: lockId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        executionId: lock.executionId,
        nodeId: lock.nodeId,
        adminOverride: true,
      }),
    });

    this.logger.info("Lock admin-unlocked", {
      lockId,
      executionId: lock.executionId,
      adminUserId,
    });
  }

  /**
   * Owner unlock — execution owner unlocks without PIN via web UI
   */
  async ownerUnlock(lockId: string, ownerId: string): Promise<void> {
    const lock = await this.lockRepo.getById(lockId);

    if (!lock) {
      throw new LockNotFoundError(lockId);
    }

    if (lock.status !== "active") {
      throw new LockNotActiveError(lockId, lock.status);
    }

    await this.lockRepo.updateStatus(lockId, "unlocked", {
      unlockedAt: new Date(),
    });

    await this.auditRepo.log({
      userId: ownerId,
      action: AuditAction.LOCK_UNLOCK,
      resource: "lock",
      resourceId: lockId,
      source: getAuditSource(),
      metadata: JSON.stringify({
        executionId: lock.executionId,
        nodeId: lock.nodeId,
        ownerUnlock: true,
      }),
    });

    this.logger.info("Lock owner-unlocked", {
      lockId,
      executionId: lock.executionId,
      ownerId,
    });
  }
}

// --- Error classes ---

export class LockNotFoundError extends Error {
  constructor(lockId: string) {
    super(`Lock not found: ${lockId}`);
    this.name = "LockNotFoundError";
  }
}

export class LockNotActiveError extends Error {
  constructor(lockId: string, currentStatus: string) {
    super(`Lock ${lockId} is not active (current status: ${currentStatus})`);
    this.name = "LockNotActiveError";
  }
}
