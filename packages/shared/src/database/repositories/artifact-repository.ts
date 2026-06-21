/**
 * Artifact Repository - Domain repository for user artifacts
 * Drizzle ORM queries for artifact operations with quota tracking
 *
 * Key concepts:
 * - id: Internal UUID, auto-generated
 * - uuid: Public URL identifier, unique globally
 * - Content stored as TEXT (HTML only in first implementation)
 * - Size tracking for quota enforcement
 * - TTL-based expiration with soft delete
 */

import { eq, and, or, isNull, desc, sql, gt, lte, lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { artifact, artifactToken } from "../schema.js";
import { createLogger } from "../../logging/logger.js";
import type * as schema from "../schema.js";
import { v4 as uuidv4 } from "uuid";
import { executeListQuery, type ListQueryConfig } from "../list-query-builder.js";

const ARTIFACT_LIST_CONFIG: ListQueryConfig<"createdAt" | "updatedAt" | "name" | "size"> = {
  table: artifact,
  sortableColumns: {
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    name: artifact.name,
    size: artifact.size,
  },
  defaultSort: { field: "createdAt", order: "desc" },
  defaultLimit: 50,
  maxLimit: 100,
};

// ===== Constants =====

/** Default TTL in milliseconds (30 days) */
export const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Maximum size per artifact in bytes (5 MB) */
export const MAX_ARTIFACT_SIZE = 5 * 1024 * 1024;

/** Maximum total size per user in bytes (100 MB) */
export const MAX_USER_TOTAL_SIZE = 100 * 1024 * 1024;

/** Maximum number of artifacts per user */
export const MAX_ARTIFACTS_PER_USER = 50;

/** Default token TTL in milliseconds (1 hour) */
export const DEFAULT_TOKEN_TTL_MS = 60 * 60 * 1000;

// ===== Interfaces =====

/**
 * Filter parameters for artifact list queries
 */
export interface ArtifactFilter {
  userId: string;
  search?: string;
  sort?: "createdAt" | "updatedAt" | "name" | "size";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * Artifact info for list display
 */
export interface ArtifactInfo {
  id: string;
  uuid: string;
  name: string;
  size: number;
  mimeType: string;
  executionId: string | null;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Full artifact with content
 */
export interface Artifact extends ArtifactInfo {
  userId: string;
  content: string;
}

/**
 * Public artifact data (for serving, no ownership check)
 */
export interface PublicArtifact {
  uuid: string;
  name: string;
  content: string;
  mimeType: string;
  expiresAt: number;
  updatedAt: number;
}

/**
 * Result of paginated artifact list
 */
export interface ArtifactListResult {
  artifacts: ArtifactInfo[];
  total: number;
}

/**
 * Options for creating an artifact
 */
export interface CreateArtifactOptions {
  userId: string;
  name: string;
  content: string;
  mimeType?: string;
  executionId?: string;
  ttlMs?: number;
}

/**
 * Options for updating an artifact
 */
export interface UpdateArtifactOptions {
  content: string;
  name?: string;
  ttlMs?: number;
}

/**
 * User quota statistics
 */
export interface ArtifactStats {
  totalArtifacts: number;
  totalSize: number;
  storageLimit: number;
  countLimit: number;
  storageUsedPercent: number;
  countUsedPercent: number;
}

/**
 * Reported artifact data for admin abuse review
 */
export interface ReportedArtifact {
  uuid: string;
  userId: string;
  name: string;
  reportCount: number;
  lastReportedAt: number | null;
  takenDown: boolean;
  takenDownAt: number | null;
  takenDownBy: string | null;
  takenDownReason: string | null;
  createdAt: number;
}

/**
 * Artifact token data
 */
export interface ArtifactTokenData {
  token: string;
  userId: string;
  type: string;
  expiresAt: number;
  used: boolean;
  createdAt: number;
}

export class ArtifactRepository {
  private logger = createLogger({ component: "ArtifactRepository" });

  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  // ===== List Operations =====

  /**
   * List artifacts for a user with pagination
   */
  async list(filter: ArtifactFilter): Promise<ArtifactListResult> {
    const { userId, search } = filter;

    this.logger.debug("list() called", { userId, limit: filter.limit, offset: filter.offset });

    // Build conditions - filter by user, exclude deleted, exclude expired
    const now = new Date();
    const conditions = [
      eq(artifact.userId, userId),
      or(eq(artifact.deleted, false), isNull(artifact.deleted)),
      gt(artifact.expiresAt, now),
    ];

    if (search) {
      conditions.push(sql`${artifact.name} LIKE ${"%" + search + "%"}`);
    }

    const artifactSelectColumns = {
      id: artifact.id,
      uuid: artifact.uuid,
      name: artifact.name,
      size: artifact.size,
      mimeType: artifact.mimeType,
      executionId: artifact.executionId,
      expiresAt: artifact.expiresAt,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
    };

    const { rows, total } = await executeListQuery(
      this.db,
      ARTIFACT_LIST_CONFIG,
      filter,
      conditions,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      artifactSelectColumns as any,
    );

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const artifacts: ArtifactInfo[] = rows.map((row: any) => ({
      id: row.id,
      uuid: row.uuid,
      name: row.name,
      size: row.size,
      mimeType: row.mimeType,
      executionId: row.executionId,
      expiresAt: (row.expiresAt as Date).getTime(),
      createdAt: (row.createdAt as Date).getTime(),
      updatedAt: (row.updatedAt as Date).getTime(),
    }));

    this.logger.debug("list() returned", { count: artifacts.length, total });

    return { artifacts, total };
  }

  // ===== Get Operations =====

  /**
   * Get artifact by UUID for a user (ownership check)
   */
  async getByUuid(uuid: string, userId: string): Promise<Artifact | null> {
    const now = new Date();

    const [row] = await this.db
      .select()
      .from(artifact)
      .where(
        and(
          eq(artifact.uuid, uuid),
          eq(artifact.userId, userId),
          or(eq(artifact.deleted, false), isNull(artifact.deleted)),
          gt(artifact.expiresAt, now),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      userId: row.userId,
      uuid: row.uuid,
      name: row.name,
      content: row.content,
      size: row.size,
      mimeType: row.mimeType,
      executionId: row.executionId,
      expiresAt: (row.expiresAt as Date).getTime(),
      createdAt: (row.createdAt as Date).getTime(),
      updatedAt: (row.updatedAt as Date).getTime(),
    };
  }

  /**
   * Get artifact by UUID for public serving (no ownership check)
   * Returns null for expired, deleted, taken-down, or non-existent artifacts
   */
  async getPublic(uuid: string): Promise<PublicArtifact | null> {
    const now = new Date();

    const [row] = await this.db
      .select({
        uuid: artifact.uuid,
        name: artifact.name,
        content: artifact.content,
        mimeType: artifact.mimeType,
        expiresAt: artifact.expiresAt,
        updatedAt: artifact.updatedAt,
      })
      .from(artifact)
      .where(
        and(
          eq(artifact.uuid, uuid),
          or(eq(artifact.deleted, false), isNull(artifact.deleted)),
          eq(artifact.takenDown, false),
          gt(artifact.expiresAt, now),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      uuid: row.uuid,
      name: row.name,
      content: row.content,
      mimeType: row.mimeType,
      expiresAt: (row.expiresAt as Date).getTime(),
      updatedAt: (row.updatedAt as Date).getTime(),
    };
  }

  /**
   * Check if user owns the artifact
   */
  async isOwner(uuid: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: artifact.id })
      .from(artifact)
      .where(and(eq(artifact.uuid, uuid), eq(artifact.userId, userId)))
      .limit(1);

    return !!row;
  }

  /**
   * Get the owner (creator) user id of an artifact by uuid, regardless of
   * deleted/expired/taken-down state. Returns null if the artifact does not
   * exist. Used by admin abuse operations.
   */
  async getOwnerId(uuid: string): Promise<string | null> {
    const [row] = await this.db
      .select({ userId: artifact.userId })
      .from(artifact)
      .where(eq(artifact.uuid, uuid))
      .limit(1);

    return row?.userId ?? null;
  }

  /**
   * Check if artifact exists and is not expired/deleted
   */
  async exists(uuid: string): Promise<boolean> {
    const now = new Date();

    const [row] = await this.db
      .select({ id: artifact.id })
      .from(artifact)
      .where(
        and(
          eq(artifact.uuid, uuid),
          or(eq(artifact.deleted, false), isNull(artifact.deleted)),
          gt(artifact.expiresAt, now),
        ),
      )
      .limit(1);

    return !!row;
  }

  // ===== Stats Operations =====

  /**
   * Get user's artifact statistics
   */
  async getStats(
    userId: string,
    storageLimit: number = MAX_USER_TOTAL_SIZE,
    countLimit: number = MAX_ARTIFACTS_PER_USER,
  ): Promise<ArtifactStats> {
    const now = new Date();

    // Count non-deleted, non-expired artifacts
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(artifact)
      .where(
        and(
          eq(artifact.userId, userId),
          or(eq(artifact.deleted, false), isNull(artifact.deleted)),
          gt(artifact.expiresAt, now),
        ),
      );
    const totalArtifacts = countResult[0]?.count ?? 0;

    // Sum sizes
    const sizeResult = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${artifact.size}), 0)` })
      .from(artifact)
      .where(
        and(
          eq(artifact.userId, userId),
          or(eq(artifact.deleted, false), isNull(artifact.deleted)),
          gt(artifact.expiresAt, now),
        ),
      );
    const totalSize = sizeResult[0]?.total ?? 0;

    return {
      totalArtifacts,
      totalSize,
      storageLimit,
      countLimit,
      storageUsedPercent: Math.round((totalSize / storageLimit) * 1000) / 10,
      countUsedPercent: Math.round((totalArtifacts / countLimit) * 1000) / 10,
    };
  }

  /**
   * Get total size of user's artifacts (for quota checking)
   */
  async getTotalSize(userId: string): Promise<number> {
    const now = new Date();

    const result = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${artifact.size}), 0)` })
      .from(artifact)
      .where(
        and(
          eq(artifact.userId, userId),
          or(eq(artifact.deleted, false), isNull(artifact.deleted)),
          gt(artifact.expiresAt, now),
        ),
      );

    return result[0]?.total ?? 0;
  }

  /**
   * Get count of user's artifacts (for quota checking)
   */
  async getCount(userId: string): Promise<number> {
    const now = new Date();

    const result = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(artifact)
      .where(
        and(
          eq(artifact.userId, userId),
          or(eq(artifact.deleted, false), isNull(artifact.deleted)),
          gt(artifact.expiresAt, now),
        ),
      );

    return result[0]?.count ?? 0;
  }

  // ===== Create Operations =====

  /**
   * Create a new artifact
   * @returns Created artifact info with uuid
   */
  async create(options: CreateArtifactOptions): Promise<ArtifactInfo> {
    const {
      userId,
      name,
      content,
      mimeType = "text/html",
      executionId,
      ttlMs = DEFAULT_TTL_MS,
    } = options;

    const now = new Date();
    const id = uuidv4();
    const uuid = uuidv4();
    const size = Buffer.byteLength(content, "utf8");
    const expiresAt = new Date(now.getTime() + ttlMs);

    this.logger.debug("create() called", { userId, name, size, mimeType, executionId });

    await this.db.insert(artifact).values({
      id,
      userId,
      uuid,
      name,
      content,
      size,
      mimeType,
      executionId: executionId ?? null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    this.logger.debug("create() completed", { id, uuid });

    return {
      id,
      uuid,
      name,
      size,
      mimeType,
      executionId: executionId ?? null,
      expiresAt: expiresAt.getTime(),
      createdAt: now.getTime(),
      updatedAt: now.getTime(),
    };
  }

  // ===== Update Operations =====

  /**
   * Update an existing artifact
   * @returns true if updated, false if not found
   */
  async update(uuid: string, userId: string, options: UpdateArtifactOptions): Promise<boolean> {
    const now = new Date();
    const { content, name, ttlMs } = options;
    const size = Buffer.byteLength(content, "utf8");

    this.logger.debug("update() called", { uuid, userId, size, hasName: !!name, hasTtl: !!ttlMs });

    const updateValues: Record<string, unknown> = {
      content,
      size,
      updatedAt: now,
    };

    if (name !== undefined) {
      updateValues.name = name;
    }

    if (ttlMs !== undefined) {
      updateValues.expiresAt = new Date(now.getTime() + ttlMs);
    }

    const result = await this.db
      .update(artifact)
      .set(updateValues)
      .where(
        and(
          eq(artifact.uuid, uuid),
          eq(artifact.userId, userId),
          or(eq(artifact.deleted, false), isNull(artifact.deleted)),
        ),
      );

    const updated = result.changes > 0;
    this.logger.debug("update() result", { uuid, updated });

    return updated;
  }

  // ===== Delete Operations =====

  /**
   * Soft delete an artifact
   */
  async softDelete(uuid: string, userId: string): Promise<boolean> {
    const now = new Date();

    const result = await this.db
      .update(artifact)
      .set({
        deleted: true,
        deletedAt: now,
        deletedBy: userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(artifact.uuid, uuid),
          eq(artifact.userId, userId),
          or(eq(artifact.deleted, false), isNull(artifact.deleted)),
        ),
      );

    return result.changes > 0;
  }

  /**
   * Hard delete an artifact
   */
  async hardDelete(uuid: string, userId: string): Promise<boolean> {
    const result = await this.db
      .delete(artifact)
      .where(and(eq(artifact.uuid, uuid), eq(artifact.userId, userId)));

    return result.changes > 0;
  }

  /**
   * Admin soft delete - can delete any user's artifact
   */
  async adminSoftDelete(uuid: string, adminUserId: string): Promise<boolean> {
    const now = new Date();

    const result = await this.db
      .update(artifact)
      .set({
        deleted: true,
        deletedAt: now,
        deletedBy: adminUserId,
        updatedAt: now,
      })
      .where(
        and(eq(artifact.uuid, uuid), or(eq(artifact.deleted, false), isNull(artifact.deleted))),
      );

    return result.changes > 0;
  }

  // ===== Abuse Operations =====

  /**
   * Record an abuse report against a public artifact.
   * Increments reportCount and updates lastReportedAt. Works regardless of
   * ownership (reporter is any viewer). Returns the new report count, or null
   * if the artifact does not exist / is not publicly servable.
   */
  async recordReport(uuid: string): Promise<number | null> {
    const now = new Date();

    const result = await this.db
      .update(artifact)
      .set({
        reportCount: sql`${artifact.reportCount} + 1`,
        lastReportedAt: now,
        updatedAt: now,
      })
      .where(
        and(eq(artifact.uuid, uuid), or(eq(artifact.deleted, false), isNull(artifact.deleted))),
      );

    if (result.changes === 0) {
      return null;
    }

    const [row] = await this.db
      .select({ reportCount: artifact.reportCount })
      .from(artifact)
      .where(eq(artifact.uuid, uuid))
      .limit(1);

    return row?.reportCount ?? null;
  }

  /**
   * Admin takedown - mark any user's artifact as taken down so it stops being
   * served publicly. Records who, when and why. Returns false if not found.
   */
  async takedown(uuid: string, adminUserId: string, reason: string): Promise<boolean> {
    const now = new Date();

    const result = await this.db
      .update(artifact)
      .set({
        takenDown: true,
        takenDownAt: now,
        takenDownBy: adminUserId,
        takenDownReason: reason,
        updatedAt: now,
      })
      .where(and(eq(artifact.uuid, uuid), eq(artifact.takenDown, false)));

    return result.changes > 0;
  }

  /**
   * Admin takedown of ALL of a user's artifacts that are not already taken down.
   * Returns the number of artifacts taken down.
   */
  async takedownAllForUser(
    targetUserId: string,
    adminUserId: string,
    reason: string,
  ): Promise<number> {
    const now = new Date();

    const result = await this.db
      .update(artifact)
      .set({
        takenDown: true,
        takenDownAt: now,
        takenDownBy: adminUserId,
        takenDownReason: reason,
        updatedAt: now,
      })
      .where(and(eq(artifact.userId, targetUserId), eq(artifact.takenDown, false)));

    return result.changes;
  }

  /**
   * List reported artifacts (admin) - artifacts with at least one report,
   * ordered by report count then most-recently-reported. Includes owner id,
   * report and takedown state.
   */
  async listReported(options: {
    limit?: number;
    offset?: number;
    includeTakenDown?: boolean;
  }): Promise<{ artifacts: ReportedArtifact[]; total: number }> {
    const { limit = 50, offset = 0, includeTakenDown = true } = options;

    const conditions = [gt(artifact.reportCount, 0)];
    if (!includeTakenDown) {
      conditions.push(eq(artifact.takenDown, false));
    }
    const whereClause = and(...conditions);

    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(artifact)
      .where(whereClause);
    const total = countResult[0]?.count ?? 0;

    const rows = await this.db
      .select({
        uuid: artifact.uuid,
        userId: artifact.userId,
        name: artifact.name,
        reportCount: artifact.reportCount,
        lastReportedAt: artifact.lastReportedAt,
        takenDown: artifact.takenDown,
        takenDownAt: artifact.takenDownAt,
        takenDownBy: artifact.takenDownBy,
        takenDownReason: artifact.takenDownReason,
        createdAt: artifact.createdAt,
      })
      .from(artifact)
      .where(whereClause)
      .orderBy(desc(artifact.reportCount), desc(artifact.lastReportedAt))
      .limit(limit)
      .offset(offset);

    const artifacts: ReportedArtifact[] = rows.map((row) => ({
      uuid: row.uuid,
      userId: row.userId,
      name: row.name,
      reportCount: row.reportCount,
      lastReportedAt: row.lastReportedAt ? (row.lastReportedAt as Date).getTime() : null,
      takenDown: row.takenDown,
      takenDownAt: row.takenDownAt ? (row.takenDownAt as Date).getTime() : null,
      takenDownBy: row.takenDownBy,
      takenDownReason: row.takenDownReason,
      createdAt: (row.createdAt as Date).getTime(),
    }));

    return { artifacts, total };
  }

  // ===== Token Operations =====

  /**
   * Create an upload token
   */
  async createToken(userId: string, ttlMs: number = DEFAULT_TOKEN_TTL_MS): Promise<string> {
    const token = uuidv4();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlMs);

    await this.db.insert(artifactToken).values({
      token,
      userId,
      type: "upload",
      expiresAt,
      used: false,
      createdAt: now,
    });

    this.logger.debug("createToken() completed", { tokenPrefix: token.substring(0, 8), userId });

    return token;
  }

  /**
   * Validate and get token data
   * Returns null if token is invalid, expired, or already used
   */
  async validateToken(token: string): Promise<ArtifactTokenData | null> {
    const now = new Date();

    const [row] = await this.db
      .select()
      .from(artifactToken)
      .where(
        and(
          eq(artifactToken.token, token),
          eq(artifactToken.used, false),
          gt(artifactToken.expiresAt, now),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      token: row.token,
      userId: row.userId,
      type: row.type,
      expiresAt: (row.expiresAt as Date).getTime(),
      used: row.used ?? false,
      createdAt: (row.createdAt as Date).getTime(),
    };
  }

  /**
   * Mark token as used
   */
  async markTokenUsed(token: string): Promise<void> {
    await this.db.update(artifactToken).set({ used: true }).where(eq(artifactToken.token, token));
  }

  /**
   * Delete expired tokens (cleanup)
   */
  async cleanupExpiredTokens(): Promise<number> {
    const now = new Date();

    const result = await this.db.delete(artifactToken).where(lt(artifactToken.expiresAt, now));

    return result.changes;
  }

  // ===== Admin Operations =====

  /**
   * List all artifacts (admin only) with optional user filter
   */
  async listAll(options: {
    userId?: string;
    limit?: number;
    offset?: number;
    includeExpired?: boolean;
    includeDeleted?: boolean;
  }): Promise<{ artifacts: (ArtifactInfo & { userId: string })[]; total: number }> {
    const {
      userId,
      limit = 50,
      offset = 0,
      includeExpired = false,
      includeDeleted = false,
    } = options;

    const conditions = [];
    const now = new Date();

    if (userId) {
      conditions.push(eq(artifact.userId, userId));
    }

    if (!includeDeleted) {
      conditions.push(or(eq(artifact.deleted, false), isNull(artifact.deleted)));
    }

    if (!includeExpired) {
      conditions.push(gt(artifact.expiresAt, now));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Get total count
    const countQuery = this.db.select({ count: sql<number>`count(*)` }).from(artifact);
    if (whereClause) {
      countQuery.where(whereClause);
    }
    const countResult = await countQuery;
    const total = countResult[0]?.count ?? 0;

    // Get paginated results
    const selectQuery = this.db
      .select({
        id: artifact.id,
        userId: artifact.userId,
        uuid: artifact.uuid,
        name: artifact.name,
        size: artifact.size,
        mimeType: artifact.mimeType,
        executionId: artifact.executionId,
        expiresAt: artifact.expiresAt,
        createdAt: artifact.createdAt,
        updatedAt: artifact.updatedAt,
      })
      .from(artifact)
      .orderBy(desc(artifact.createdAt))
      .limit(limit)
      .offset(offset);

    if (whereClause) {
      selectQuery.where(whereClause);
    }

    const rows = await selectQuery;

    const artifacts = rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      uuid: row.uuid,
      name: row.name,
      size: row.size,
      mimeType: row.mimeType,
      executionId: row.executionId,
      expiresAt: (row.expiresAt as Date).getTime(),
      createdAt: (row.createdAt as Date).getTime(),
      updatedAt: (row.updatedAt as Date).getTime(),
    }));

    return { artifacts, total };
  }

  /**
   * Get system-wide statistics (admin only)
   */
  async getSystemStats(): Promise<{
    totalArtifacts: number;
    totalSize: number;
    totalUsers: number;
    expiredCount: number;
    deletedCount: number;
  }> {
    const now = new Date();

    // Total active artifacts
    const activeResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(artifact)
      .where(
        and(or(eq(artifact.deleted, false), isNull(artifact.deleted)), gt(artifact.expiresAt, now)),
      );
    const totalArtifacts = activeResult[0]?.count ?? 0;

    // Total size of active artifacts
    const sizeResult = await this.db
      .select({ total: sql<number>`COALESCE(SUM(${artifact.size}), 0)` })
      .from(artifact)
      .where(
        and(or(eq(artifact.deleted, false), isNull(artifact.deleted)), gt(artifact.expiresAt, now)),
      );
    const totalSize = sizeResult[0]?.total ?? 0;

    // Unique users with artifacts
    const usersResult = await this.db
      .select({ count: sql<number>`count(DISTINCT ${artifact.userId})` })
      .from(artifact)
      .where(
        and(or(eq(artifact.deleted, false), isNull(artifact.deleted)), gt(artifact.expiresAt, now)),
      );
    const totalUsers = usersResult[0]?.count ?? 0;

    // Expired (but not deleted)
    const expiredResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(artifact)
      .where(
        and(
          or(eq(artifact.deleted, false), isNull(artifact.deleted)),
          lte(artifact.expiresAt, now),
        ),
      );
    const expiredCount = expiredResult[0]?.count ?? 0;

    // Deleted
    const deletedResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(artifact)
      .where(eq(artifact.deleted, true));
    const deletedCount = deletedResult[0]?.count ?? 0;

    return {
      totalArtifacts,
      totalSize,
      totalUsers,
      expiredCount,
      deletedCount,
    };
  }
}
