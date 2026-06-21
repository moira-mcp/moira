/**
 * Admin Token Management Routes
 * List all tokens (with user info), filter, search, paginate, and admin revoke
 */

import { Router, Request, Response } from "express";
import { eq, and, like, or, desc, asc, count, isNull, isNotNull, sql } from "drizzle-orm";
import {
  getDatabase,
  apiToken,
  user,
  logAuditEvent,
  AuditAction,
  createLogger,
} from "@mcp-moira/shared";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { requireAdmin } from "../middleware/admin-middleware.js";
import { DatabaseRepository } from "@mcp-moira/workflow-engine";

const logger = createLogger({ component: "AdminTokenRoutes" });
const router = Router();

router.use(requireAdmin);

type TokenStatus = "active" | "expired" | "revoked";

/**
 * GET /api/admin/tokens - List all tokens with user info
 * Query: userId, status, search, sort, sortOrder, limit, offset
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = req.query.userId as string | undefined;
    const status = req.query.status as TokenStatus | undefined;
    const search = req.query.search as string | undefined;
    const sort = (req.query.sort as string) || "createdAt";
    const sortOrder = (req.query.sortOrder as "asc" | "desc") || "desc";
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

    if (status && !["active", "expired", "revoked"].includes(status)) {
      throw createApiError.validationFailed(
        "Invalid status: must be one of active, expired, revoked",
      );
    }

    const allowedSorts = ["createdAt", "lastUsedAt", "name"];
    if (!allowedSorts.includes(sort)) {
      throw createApiError.validationFailed(
        `Invalid sort: must be one of ${allowedSorts.join(", ")}`,
      );
    }

    const db = getDatabase();
    const now = new Date().toISOString();

    // Build WHERE conditions
    const conditions = [];

    if (userId) {
      conditions.push(eq(apiToken.userId, userId));
    }

    if (status === "revoked") {
      conditions.push(isNotNull(apiToken.revokedAt));
    } else if (status === "active") {
      conditions.push(isNull(apiToken.revokedAt));
      // Not expired: expiresAt is null (never) or in the future
      conditions.push(or(isNull(apiToken.expiresAt), sql`${apiToken.expiresAt} > ${now}`));
    } else if (status === "expired") {
      conditions.push(isNull(apiToken.revokedAt));
      conditions.push(isNotNull(apiToken.expiresAt));
      conditions.push(sql`${apiToken.expiresAt} <= ${now}`);
    }

    if (search) {
      const pattern = `%${search}%`;
      conditions.push(or(like(apiToken.name, pattern), like(user.email, pattern)));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Sort column
    const sortColumn =
      sort === "lastUsedAt"
        ? apiToken.lastUsedAt
        : sort === "name"
          ? apiToken.name
          : apiToken.createdAt;
    const orderFn = sortOrder === "asc" ? asc : desc;

    // Count total
    const [{ total }] = await db
      .select({ total: count() })
      .from(apiToken)
      .leftJoin(user, eq(apiToken.userId, user.id))
      .where(whereClause);

    // Fetch tokens with user info
    const tokens = await db
      .select({
        id: apiToken.id,
        name: apiToken.name,
        tokenPrefix: apiToken.tokenPrefix,
        scopes: apiToken.scopes,
        userId: apiToken.userId,
        userEmail: user.email,
        userName: user.name,
        expiresAt: apiToken.expiresAt,
        lastUsedAt: apiToken.lastUsedAt,
        createdAt: apiToken.createdAt,
        revokedAt: apiToken.revokedAt,
      })
      .from(apiToken)
      .leftJoin(user, eq(apiToken.userId, user.id))
      .where(whereClause)
      .orderBy(orderFn(sortColumn), asc(apiToken.id))
      .limit(limit)
      .offset(offset);

    const nowMs = Date.now();
    const enriched = tokens.map((t) => ({
      ...t,
      scopes: t.scopes ? JSON.parse(t.scopes) : null,
      isExpired: t.expiresAt ? new Date(t.expiresAt).getTime() < nowMs : false,
      isRevoked: t.revokedAt !== null,
    }));

    res.json({
      success: true,
      data: {
        tokens: enriched,
        total,
        limit,
        offset,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * DELETE /api/admin/tokens/:id - Admin revoke any token
 * Soft delete via revokedAt. Idempotent.
 */
router.delete(
  "/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params;
    const db = getDatabase();

    const [token] = await db
      .select({ id: apiToken.id, userId: apiToken.userId, revokedAt: apiToken.revokedAt })
      .from(apiToken)
      .where(eq(apiToken.id, id))
      .limit(1);

    if (!token) {
      throw createApiError.notFound("Token not found");
    }

    const now = new Date().toISOString();

    if (!token.revokedAt) {
      await db.update(apiToken).set({ revokedAt: now }).where(eq(apiToken.id, id));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adminUserId = (req as any).userId || (req as any).user?.userId;

      const repository = new DatabaseRepository();
      await logAuditEvent(repository, req, {
        userId: adminUserId,
        action: AuditAction.ADMIN_TOKEN_REVOKE,
        resource: "apiToken",
        resourceId: id,
        metadata: { tokenOwnerId: token.userId },
      });

      logger.info("Admin revoked token", { adminUserId, tokenId: id, tokenOwnerId: token.userId });
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

export { router as adminTokenRoutes };
