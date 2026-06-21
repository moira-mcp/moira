/**
 * Workflow Sharing Repository - Domain repository for workflow invite links and access
 * Drizzle ORM queries for sharing operations
 *
 * Key concepts:
 * - Invites: One-time tokens with 7-day expiration for sharing workflows
 * - Access: Granted permissions linking users to workflows
 * - Token: 32-character URL-safe cryptographically random string
 * - Permissions: view, start, copy (but not edit)
 */

import * as crypto from "crypto";
import { eq, and, isNull, desc, sql, aliasedTable } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { workflowInvite, workflowAccess, user } from "../schema.js";
import { createLogger } from "../../logging/logger.js";
import type * as schema from "../schema.js";
import { v4 as uuidv4 } from "uuid";

// ===== Constants =====

/** Default invite expiration time in milliseconds (7 days) */
export const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Token length in characters (URL-safe base64) */
export const TOKEN_LENGTH = 32;

// ===== Interfaces =====

/**
 * Invite info for list display
 */
export interface InviteInfo {
  id: string;
  workflowId: string;
  createdBy: string;
  createdByHandle: string | null;
  token: string;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
  usedByHandle: string | null;
  usedByName: string | null;
  createdAt: number;
  /** Time remaining until expiration in milliseconds (null if expired or used) */
  remainingMs: number | null;
}

/**
 * Access info for list display
 */
export interface AccessInfo {
  id: string;
  workflowId: string;
  userId: string;
  userHandle: string;
  userName: string | null;
  userEmail: string;
  grantedBy: string;
  grantedByHandle: string;
  inviteId: string | null;
  grantedAt: number;
}

/**
 * Filter parameters for invite list queries
 */
export interface InviteFilter {
  workflowId: string;
  activeOnly?: boolean; // Only return unused, non-expired invites
  limit?: number;
  offset?: number;
}

/**
 * Filter parameters for access list queries
 */
export interface AccessFilter {
  workflowId: string;
  limit?: number;
  offset?: number;
}

/**
 * Result of paginated invite list
 */
export interface InviteListResult {
  invites: InviteInfo[];
  total: number;
}

/**
 * Result of paginated access list
 */
export interface AccessListResult {
  accesses: AccessInfo[];
  total: number;
}

/**
 * Options for creating an invite
 */
export interface CreateInviteOptions {
  workflowId: string;
  createdBy: string;
  ttlMs?: number;
}

/**
 * Options for accepting an invite
 */
export interface AcceptInviteOptions {
  token: string;
  userId: string;
}

/**
 * Result of accepting an invite
 */
export interface AcceptInviteResult {
  accessId: string;
  workflowId: string;
  inviteId: string;
}

export class WorkflowSharingRepository {
  private logger = createLogger({ component: "WorkflowSharingRepository" });

  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  // ===== Token Generation =====

  /**
   * Generate a cryptographically secure URL-safe token
   */
  private generateToken(): string {
    // Generate random bytes and convert to URL-safe base64
    const bytes = crypto.randomBytes(24); // 24 bytes = 32 chars in base64
    return bytes.toString("base64url").slice(0, TOKEN_LENGTH);
  }

  // ===== Invite Operations =====

  /**
   * Create a new invite for a workflow
   */
  async createInvite(options: CreateInviteOptions): Promise<InviteInfo> {
    const { workflowId, createdBy, ttlMs = DEFAULT_INVITE_TTL_MS } = options;
    const now = Date.now();
    const id = uuidv4();
    const token = this.generateToken();
    const expiresAt = now + ttlMs;

    this.logger.debug("createInvite() called", { workflowId, createdBy, ttlMs });

    await this.db.insert(workflowInvite).values({
      id,
      workflowId,
      createdBy,
      token,
      expiresAt: new Date(expiresAt),
      createdAt: new Date(now),
    });

    // Get creator handle
    const [creatorRow] = await this.db
      .select({ handle: user.handle })
      .from(user)
      .where(eq(user.id, createdBy))
      .limit(1);

    this.logger.debug("createInvite() created", { id, token: token.slice(0, 8) + "..." });

    return {
      id,
      workflowId,
      createdBy,
      createdByHandle: creatorRow?.handle ?? null,
      token,
      expiresAt,
      usedAt: null,
      usedBy: null,
      usedByHandle: null,
      usedByName: null,
      createdAt: now,
      remainingMs: ttlMs,
    };
  }

  /**
   * Get invite by token
   */
  async getInviteByToken(token: string): Promise<InviteInfo | null> {
    // Alias for creator user join
    const creatorUser = aliasedTable(user, "creator");
    const usedByUser = aliasedTable(user, "usedBy");

    const [row] = await this.db
      .select({
        id: workflowInvite.id,
        workflowId: workflowInvite.workflowId,
        createdBy: workflowInvite.createdBy,
        createdByHandle: creatorUser.handle,
        token: workflowInvite.token,
        expiresAt: workflowInvite.expiresAt,
        usedAt: workflowInvite.usedAt,
        usedBy: workflowInvite.usedBy,
        createdAt: workflowInvite.createdAt,
        usedByHandle: usedByUser.handle,
        usedByName: usedByUser.name,
      })
      .from(workflowInvite)
      .leftJoin(creatorUser, eq(workflowInvite.createdBy, creatorUser.id))
      .leftJoin(usedByUser, eq(workflowInvite.usedBy, usedByUser.id))
      .where(eq(workflowInvite.token, token))
      .limit(1);

    if (!row) {
      return null;
    }

    return this.mapInviteRow(row);
  }

  /**
   * Get invite by ID
   */
  async getInviteById(inviteId: string): Promise<InviteInfo | null> {
    const creatorUser = aliasedTable(user, "creator");
    const usedByUser = aliasedTable(user, "usedBy");

    const [row] = await this.db
      .select({
        id: workflowInvite.id,
        workflowId: workflowInvite.workflowId,
        createdBy: workflowInvite.createdBy,
        createdByHandle: creatorUser.handle,
        token: workflowInvite.token,
        expiresAt: workflowInvite.expiresAt,
        usedAt: workflowInvite.usedAt,
        usedBy: workflowInvite.usedBy,
        createdAt: workflowInvite.createdAt,
        usedByHandle: usedByUser.handle,
        usedByName: usedByUser.name,
      })
      .from(workflowInvite)
      .leftJoin(creatorUser, eq(workflowInvite.createdBy, creatorUser.id))
      .leftJoin(usedByUser, eq(workflowInvite.usedBy, usedByUser.id))
      .where(eq(workflowInvite.id, inviteId))
      .limit(1);

    if (!row) {
      return null;
    }

    return this.mapInviteRow(row);
  }

  /**
   * List invites for a workflow
   */
  async listInvites(filter: InviteFilter): Promise<InviteListResult> {
    const { workflowId, activeOnly = false, limit = 50, offset = 0 } = filter;

    this.logger.debug("listInvites() called", { workflowId, activeOnly, limit, offset });

    const now = Date.now();

    // Build conditions
    const conditions = [eq(workflowInvite.workflowId, workflowId)];

    if (activeOnly) {
      // Active = not used AND not expired
      conditions.push(isNull(workflowInvite.usedAt));
      conditions.push(sql`${workflowInvite.expiresAt} > ${now}`);
    }

    // Get total count
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(workflowInvite)
      .where(and(...conditions));
    const total = countResult[0]?.count ?? 0;

    // Get paginated results with creator handle
    const creatorUser = aliasedTable(user, "creator");
    const usedByUser = aliasedTable(user, "usedBy");

    const rows = await this.db
      .select({
        id: workflowInvite.id,
        workflowId: workflowInvite.workflowId,
        createdBy: workflowInvite.createdBy,
        createdByHandle: creatorUser.handle,
        token: workflowInvite.token,
        expiresAt: workflowInvite.expiresAt,
        usedAt: workflowInvite.usedAt,
        usedBy: workflowInvite.usedBy,
        createdAt: workflowInvite.createdAt,
        usedByHandle: usedByUser.handle,
        usedByName: usedByUser.name,
      })
      .from(workflowInvite)
      .leftJoin(creatorUser, eq(workflowInvite.createdBy, creatorUser.id))
      .leftJoin(usedByUser, eq(workflowInvite.usedBy, usedByUser.id))
      .where(and(...conditions))
      .orderBy(desc(workflowInvite.createdAt))
      .limit(limit)
      .offset(offset);

    const invites = rows.map((row) => this.mapInviteRow(row));

    this.logger.debug("listInvites() returned", { count: invites.length, total });

    return { invites, total };
  }

  /**
   * Mark invite as used
   */
  async markInviteUsed(inviteId: string, usedBy: string): Promise<boolean> {
    const now = Date.now();

    const result = await this.db
      .update(workflowInvite)
      .set({
        usedAt: new Date(now),
        usedBy,
      })
      .where(and(eq(workflowInvite.id, inviteId), isNull(workflowInvite.usedAt)));

    return result.changes > 0;
  }

  /**
   * Delete an invite by ID
   */
  async deleteInvite(inviteId: string): Promise<boolean> {
    const result = await this.db.delete(workflowInvite).where(eq(workflowInvite.id, inviteId));

    return result.changes > 0;
  }

  /**
   * Delete all expired invites (cleanup)
   */
  async deleteExpiredInvites(): Promise<number> {
    const now = new Date();

    const result = await this.db
      .delete(workflowInvite)
      .where(sql`${workflowInvite.expiresAt} < ${now.getTime()}`);

    return result.changes;
  }

  // ===== Access Operations =====

  /**
   * Grant access to a user for a workflow
   */
  async grantAccess(
    workflowId: string,
    userId: string,
    grantedBy: string,
    inviteId?: string,
  ): Promise<string> {
    const now = Date.now();
    const id = uuidv4();

    this.logger.debug("grantAccess() called", { workflowId, userId, grantedBy, inviteId });

    await this.db.insert(workflowAccess).values({
      id,
      workflowId,
      userId,
      grantedBy,
      inviteId: inviteId || null,
      grantedAt: new Date(now),
    });

    this.logger.debug("grantAccess() granted", { id });

    return id;
  }

  /**
   * Check if a user has access to a workflow
   */
  async hasAccess(workflowId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: workflowAccess.id })
      .from(workflowAccess)
      .where(and(eq(workflowAccess.workflowId, workflowId), eq(workflowAccess.userId, userId)))
      .limit(1);

    return !!row;
  }

  /**
   * Get access record by workflow and user
   */
  async getAccess(workflowId: string, userId: string): Promise<AccessInfo | null> {
    const [row] = await this.db
      .select({
        id: workflowAccess.id,
        workflowId: workflowAccess.workflowId,
        userId: workflowAccess.userId,
        grantedBy: workflowAccess.grantedBy,
        inviteId: workflowAccess.inviteId,
        grantedAt: workflowAccess.grantedAt,
      })
      .from(workflowAccess)
      .where(and(eq(workflowAccess.workflowId, workflowId), eq(workflowAccess.userId, userId)))
      .limit(1);

    if (!row) {
      return null;
    }

    // Get user info
    const [userRow] = await this.db
      .select({ handle: user.handle, name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, row.userId))
      .limit(1);

    // Get grantor info
    const [grantorRow] = await this.db
      .select({ handle: user.handle })
      .from(user)
      .where(eq(user.id, row.grantedBy))
      .limit(1);

    return {
      id: row.id,
      workflowId: row.workflowId,
      userId: row.userId,
      userHandle: userRow?.handle || "unknown",
      userName: userRow?.name || null,
      userEmail: userRow?.email || "unknown",
      grantedBy: row.grantedBy,
      grantedByHandle: grantorRow?.handle || "unknown",
      inviteId: row.inviteId,
      grantedAt: (row.grantedAt as Date).getTime(),
    };
  }

  /**
   * List users with access to a workflow
   */
  async listAccess(filter: AccessFilter): Promise<AccessListResult> {
    const { workflowId, limit = 50, offset = 0 } = filter;

    this.logger.debug("listAccess() called", { workflowId, limit, offset });

    // Get total count
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(workflowAccess)
      .where(eq(workflowAccess.workflowId, workflowId));
    const total = countResult[0]?.count ?? 0;

    // Get paginated results with user joins
    // Using subqueries for user info since Drizzle doesn't support multiple left joins to same table cleanly
    const rows = await this.db
      .select({
        id: workflowAccess.id,
        workflowId: workflowAccess.workflowId,
        userId: workflowAccess.userId,
        grantedBy: workflowAccess.grantedBy,
        inviteId: workflowAccess.inviteId,
        grantedAt: workflowAccess.grantedAt,
      })
      .from(workflowAccess)
      .where(eq(workflowAccess.workflowId, workflowId))
      .orderBy(desc(workflowAccess.grantedAt))
      .limit(limit)
      .offset(offset);

    // Fetch user info for each access record
    const accesses: AccessInfo[] = [];
    for (const row of rows) {
      const [userRow] = await this.db
        .select({ handle: user.handle, name: user.name, email: user.email })
        .from(user)
        .where(eq(user.id, row.userId))
        .limit(1);

      const [grantorRow] = await this.db
        .select({ handle: user.handle })
        .from(user)
        .where(eq(user.id, row.grantedBy))
        .limit(1);

      accesses.push({
        id: row.id,
        workflowId: row.workflowId,
        userId: row.userId,
        userHandle: userRow?.handle || "unknown",
        userName: userRow?.name || null,
        userEmail: userRow?.email || "unknown",
        grantedBy: row.grantedBy,
        grantedByHandle: grantorRow?.handle || "unknown",
        inviteId: row.inviteId,
        grantedAt: (row.grantedAt as Date).getTime(),
      });
    }

    this.logger.debug("listAccess() returned", { count: accesses.length, total });

    return { accesses, total };
  }

  /**
   * List all workflows a user has access to
   */
  async listUserAccess(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ workflowId: workflowAccess.workflowId })
      .from(workflowAccess)
      .where(eq(workflowAccess.userId, userId));

    return rows.map((r) => r.workflowId);
  }

  /**
   * Revoke access for a user
   */
  async revokeAccess(workflowId: string, userId: string): Promise<boolean> {
    const result = await this.db
      .delete(workflowAccess)
      .where(and(eq(workflowAccess.workflowId, workflowId), eq(workflowAccess.userId, userId)));

    return result.changes > 0;
  }

  /**
   * Revoke all access for a workflow
   */
  async revokeAllAccess(workflowId: string): Promise<number> {
    const result = await this.db
      .delete(workflowAccess)
      .where(eq(workflowAccess.workflowId, workflowId));

    return result.changes;
  }

  // ===== Combined Operations =====

  /**
   * Accept an invite: validate, grant access, mark used
   * Returns null if invite is invalid, expired, or already used
   */
  async acceptInvite(options: AcceptInviteOptions): Promise<AcceptInviteResult | null> {
    const { token, userId } = options;
    const now = Date.now();

    this.logger.debug("acceptInvite() called", { tokenPrefix: token.slice(0, 8), userId });

    // Get invite
    const invite = await this.getInviteByToken(token);
    if (!invite) {
      this.logger.debug("acceptInvite() failed: invite not found");
      return null;
    }

    // Check if already used
    if (invite.usedAt !== null) {
      this.logger.debug("acceptInvite() failed: already used");
      return null;
    }

    // Check if expired
    if (invite.expiresAt < now) {
      this.logger.debug("acceptInvite() failed: expired");
      return null;
    }

    // Check if user already has access
    const existingAccess = await this.hasAccess(invite.workflowId, userId);
    if (existingAccess) {
      this.logger.debug("acceptInvite() failed: user already has access");
      return null;
    }

    // Grant access
    // Grant access - grantedBy is the invite creator (workflow owner)
    const accessId = await this.grantAccess(invite.workflowId, userId, invite.createdBy, invite.id);

    // Mark invite as used
    await this.markInviteUsed(invite.id, userId);

    this.logger.debug("acceptInvite() succeeded", { accessId, inviteId: invite.id });

    return {
      accessId,
      workflowId: invite.workflowId,
      inviteId: invite.id,
    };
  }

  // ===== Helper Methods =====

  private mapInviteRow(row: {
    id: string;
    workflowId: string;
    createdBy: string;
    createdByHandle?: string | null;
    token: string;
    expiresAt: Date | number;
    usedAt: Date | number | null;
    usedBy: string | null;
    createdAt: Date | number;
    usedByHandle: string | null;
    usedByName: string | null;
  }): InviteInfo {
    const now = Date.now();
    const expiresAt =
      row.expiresAt instanceof Date ? row.expiresAt.getTime() : (row.expiresAt as number);
    const usedAt =
      row.usedAt instanceof Date
        ? row.usedAt.getTime()
        : row.usedAt !== null
          ? (row.usedAt as number)
          : null;
    const createdAt =
      row.createdAt instanceof Date ? row.createdAt.getTime() : (row.createdAt as number);

    // Calculate remaining time
    let remainingMs: number | null = null;
    if (usedAt === null && expiresAt > now) {
      remainingMs = expiresAt - now;
    }

    return {
      id: row.id,
      workflowId: row.workflowId,
      createdBy: row.createdBy,
      createdByHandle: row.createdByHandle ?? null,
      token: row.token,
      expiresAt,
      usedAt,
      usedBy: row.usedBy,
      usedByHandle: row.usedByHandle,
      usedByName: row.usedByName,
      createdAt,
      remainingMs,
    };
  }
}
