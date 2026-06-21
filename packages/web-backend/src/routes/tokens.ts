/**
 * User Token API Routes
 * Create, list, and revoke persistent API tokens
 */

import { Router, Request, Response } from "express";
import { eq, and, isNull, count } from "drizzle-orm";
import {
  getDatabase,
  apiToken,
  generateToken,
  hashToken,
  extractTokenPrefix,
  generateTokenId,
  calculateExpiration,
  MAX_TOKENS_PER_USER,
  EXPIRATION_OPTIONS,
  DEFAULT_EXPIRATION,
  logAuditEvent,
  AuditAction,
  createLogger,
  type ExpirationOption,
} from "@mcp-moira/shared";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { requireVerifiedAuth } from "../middleware/auth-middleware.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "TokenRoutes" });
const router = Router();

router.use(requireVerifiedAuth);

/**
 * POST /api/tokens - Create a new API token
 * Returns the full plaintext token ONCE. It cannot be retrieved again.
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { name, expiresIn } = req.body;
    // v1: scopes not supported — all tokens have full MCP access

    // Validate name
    if (!name || typeof name !== "string") {
      throw createApiError.validationFailed("Token name is required");
    }
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > 100) {
      throw createApiError.validationFailed("Token name must be 1-100 characters");
    }

    // Validate expiresIn
    const expirationOption: ExpirationOption = expiresIn || DEFAULT_EXPIRATION;
    if (!(expirationOption in EXPIRATION_OPTIONS)) {
      throw createApiError.validationFailed(
        `Invalid expiresIn: must be one of ${Object.keys(EXPIRATION_OPTIONS).join(", ")}`,
      );
    }

    // Check active token limit
    const db = getDatabase();
    const [{ activeCount }] = await db
      .select({ activeCount: count() })
      .from(apiToken)
      .where(and(eq(apiToken.userId, userId), isNull(apiToken.revokedAt)));

    if (activeCount >= MAX_TOKENS_PER_USER) {
      throw createApiError.validationFailed(
        `Token limit exceeded: maximum ${MAX_TOKENS_PER_USER} active tokens per user`,
      );
    }

    // Generate token
    const plaintext = generateToken();
    const tokenHash = hashToken(plaintext);
    const tokenPrefix = extractTokenPrefix(plaintext);
    const id = generateTokenId();
    const expiresAt = calculateExpiration(expirationOption);
    const now = new Date().toISOString();

    await db.insert(apiToken).values({
      id,
      name: trimmedName,
      tokenPrefix,
      tokenHash,
      userId,
      scopes: null,
      expiresAt,
      createdAt: now,
    });

    const repository = new DatabaseRepository();
    await logAuditEvent(repository, req, {
      userId,
      action: AuditAction.TOKEN_CREATE,
      resource: "apiToken",
      resourceId: id,
      metadata: { name: trimmedName, expiresAt },
    });

    logger.info("Token created", { userId, tokenId: id, name: trimmedName });

    res.status(201).json({
      success: true,
      data: {
        id,
        name: trimmedName,
        token: plaintext,
        tokenPrefix,
        scopes: null,
        expiresAt,
        createdAt: now,
      },
      timestamp: now,
    });
  }),
);

/**
 * GET /api/tokens - List user's tokens
 * Returns metadata only — never includes full token or hash.
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const db = getDatabase();

    const tokens = await db
      .select({
        id: apiToken.id,
        name: apiToken.name,
        tokenPrefix: apiToken.tokenPrefix,
        scopes: apiToken.scopes,
        expiresAt: apiToken.expiresAt,
        lastUsedAt: apiToken.lastUsedAt,
        createdAt: apiToken.createdAt,
        revokedAt: apiToken.revokedAt,
      })
      .from(apiToken)
      .where(eq(apiToken.userId, userId))
      .orderBy(apiToken.createdAt);

    const now = Date.now();
    const enriched = tokens.map((t) => ({
      ...t,
      scopes: t.scopes ? JSON.parse(t.scopes) : null,
      isExpired: t.expiresAt ? new Date(t.expiresAt).getTime() < now : false,
      isRevoked: t.revokedAt !== null,
    }));

    res.json({
      success: true,
      data: {
        tokens: enriched,
        total: enriched.length,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/tokens/:id - Revoke a token (soft delete)
 * Sets revokedAt timestamp. Idempotent — revoking an already-revoked token succeeds.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { id } = req.params;
    const db = getDatabase();

    // Find token owned by this user
    const [token] = await db
      .select({ id: apiToken.id, revokedAt: apiToken.revokedAt })
      .from(apiToken)
      .where(and(eq(apiToken.id, id), eq(apiToken.userId, userId)))
      .limit(1);

    if (!token) {
      throw createApiError.notFound("Token not found");
    }

    const now = new Date().toISOString();

    // Idempotent: only update if not already revoked
    if (!token.revokedAt) {
      await db.update(apiToken).set({ revokedAt: now }).where(eq(apiToken.id, id));

      const repository = new DatabaseRepository();
      await logAuditEvent(repository, req, {
        userId,
        action: AuditAction.TOKEN_REVOKE,
        resource: "apiToken",
        resourceId: id,
      });

      logger.info("Token revoked", { userId, tokenId: id });
    }

    res.json({
      success: true,
      data: {
        id,
        revoked: true,
        revokedAt: token.revokedAt || now,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

export { router as tokenRoutes };
