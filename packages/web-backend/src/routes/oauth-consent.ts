/**
 * OAuth Consent API Routes
 * Handles consent checking and saving for OAuth flow
 */

import { Router, Request, Response } from "express";
import { oauthConsent, getDatabase, AuditAction, logAuditEvent } from "@mcp-moira/shared";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";
import { eq, and } from "drizzle-orm";
import { v4 as uuidv4 } from "uuid";
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
      .where(
        and(
          eq(oauthConsent.userId, userId),
          eq(oauthConsent.clientId, clientId),
          eq(oauthConsent.consentGiven, true),
        ),
      )
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

/**
 * POST /api/oauth/consent
 * Save user consent for a client
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { client_id: clientId, scopes } = req.body;

    if (!userId) {
      throw createApiError.unauthorized("Not authenticated");
    }

    if (!clientId) {
      throw createApiError.validationFailed("client_id is required");
    }

    const db = getDatabase();
    const now = new Date().toISOString();
    const scopesStr = Array.isArray(scopes) ? scopes.join(" ") : scopes || "openid";

    // Check if consent already exists
    const existingConsent = await db
      .select()
      .from(oauthConsent)
      .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
      .limit(1);

    let consentId: string;
    const auditRepo = new DatabaseRepository();

    if (existingConsent.length > 0) {
      // Update existing consent
      consentId = existingConsent[0].id;
      await db
        .update(oauthConsent)
        .set({
          consentGiven: true,
          scopes: scopesStr,
          updatedAt: now,
        })
        .where(eq(oauthConsent.id, consentId));

      await logAuditEvent(auditRepo, req, {
        userId,
        action: AuditAction.OAUTH_CONSENT_UPDATE,
        resource: "oauth_consent",
        resourceId: consentId,
        metadata: { clientId, scopes: scopesStr },
      });
    } else {
      // Create new consent
      consentId = uuidv4();
      await db.insert(oauthConsent).values({
        id: consentId,
        userId,
        clientId,
        scopes: scopesStr,
        consentGiven: true,
        createdAt: now,
        updatedAt: now,
      });

      await logAuditEvent(auditRepo, req, {
        userId,
        action: AuditAction.OAUTH_CONSENT_GRANT,
        resource: "oauth_consent",
        resourceId: consentId,
        metadata: { clientId, scopes: scopesStr },
      });
    }

    res.json({
      success: true,
      data: {
        consentId,
        message: "Consent saved successfully",
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

export default router;
