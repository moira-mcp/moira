/**
 * Artifacts API Routes
 * User artifact management with authentication
 * All operations scoped to authenticated user
 */

import { Router, Request, Response } from "express";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import {
  getArtifactService,
  ArtifactNotFoundError,
  ArtifactSizeExceededError,
  ArtifactQuotaExceededError,
  ArtifactAccessDeniedError,
  InvalidArtifactContentError,
  createLogger,
  getArtifactUrl,
} from "@mcp-moira/shared";

const router = Router();
const artifactService = getArtifactService();
const _logger = createLogger({ component: "ArtifactsRoutes" });

/**
 * GET /api/artifacts - List user's artifacts with pagination
 * Query params:
 *   - limit: Max results (default 50, max 100)
 *   - offset: Pagination offset (default 0)
 */
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { limit, offset } = req.query;

    const result = await artifactService.list(userId, {
      limit: limit ? Math.min(parseInt(limit as string, 10), 100) : 50,
      offset: offset ? parseInt(offset as string, 10) : 0,
    });

    // Add URL to each artifact
    const artifactsWithUrl = result.artifacts.map((a) => ({
      ...a,
      url: getArtifactUrl(a.uuid),
    }));

    res.json({
      success: true,
      data: {
        artifacts: artifactsWithUrl,
        total: result.total,
      },
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/artifacts/stats - Get user's artifact statistics
 */
router.get(
  "/stats",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;

    const stats = await artifactService.getStats(userId);

    res.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
    });
  }),
);

/**
 * GET /api/artifacts/:uuid - Get single artifact metadata by UUID
 */
router.get(
  "/:uuid",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { uuid } = req.params;

    try {
      const artifact = await artifactService.get(userId, uuid);

      res.json({
        success: true,
        data: {
          ...artifact,
          url: getArtifactUrl(artifact.uuid),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        throw createApiError.notFound(`Artifact not found: ${uuid}`, { uuid });
      }
      throw error;
    }
  }),
);

/**
 * POST /api/artifacts - Create a new artifact
 * Body: { name, content, executionId? }
 */
router.post(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { name, content, executionId } = req.body;

    if (!name) {
      throw createApiError.validationFailed("Name is required");
    }
    if (!content) {
      throw createApiError.validationFailed("Content is required");
    }

    try {
      const artifact = await artifactService.create(userId, {
        name,
        content,
        executionId,
      });

      res.status(201).json({
        success: true,
        data: {
          uuid: artifact.uuid,
          url: getArtifactUrl(artifact.uuid),
          name: artifact.name,
          size: artifact.size,
          expiresAt: new Date(artifact.expiresAt).toISOString(),
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleArtifactServiceError(error);
    }
  }),
);

/**
 * PUT /api/artifacts/:uuid - Update an existing artifact
 * Body: { content, name? }
 */
router.put(
  "/:uuid",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { uuid } = req.params;
    const { content, name } = req.body;

    if (!content) {
      throw createApiError.validationFailed("Content is required");
    }

    try {
      await artifactService.update(userId, uuid, { content, name });

      res.json({
        success: true,
        data: {
          uuid,
          updated: true,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        throw createApiError.notFound(`Artifact not found: ${uuid}`, { uuid });
      }
      if (error instanceof ArtifactAccessDeniedError) {
        throw createApiError.forbidden(`Access denied to artifact: ${uuid}`, { uuid });
      }
      handleArtifactServiceError(error);
    }
  }),
);

/**
 * DELETE /api/artifacts/:uuid - Soft delete an artifact
 */
router.delete(
  "/:uuid",
  asyncHandler(async (req: Request, res: Response) => {
    const userId = (req as AuthenticatedRequest).userId;
    const { uuid } = req.params;

    try {
      await artifactService.delete(userId, uuid);

      res.json({
        success: true,
        data: {
          uuid,
          deleted: true,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      if (error instanceof ArtifactNotFoundError) {
        throw createApiError.notFound(`Artifact not found: ${uuid}`, { uuid });
      }
      if (error instanceof ArtifactAccessDeniedError) {
        throw createApiError.forbidden(`Access denied to artifact: ${uuid}`, { uuid });
      }
      throw error;
    }
  }),
);

/**
 * Handle ArtifactService domain errors and convert to API errors
 */
function handleArtifactServiceError(error: unknown): never {
  if (error instanceof InvalidArtifactContentError) {
    throw createApiError.validationFailed(error.message);
  }
  if (error instanceof ArtifactSizeExceededError) {
    throw createApiError.validationFailed(error.message, {
      size: error.size,
      limit: error.limit,
    });
  }
  if (error instanceof ArtifactQuotaExceededError) {
    throw createApiError.validationFailed(error.message, {
      quotaType: error.quotaType,
      current: error.current,
      limit: error.limit,
    });
  }
  throw error;
}

export { router as artifactsRoutes };
