/**
 * Public Artifact Token Routes
 * Upload artifacts via one-time tokens (no auth middleware required)
 * Token itself provides authorization
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import {
  getArtifactService,
  InvalidArtifactTokenError,
  InvalidArtifactContentError,
  ArtifactSizeExceededError,
  ArtifactQuotaExceededError,
  createLogger,
  getArtifactUrl,
} from "@mcp-moira/shared";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";

const router = Router();
const artifactService = getArtifactService();
const logger = createLogger({ component: "ArtifactTokens" });

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit (matches artifact max size)
  },
});

/**
 * POST /api/public/artifacts/upload/:token - Upload artifact via one-time token
 * Public endpoint - token provides authorization
 *
 * Accepts either:
 * - multipart/form-data with 'file' field
 * - application/json with { name, content }
 */
router.post(
  "/upload/:token",
  upload.single("file"),
  asyncHandler(async (req: Request, res: Response) => {
    const { token } = req.params;

    logger.debug("Artifact upload request received", { tokenPrefix: token.substring(0, 8) });

    let name: string;
    let content: string;

    // Handle multipart file upload
    if (req.file) {
      name = req.file.originalname || "artifact.html";
      content = req.file.buffer.toString("utf-8");
    }
    // Handle JSON body
    else if (req.body && req.body.name && req.body.content) {
      name = req.body.name;
      content = req.body.content;
    }
    // Neither file nor JSON body provided
    else {
      throw createApiError.validationFailed(
        "Upload artifact via file (multipart/form-data with 'file' field) or JSON body ({ name, content })",
      );
    }

    // Optional executionId from body
    const executionId = req.body?.executionId;

    try {
      // Create artifact using the token (validates token and marks as used)
      const artifact = await artifactService.createWithToken(token, {
        name,
        content,
        executionId,
      });

      logger.info("Artifact uploaded via token", {
        uuid: artifact.uuid,
        name: artifact.name,
        size: artifact.size,
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
      if (error instanceof InvalidArtifactTokenError) {
        throw createApiError.unauthorized("Invalid, expired, or already used token");
      }
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
  }),
);

export { router as artifactTokenRoutes };
