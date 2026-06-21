/**
 * User Profile Management API Routes
 * Handles profile data, password changes, and email verification
 */

import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth-middleware.js";
import { apiLimiter } from "../middleware/rate-limit-middleware.js";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import {
  getDatabase,
  logAuditEvent,
  AuditAction,
  getBaseUrl,
  getAppPrefix,
  getUserService,
  validateHandle,
  HandleConflictError,
  UserNotFoundError,
} from "@mcp-moira/shared";
import { user, session, oauthAccessToken } from "@mcp-moira/shared";
import { eq, and, ne } from "drizzle-orm";
import { auth } from "../auth.js";
import { toHeaders } from "../utils/headers.js";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";

const router = Router();

// In-memory rate limiting for verification email resend (per user)
const VERIFICATION_COOLDOWN_SECONDS = 60;
const lastVerificationSentMap = new Map<string, number>();

/**
 * Get remaining cooldown seconds for a user
 */
function getVerificationCooldown(userId: string): number {
  const lastSent = lastVerificationSentMap.get(userId);
  if (!lastSent) return 0;

  const elapsed = Math.floor((Date.now() - lastSent) / 1000);
  const remaining = VERIFICATION_COOLDOWN_SECONDS - elapsed;

  // Clean up expired entries
  if (remaining <= 0) {
    lastVerificationSentMap.delete(userId);
    return 0;
  }

  return remaining;
}

/**
 * Record verification email sent time
 */
function recordVerificationSent(userId: string): void {
  lastVerificationSentMap.set(userId, Date.now());
}

// Apply rate limiting and authentication to all routes
router.use(apiLimiter);
router.use(requireAuth);

/**
 * GET /api/user/profile
 * Get current user profile data
 */
router.get(
  "/profile",
  asyncHandler(async (req: Request, res: Response) => {
    const db = getDatabase();
    const userId = (req as AuthenticatedRequest).userId;

    if (!userId) {
      throw createApiError.unauthorized("User ID not found in session");
    }

    // Fetch user data from database
    const userData = await db
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

    if (!userData || userData.length === 0) {
      throw createApiError.notFound("User not found", { userId });
    }

    res.json({
      success: true,
      data: userData[0],
    });
  }),
);

/**
 * PATCH /api/user/profile
 * Update user profile (name only)
 */
router.patch(
  "/profile",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { name } = req.body;

    if (!userId) {
      throw createApiError.unauthorized("User ID not found in session");
    }

    // Validate name
    if (name !== undefined) {
      if (typeof name !== "string") {
        throw createApiError.validationFailed("Name must be a string");
      }
      if (name.length > 100) {
        throw createApiError.validationFailed("Name must be less than 100 characters");
      }
    }

    // Use UserService for profile update with audit
    const userService = getUserService();
    await userService.updateProfile(userId, { name: name || null });

    res.json({
      success: true,
      message: "Profile updated successfully",
    });
  }),
);

/**
 * POST /api/user/change-password
 * Change user password with current password verification
 */
router.post(
  "/change-password",
  asyncHandler(async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;
    const userId = (req as AuthenticatedRequest).userId;

    if (!userId) {
      throw createApiError.unauthorized("User ID not found in session");
    }

    // Validate inputs
    if (!currentPassword || !newPassword) {
      throw createApiError.validationFailed("Current password and new password are required");
    }

    if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
      throw createApiError.validationFailed("Passwords must be strings");
    }

    // Validate new password strength
    if (newPassword.length < 6) {
      throw createApiError.validationFailed("New password must be at least 6 characters");
    }

    if (newPassword.length > 128) {
      throw createApiError.validationFailed("New password must be less than 128 characters");
    }

    if (currentPassword === newPassword) {
      throw createApiError.validationFailed("New password must be different from current password");
    }

    // Use Better Auth API to change password
    // Better Auth handles: current password verification, new password hashing, updating account table
    try {
      await auth.api.changePassword({
        body: {
          currentPassword,
          newPassword,
          revokeOtherSessions: false,
        },
        headers: toHeaders(req.headers),
      });

      // Password changed successfully - now revoke sessions and OAuth tokens
      const db = getDatabase();
      const currentToken = (req as AuthenticatedRequest).session?.token;

      // Revoke all sessions EXCEPT current
      if (currentToken) {
        await db
          .delete(session)
          .where(and(eq(session.userId, userId), ne(session.token, currentToken)));
      } else {
        // If no current token (shouldn't happen), revoke ALL sessions
        await db.delete(session).where(eq(session.userId, userId));
      }

      // Revoke all OAuth access tokens
      await db.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, userId));

      // Audit log entry
      const repository = new DatabaseRepository();
      await logAuditEvent(repository, req, {
        userId,
        action: AuditAction.USER_PASSWORD_CHANGED,
        resource: "user",
        resourceId: userId,
        metadata: {
          sessionsRevoked: true,
          oauthTokensRevoked: true,
        },
      });

      res.json({
        success: true,
        message:
          "Password changed successfully. All other sessions and OAuth tokens have been revoked.",
      });
    } catch (authError) {
      // Better Auth throws errors for invalid current password
      const errorMessage = (authError as Error).message || "Password change failed";

      if (errorMessage.includes("Invalid password") || errorMessage.includes("incorrect")) {
        throw createApiError.validationFailed("Current password is incorrect");
      }

      throw authError;
    }
  }),
);

/**
 * POST /api/user/resend-verification
 * Resend email verification link with rate limiting
 * Returns cooldown seconds if rate limited
 */
router.post(
  "/resend-verification",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const userEmail = (req as AuthenticatedRequest).userEmail;

    if (!userId || !userEmail) {
      throw createApiError.unauthorized("User session not found");
    }

    // Check rate limit
    const cooldown = getVerificationCooldown(userId);
    if (cooldown > 0) {
      throw createApiError.rateLimited("Too many requests", { cooldownSeconds: cooldown });
    }

    // Check if email is already verified
    const db = getDatabase();
    const userData = await db
      .select({ emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);

    if (!userData || userData.length === 0) {
      throw createApiError.notFound("User not found", { userId });
    }

    if (userData[0].emailVerified) {
      throw createApiError.badRequest("Email is already verified");
    }

    // Use Better Auth API to send verification email
    await auth.api.sendVerificationEmail({
      body: {
        email: userEmail,
        callbackURL: `${getBaseUrl()}${getAppPrefix()}/verify-email`,
      },
      headers: toHeaders(req.headers),
    });

    // Record successful send for rate limiting
    recordVerificationSent(userId);

    res.json({
      success: true,
      message: "Verification email sent successfully",
      cooldownSeconds: VERIFICATION_COOLDOWN_SECONDS,
    });
  }),
);

/**
 * GET /api/user/handle
 * Get current user's handle
 */
router.get("/handle", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).userId;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "User ID not found in session",
      });
    }

    const userService = getUserService();
    const handle = await userService.getHandle(userId);

    if (handle === null) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    return res.json({
      success: true,
      data: { handle },
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: "Failed to fetch handle",
    });
  }
});

/**
 * PATCH /api/user/handle
 * Update user handle
 */
router.patch("/handle", async (req: Request, res: Response) => {
  try {
    const userId = (req as AuthenticatedRequest).userId;
    const { handle } = req.body;

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: "User ID not found in session",
      });
    }

    // Validate handle
    if (!handle || typeof handle !== "string") {
      return res.status(400).json({
        success: false,
        error: "Handle is required and must be a string",
      });
    }

    // Validate handle format
    const handleValidation = validateHandle(handle);
    if (!handleValidation.valid) {
      return res.status(400).json({
        success: false,
        error: `Invalid handle: ${handleValidation.error}`,
      });
    }

    // Update handle via service (handles validation and audit automatically)
    const userService = getUserService();
    const success = await userService.updateHandle(userId, handle);

    if (!success) {
      return res.status(500).json({
        success: false,
        error: "Failed to update handle",
      });
    }

    return res.json({
      success: true,
      data: { handle },
      message: "Handle updated successfully",
    });
  } catch (error) {
    if (error instanceof HandleConflictError) {
      return res.status(409).json({
        success: false,
        error: "Handle is already taken",
      });
    }
    if (error instanceof UserNotFoundError) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }
    return res.status(500).json({
      success: false,
      error: "Failed to update handle",
    });
  }
});

export const userProfileRoutes = router;
