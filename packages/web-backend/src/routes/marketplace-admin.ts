/**
 * Admin marketplace API — mounted under `/api/marketplace/admin` behind
 * `apiLimiter` + `requireAuth`; every route additionally requires the admin role
 * (`requireAdmin`). Covers the verified badge, featuring, the moderation queue, and
 * status transitions.
 *
 * Endpoints:
 *   POST   /listings/:id/verify    grant verified badge → listing
 *   DELETE /listings/:id/verify    revoke verified badge → listing
 *   POST   /listings/:id/feature   set featured flag (body { featured }) → listing
 *   GET    /listings?status=       moderation queue by status → listings
 *   POST   /listings/:id/status    transition status (body { status, reason? }) → listing
 */

import { Router, Request, Response } from "express";
import { asyncHandler } from "../middleware/error-middleware.js";
import { requireAdmin } from "../middleware/admin-middleware.js";
import { ApiResponse } from "../types/index.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import { getMarketplaceService } from "@mcp-moira/shared";

const router = Router();

// Every admin marketplace route requires the admin role.
router.use(requireAdmin);

function ok<T>(res: Response, data: T): void {
  const body: ApiResponse<T> = { success: true, data, timestamp: new Date().toISOString() };
  res.json(body);
}

function adminId(req: Request): string {
  return (req as AuthenticatedRequest).userId;
}

// POST /api/marketplace/admin/listings/:id/verify
router.post(
  "/listings/:id/verify",
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await getMarketplaceService().verifyListing(adminId(req), req.params.id));
  }),
);

// DELETE /api/marketplace/admin/listings/:id/verify
router.delete(
  "/listings/:id/verify",
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await getMarketplaceService().unverifyListing(req.params.id));
  }),
);

// POST /api/marketplace/admin/listings/:id/feature
router.post(
  "/listings/:id/feature",
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    ok(
      res,
      await getMarketplaceService().setListingFeatured(req.params.id, body.featured === true),
    );
  }),
);

// GET /api/marketplace/admin/listings?status=pending
router.get(
  "/listings",
  asyncHandler(async (req: Request, res: Response) => {
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    ok(res, { listings: await getMarketplaceService().getModerationQueue(status) });
  }),
);

// POST /api/marketplace/admin/listings/:id/status
router.post(
  "/listings/:id/status",
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    ok(
      res,
      await getMarketplaceService().setListingStatus(req.params.id, String(body.status ?? "")),
    );
  }),
);

export { router as marketplaceAdminRoutes };
