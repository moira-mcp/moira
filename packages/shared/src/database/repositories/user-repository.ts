/**
 * User Repository - Domain repository for user operations
 * Drizzle ORM queries for user, session, and OAuth operations
 *
 * Key concepts:
 * - handle: Globally unique user identifier (4-40 chars, alphanumeric + hyphen)
 * - User lookup: by ID or by handle
 */

import { eq, and, ne, like, or, sql, gt, asc, desc } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  user,
  session,
  oauthConsent,
  oauthAccessToken,
  oauthApplication,
  workflow,
} from "../schema.js";
import type * as schema from "../schema.js";
import { validateHandle, normalizeHandle } from "../../validation/slug-handle.js";
import { executeListQuery, type ListQueryConfig } from "../list-query-builder.js";

const USER_LIST_CONFIG: ListQueryConfig<"email" | "name" | "createdAt"> = {
  table: user,
  sortableColumns: {
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
  },
  defaultSort: { field: "createdAt", order: "desc" },
  defaultLimit: 20,
  maxLimit: 100,
};

/**
 * User profile with handle
 */
export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  handle: string;
  emailVerified: boolean;
  createdAt: string;
  image: string | null;
}

export interface UserSession {
  id: string;
  token: string;
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface OAuthConsentInfo {
  id: string;
  clientId: string;
  scopes: string | null;
  createdAt: string;
  clientName?: string | null;
  clientIcon?: string | null;
}

/**
 * Filter options for listing sessions with pagination
 */
export interface SessionFilter {
  userId: string;
  currentToken?: string;
  search?: string;
  sort?: "createdAt" | "expiresAt";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

/**
 * Filter options for listing OAuth consents with pagination
 */
export interface OAuthConsentFilter {
  userId: string;
  search?: string;
  sort?: "createdAt";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface SessionListResult {
  sessions: Array<UserSession & { isCurrent: boolean }>;
  total: number;
}

export interface OAuthConsentListResult {
  consents: OAuthConsentInfo[];
  total: number;
}

/**
 * Minimal user info for lookups
 */
export interface UserInfo {
  id: string;
  handle: string;
  name: string | null;
}

export class UserRepository {
  constructor(private db: BetterSQLite3Database<typeof schema>) {}

  // ===== Handle Operations =====

  /**
   * Resolve a handle to user ID
   * @param handle - User handle
   * @returns User ID or null if not found
   */
  async resolveHandle(handle: string): Promise<string | null> {
    const normalizedHandle = normalizeHandle(handle);

    const [row] = await this.db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.handle, normalizedHandle))
      .limit(1);

    return row?.id ?? null;
  }

  /**
   * Get user by handle
   * @param handle - User handle
   * @returns User info or null if not found
   */
  async getByHandle(handle: string): Promise<UserInfo | null> {
    const normalizedHandle = normalizeHandle(handle);

    const [row] = await this.db
      .select({
        id: user.id,
        handle: user.handle,
        name: user.name,
      })
      .from(user)
      .where(eq(user.handle, normalizedHandle))
      .limit(1);

    return row ?? null;
  }

  /**
   * Check if a handle is already taken
   * @param handle - Handle to check
   * @param excludeUserId - Optional user ID to exclude (for update checks)
   * @returns true if handle exists
   */
  async handleExists(handle: string, excludeUserId?: string): Promise<boolean> {
    const normalizedHandle = normalizeHandle(handle);

    const conditions = [eq(user.handle, normalizedHandle)];
    if (excludeUserId) {
      conditions.push(ne(user.id, excludeUserId));
    }

    const [row] = await this.db
      .select({ id: user.id })
      .from(user)
      .where(and(...conditions))
      .limit(1);

    return !!row;
  }

  /**
   * Update user handle
   * @param userId - User ID
   * @param newHandle - New handle value
   * @returns true if update succeeded
   * @throws Error if handle is invalid or already taken
   */
  async updateHandle(userId: string, newHandle: string): Promise<boolean> {
    const validation = validateHandle(newHandle);
    if (!validation.valid) {
      throw new Error(`Invalid handle: ${validation.error}`);
    }

    const normalizedHandle = normalizeHandle(newHandle);

    // Check if handle is already taken by another user
    const exists = await this.handleExists(normalizedHandle, userId);
    if (exists) {
      throw new Error(`Handle '${normalizedHandle}' is already taken`);
    }

    const result = await this.db
      .update(user)
      .set({
        handle: normalizedHandle,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(user.id, userId));

    return result.changes > 0;
  }

  /**
   * Get user's current handle
   * @param userId - User ID
   * @returns Handle or null if user not found
   */
  async getHandle(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ handle: user.handle })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    return row?.handle ?? null;
  }

  // ===== Profile Operations =====

  /**
   * Get user profile by ID (now includes handle)
   */
  async getProfile(userId: string): Promise<UserProfile | null> {
    const [userData] = await this.db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        handle: user.handle,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
        image: user.image,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    return (userData as UserProfile | undefined) ?? null;
  }

  /**
   * Update user profile
   */
  async updateProfile(userId: string, updates: { name?: string | null }): Promise<void> {
    await this.db
      .update(user)
      .set({
        ...updates,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(user.id, userId));
  }

  // ===== Session Operations =====

  /**
   * Get all sessions for user
   */
  async getSessions(userId: string): Promise<UserSession[]> {
    return await this.db
      .select({
        id: session.id,
        token: session.token,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        country: session.country,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      })
      .from(session)
      .where(eq(session.userId, userId));
  }

  /**
   * Get session by ID (for ownership verification)
   */
  async getSessionById(sessionId: string, userId: string): Promise<UserSession | null> {
    const [result] = await this.db
      .select({
        id: session.id,
        token: session.token,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        country: session.country,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      })
      .from(session)
      .where(and(eq(session.id, sessionId), eq(session.userId, userId)))
      .limit(1);

    return result ?? null;
  }

  /**
   * Delete session by ID
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.db.delete(session).where(eq(session.id, sessionId));
  }

  /**
   * Delete all sessions for user except current
   */
  async deleteAllSessionsExcept(userId: string, excludeToken?: string): Promise<number> {
    // Count sessions to delete
    const sessionsToDelete = await this.db
      .select({ id: session.id })
      .from(session)
      .where(
        excludeToken
          ? and(eq(session.userId, userId), ne(session.token, excludeToken))
          : eq(session.userId, userId),
      );

    const count = sessionsToDelete.length;

    // Delete sessions
    if (excludeToken) {
      await this.db
        .delete(session)
        .where(and(eq(session.userId, userId), ne(session.token, excludeToken)));
    } else {
      await this.db.delete(session).where(eq(session.userId, userId));
    }

    return count;
  }

  /**
   * List sessions with filters, sorting, and server-side pagination.
   * Filters out expired sessions and tags the current one.
   */
  async listSessionsWithFilters(filter: SessionFilter): Promise<SessionListResult> {
    const now = new Date().toISOString();
    const conditions = [eq(session.userId, filter.userId), gt(session.expiresAt, now)];

    if (filter.search) {
      conditions.push(
        or(
          like(session.userAgent, `%${filter.search}%`),
          like(session.ipAddress, `%${filter.search}%`),
          like(session.country, `%${filter.search}%`),
        )!,
      );
    }

    const whereClause = and(...conditions);

    // COUNT
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(session)
      .where(whereClause);
    const total = countResult[0]?.count ?? 0;

    // SORT
    const sortField = filter.sort === "expiresAt" ? session.expiresAt : session.createdAt;
    const orderFn = (filter.sortOrder ?? "desc") === "asc" ? asc : desc;

    // PAGINATION
    const limit = Math.min(Math.max(1, filter.limit ?? 20), 100);
    const offset = Math.max(0, filter.offset ?? 0);

    const rows = await this.db
      .select({
        id: session.id,
        token: session.token,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        country: session.country,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
      })
      .from(session)
      .where(whereClause)
      .orderBy(orderFn(sortField))
      .limit(limit)
      .offset(offset);

    const sessions = rows.map((s) => ({
      ...s,
      isCurrent: filter.currentToken ? s.token === filter.currentToken : false,
    }));

    return { sessions, total };
  }

  // ===== OAuth Operations =====

  /**
   * Get OAuth consents for user with client application info
   */
  async getOAuthConsents(userId: string): Promise<OAuthConsentInfo[]> {
    return await this.db
      .select({
        id: oauthConsent.id,
        clientId: oauthConsent.clientId,
        scopes: oauthConsent.scopes,
        createdAt: oauthConsent.createdAt,
        clientName: oauthApplication.name,
        clientIcon: oauthApplication.icon,
      })
      .from(oauthConsent)
      .leftJoin(oauthApplication, eq(oauthConsent.clientId, oauthApplication.clientId))
      .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.consentGiven, true)));
  }

  /**
   * List OAuth consents with filters, sorting, and server-side pagination.
   * Joins with oauthApplication for client name/icon.
   */
  async listOAuthConsentsWithFilters(filter: OAuthConsentFilter): Promise<OAuthConsentListResult> {
    const baseConditions = [
      eq(oauthConsent.userId, filter.userId),
      eq(oauthConsent.consentGiven, true),
    ];

    if (filter.search) {
      baseConditions.push(
        or(
          like(oauthApplication.name, `%${filter.search}%`),
          like(oauthConsent.clientId, `%${filter.search}%`),
        )!,
      );
    }

    const whereClause = and(...baseConditions);

    // COUNT with JOIN
    const countResult = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(oauthConsent)
      .leftJoin(oauthApplication, eq(oauthConsent.clientId, oauthApplication.clientId))
      .where(whereClause);
    const total = countResult[0]?.count ?? 0;

    // SORT
    const orderFn = (filter.sortOrder ?? "desc") === "asc" ? asc : desc;

    // PAGINATION
    const limit = Math.min(Math.max(1, filter.limit ?? 20), 100);
    const offset = Math.max(0, filter.offset ?? 0);

    const rows = await this.db
      .select({
        id: oauthConsent.id,
        clientId: oauthConsent.clientId,
        scopes: oauthConsent.scopes,
        createdAt: oauthConsent.createdAt,
        clientName: oauthApplication.name,
        clientIcon: oauthApplication.icon,
      })
      .from(oauthConsent)
      .leftJoin(oauthApplication, eq(oauthConsent.clientId, oauthApplication.clientId))
      .where(whereClause)
      .orderBy(orderFn(oauthConsent.createdAt))
      .limit(limit)
      .offset(offset);

    return { consents: rows, total };
  }

  /**
   * Get OAuth consent by ID (for ownership verification)
   */
  async getOAuthConsentById(consentId: string, userId: string): Promise<OAuthConsentInfo | null> {
    const [result] = await this.db
      .select({
        id: oauthConsent.id,
        clientId: oauthConsent.clientId,
        scopes: oauthConsent.scopes,
        createdAt: oauthConsent.createdAt,
      })
      .from(oauthConsent)
      .where(and(eq(oauthConsent.id, consentId), eq(oauthConsent.userId, userId)))
      .limit(1);

    return result ?? null;
  }

  /**
   * Delete OAuth consent by ID
   */
  async deleteOAuthConsent(consentId: string): Promise<void> {
    await this.db.delete(oauthConsent).where(eq(oauthConsent.id, consentId));
  }

  /**
   * Delete OAuth access tokens for user and client
   */
  async deleteOAuthTokensForClient(userId: string, clientId: string): Promise<void> {
    await this.db
      .delete(oauthAccessToken)
      .where(and(eq(oauthAccessToken.userId, userId), eq(oauthAccessToken.clientId, clientId)));
  }

  /**
   * Delete all OAuth access tokens for user
   */
  async deleteAllOAuthTokens(userId: string): Promise<number> {
    const tokensToDelete = await this.db
      .select({ id: oauthAccessToken.id })
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.userId, userId));

    const count = tokensToDelete.length;

    await this.db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));

    return count;
  }

  // ===== Artifact Quota Operations =====

  /**
   * Get user's artifact quota overrides
   * Returns null values for fields that should use global defaults
   */
  async getArtifactQuota(
    userId: string,
  ): Promise<{ artifactQuotaMb: number | null; artifactMaxFiles: number | null }> {
    const [row] = await this.db
      .select({
        artifactQuotaMb: user.artifactQuotaMb,
        artifactMaxFiles: user.artifactMaxFiles,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    return {
      artifactQuotaMb: row?.artifactQuotaMb ?? null,
      artifactMaxFiles: row?.artifactMaxFiles ?? null,
    };
  }

  /**
   * Update user's artifact quota overrides
   * Pass null to reset to global default
   */
  async updateArtifactQuota(
    userId: string,
    quotaMb: number | null,
    maxFiles: number | null,
  ): Promise<boolean> {
    const result = await this.db
      .update(user)
      .set({
        artifactQuotaMb: quotaMb,
        artifactMaxFiles: maxFiles,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(user.id, userId));

    return result.changes > 0;
  }

  // ===== Admin List Operations =====

  /**
   * List users with server-side search, sort, and pagination.
   * Includes workflow count per user via subquery.
   */
  async listAdmin(filter: {
    search?: string;
    sort?: "email" | "name" | "createdAt";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<{
    users: Array<{
      id: string;
      email: string;
      name: string | null;
      isAdmin: boolean;
      emailVerified: boolean;
      blocked: boolean;
      createdAt: string;
      workflowsCount: number;
    }>;
    total: number;
  }> {
    const conditions = [];

    if (filter.search) {
      const pattern = `%${filter.search}%`;
      conditions.push(or(like(user.email, pattern), like(user.name, pattern)));
    }

    const { rows, total } = await executeListQuery(
      this.db,
      USER_LIST_CONFIG,
      {
        sort: filter.sort,
        sortOrder: filter.sortOrder,
        limit: filter.limit,
        offset: filter.offset,
      },
      conditions,
      {
        id: user.id,
        email: user.email,
        name: user.name,
        isAdmin: user.isAdmin,
        emailVerified: user.emailVerified,
        blocked: user.blocked,
        createdAt: user.createdAt,
      },
    );

    // Get workflow counts for these users in a single query
    const userIds = rows.map((r: { id: string }) => r.id);
    let workflowCounts: Record<string, number> = {};
    if (userIds.length > 0) {
      const countRows = await this.db
        .select({
          userId: workflow.userId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          count: sql<number>`count(*)` as any,
        })
        .from(workflow)
        .where(
          and(
            sql`${workflow.userId} IN (${sql.join(
              userIds.map((id: string) => sql`${id}`),
              sql`, `,
            )})`,
            eq(workflow.deleted, false),
          ),
        )
        .groupBy(workflow.userId);

      workflowCounts = Object.fromEntries(countRows.map((r) => [r.userId, r.count]));
    }

    return {
      users: rows.map((r: Record<string, unknown>) => ({
        id: r.id as string,
        email: r.email as string,
        name: r.name as string | null,
        isAdmin: r.isAdmin as boolean,
        emailVerified: r.emailVerified as boolean,
        blocked: r.blocked as boolean,
        createdAt: r.createdAt as string,
        workflowsCount: workflowCounts[r.id as string] || 0,
      })),
      total,
    };
  }

  /**
   * Return the user IDs of all administrators (isAdmin = true), excluding blocked
   * accounts. Used to fan out admin notifications (e.g. abuse reports).
   */
  async getAdminUserIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.isAdmin, true), eq(user.blocked, false)));
    return rows.map((r) => r.id);
  }
}
