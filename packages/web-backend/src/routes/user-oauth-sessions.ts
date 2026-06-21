/**
 * User OAuth and Sessions Management API Routes
 * Manages user's OAuth consents and active sessions
 *
 * Audit logging is handled automatically via UserService
 */

import { Router } from "express";
import { getUserService } from "@mcp-moira/shared";
import { requireAuth } from "../middleware/auth-middleware.js";
import { apiLimiter } from "../middleware/rate-limit-middleware.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";

const router = Router();

// Get UserService for operations with automatic audit
const userService = getUserService();

// Apply middleware
router.use(apiLimiter);
router.use(requireAuth);

/**
 * GET /api/user/oauth-consents
 * Get paginated list of active OAuth consents with client info
 */
router.get(
  "/oauth-consents",
  asyncHandler(async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { search, sort, sortOrder, limit, offset } = req.query;

    const result = await userService.listOAuthConsentsWithFilters({
      userId,
      search: search as string | undefined,
      sort: (sort as "createdAt") || undefined,
      sortOrder: (sortOrder as "asc" | "desc") || undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });

    res.json({
      success: true,
      data: result.consents.map((consent) => ({
        id: consent.id,
        clientId: consent.clientId,
        clientName: consent.clientName || "Unknown Application",
        clientIcon: consent.clientIcon,
        scopes: consent.scopes ? consent.scopes.split(",") : [],
        createdAt: consent.createdAt,
      })),
      total: result.total,
      limit: limit ? parseInt(limit as string, 10) : 20,
      offset: offset ? parseInt(offset as string, 10) : 0,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/user/oauth-consents/:id
 * Revoke specific OAuth consent (only own consents)
 * Audit logging handled by UserService
 */
router.delete(
  "/oauth-consents/:id",
  asyncHandler(async (req, res) => {
    const userId = (req as unknown as AuthenticatedRequest).userId;
    const consentId = req.params.id;

    // Revoke consent via service (handles audit automatically)
    const result = await userService.revokeOAuthConsent(userId, consentId);

    if (!result.success) {
      throw createApiError.notFound(result.error || "Consent not found", { consentId });
    }

    res.json({
      success: true,
      message: "OAuth consent revoked successfully",
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/user/sessions
 * Get paginated list of active sessions with device info
 */
router.get(
  "/sessions",
  asyncHandler(async (req, res) => {
    const userId = (req as AuthenticatedRequest).userId;
    const currentToken = (req as AuthenticatedRequest).session?.token;
    const { search, sort, sortOrder, limit, offset } = req.query;

    const result = await userService.listSessionsWithFilters({
      userId,
      currentToken,
      search: search as string | undefined,
      sort: (sort as "createdAt" | "expiresAt") || undefined,
      sortOrder: (sortOrder as "asc" | "desc") || undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });

    res.json({
      success: true,
      data: result.sessions.map((s) => ({
        id: s.id,
        ipAddress: s.ipAddress || "Unknown",
        userAgent: s.userAgent || "Unknown Device",
        country: s.country || "Unknown",
        createdAt: s.createdAt,
        expiresAt: s.expiresAt,
        isCurrent: s.isCurrent,
      })),
      total: result.total,
      limit: limit ? parseInt(limit as string, 10) : 20,
      offset: offset ? parseInt(offset as string, 10) : 0,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/user/sessions/:sessionId
 * Revoke specific session (cannot revoke current session)
 * Audit logging handled by UserService
 */
router.delete(
  "/sessions/:sessionId",
  asyncHandler(async (req, res) => {
    const userId = (req as unknown as AuthenticatedRequest).userId;
    const sessionId = req.params.sessionId;
    const currentToken = (req as unknown as AuthenticatedRequest).session?.token;

    // Revoke session via service (handles audit automatically)
    const result = await userService.revokeSession(userId, sessionId, currentToken);

    if (!result.success) {
      if (result.error === "Cannot revoke current session") {
        throw createApiError.badRequest(result.error);
      }
      throw createApiError.notFound(result.error || "Session not found", { sessionId });
    }

    res.json({
      success: true,
      message: "Session revoked successfully",
      timestamp: new Date().toISOString(),
    });
  }),
);

export default router;
