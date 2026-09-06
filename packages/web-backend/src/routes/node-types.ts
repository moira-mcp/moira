/**
 * Node Types Route
 *
 * What node types exist, so that the browser stops answering that question from a list compiled
 * into its bundle. The answer is computed from the engine's own built-in list and from this
 * process's live extension registry, which is also what validation uses — one source, one answer.
 *
 * The response describes types only: no setting values, no secrets, nothing an authenticated user
 * may not see. Authentication is still required, like every other user-facing API route, because
 * the names and schemas of an installation's extensions are not public information.
 */

import { Router, Request, Response } from "express";
import { buildNodeTypeCatalog, getActiveExtensionRegistry } from "@mcp-moira/workflow-engine";

import { asyncHandler } from "../middleware/error-middleware.js";

const router = Router();

/**
 * GET /api/node-types - Known node types with their titles, origin and schemas
 */
router.get(
  "/",
  asyncHandler(async (_req: Request, res: Response) => {
    const catalog = buildNodeTypeCatalog(getActiveExtensionRegistry());

    res.json({
      success: true,
      data: catalog,
      timestamp: new Date().toISOString(),
    });
  }),
);

export { router as nodeTypesRoutes };
export default router;
