/**
 * Workflow Sharing Routes
 * REST API endpoints for workflow invite links and shared access management
 *
 * Routes (UUID format):
 * - POST   /api/workflows/:id/invites         - Create invite link
 * - GET    /api/workflows/:id/invites         - List active invites
 * - DELETE /api/workflows/:id/invites/:inviteId - Revoke invite
 * - GET    /api/workflows/:id/access          - List users with access
 * - DELETE /api/workflows/:id/access/:userId  - Revoke user access
 *
 * Routes (handle/slug format):
 * - POST   /api/workflows/:handle/:slug/invites         - Create invite link
 * - GET    /api/workflows/:handle/:slug/invites         - List active invites
 * - DELETE /api/workflows/:handle/:slug/invites/:inviteId - Revoke invite
 * - GET    /api/workflows/:handle/:slug/access          - List users with access
 * - DELETE /api/workflows/:handle/:slug/access/:userId  - Revoke user access
 */

import { Router, Request, Response } from "express";
// z import removed - not needed for simple validators
import { AuthenticatedRequest } from "../types/index.js";
import { asyncHandler, validateParams, paramValidators } from "../middleware/error-middleware.js";
import {
  getWorkflowSharingService,
  getWorkflowService,
  WorkflowNotFoundError,
  WorkflowAccessDeniedError,
  InviteNotFoundError,
  InviteExpiredError,
  InviteAlreadyUsedError,
  SelfInviteError,
  AccessAlreadyExistsError,
  AccessNotFoundError,
} from "@mcp-moira/shared";

const router = Router();

// UUID validator for invite IDs
const uuidValidator = (value: string): boolean => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
};

// User ID validator (Better Auth IDs are alphanumeric, not UUID)
const userIdValidator = paramValidators.userId;

// ===== Handle/slug routes (must be BEFORE :id routes to match first) =====

/**
 * POST /api/workflows/:handle/:slug/invites - Create invite link by handle/slug
 */
router.post(
  "/:handle/:slug/invites",
  validateParams({ handle: paramValidators.handle, slug: paramValidators.slug }),
  asyncHandler(async (req: Request, res: Response) => {
    const workflowRef = `${req.params.handle}/${req.params.slug}`;
    const userId = (req as AuthenticatedRequest).userId;
    const { ttlMs } = req.body || {};

    const sharingService = getWorkflowSharingService();

    try {
      const resolvedId = await resolveWorkflowId(workflowRef, userId);
      if (!resolvedId) {
        throw new WorkflowNotFoundError(workflowRef, "reference");
      }

      const result = await sharingService.createInvite({
        workflowId: resolvedId,
        userId,
        ttlMs,
      });

      res.status(201).json({
        success: true,
        data: {
          invite: {
            id: result.invite.id,
            token: result.invite.token,
            expiresAt: result.invite.expiresAt,
            remainingMs: result.invite.remainingMs,
          },
          inviteUrl: result.inviteUrl,
        },
      });
    } catch (error) {
      handleSharingError(error, res);
    }
  }),
);

/**
 * GET /api/workflows/:handle/:slug/invites - List invites by handle/slug
 */
router.get(
  "/:handle/:slug/invites",
  validateParams({ handle: paramValidators.handle, slug: paramValidators.slug }),
  asyncHandler(async (req: Request, res: Response) => {
    const workflowRef = `${req.params.handle}/${req.params.slug}`;
    const userId = (req as AuthenticatedRequest).userId;
    const activeOnly = req.query.activeOnly !== "false";
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 50), 100);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    const sharingService = getWorkflowSharingService();

    try {
      const resolvedId = await resolveWorkflowId(workflowRef, userId);
      if (!resolvedId) {
        throw new WorkflowNotFoundError(workflowRef, "reference");
      }

      const result = await sharingService.listInvites({
        workflowId: resolvedId,
        userId,
        activeOnly,
        limit,
        offset,
      });

      res.json({
        success: true,
        data: {
          invites: result.invites.map((invite) => ({
            id: invite.id,
            token: invite.token,
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
            remainingMs: invite.remainingMs,
            usedAt: invite.usedAt,
            usedBy: invite.usedBy,
            usedByHandle: invite.usedByHandle,
          })),
          total: result.total,
          hasMore: offset + limit < result.total,
        },
      });
    } catch (error) {
      handleSharingError(error, res);
    }
  }),
);

/**
 * DELETE /api/workflows/:handle/:slug/invites/:inviteId - Revoke invite by handle/slug
 */
router.delete(
  "/:handle/:slug/invites/:inviteId",
  validateParams({
    handle: paramValidators.handle,
    slug: paramValidators.slug,
    inviteId: uuidValidator,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const inviteId = req.params.inviteId;
    const userId = (req as AuthenticatedRequest).userId;

    const sharingService = getWorkflowSharingService();

    try {
      await sharingService.revokeInvite({ inviteId, userId });

      res.json({
        success: true,
        data: { revoked: true },
      });
    } catch (error) {
      handleSharingError(error, res);
    }
  }),
);

/**
 * GET /api/workflows/:handle/:slug/access - List users with access by handle/slug
 */
router.get(
  "/:handle/:slug/access",
  validateParams({ handle: paramValidators.handle, slug: paramValidators.slug }),
  asyncHandler(async (req: Request, res: Response) => {
    const workflowRef = `${req.params.handle}/${req.params.slug}`;
    const userId = (req as AuthenticatedRequest).userId;
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 50), 100);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    const sharingService = getWorkflowSharingService();

    try {
      const resolvedId = await resolveWorkflowId(workflowRef, userId);
      if (!resolvedId) {
        throw new WorkflowNotFoundError(workflowRef, "reference");
      }

      const result = await sharingService.listAccess({
        workflowId: resolvedId,
        userId,
        limit,
        offset,
      });

      res.json({
        success: true,
        data: {
          users: result.accesses.map((access) => ({
            userId: access.userId,
            handle: access.userHandle,
            name: access.userName,
            grantedAt: access.grantedAt,
            grantedBy: access.grantedBy,
            grantedByHandle: access.grantedByHandle,
          })),
          total: result.total,
          hasMore: offset + limit < result.total,
        },
      });
    } catch (error) {
      handleSharingError(error, res);
    }
  }),
);

/**
 * DELETE /api/workflows/:handle/:slug/access/:userId - Revoke user access by handle/slug
 */
router.delete(
  "/:handle/:slug/access/:userId",
  validateParams({
    handle: paramValidators.handle,
    slug: paramValidators.slug,
    userId: userIdValidator,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const workflowRef = `${req.params.handle}/${req.params.slug}`;
    const targetUserId = req.params.userId;
    const userId = (req as AuthenticatedRequest).userId;

    const sharingService = getWorkflowSharingService();

    try {
      const resolvedId = await resolveWorkflowId(workflowRef, userId);
      if (!resolvedId) {
        throw new WorkflowNotFoundError(workflowRef, "reference");
      }

      await sharingService.revokeAccess({
        workflowId: resolvedId,
        targetUserId,
        userId,
      });

      res.json({
        success: true,
        data: { revoked: true },
      });
    } catch (error) {
      handleSharingError(error, res);
    }
  }),
);

// ===== UUID-based routes =====

/**
 * POST /api/workflows/:id/invites - Create invite link
 * Requires owner authentication
 */
router.post(
  "/:id/invites",
  validateParams({ id: paramValidators.workflowId }),
  asyncHandler(async (req: Request, res: Response) => {
    const workflowId = req.params.id;
    const userId = (req as AuthenticatedRequest).userId;
    const { ttlMs } = req.body || {};

    const sharingService = getWorkflowSharingService();

    try {
      // Resolve workflow identifier to actual ID
      const resolvedId = await resolveWorkflowId(workflowId, userId);
      if (!resolvedId) {
        throw new WorkflowNotFoundError(workflowId, "id");
      }

      const result = await sharingService.createInvite({
        workflowId: resolvedId,
        userId,
        ttlMs,
      });

      res.status(201).json({
        success: true,
        data: {
          invite: {
            id: result.invite.id,
            token: result.invite.token,
            expiresAt: result.invite.expiresAt,
            remainingMs: result.invite.remainingMs,
          },
          inviteUrl: result.inviteUrl,
        },
      });
    } catch (error) {
      handleSharingError(error, res);
    }
  }),
);

/**
 * GET /api/workflows/:id/invites - List active invites
 * Requires owner authentication
 */
router.get(
  "/:id/invites",
  validateParams({ id: paramValidators.workflowId }),
  asyncHandler(async (req: Request, res: Response) => {
    const workflowId = req.params.id;
    const userId = (req as AuthenticatedRequest).userId;
    const activeOnly = req.query.activeOnly !== "false";
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 50), 100);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    const sharingService = getWorkflowSharingService();

    try {
      const resolvedId = await resolveWorkflowId(workflowId, userId);
      if (!resolvedId) {
        throw new WorkflowNotFoundError(workflowId, "id");
      }

      const result = await sharingService.listInvites({
        workflowId: resolvedId,
        userId,
        activeOnly,
        limit,
        offset,
      });

      res.json({
        success: true,
        data: {
          invites: result.invites.map((invite) => ({
            id: invite.id,
            token: invite.token,
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
            remainingMs: invite.remainingMs,
            usedAt: invite.usedAt,
            usedBy: invite.usedBy,
            usedByHandle: invite.usedByHandle,
          })),
          total: result.total,
          hasMore: offset + limit < result.total,
        },
      });
    } catch (error) {
      handleSharingError(error, res);
    }
  }),
);

/**
 * DELETE /api/workflows/:id/invites/:inviteId - Revoke invite
 * Requires owner authentication
 */
router.delete(
  "/:id/invites/:inviteId",
  validateParams({
    id: paramValidators.workflowId,
    inviteId: uuidValidator,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const inviteId = req.params.inviteId;
    const userId = (req as AuthenticatedRequest).userId;

    const sharingService = getWorkflowSharingService();

    try {
      await sharingService.revokeInvite({ inviteId, userId });

      res.json({
        success: true,
        data: { revoked: true },
      });
    } catch (error) {
      handleSharingError(error, res);
    }
  }),
);

/**
 * GET /api/workflows/:id/access - List users with shared access
 * Requires owner authentication
 */
router.get(
  "/:id/access",
  validateParams({ id: paramValidators.workflowId }),
  asyncHandler(async (req: Request, res: Response) => {
    const workflowId = req.params.id;
    const userId = (req as AuthenticatedRequest).userId;
    const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 50), 100);
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    const sharingService = getWorkflowSharingService();

    try {
      const resolvedId = await resolveWorkflowId(workflowId, userId);
      if (!resolvedId) {
        throw new WorkflowNotFoundError(workflowId, "id");
      }

      const result = await sharingService.listAccess({
        workflowId: resolvedId,
        userId,
        limit,
        offset,
      });

      res.json({
        success: true,
        data: {
          users: result.accesses.map((access) => ({
            userId: access.userId,
            handle: access.userHandle,
            name: access.userName,
            grantedAt: access.grantedAt,
            grantedBy: access.grantedBy,
            grantedByHandle: access.grantedByHandle,
          })),
          total: result.total,
          hasMore: offset + limit < result.total,
        },
      });
    } catch (error) {
      handleSharingError(error, res);
    }
  }),
);

/**
 * DELETE /api/workflows/:id/access/:userId - Revoke user access
 * Requires owner authentication
 */
router.delete(
  "/:id/access/:userId",
  validateParams({
    id: paramValidators.workflowId,
    userId: userIdValidator,
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const workflowId = req.params.id;
    const targetUserId = req.params.userId;
    const userId = (req as AuthenticatedRequest).userId;

    const sharingService = getWorkflowSharingService();

    try {
      const resolvedId = await resolveWorkflowId(workflowId, userId);
      if (!resolvedId) {
        throw new WorkflowNotFoundError(workflowId, "id");
      }

      await sharingService.revokeAccess({
        workflowId: resolvedId,
        targetUserId,
        userId,
      });

      res.json({
        success: true,
        data: { revoked: true },
      });
    } catch (error) {
      handleSharingError(error, res);
    }
  }),
);

// ===== Helper Functions =====

/**
 * Resolve workflow identifier (UUID, slug, or handle/slug) to actual UUID
 */
async function resolveWorkflowId(identifier: string, userId: string): Promise<string | null> {
  const workflowService = getWorkflowService();

  // Check if this is a handle/slug reference (contains exactly one slash)
  if (identifier.includes("/") && identifier.split("/").length === 2) {
    const { workflow } = await workflowService.getByReference(identifier, userId);
    if (workflow) {
      return workflow.id ?? null;
    }
    return null;
  }

  // First try as UUID directly
  const workflow = await workflowService.get(identifier, userId);
  if (workflow) {
    return identifier;
  }

  // Try as slug for current user
  const workflowBySlug = await workflowService.getBySlug(identifier, userId);
  if (workflowBySlug) {
    return workflowBySlug.id ?? null;
  }

  return null;
}

/**
 * Handle domain errors and send appropriate HTTP responses
 */
function handleSharingError(error: unknown, res: Response): void {
  if (error instanceof WorkflowNotFoundError) {
    res.status(404).json({
      success: false,
      error: { message: error.message, code: error.code },
    });
  } else if (error instanceof WorkflowAccessDeniedError) {
    res.status(403).json({
      success: false,
      error: { message: error.message, code: error.code },
    });
  } else if (error instanceof InviteNotFoundError) {
    res.status(404).json({
      success: false,
      error: { message: error.message, code: error.code },
    });
  } else if (error instanceof InviteExpiredError) {
    res.status(410).json({
      success: false,
      error: { message: error.message, code: error.code },
    });
  } else if (error instanceof InviteAlreadyUsedError) {
    res.status(410).json({
      success: false,
      error: { message: error.message, code: error.code },
    });
  } else if (error instanceof SelfInviteError) {
    res.status(400).json({
      success: false,
      error: { message: error.message, code: error.code },
    });
  } else if (error instanceof AccessAlreadyExistsError) {
    res.status(409).json({
      success: false,
      error: { message: error.message, code: error.code },
    });
  } else if (error instanceof AccessNotFoundError) {
    res.status(404).json({
      success: false,
      error: { message: error.message, code: error.code },
    });
  } else {
    throw error; // Let global error handler deal with it
  }
}

export { router as workflowSharingRoutes };
