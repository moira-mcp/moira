/**
 * User Info Routes
 * Current user information endpoint
 */

import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { requireAuth } from "../middleware/auth-middleware.js";
import { checkAdminRole } from "../utils/admin-utils.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import { toHeaders } from "../utils/headers.js";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { logAuditEvent, AuditAction } from "@mcp-moira/shared";

const router = Router();

/**
 * GET /api/user/me - Get current user info
 */
router.get(
  "/me",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const userEmail = (req as AuthenticatedRequest).userEmail;

    const { user, getDatabase } = await import("@mcp-moira/shared");
    const { eq } = await import("drizzle-orm");
    const db = getDatabase();

    // Get user data including passwordResetRequired flag
    const [userData] = await db.select().from(user).where(eq(user.id, userId)).limit(1);

    // Check admin status
    const isAdmin = await checkAdminRole(userId);

    res.json({
      success: true,
      data: {
        id: userId,
        email: userEmail,
        handle: userData?.handle || null,
        isAdmin,
        passwordResetRequired: userData?.passwordResetRequired || false,
        blocked: userData?.blocked || false,
        emailVerified: !!userData?.emailVerified,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * POST /api/user/change-password-forced - Change password when forced reset is required
 */
router.post(
  "/change-password-forced",
  requireAuth,
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      throw createApiError.validationFailed("Current password and new password are required");
    }

    const { user, getDatabase, oauthConsent, oauthAccessToken } = await import("@mcp-moira/shared");
    const { eq } = await import("drizzle-orm");
    const { auth } = await import("../auth.js");
    const db = getDatabase();

    // Get user data
    const [userData] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
    if (!userData) {
      throw createApiError.notFound("User not found", { userId });
    }

    // Verify user actually has passwordResetRequired flag
    if (!userData.passwordResetRequired) {
      throw createApiError.badRequest("Password reset not required");
    }

    // Use Better Auth API to change password (handles verification and hashing)
    try {
      await auth.api.changePassword({
        body: {
          currentPassword,
          newPassword,
          revokeOtherSessions: false, // We'll manually revoke everything
        },
        headers: toHeaders(req.headers),
      });
    } catch {
      throw createApiError.unauthorized("Current password is incorrect or password change failed");
    }

    // Clear passwordResetRequired flag
    await db
      .update(user)
      .set({
        passwordResetRequired: false,
        passwordResetRequestedAt: null,
        passwordResetRequestedBy: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(user.id, userId));

    // Revoke all OAuth tokens for security
    await db.delete(oauthConsent).where(eq(oauthConsent.userId, userId));
    await db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));

    // Audit log for forced password change
    const repository = new DatabaseRepository();
    await logAuditEvent(repository, req, {
      userId,
      action: AuditAction.USER_PASSWORD_CHANGED,
      resource: "user",
      resourceId: userId,
      metadata: {
        forced: true,
        oauthTokensRevoked: true,
        passwordResetRequiredCleared: true,
      },
    });

    res.json({
      success: true,
      data: {
        userId,
        passwordChanged: true,
        oauthTokensRevoked: true,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

export { router as userInfoRoutes };
