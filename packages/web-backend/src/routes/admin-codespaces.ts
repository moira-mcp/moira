import { Router } from "express";
import {
  CodespaceResourceError,
  type CodespaceObservabilityService,
  type CodespaceResourceService,
} from "@mcp-moira/shared";
import type { AuthenticatedRequest } from "../types/express-types.js";
import { asyncHandler } from "../middleware/error-middleware.js";
import {
  getCodespaceObservabilityService,
  getCodespaceResourceService,
} from "../services/codespace-services.js";

export interface AdminCodespaceServices {
  observability: Pick<CodespaceObservabilityService, "readiness">;
  resource: Pick<CodespaceResourceService, "listControls" | "setControl"> | null;
}

const SCOPE = /^(global|provider:[a-z0-9-]{1,64})$/;

function defaultServices(): AdminCodespaceServices {
  return {
    observability: getCodespaceObservabilityService(),
    resource: getCodespaceResourceService(),
  };
}

/**
 * Administrator operations for cloud codespaces: the shared readiness decision and
 * the durable global/provider kill switches. Mounted behind the admin namespace guard.
 * Disabling a control refuses new work and stops persistent codespaces; it never
 * deletes user data.
 */
export function createAdminCodespaceRoutes(
  services: AdminCodespaceServices = defaultServices(),
): Router {
  const router = Router();

  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const readiness = await services.observability.readiness();
      res.json({ success: true, data: { readiness, controls: readiness.controls } });
    }),
  );

  router.put(
    "/controls/:scope",
    asyncHandler(async (req, res) => {
      const userId = (req as AuthenticatedRequest).userId;
      const scope = req.params.scope;
      const disabled = req.body?.disabled;
      const reason = req.body?.reason;
      if (
        !SCOPE.test(scope) ||
        typeof disabled !== "boolean" ||
        (reason !== undefined && reason !== null && typeof reason !== "string") ||
        (typeof reason === "string" && reason.length > 500)
      ) {
        res.status(400).json({
          success: false,
          error: {
            code: "CODESPACE_CONTROL_INVALID",
            message:
              "A control needs a known scope, a boolean disabled flag and an optional reason",
          },
        });
        return;
      }
      if (!services.resource) {
        res.status(503).json({
          success: false,
          error: {
            code: "CODESPACE_NOT_CONFIGURED",
            message: "Cloud codespaces are not configured on this Moira instance",
          },
        });
        return;
      }
      try {
        await services.resource.setControl({
          scope: scope as "global" | `provider:${string}`,
          disabled,
          reason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
          updatedBy: userId,
        });
        // One control shape for every caller: the readiness projection.
        const readiness = await services.observability.readiness();
        res.json({ success: true, data: { readiness, controls: readiness.controls } });
      } catch (error) {
        if (error instanceof CodespaceResourceError) {
          res.status(error.code === "CODESPACE_RESOURCE_INVALID" ? 400 : 503).json({
            success: false,
            error: { code: error.code, message: error.message },
          });
          return;
        }
        throw error;
      }
    }),
  );

  return router;
}
