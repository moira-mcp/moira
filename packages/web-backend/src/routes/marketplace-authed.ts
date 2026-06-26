/**
 * Authenticated marketplace API — mounted under `/api/marketplace` behind
 * `apiLimiter` + `requireAuth`. Covers publish/unpublish + owner metadata edits,
 * the owner's listings + library, adopt (install) / fork / remove, ratings, and the
 * entitlement check. Admin moderation lives in `marketplace-admin.ts`.
 *
 * Endpoints:
 *   POST   /listings                          publish a workflow → ListingDetail
 *   PATCH  /listings/:id                       owner metadata edit → listing
 *   DELETE /listings/:id                       unpublish (status=unlisted) → 204
 *   GET    /me/listings                        the caller's listings (any status)
 *   GET    /me/library?filter=…                 the caller's library (all|official|added|mine|shared)
 *   POST   /listings/:id/install               adopt as reference → { startRef }
 *   POST   /listings/:id/fork                  fork an editable copy → { workflowId, slug }
 *   DELETE /library/:workflowId                remove a flow from the library → 204
 *   POST   /listings/:id/reviews               rate/review → { review, ratingAvg, ratingCount }
 *   DELETE /listings/:id/reviews/me            remove own review → 204
 *   GET    /listings/:id/entitlement           { hasAccess, reason }
 */

import { Router, Request, Response } from "express";
import multer from "multer";
import { WorkflowGraph } from "@mcp-moira/workflow-engine";
import { asyncHandler, createApiError } from "../middleware/error-middleware.js";
import { ApiResponse } from "../types/index.js";
import { AuthenticatedRequest } from "../types/express-types.js";
import {
  getMarketplaceService,
  isMarketplaceEnabled,
  MarketplaceDisabledError,
  type LibrarySourceFilter,
} from "@mcp-moira/shared";
import { WorkflowValidationService } from "../services/validation-service.js";

const router = Router();

// File import uploads (the offline adoption path) — in-memory, 5MB cap to match the
// workflow repository's save limit so an oversize file fails at the upload boundary
// instead of passing multer only to be rejected deeper.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function ok<T>(res: Response, data: T, status = 200): void {
  const body: ApiResponse<T> = { success: true, data, timestamp: new Date().toISOString() };
  res.status(status).json(body);
}

function userId(req: Request): string {
  return (req as AuthenticatedRequest).userId;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalTags(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((t) => typeof t === "string")
    ? (value as string[])
    : undefined;
}

const LIBRARY_FILTERS: readonly LibrarySourceFilter[] = [
  "all",
  "official",
  "added",
  "mine",
  "shared",
];

/** Map the `?filter=` query value to a LibrarySourceFilter (default "all"). */
function parseLibraryFilter(value: unknown): LibrarySourceFilter {
  return LIBRARY_FILTERS.includes(value as LibrarySourceFilter)
    ? (value as LibrarySourceFilter)
    : "all";
}

// POST /api/marketplace/listings — publish a workflow
router.post(
  "/listings",
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const service = getMarketplaceService();
    const listing = await service.publish(userId(req), String(body.workflowId ?? ""), {
      title: optionalString(body.title),
      summary: optionalString(body.summary) ?? null,
      category: optionalString(body.category),
      tags: optionalTags(body.tags),
      isPaid: body.isPaid === true ? true : undefined,
      price: typeof body.price === "number" ? body.price : undefined,
      tier: optionalString(body.tier) ?? undefined,
    });
    ok(res, await service.getDetailById(listing.id, userId(req)), 201);
  }),
);

// PATCH /api/marketplace/listings/:id — owner metadata edit
router.patch(
  "/listings/:id",
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const listing = await getMarketplaceService().updateListing(userId(req), req.params.id, {
      title: optionalString(body.title),
      summary: body.summary === null ? null : optionalString(body.summary),
      category: optionalString(body.category),
      tags: optionalTags(body.tags),
    });
    ok(res, listing);
  }),
);

// DELETE /api/marketplace/listings/:id — unpublish
router.delete(
  "/listings/:id",
  asyncHandler(async (req: Request, res: Response) => {
    await getMarketplaceService().unpublishById(userId(req), req.params.id);
    res.status(204).end();
  }),
);

// GET /api/marketplace/me/listings — the caller's listings
router.get(
  "/me/listings",
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, { listings: await getMarketplaceService().getMyListings(userId(req)) });
  }),
);

// GET /api/marketplace/me/library — the caller's library (optional ?filter=)
router.get(
  "/me/library",
  asyncHandler(async (req: Request, res: Response) => {
    const filter = parseLibraryFilter(req.query.filter);
    ok(res, { items: await getMarketplaceService().getLibrary(userId(req), filter) });
  }),
);

// POST /api/marketplace/listings/:id/install — adopt as a live reference
router.post(
  "/listings/:id/install",
  asyncHandler(async (req: Request, res: Response) => {
    const result = await getMarketplaceService().install(userId(req), req.params.id);
    ok(res, { startRef: result.startRef });
  }),
);

// POST /api/marketplace/listings/:id/fork — fork an editable copy
router.post(
  "/listings/:id/fork",
  asyncHandler(async (req: Request, res: Response) => {
    const result = await getMarketplaceService().fork(userId(req), req.params.id);
    ok(res, result, 201);
  }),
);

// POST /api/marketplace/import — import a workflow from an uploaded file into the
// library (offline adoption, NO cloud call). Gated by the local marketplace feature
// (checked first → 404 when off, before parsing); validates the graph before saving.
router.post(
  "/import",
  upload.single("workflow"),
  asyncHandler(async (req: Request, res: Response) => {
    // Enforce the local-feature gate FIRST, before parsing/validating the upload, so a
    // disabled instance refuses any import uniformly (404) rather than processing input.
    if (!isMarketplaceEnabled()) {
      throw new MarketplaceDisabledError();
    }
    if (!req.file) {
      throw createApiError.validationFailed("No file uploaded");
    }

    let graph: WorkflowGraph;
    try {
      graph = JSON.parse(req.file.buffer.toString("utf-8")) as WorkflowGraph;
    } catch {
      throw createApiError.validationFailed("Invalid JSON format");
    }
    if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes) || !graph.metadata) {
      throw createApiError.validationFailed(
        "Not a workflow file: expected an object with metadata and a nodes array",
      );
    }

    // Validate against a temporary id (the import drops it and assigns a fresh one).
    const validation = await new WorkflowValidationService().validateWorkflow({
      ...graph,
      id: graph.id ?? "import-validation-id",
    });
    if (!validation.isValid) {
      throw createApiError.validationFailed("Workflow validation failed", { validation });
    }

    const result = await getMarketplaceService().importFromFile(userId(req), graph);
    ok(res, result, 201);
  }),
);

// DELETE /api/marketplace/library/:workflowId — remove from library
router.delete(
  "/library/:workflowId",
  asyncHandler(async (req: Request, res: Response) => {
    await getMarketplaceService().remove(userId(req), req.params.workflowId);
    res.status(204).end();
  }),
);

// POST /api/marketplace/listings/:id/reviews — rate / review
router.post(
  "/listings/:id/reviews",
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const result = await getMarketplaceService().rate(
      userId(req),
      req.params.id,
      Number(body.stars),
      body.reviewText === null ? null : optionalString(body.reviewText),
    );
    ok(res, result);
  }),
);

// DELETE /api/marketplace/listings/:id/reviews/me — remove own review
router.delete(
  "/listings/:id/reviews/me",
  asyncHandler(async (req: Request, res: Response) => {
    await getMarketplaceService().removeReview(userId(req), req.params.id);
    res.status(204).end();
  }),
);

// GET /api/marketplace/listings/:id/entitlement — access decision
router.get(
  "/listings/:id/entitlement",
  asyncHandler(async (req: Request, res: Response) => {
    ok(res, await getMarketplaceService().getEntitlement(userId(req), req.params.id));
  }),
);

export { router as marketplaceAuthedRoutes };
