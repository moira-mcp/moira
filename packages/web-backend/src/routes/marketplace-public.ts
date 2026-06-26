/**
 * Public marketplace read API — unauthenticated, mounted under
 * `/api/public/marketplace` behind `apiLimiter` (no `requireAuth`).
 *
 * Endpoints:
 *   GET /                              gallery (search, category, tag, sort, pagination)
 *   GET /categories                    fixed category set
 *   GET /sitemap.xml                   dynamic sitemap of listed flows (XML)
 *   GET /listings/:handle/:slug         flow detail by reference (+ view signal)
 *   GET /listings/:handle/:slug/reviews reviews with author handles
 *   GET /listings/:handle/:slug/export  purchase-gated export (JSON download)
 */

import { Router, Request, Response } from "express";
import { asyncHandler } from "../middleware/error-middleware.js";
import { ApiResponse } from "../types/index.js";
import {
  getMarketplaceService,
  getBaseUrl,
  createLogger,
  Service,
  type GallerySortOption,
} from "@mcp-moira/shared";

const router = Router();
const logger = createLogger({ component: "MarketplacePublic" }).child({
  service: Service.WEB_BACKEND,
});

/** Synthetic principal for unauthenticated reads — only resolves PUBLIC workflows. */
const ANONYMOUS = "__anonymous__";

const SORTS: GallerySortOption[] = ["recent", "rating", "installs", "trending"];

function ok<T>(res: Response, data: T): void {
  const body: ApiResponse<T> = { success: true, data, timestamp: new Date().toISOString() };
  res.json(body);
}

function parseIntOr(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

// GET /api/public/marketplace — gallery
router.get(
  "/",
  asyncHandler(async (req: Request, res: Response) => {
    const q = req.query;
    const sort = SORTS.includes(q.sort as GallerySortOption)
      ? (q.sort as GallerySortOption)
      : "recent";
    // Two independent boolean filters (each enabled only by the literal "true"):
    //   ?official=true → the canonical "Official" set (listings owned by a system
    //                    account; mirrors the library's owner-based Official notion).
    //   ?verified=true → the verified trust badge (may include verified community flows).
    const official = q.official === "true" ? true : undefined;
    const verified = q.verified === "true" ? true : undefined;
    const page = await getMarketplaceService().getGallery({
      search: typeof q.search === "string" ? q.search : undefined,
      category: typeof q.category === "string" ? q.category : undefined,
      tag: typeof q.tag === "string" ? q.tag : undefined,
      official,
      verified,
      sort,
      limit: q.limit !== undefined ? parseIntOr(q.limit, 24) : undefined,
      offset: q.offset !== undefined ? parseIntOr(q.offset, 0) : undefined,
    });
    ok(res, page);
  }),
);

// GET /api/public/marketplace/categories
router.get(
  "/categories",
  asyncHandler(async (_req: Request, res: Response) => {
    ok(res, { categories: getMarketplaceService().getCategories() });
  }),
);

// GET /api/public/marketplace/sitemap.xml
router.get(
  "/sitemap.xml",
  asyncHandler(async (_req: Request, res: Response) => {
    // getSitemapRefs caps at 50000 rows (under the sitemap protocol's 50k-URL limit);
    // the `/explore` index plus per-flow detail pages keep us within one sitemap file.
    const refs = await getMarketplaceService().getSitemapRefs();
    const base = getBaseUrl();
    // Detail loc must match the canonical Step-7 SSR page path (`/w/{handle}/{slug}`).
    const entries = [`  <url>\n    <loc>${base}/explore</loc>\n  </url>`].concat(
      refs
        .filter((r) => r.ownerHandle)
        .map(
          (r) =>
            `  <url>\n    <loc>${base}/w/${r.ownerHandle}/${r.slug}</loc>\n    <lastmod>${r.updatedAt.toISOString()}</lastmod>\n  </url>`,
        ),
    );
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.send(xml);
  }),
);

// GET /api/public/marketplace/listings/:handle/:slug — detail
router.get(
  "/listings/:handle/:slug",
  asyncHandler(async (req: Request, res: Response) => {
    const reference = `${req.params.handle}/${req.params.slug}`;
    const service = getMarketplaceService();
    const detail = await service.getDetailByReference(reference, ANONYMOUS);
    // View signal is fire-and-forget telemetry: do NOT await it (it must not add
    // latency to the response), and log rather than swallow if it fails.
    void service.recordView(detail.listing.id, null).catch((err) => {
      logger.warn("Failed to record marketplace view", {
        listingId: detail.listing.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    ok(res, detail);
  }),
);

// GET /api/public/marketplace/listings/:handle/:slug/reviews
router.get(
  "/listings/:handle/:slug/reviews",
  asyncHandler(async (req: Request, res: Response) => {
    const reference = `${req.params.handle}/${req.params.slug}`;
    const reviews = await getMarketplaceService().getReviewsByReference(reference);
    ok(res, { reviews });
  }),
);

// GET /api/public/marketplace/listings/:handle/:slug/export — purchase-gated download
router.get(
  "/listings/:handle/:slug/export",
  asyncHandler(async (req: Request, res: Response) => {
    const reference = `${req.params.handle}/${req.params.slug}`;
    const { listing, workflow } = await getMarketplaceService().exportListing(reference, ANONYMOUS);
    const filename = `${req.params.slug}.json`;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(
      JSON.stringify({ listing: { id: listing.id, title: listing.title }, workflow }, null, 2),
    );
  }),
);

export { router as marketplacePublicRoutes };
