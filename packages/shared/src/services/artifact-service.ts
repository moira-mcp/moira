/**
 * Artifact Service - Business logic layer for static HTML artifacts
 * Wraps ArtifactRepository with validation, quota enforcement, and audit logging
 *
 * Validation rules:
 * - Content: Must be valid HTML (basic validation)
 * - Size: Max from global setting (default 5 MB per artifact)
 * - Quota: Max from global/per-user setting (default 100 MB total, 50 artifacts per user)
 * - TTL: Default from global setting (30 days)
 *
 * Quota resolution order:
 * 1. Per-user override (user.artifactQuotaMb, user.artifactMaxFiles)
 * 2. Global setting (artifacts.default_quota_mb, artifacts.default_max_files)
 * 3. Hardcoded defaults (100 MB, 50 files)
 */

import type { AuditRepository } from "../database/repositories/audit-repository.js";
import type { GlobalSettingsService } from "./global-settings-service.js";
import {
  ArtifactRepository,
  MAX_ARTIFACT_SIZE,
  MAX_USER_TOTAL_SIZE,
  MAX_ARTIFACTS_PER_USER,
  DEFAULT_TTL_MS,
  DEFAULT_TOKEN_TTL_MS,
  type Artifact,
  type ArtifactInfo,
  type ArtifactListResult,
  type ArtifactStats,
  type PublicArtifact,
  type ReportedArtifact,
} from "../database/repositories/artifact-repository.js";
import { getAuditSource } from "../logging/context.js";
import { createLogger } from "../logging/logger.js";
import { AuditAction } from "../audit/actions.js";
import {
  ArtifactNotFoundError,
  ArtifactSizeExceededError,
  ArtifactQuotaExceededError,
  ArtifactAccessDeniedError,
  InvalidArtifactContentError,
  InvalidArtifactTokenError,
} from "../errors/domain-errors.js";

// Re-export domain errors for backward compatibility
export {
  ArtifactNotFoundError,
  ArtifactSizeExceededError,
  ArtifactQuotaExceededError,
  ArtifactAccessDeniedError,
  InvalidArtifactContentError,
  InvalidArtifactTokenError,
};

// Re-export constants
export {
  MAX_ARTIFACT_SIZE,
  MAX_USER_TOTAL_SIZE,
  MAX_ARTIFACTS_PER_USER,
  DEFAULT_TTL_MS,
  DEFAULT_TOKEN_TTL_MS,
};

// Re-export types
export type { Artifact, ArtifactInfo, ArtifactListResult, ArtifactStats, PublicArtifact };

// ===== Service Options =====

export interface CreateArtifactOptions {
  name: string;
  content: string;
  executionId?: string;
  ttlMs?: number;
}

export interface UpdateArtifactOptions {
  content: string;
  name?: string;
  ttlMs?: number;
}

export interface QuotaOverrides {
  maxSize?: number;
  maxTotalSize?: number;
  maxCount?: number;
}

/**
 * Provider for per-user quota settings
 * Returns null for fields that should use global defaults
 */
export interface UserQuotaProvider {
  getUserQuota(userId: string): Promise<{
    artifactQuotaMb: number | null;
    artifactMaxFiles: number | null;
  }>;
}

// Global settings keys for artifacts
const GLOBAL_SETTINGS_KEYS = {
  defaultQuotaMb: "artifacts.default_quota_mb",
  defaultTtlDays: "artifacts.default_ttl_days",
  maxFileSizeMb: "artifacts.max_file_size_mb",
  defaultMaxFiles: "artifacts.default_max_files",
} as const;

// ===== Validation Functions =====

/**
 * Validate HTML content
 * Basic validation - checks for doctype or html/body tags
 */
export function validateHtmlContent(content: string): { valid: boolean; error?: string } {
  if (!content || typeof content !== "string") {
    return { valid: false, error: "Content is required" };
  }

  const trimmed = content.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: "Content cannot be empty" };
  }

  // Basic HTML validation - look for html structure
  const lowerContent = trimmed.toLowerCase();
  const hasDoctype = lowerContent.startsWith("<!doctype");
  const hasHtmlTag = lowerContent.includes("<html");
  const hasBodyTag = lowerContent.includes("<body");
  const hasAnyHtmlTag = /<[a-z][^>]*>/i.test(trimmed);

  if (!hasDoctype && !hasHtmlTag && !hasBodyTag && !hasAnyHtmlTag) {
    return { valid: false, error: "Content must be valid HTML" };
  }

  return { valid: true };
}

/**
 * Validate artifact name
 */
export function validateArtifactName(name: string): { valid: boolean; error?: string } {
  if (!name || typeof name !== "string") {
    return { valid: false, error: "Name is required" };
  }

  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return { valid: false, error: "Name cannot be empty" };
  }

  if (trimmed.length > 255) {
    return { valid: false, error: "Name must be at most 255 characters" };
  }

  return { valid: true };
}

// ===== Service Class =====

export class ArtifactService {
  private logger = createLogger({ component: "ArtifactService" });

  constructor(
    private artifactRepo: ArtifactRepository,
    private auditRepo: AuditRepository,
    private quotaOverrides?: QuotaOverrides,
    private globalSettingsService?: GlobalSettingsService,
    private userQuotaProvider?: UserQuotaProvider,
  ) {}

  // ===== Quota Configuration =====

  /**
   * Get max file size in bytes (from global settings or hardcoded default)
   */
  private async getMaxFileSize(): Promise<number> {
    if (this.quotaOverrides?.maxSize) {
      return this.quotaOverrides.maxSize;
    }
    if (this.globalSettingsService) {
      const mb = await this.globalSettingsService.getValue<string>(
        GLOBAL_SETTINGS_KEYS.maxFileSizeMb,
      );
      if (mb) {
        return parseInt(mb, 10) * 1024 * 1024; // MB to bytes
      }
    }
    return MAX_ARTIFACT_SIZE;
  }

  /**
   * Get max total storage in bytes for a user
   * Resolution: per-user override → global setting → hardcoded default
   */
  private async getMaxTotalSize(userId: string): Promise<number> {
    if (this.quotaOverrides?.maxTotalSize) {
      return this.quotaOverrides.maxTotalSize;
    }

    // Check per-user override
    if (this.userQuotaProvider) {
      const userQuota = await this.userQuotaProvider.getUserQuota(userId);
      if (userQuota.artifactQuotaMb !== null) {
        return userQuota.artifactQuotaMb * 1024 * 1024; // MB to bytes
      }
    }

    // Check global setting
    if (this.globalSettingsService) {
      const mb = await this.globalSettingsService.getValue<string>(
        GLOBAL_SETTINGS_KEYS.defaultQuotaMb,
      );
      if (mb) {
        return parseInt(mb, 10) * 1024 * 1024;
      }
    }

    return MAX_USER_TOTAL_SIZE;
  }

  /**
   * Get max artifact count for a user
   * Resolution: per-user override → global setting → hardcoded default
   */
  private async getMaxCount(userId: string): Promise<number> {
    if (this.quotaOverrides?.maxCount) {
      return this.quotaOverrides.maxCount;
    }

    // Check per-user override
    if (this.userQuotaProvider) {
      const userQuota = await this.userQuotaProvider.getUserQuota(userId);
      if (userQuota.artifactMaxFiles !== null) {
        return userQuota.artifactMaxFiles;
      }
    }

    // Check global setting
    if (this.globalSettingsService) {
      const count = await this.globalSettingsService.getValue<string>(
        GLOBAL_SETTINGS_KEYS.defaultMaxFiles,
      );
      if (count) {
        return parseInt(count, 10);
      }
    }

    return MAX_ARTIFACTS_PER_USER;
  }

  /**
   * Get default TTL in milliseconds (from global settings or hardcoded default)
   */
  private async getDefaultTtlMs(): Promise<number> {
    if (this.globalSettingsService) {
      const days = await this.globalSettingsService.getValue<string>(
        GLOBAL_SETTINGS_KEYS.defaultTtlDays,
      );
      if (days) {
        return parseInt(days, 10) * 24 * 60 * 60 * 1000; // days to ms
      }
    }
    return DEFAULT_TTL_MS;
  }

  // Legacy getters for backward compatibility (use hardcoded defaults)
  private get maxSize(): number {
    return this.quotaOverrides?.maxSize ?? MAX_ARTIFACT_SIZE;
  }

  private get maxTotalSize(): number {
    return this.quotaOverrides?.maxTotalSize ?? MAX_USER_TOTAL_SIZE;
  }

  private get maxCount(): number {
    return this.quotaOverrides?.maxCount ?? MAX_ARTIFACTS_PER_USER;
  }

  // ===== List Operations =====

  /**
   * List artifacts for a user
   */
  async list(
    userId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<ArtifactListResult> {
    const result = await this.artifactRepo.list({
      userId,
      limit: options?.limit,
      offset: options?.offset,
    });

    // Audit log for list operation
    await this.auditRepo.log({
      userId,
      action: AuditAction.ARTIFACT_LIST,
      resource: "artifact",
      source: getAuditSource(),
      metadata: JSON.stringify({
        limit: options?.limit,
        offset: options?.offset,
        resultCount: result.artifacts.length,
        totalCount: result.total,
      }),
    });

    return result;
  }

  // ===== Get Operations =====

  /**
   * Get artifact by UUID (with ownership check)
   * @throws ArtifactNotFoundError if artifact doesn't exist or user doesn't own it
   */
  async get(userId: string, uuid: string): Promise<Artifact> {
    const artifact = await this.artifactRepo.getByUuid(uuid, userId);
    if (!artifact) {
      throw new ArtifactNotFoundError(uuid);
    }

    // Audit log for get operation
    await this.auditRepo.log({
      userId,
      action: AuditAction.ARTIFACT_GET,
      resource: "artifact",
      resourceId: uuid,
      source: getAuditSource(),
    });

    return artifact;
  }

  /**
   * Get artifact by UUID (returns null if not found)
   */
  async getOrNull(userId: string, uuid: string): Promise<Artifact | null> {
    return await this.artifactRepo.getByUuid(uuid, userId);
  }

  /**
   * Get artifact for public serving (no ownership check)
   * Returns null for expired, deleted, or non-existent artifacts
   */
  async getPublic(uuid: string): Promise<PublicArtifact | null> {
    return await this.artifactRepo.getPublic(uuid);
  }

  // ===== Stats Operations =====

  /**
   * Get user's artifact statistics
   * Uses per-user quotas if available, otherwise global settings
   */
  async getStats(userId: string): Promise<ArtifactStats> {
    const maxTotalSize = await this.getMaxTotalSize(userId);
    const maxCount = await this.getMaxCount(userId);
    const stats = await this.artifactRepo.getStats(userId, maxTotalSize, maxCount);

    // Audit log for stats operation
    await this.auditRepo.log({
      userId,
      action: AuditAction.ARTIFACT_STATS,
      resource: "artifact",
      source: getAuditSource(),
      metadata: JSON.stringify({
        totalArtifacts: stats.totalArtifacts,
        totalSize: stats.totalSize,
      }),
    });

    return stats;
  }

  // ===== Create Operations =====

  /**
   * Create a new artifact with validation and quota enforcement
   * @throws InvalidArtifactContentError if content is not valid HTML
   * @throws ArtifactSizeExceededError if content exceeds size limit
   * @throws ArtifactQuotaExceededError if user quota would be exceeded
   */
  async create(userId: string, options: CreateArtifactOptions): Promise<ArtifactInfo> {
    const { name, content, executionId, ttlMs } = options;

    // Validate name
    const nameValidation = validateArtifactName(name);
    if (!nameValidation.valid) {
      throw new InvalidArtifactContentError(nameValidation.error!);
    }

    // Validate content
    const contentValidation = validateHtmlContent(content);
    if (!contentValidation.valid) {
      throw new InvalidArtifactContentError(contentValidation.error!);
    }

    // Calculate size
    const size = Buffer.byteLength(content, "utf8");

    // Get quotas (async - respects per-user overrides and global settings)
    const maxFileSize = await this.getMaxFileSize();
    const maxTotalSize = await this.getMaxTotalSize(userId);
    const maxCount = await this.getMaxCount(userId);

    // Check per-artifact size limit
    if (size > maxFileSize) {
      throw new ArtifactSizeExceededError(size, maxFileSize);
    }

    // Check storage quota
    const currentTotalSize = await this.artifactRepo.getTotalSize(userId);
    if (currentTotalSize + size > maxTotalSize) {
      throw new ArtifactQuotaExceededError("storage", currentTotalSize, maxTotalSize);
    }

    // Check count quota
    const currentCount = await this.artifactRepo.getCount(userId);
    if (currentCount >= maxCount) {
      throw new ArtifactQuotaExceededError("count", currentCount, maxCount);
    }

    // Get default TTL from settings if not provided
    const effectiveTtlMs = ttlMs ?? (await this.getDefaultTtlMs());

    // Create the artifact
    const artifact = await this.artifactRepo.create({
      userId,
      name: name.trim(),
      content,
      executionId,
      ttlMs: effectiveTtlMs,
    });

    // Audit log
    await this.auditRepo.log({
      userId,
      action: AuditAction.ARTIFACT_CREATE,
      resource: "artifact",
      resourceId: artifact.uuid,
      source: getAuditSource(),
      metadata: JSON.stringify({
        name: artifact.name,
        size: artifact.size,
        executionId: artifact.executionId,
        expiresAt: artifact.expiresAt,
      }),
    });

    this.logger.info("Artifact created", {
      userId,
      uuid: artifact.uuid,
      name: artifact.name,
      size: artifact.size,
    });

    return artifact;
  }

  // ===== Update Operations =====

  /**
   * Update an existing artifact
   * @throws ArtifactNotFoundError if artifact doesn't exist
   * @throws ArtifactAccessDeniedError if user doesn't own the artifact
   * @throws InvalidArtifactContentError if content is not valid HTML
   * @throws ArtifactSizeExceededError if content exceeds size limit
   * @throws ArtifactQuotaExceededError if user quota would be exceeded
   */
  async update(userId: string, uuid: string, options: UpdateArtifactOptions): Promise<void> {
    const { content, name, ttlMs } = options;

    // Check if artifact exists
    const existing = await this.artifactRepo.getByUuid(uuid, userId);
    if (!existing) {
      // Check if it exists but user doesn't own it
      const isOwner = await this.artifactRepo.isOwner(uuid, userId);
      if (!isOwner && (await this.artifactRepo.exists(uuid))) {
        throw new ArtifactAccessDeniedError(uuid, "update");
      }
      throw new ArtifactNotFoundError(uuid);
    }

    // Validate name if provided
    if (name !== undefined) {
      const nameValidation = validateArtifactName(name);
      if (!nameValidation.valid) {
        throw new InvalidArtifactContentError(nameValidation.error!);
      }
    }

    // Validate content
    const contentValidation = validateHtmlContent(content);
    if (!contentValidation.valid) {
      throw new InvalidArtifactContentError(contentValidation.error!);
    }

    // Calculate new size
    const newSize = Buffer.byteLength(content, "utf8");

    // Get quotas (async - respects per-user overrides and global settings)
    const maxFileSize = await this.getMaxFileSize();
    const maxTotalSize = await this.getMaxTotalSize(userId);

    // Check per-artifact size limit
    if (newSize > maxFileSize) {
      throw new ArtifactSizeExceededError(newSize, maxFileSize);
    }

    // Check storage quota (subtract existing size, add new size)
    const currentTotalSize = await this.artifactRepo.getTotalSize(userId);
    const newTotalSize = currentTotalSize - existing.size + newSize;
    if (newTotalSize > maxTotalSize) {
      throw new ArtifactQuotaExceededError(
        "storage",
        currentTotalSize - existing.size,
        maxTotalSize,
      );
    }

    // Update the artifact
    await this.artifactRepo.update(uuid, userId, {
      content,
      name: name?.trim(),
      ttlMs,
    });

    // Audit log
    await this.auditRepo.log({
      userId,
      action: AuditAction.ARTIFACT_UPDATE,
      resource: "artifact",
      resourceId: uuid,
      source: getAuditSource(),
      metadata: JSON.stringify({
        oldSize: existing.size,
        newSize,
        nameChanged: name !== undefined,
        ttlChanged: ttlMs !== undefined,
      }),
      changes: JSON.stringify([
        { field: "content", oldValue: "[content]", newValue: "[content]" },
        { field: "size", oldValue: existing.size, newValue: newSize },
      ]),
    });

    this.logger.info("Artifact updated", {
      userId,
      uuid,
      oldSize: existing.size,
      newSize,
    });
  }

  // ===== Delete Operations =====

  /**
   * Delete an artifact (soft delete)
   * @throws ArtifactNotFoundError if artifact doesn't exist
   * @throws ArtifactAccessDeniedError if user doesn't own the artifact
   */
  async delete(userId: string, uuid: string): Promise<void> {
    // Check ownership first
    const isOwner = await this.artifactRepo.isOwner(uuid, userId);
    if (!isOwner) {
      const exists = await this.artifactRepo.exists(uuid);
      if (exists) {
        throw new ArtifactAccessDeniedError(uuid, "delete");
      }
      throw new ArtifactNotFoundError(uuid);
    }

    const deleted = await this.artifactRepo.softDelete(uuid, userId);
    if (!deleted) {
      throw new ArtifactNotFoundError(uuid);
    }

    await this.auditRepo.log({
      userId,
      action: AuditAction.ARTIFACT_DELETE,
      resource: "artifact",
      resourceId: uuid,
      source: getAuditSource(),
    });

    this.logger.info("Artifact deleted", { userId, uuid });
  }

  // ===== Token Operations =====

  /**
   * Create an upload token for HTTP API
   */
  async createUploadToken(userId: string, ttlMs?: number): Promise<string> {
    const token = await this.artifactRepo.createToken(userId, ttlMs ?? DEFAULT_TOKEN_TTL_MS);

    await this.auditRepo.log({
      userId,
      action: AuditAction.ARTIFACT_TOKEN_CREATE,
      resource: "artifact_token",
      source: getAuditSource(),
      metadata: JSON.stringify({
        tokenPrefix: token.substring(0, 8),
        ttlMs: ttlMs ?? DEFAULT_TOKEN_TTL_MS,
      }),
    });

    return token;
  }

  /**
   * Validate an upload token
   * @throws InvalidArtifactTokenError if token is invalid
   */
  async validateToken(token: string): Promise<{ userId: string }> {
    const tokenData = await this.artifactRepo.validateToken(token);
    if (!tokenData) {
      throw new InvalidArtifactTokenError();
    }
    return { userId: tokenData.userId };
  }

  /**
   * Mark token as used after successful upload
   */
  async markTokenUsed(token: string): Promise<void> {
    await this.artifactRepo.markTokenUsed(token);
  }

  /**
   * Create artifact using a one-time token
   * @throws InvalidArtifactTokenError if token is invalid
   * @throws InvalidArtifactContentError if content is not valid HTML
   * @throws ArtifactSizeExceededError if content exceeds size limit
   * @throws ArtifactQuotaExceededError if user quota would be exceeded
   */
  async createWithToken(token: string, options: CreateArtifactOptions): Promise<ArtifactInfo> {
    // Validate token
    const { userId } = await this.validateToken(token);

    // Create artifact
    const artifact = await this.create(userId, options);

    // Mark token as used
    await this.markTokenUsed(token);

    return artifact;
  }

  // ===== Utility Operations =====

  /**
   * Check if user owns the artifact
   */
  async isOwner(uuid: string, userId: string): Promise<boolean> {
    return await this.artifactRepo.isOwner(uuid, userId);
  }

  /**
   * Get the owner (creator) user id of an artifact, or null if not found.
   * Independent of deleted/expired/taken-down state.
   */
  async getOwnerId(uuid: string): Promise<string | null> {
    return await this.artifactRepo.getOwnerId(uuid);
  }

  /**
   * Check if artifact exists
   */
  async exists(uuid: string): Promise<boolean> {
    return await this.artifactRepo.exists(uuid);
  }

  // ===== Abuse Operations =====

  /**
   * Report an artifact as abusive (any viewer, no ownership required).
   * Increments the report count, records the time, and writes an audit entry.
   * Returns the new report count. Throws ArtifactNotFoundError if the artifact
   * does not exist or is not publicly servable.
   *
   * The reporter is anonymous by default (public viewers may be unauthenticated);
   * pass reporterUserId when the report comes from an authenticated session.
   */
  async report(uuid: string, reporterUserId?: string): Promise<number> {
    const newCount = await this.artifactRepo.recordReport(uuid);
    if (newCount === null) {
      throw new ArtifactNotFoundError(uuid);
    }

    await this.auditRepo.log({
      userId: reporterUserId,
      action: AuditAction.ARTIFACT_REPORT,
      resource: "artifact",
      resourceId: uuid,
      source: getAuditSource(),
      metadata: JSON.stringify({ reportCount: newCount }),
    });

    this.logger.warn("Artifact reported", { uuid, reportCount: newCount, reporterUserId });

    return newCount;
  }

  // ===== Admin Operations =====

  /**
   * Admin: Take down any user's artifact so it stops being served publicly.
   * Records actor, time and reason, and writes an audit entry including the
   * artifact creator. Throws ArtifactNotFoundError if not found.
   */
  async adminTakedown(adminUserId: string, uuid: string, reason: string): Promise<void> {
    const owner = await this.artifactRepo.getOwnerId(uuid);
    if (owner === null) {
      throw new ArtifactNotFoundError(uuid);
    }

    const done = await this.artifactRepo.takedown(uuid, adminUserId, reason);

    await this.auditRepo.log({
      userId: adminUserId,
      action: AuditAction.ADMIN_ARTIFACT_TAKEDOWN,
      resource: "artifact",
      resourceId: uuid,
      source: getAuditSource(),
      metadata: JSON.stringify({ reason, createdBy: owner, alreadyTakenDown: !done }),
    });

    this.logger.warn("Artifact taken down by admin", { adminUserId, uuid, createdBy: owner });
  }

  /**
   * Admin: Take down ALL of a user's artifacts (e.g. abusive account).
   * Returns the number of artifacts taken down and writes an audit entry.
   */
  async adminTakedownAllForUser(
    adminUserId: string,
    targetUserId: string,
    reason: string,
  ): Promise<number> {
    const count = await this.artifactRepo.takedownAllForUser(targetUserId, adminUserId, reason);

    await this.auditRepo.log({
      userId: adminUserId,
      action: AuditAction.ADMIN_ARTIFACT_TAKEDOWN,
      resource: "artifact",
      resourceId: targetUserId,
      source: getAuditSource(),
      metadata: JSON.stringify({ reason, targetUserId, takenDownCount: count, bulk: true }),
    });

    this.logger.warn("All artifacts taken down for user by admin", {
      adminUserId,
      targetUserId,
      count,
    });

    return count;
  }

  /**
   * Admin: List reported artifacts for abuse review.
   */
  async adminListReported(
    adminUserId: string,
    options?: { limit?: number; offset?: number; includeTakenDown?: boolean },
  ): Promise<{ artifacts: ReportedArtifact[]; total: number }> {
    const result = await this.artifactRepo.listReported(options ?? {});

    await this.auditRepo.log({
      userId: adminUserId,
      action: AuditAction.ADMIN_ARTIFACT_LIST_REPORTED,
      resource: "artifact",
      source: getAuditSource(),
      metadata: JSON.stringify({
        resultCount: result.artifacts.length,
        totalCount: result.total,
      }),
    });

    return result;
  }

  /**
   * Admin: Delete any user's artifact
   */
  async adminDelete(adminUserId: string, uuid: string): Promise<void> {
    const exists = await this.artifactRepo.exists(uuid);
    if (!exists) {
      throw new ArtifactNotFoundError(uuid);
    }

    await this.artifactRepo.adminSoftDelete(uuid, adminUserId);

    await this.auditRepo.log({
      userId: adminUserId,
      action: AuditAction.ADMIN_ARTIFACT_DELETE,
      resource: "artifact",
      resourceId: uuid,
      source: getAuditSource(),
    });

    this.logger.info("Artifact deleted by admin", { adminUserId, uuid });
  }

  /**
   * Admin: List all artifacts
   */
  async adminList(
    adminUserId: string,
    options?: {
      userId?: string;
      limit?: number;
      offset?: number;
      includeExpired?: boolean;
      includeDeleted?: boolean;
    },
  ): Promise<{ artifacts: (ArtifactInfo & { userId: string })[]; total: number }> {
    const result = await this.artifactRepo.listAll(options ?? {});

    await this.auditRepo.log({
      userId: adminUserId,
      action: AuditAction.ADMIN_ARTIFACT_LIST,
      resource: "artifact",
      source: getAuditSource(),
      metadata: JSON.stringify({
        filterUserId: options?.userId,
        limit: options?.limit,
        offset: options?.offset,
        resultCount: result.artifacts.length,
        totalCount: result.total,
      }),
    });

    return result;
  }

  /**
   * Admin: Get system-wide statistics
   */
  async adminGetSystemStats(adminUserId: string): Promise<{
    totalArtifacts: number;
    totalSize: number;
    totalUsers: number;
    expiredCount: number;
    deletedCount: number;
  }> {
    const stats = await this.artifactRepo.getSystemStats();

    await this.auditRepo.log({
      userId: adminUserId,
      action: AuditAction.ARTIFACT_STATS,
      resource: "artifact",
      source: getAuditSource(),
      metadata: JSON.stringify({
        systemWide: true,
        ...stats,
      }),
    });

    return stats;
  }

  /**
   * Cleanup expired tokens (for scheduled task)
   */
  async cleanupExpiredTokens(): Promise<number> {
    return await this.artifactRepo.cleanupExpiredTokens();
  }
}
