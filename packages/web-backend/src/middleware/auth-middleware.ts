/**
 * Authentication middleware for Web Backend API routes
 * Validates Better Auth session and attaches userId to request
 */

import { Request, Response, NextFunction } from "express";
import { auth } from "../auth.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import { toHeaders } from "../utils/headers.js";
import { getDatabase, user, session as sessionTable, getFeatureResolver } from "@mcp-moira/shared";
import { eq } from "drizzle-orm";

interface AuthOptions {
  requireEmailVerified?: boolean;
}

/**
 * Core auth validation logic - checks session, blocked status, and email verification
 */
async function validateAuth(
  req: Request,
  res: Response,
  options: AuthOptions = {},
): Promise<boolean> {
  const { requireEmailVerified = false } = options;

  const session = await auth.api.getSession({
    headers: toHeaders(req.headers),
  });

  if (!session || !session.user) {
    res.status(401).json({
      success: false,
      error: {
        message: "Unauthorized - authentication required",
        code: "AUTHENTICATION_REQUIRED",
      },
    });
    return false;
  }

  // Check user status in database (blocked, emailVerified)
  const db = getDatabase();
  const [userData] = await db.select().from(user).where(eq(user.id, session.user.id)).limit(1);

  if (userData?.blocked) {
    // Invalidate current session
    if (session.session?.token) {
      await db.delete(sessionTable).where(eq(sessionTable.token, session.session.token));
    }

    res.status(403).json({
      success: false,
      error: {
        message: "Account is blocked",
        code: "ACCOUNT_BLOCKED",
      },
    });
    return false;
  }

  // Check email verification if required AND the gate is enabled for this mode.
  // In self-host the email-verification gate is off, so token/MCP endpoints work
  // without a verified email (no mail server assumed).
  if (
    requireEmailVerified &&
    !userData?.emailVerified &&
    getFeatureResolver().isEnabled("emailVerificationGate")
  ) {
    res.status(403).json({
      success: false,
      error: {
        message: "Email verification required",
        code: "EMAIL_NOT_VERIFIED",
      },
    });
    return false;
  }

  // Attach userId to request for downstream use
  (req as AuthenticatedRequest).userId = session.user.id;
  (req as AuthenticatedRequest).userEmail = session.user.email;
  (req as AuthenticatedRequest).emailVerified = !!userData?.emailVerified;
  (req as AuthenticatedRequest).userInfo = {
    isAdmin: !!userData?.isAdmin,
  };

  // Attach session token for current session detection
  if (session.session && session.session.token) {
    (req as AuthenticatedRequest).session = {
      token: session.session.token,
    };
  }

  return true;
}

/**
 * Basic auth - requires valid session, checks blocked status
 * Does NOT require email verification
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const isValid = await validateAuth(req, res, { requireEmailVerified: false });
    if (isValid) {
      next();
    }
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: {
        message: "Authentication validation failed",
        code: "AUTHENTICATION_FAILED",
      },
    });
  }
}

/**
 * Strict auth - requires valid session AND verified email
 * Use for sensitive operations like OAuth consent, MCP access
 */
export async function requireVerifiedAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const isValid = await validateAuth(req, res, { requireEmailVerified: true });
    if (isValid) {
      next();
    }
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: {
        message: "Authentication validation failed",
        code: "AUTHENTICATION_FAILED",
      },
    });
  }
}

/**
 * Optional auth - populates userId if authenticated, but doesn't reject unauthenticated requests
 * Use for routes that need to work both with and without auth (e.g., public invite info)
 */
export async function optionalAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const session = await auth.api.getSession({
      headers: toHeaders(req.headers),
    });

    if (session && session.user) {
      // Check user status in database (blocked)
      const db = getDatabase();
      const [userData] = await db.select().from(user).where(eq(user.id, session.user.id)).limit(1);

      // If user is blocked, treat as unauthenticated (don't populate userId)
      if (!userData?.blocked) {
        (req as AuthenticatedRequest).userId = session.user.id;
        (req as AuthenticatedRequest).userEmail = session.user.email;
        (req as AuthenticatedRequest).emailVerified = !!userData?.emailVerified;

        if (session.session && session.session.token) {
          (req as AuthenticatedRequest).session = {
            token: session.session.token,
          };
        }
      }
    }

    // Always continue to next middleware, regardless of auth status
    next();
  } catch {
    // On error, continue without auth
    next();
  }
}
