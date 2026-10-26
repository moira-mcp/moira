/**
 * Public Artifact Token Routes
 * Upload artifacts via one-time tokens (no auth middleware required)
 * Token itself provides authorization
 */

import { Router, Request, Response } from "express";
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
import { readArtifactBody } from "../middleware/artifact-body.js";
import { settleOwnerFrame } from "@mcp-moira/shared/http/owner-stream-frame";

const logger = createLogger({ component: "ArtifactTokens" });

export function createArtifactTokenRoutes(
  artifactService: Pick<
    ReturnType<typeof getArtifactService>,
    "validateToken" | "getMaxFileSize" | "createWithToken"
  >,
) {
  const router = Router();

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
    asyncHandler(async (req: Request, res: Response) => {
      const { token } = req.params;

      logger.debug("Artifact upload request received", { tokenPrefix: token.substring(0, 8) });

      try {
        const { userId } = await artifactService.validateToken(token);
        const maxContentBytes = await artifactService.getMaxFileSize(userId);
        if (!(await readArtifactBody(req, res, maxContentBytes, true))) return;

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
        if (!req.readableEnded) settleOwnerFrame(req, res);
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

  return router;
}

const router = createArtifactTokenRoutes(getArtifactService());
export { router as artifactTokenRoutes };
