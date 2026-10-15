import { Router } from "express";
import type { CodespaceObservabilityService } from "@mcp-moira/shared";
import { asyncHandler } from "../middleware/error-middleware.js";
import { getCodespaceObservabilityService } from "../services/codespace-services.js";

export interface AdminCodespaceServices {
  observability: Pick<CodespaceObservabilityService, "readiness">;
}
/** Admin configuration observation does not enqueue or stop owned provider resources. */
export function createAdminCodespaceRoutes(
  services: AdminCodespaceServices = { observability: getCodespaceObservabilityService() },
): Router {
  const router = Router();
  router.get(
    "/",
    asyncHandler(async (_req, res) => {
      const readiness = await services.observability.readiness();
      res.json({ success: true, data: { readiness } });
    }),
  );
  return router;
}
