/**
 * OAuth Consent API Routes
 * Handles consent checking and saving for OAuth flow
 */

import { Router, Request, Response } from "express";
import { oauthConsent, getDatabase } from "@mcp-moira/shared";
import { eq, and } from "drizzle-orm";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { AuthenticatedRequest } from "../types/express-types.js";

const router = Router();

/**
 * GET /api/oauth/consent/check
 * Check if user has already given consent for a client
 */
router.get(
  "/check",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const clientId = req.query.client_id as string;

    if (!userId) {
      throw createApiError.unauthorized("Not authenticated");
    }

    if (!clientId) {
      throw createApiError.validationFailed("client_id is required");
    }

    const db = getDatabase();

    const existingConsent = await db
      .select()
      .from(oauthConsent)
      .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
      .limit(1);

    res.json({
      success: true,
      data: {
        hasConsent: existingConsent.length > 0,
        consentId: existingConsent[0]?.id || null,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

export default router;
