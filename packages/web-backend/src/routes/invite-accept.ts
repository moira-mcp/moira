/**
 * Invite Acceptance Routes
 * Public route for accepting workflow invite links
 *
 * Routes:
 * - POST /api/invites/:token/accept - Accept invite (requires auth)
 * - GET  /api/invites/:token        - Get invite info (public, for UI)
 */

import { Router, Request, Response } from "express";
import { AuthenticatedRequest } from "../types/index.js";
import { asyncHandler, validateParams } from "../middleware/error-middleware.js";
import {
  getWorkflowSharingService,
  InviteNotFoundError,
  InviteExpiredError,
  InviteAlreadyUsedError,
  SelfInviteError,
  AccessAlreadyExistsError,
} from "@mcp-moira/shared";

const router = Router();

// Token validator (URL-safe base64)
const tokenValidator = (value: string): boolean => {
  return /^[A-Za-z0-9_-]+$/.test(value) && value.length >= 16;
};

/**
 * GET /api/invites/:token - Get invite info (for UI landing page)
 * This is a public route but returns limited info
 */
router.get(
  "/:token",
  validateParams({ token: tokenValidator }),
  asyncHandler(async (req: Request, res: Response) => {
    const token = req.params.token;
    const sharingService = getWorkflowSharingService();

    try {
      // Get invite info - uses internal repo method
      const invite = await sharingService.getInviteInfo(token);

      if (!invite) {
        res.status(404).json({
          success: false,
          error: { message: "Invite not found or expired", code: "INVITE_NOT_FOUND" },
        });
        return;
      }

      // Return limited public info
      res.json({
        success: true,
        data: {
          valid: invite.isValid,
          expired: invite.isExpired,
          used: invite.isUsed,
          workflowName: invite.workflowName,
          createdByHandle: invite.createdByHandle,
          expiresAt: invite.expiresAt,
          remainingMs: invite.remainingMs,
        },
      });
    } catch (error) {
      handleInviteError(error, res);
    }
  }),
);

/**
 * POST /api/invites/:token/accept - Accept invite and gain access
 * Requires authentication
 */
router.post(
  "/:token/accept",
  validateParams({ token: tokenValidator }),
  asyncHandler(async (req: Request, res: Response) => {
    const token = req.params.token;
    const userId = (req as AuthenticatedRequest).userId;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: { message: "Authentication required to accept invite", code: "AUTH_REQUIRED" },
      });
      return;
    }

    const sharingService = getWorkflowSharingService();

    try {
      const result = await sharingService.acceptInvite({ token, userId });

      res.status(201).json({
        success: true,
        data: {
          accessId: result.accessId,
          workflowId: result.workflowId,
          ownerHandle: result.ownerHandle,
          slug: result.slug,
          message: "Access granted successfully",
        },
      });
    } catch (error) {
      handleInviteError(error, res);
    }
  }),
);

/**
 * Handle invite-specific errors
 */
function handleInviteError(error: unknown, res: Response): void {
  if (error instanceof InviteNotFoundError) {
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
  } else {
    throw error;
  }
}

export { router as inviteAcceptRoutes };
