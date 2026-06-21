/**
 * Admin User Security Management Routes
 * Admin-only endpoints for user security actions
 * Force password reset, revoke OAuth tokens, security activity
 */

import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { requireAdmin } from "../middleware/admin-middleware.js";
import {
  logAuditEvent,
  AuditAction,
  getDatabase,
  user,
  oauthAccessToken,
  session,
  oauthConsent,
} from "@mcp-moira/shared";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { eq, and } from "drizzle-orm";

const router = Router();
const repository = new DatabaseRepository();

// All routes protected by requireAdmin middleware
router.use(requireAdmin);

/**
 * POST /api/admin/users/:id/force-password-reset
 * Mark user for forced password reset on next login
 */
router.post(
  "/users/:id/force-password-reset",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const db = getDatabase();

    // Get current admin user ID
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;

    // Get user
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Prevent admin from targeting themselves
    if (id === currentUserId) {
      throw createApiError.badRequest("Cannot force password reset on yourself");
    }

    // Update user to mark password reset required
    await db
      .update(user)
      .set({
        passwordResetRequired: true,
        passwordResetRequestedAt: new Date().toISOString(),
        passwordResetRequestedBy: currentUserId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(user.id, id));

    // Revoke ALL sessions for the user (force logout from all devices)
    const sessionsBeforeRevoke = await db.select().from(session).where(eq(session.userId, id));

    const sessionsCount = sessionsBeforeRevoke.length;

    await db.delete(session).where(eq(session.userId, id));

    // Audit logging
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_FORCE_PASSWORD_RESET,
      resource: "user",
      resourceId: id,
      metadata: {
        targetEmail: userData.email,
        targetUserId: id,
        sessionsRevoked: sessionsCount,
      },
    });

    res.json({
      success: true,
      data: {
        userId: id,
        passwordResetRequired: true,
        requestedAt: new Date().toISOString(),
        requestedBy: currentUserId,
        sessionsRevoked: sessionsCount,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/users/:id/security-activity
 * Get security statistics and activity for user
 */
router.get(
  "/users/:id/security-activity",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const db = getDatabase();

    // Verify user exists
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Get sessions count
    const sessions = await db.select().from(session).where(eq(session.userId, id));

    // Filter active sessions (not expired)
    const now = new Date();
    const activeSessions = sessions.filter((s) => new Date(s.expiresAt) > now);

    // Get OAuth tokens count
    const tokens = await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, id));

    // Filter active tokens (not expired)
    const activeTokens = tokens.filter((t) => new Date(t.accessTokenExpiresAt) > now);

    res.json({
      success: true,
      data: {
        sessionsCount: activeSessions.length,
        oauthTokensCount: activeTokens.length,
        passwordResetRequired: userData.passwordResetRequired || false,
        passwordResetRequestedAt: userData.passwordResetRequestedAt || null,
        passwordResetRequestedBy: userData.passwordResetRequestedBy || null,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/users/:id/sessions
 * List all sessions for user with details
 */
router.get(
  "/users/:id/sessions",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const db = getDatabase();

    // Verify user exists
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Get all sessions for user
    const sessions = await db.select().from(session).where(eq(session.userId, id));

    res.json({
      success: true,
      data: sessions.map((s) => ({
        id: s.id,
        token: s.token,
        ipAddress: s.ipAddress,
        userAgent: s.userAgent,
        country: s.country,
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        updatedAt: s.updatedAt,
      })),
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/admin/users/:id/sessions/:sessionId
 * Revoke individual session
 */
router.delete(
  "/users/:id/sessions/:sessionId",
  asyncHandler(async (req: Request, res: Response) => {
    const { id, sessionId } = req.params;
    const db = getDatabase();

    // Verify user exists
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Verify session exists and belongs to user
    const [sessionData] = await db
      .select()
      .from(session)
      .where(and(eq(session.id, sessionId), eq(session.userId, id)))
      .limit(1);

    if (!sessionData) {
      throw createApiError.notFound(`Session not found: ${sessionId}`, { sessionId });
    }

    // Delete session
    await db.delete(session).where(and(eq(session.id, sessionId), eq(session.userId, id)));

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_REVOKE_SESSION,
      resource: "session",
      resourceId: sessionId,
      metadata: {
        targetEmail: userData.email,
        targetUserId: id,
        sessionId: sessionId,
      },
    });

    res.json({
      success: true,
      data: {
        sessionId: sessionId,
        revoked: true,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/admin/users/:id/sessions
 * Revoke all sessions for user
 */
router.delete(
  "/users/:id/sessions",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const db = getDatabase();

    // Verify user exists
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Get count before deletion
    const sessionsBeforeDelete = await db.select().from(session).where(eq(session.userId, id));
    const oauthTokensBeforeDelete = await db
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.userId, id));
    const oauthConsentsBeforeDelete = await db
      .select()
      .from(oauthConsent)
      .where(eq(oauthConsent.userId, id));

    const sessionsCount = sessionsBeforeDelete.length;
    const oauthTokensCount = oauthTokensBeforeDelete.length;
    const oauthConsentsCount = oauthConsentsBeforeDelete.length;

    // Delete all sessions, OAuth tokens, and OAuth consents
    await db.delete(session).where(eq(session.userId, id));
    await db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, id));
    await db.delete(oauthConsent).where(eq(oauthConsent.userId, id));

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_REVOKE_ALL_SESSIONS,
      resource: "session",
      resourceId: id,
      metadata: {
        targetEmail: userData.email,
        targetUserId: id,
        sessionsRevoked: sessionsCount,
        oauthTokensRevoked: oauthTokensCount,
        oauthConsentsRevoked: oauthConsentsCount,
      },
    });

    res.json({
      success: true,
      data: {
        userId: id,
        sessionsRevoked: sessionsCount,
        oauthTokensRevoked: oauthTokensCount,
        oauthConsentsRevoked: oauthConsentsCount,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/admin/users/:id/oauth-tokens
 * List OAuth tokens by provider with details
 */
router.get(
  "/users/:id/oauth-tokens",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const db = getDatabase();

    // Verify user exists
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Get all OAuth consents for user
    const consents = await db.select().from(oauthConsent).where(eq(oauthConsent.userId, id));

    // Get all OAuth tokens for user
    const tokens = await db.select().from(oauthAccessToken).where(eq(oauthAccessToken.userId, id));

    // Group tokens by clientId
    const tokensByClient: Record<string, typeof tokens> = {};
    tokens.forEach((token) => {
      if (!tokensByClient[token.clientId]) {
        tokensByClient[token.clientId] = [];
      }
      tokensByClient[token.clientId].push(token);
    });

    // Combine consents with tokens
    const oauthData = consents.map((consent) => ({
      consentId: consent.id,
      clientId: consent.clientId,
      scopes: consent.scopes,
      consentGiven: consent.consentGiven,
      createdAt: consent.createdAt,
      updatedAt: consent.updatedAt,
      tokens: tokensByClient[consent.clientId] || [],
    }));

    res.json({
      success: true,
      data: oauthData,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/admin/users/:id/oauth-tokens/:provider
 * Revoke OAuth tokens for specific provider (consent + tokens)
 */
router.delete(
  "/users/:id/oauth-tokens/:provider",
  asyncHandler(async (req: Request, res: Response) => {
    const { id, provider } = req.params;
    const db = getDatabase();

    // Verify user exists
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Find consent by clientId (provider parameter is clientId)
    const [consentData] = await db
      .select()
      .from(oauthConsent)
      .where(and(eq(oauthConsent.userId, id), eq(oauthConsent.clientId, provider)))
      .limit(1);

    if (!consentData) {
      throw createApiError.notFound(`OAuth consent not found for provider: ${provider}`, {
        userId: id,
        provider,
      });
    }

    // Get tokens count before deletion
    const tokensBeforeDelete = await db
      .select()
      .from(oauthAccessToken)
      .where(and(eq(oauthAccessToken.userId, id), eq(oauthAccessToken.clientId, provider)));

    const tokensCount = tokensBeforeDelete.length;

    // Delete consent (will cascade delete tokens if FK configured, otherwise delete manually)
    await db
      .delete(oauthConsent)
      .where(and(eq(oauthConsent.userId, id), eq(oauthConsent.clientId, provider)));

    // Delete associated access tokens
    await db
      .delete(oauthAccessToken)
      .where(and(eq(oauthAccessToken.userId, id), eq(oauthAccessToken.clientId, provider)));

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_REVOKE_OAUTH_PROVIDER,
      resource: "oauthConsent",
      resourceId: consentData.id,
      metadata: {
        targetEmail: userData.email,
        targetUserId: id,
        provider: provider,
        tokensRevoked: tokensCount,
      },
    });

    res.json({
      success: true,
      data: {
        userId: id,
        provider: provider,
        tokensRevoked: tokensCount,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/admin/users/:id/oauth-tokens
 * Revoke all OAuth tokens for user (all consents + tokens)
 */
router.delete(
  "/users/:id/oauth-tokens",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const db = getDatabase();

    // Verify user exists
    const [userData] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!userData) {
      throw createApiError.notFound(`User not found: ${id}`, { userId: id });
    }

    // Get counts before deletion
    const consentsBeforeDelete = await db
      .select()
      .from(oauthConsent)
      .where(eq(oauthConsent.userId, id));

    const tokensBeforeDelete = await db
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.userId, id));

    const consentsCount = consentsBeforeDelete.length;
    const tokensCount = tokensBeforeDelete.length;

    // Delete all consents
    await db.delete(oauthConsent).where(eq(oauthConsent.userId, id));

    // Delete all access tokens
    await db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, id));

    // Audit logging
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentUserId = (req as any).user?.userId;
    await logAuditEvent(repository, req, {
      userId: currentUserId,
      action: AuditAction.ADMIN_REVOKE_ALL_OAUTH,
      resource: "oauthConsent",
      resourceId: id,
      metadata: {
        targetEmail: userData.email,
        targetUserId: id,
        consentsRevoked: consentsCount,
        tokensRevoked: tokensCount,
      },
    });

    res.json({
      success: true,
      data: {
        userId: id,
        consentsRevoked: consentsCount,
        tokensRevoked: tokensCount,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

// NOTE: block/unblock endpoints are defined in admin.ts
// They were previously duplicated here but have been removed to avoid conflicts

export default router;
