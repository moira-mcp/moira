/**
 * Server-rendered PUBLIC marketplace pages (SEO) — mounted at the ROOT (not /api),
 * behind `apiLimiter`, optional-auth (same-origin session-aware). Rendered server-side
 * from the LIVE database per request via the `@mcp-moira/marketplace-render` package:
 * the SAME React components are rendered to an HTML string here and the catalog body is
 * hydrated in the browser by the `marketplace-hydrate` bundle. A flow published a second
 * ago is immediately listed and crawlable with no image rebuild (the freshness
 * requirement). The HTML is fully readable with JavaScript off (progressive
 * enhancement); hydration only upgrades interactivity.
 *
 *   GET /explore              gallery of listed flows (component-rendered HTML + meta)
 *   GET /w/:handle/:slug      flow detail (HTML + OpenGraph + JSON-LD)
 *   GET /sitemap.xml          dynamic sitemap (/explore + every /w/{handle}/{slug})
 *
 * This SUPERSEDES the interim string-template implementation: the hand-written
 * `layout()/flowCard()/renderGallery()/renderDetail()` helpers are gone — markup now
 * comes from the render package's components and SEO builders.
 *
 * Session-aware: each page reads the same-origin Better Auth session cookie. Anonymous
 * (or invalid/expired) requests render the read-only / sign-in variant with all-false
 * annotations on a publicly cacheable fast path; a signed-in request is enriched with
 * the viewer's library/ownership pills and account header and is non-cacheable. See
 * `resolveViewer` / `applyCacheHeaders`.
 *
 * nginx routes these paths to the web-backend instead of the SPA catch-all
 * (config/nginx-root.conf + config/nginx-app.conf); the hydration bundle is served as
 * a normal static asset from the web root.
 */

import { Router, Request, Response } from "express";
import {
  getMarketplaceService,
  getBaseUrl,
  getAppPrefix,
  isDomainError,
  MarketplaceDisabledError,
  toMarketplaceLocale,
  type MarketplaceLocale,
  type GallerySortOption,
} from "@mcp-moira/shared";
import {
  renderExploreToHtml,
  renderDetailToHtml,
  toGalleryView,
  toDetailView,
  buildDocument,
  makeLabels,
  jsonLdSafe,
  escapeHtml,
  type GalleryView,
  type DetailView,
  type SeoContext,
  type ViewerContext,
  type ExploreFilter,
} from "@mcp-moira/marketplace-render";
import { apiLimiter } from "../middleware/rate-limit-middleware.js";
import { auth } from "../auth.js";
import { toHeaders } from "../utils/headers.js";

const router = Router();

// Anonymous HTML is identical for every signed-out visitor (theme is personalized
// client-side by the no-flash script), so crawlers/CDNs may cache it briefly. Language
// is part of the cache key via `Vary: Accept-Language` (and the `?lang` URL).
const ANON_CACHE_CONTROL = "public, max-age=60";
// Viewer-personalized HTML carries the signed-in header and the viewer's library/own
// state — never cache it, and vary by the session cookie.
const AUTH_CACHE_CONTROL = "private, no-store";

/**
 * Resolve the current viewer from the request's Better Auth session cookie (same-origin,
 * optional-auth). Returns `null` for anonymous, expired, or invalid sessions — those
 * render the public read-only variant on the cacheable fast path (graceful degrade,
 * never an error). The `handle` drives the account chip in the header.
 */
async function resolveViewer(req: Request): Promise<ViewerContext | null> {
  try {
    const session = await auth.api.getSession({ headers: toHeaders(req.headers) });
    if (!session?.user) return null;
    const handle = (session.user as { handle?: string | null }).handle ?? null;
    return { userId: session.user.id, handle };
  } catch {
    return null;
  }
}

/** Apply the cache headers appropriate to the viewer (anonymous cacheable vs private). */
function applyCacheHeaders(res: Response, viewer: ViewerContext | null): void {
  if (viewer) {
    res.setHeader("Cache-Control", AUTH_CACHE_CONTROL);
    res.setHeader("Vary", "Cookie");
  } else {
    res.setHeader("Cache-Control", ANON_CACHE_CONTROL);
    res.setHeader("Vary", "Accept-Language, Cookie");
  }
}

/**
 * Stable hydration bundle URL. The frontend webpack `marketplace-hydrate` entry emits
 * `marketplace-hydrate.js` (no contenthash) so the server can reference it
 * deterministically without a manifest. Served by nginx's static-asset location from
 * the web root; the `defer` script reads the inlined initial-data island and calls
 * `hydrateRoot` on `#root`. The path is base-path aware: root mode → `/…`, our `/app`
 * deploy → `/app/…` (where the frontend dist — and thus this bundle — is published).
 */
function hydrateBundleUrl(): string {
  return `${getAppPrefix()}/marketplace-hydrate.js`;
}

/**
 * `window.__MP__` is the initial-data island: the exact view-model + context the server
 * rendered, so the browser hydrates the SAME tree without a refetch. Serialized as JSON
 * and `<`-escaped (same hardening as JSON-LD) so a malicious title containing
 * `</script>` cannot break out of the inline `<script>` — the payload is parsed as data,
 * never executed as a JS string literal.
 */
interface HydrationIsland {
  page: "explore" | "detail";
  gallery?: GalleryView;
  detail?: DetailView;
  viewer: ViewerContext | null;
  seo: SeoContext;
  /** The active gallery filter (explore only) so the chips hydrate with the same state. */
  filter?: ExploreFilter;
}

/** Build the inline bootstrap `<script>`s (escaped island + deferred hydration bundle). */
function hydrationScripts(island: HydrationIsland): string {
  const json = jsonLdSafe(JSON.stringify(island));
  return (
    `<script id="mp-bootstrap" type="application/json">${json}</script>` +
    `<script src="${hydrateBundleUrl()}" defer></script>`
  );
}

/**
 * Inject the hydration bootstrap before `</body>`. The render package returns a
 * complete document ending in `</body>\n</html>`; we splice the scripts in just before
 * the closing body so the SSR markup (and JSON-LD in `<head>`) is untouched and the
 * page stays fully usable with JS disabled.
 */
function withHydration(html: string, island: HydrationIsland): string {
  return html.replace("</body>", `${hydrationScripts(island)}\n</body>`);
}

/**
 * Pick the render locale: an explicit `?lang=en|ru` query wins (the language switch
 * links + a crawlable per-language URL), else the first `Accept-Language` preference.
 * `toMarketplaceLocale` clamps anything unknown to the default (`en`).
 */
function pickLocale(req: Request): MarketplaceLocale {
  const queryLang = typeof req.query.lang === "string" ? req.query.lang : "";
  if (queryLang) return toMarketplaceLocale(queryLang);
  const accept = (req.headers["accept-language"] || "").toString();
  const first = accept.split(",")[0]?.trim() ?? "";
  return toMarketplaceLocale(first);
}

/** Build the SEO/page context: origin, locale, current path, and the SPA base path. */
function buildSeo(req: Request, currentPath: string): SeoContext {
  return {
    baseUrl: getBaseUrl(),
    locale: pickLocale(req),
    currentPath,
    appPrefix: getAppPrefix(),
  };
}

/** A SEO-complete 404 page rendered via the package's document shell (not the SPA). */
function notFoundPage(seo: SeoContext, message: string): string {
  const labels = makeLabels(seo.locale);
  const body =
    `<main class="mp-notfound" data-mp="notfound">` +
    `<header class="mp-header"><h1>${escapeHtml(labels.chrome.notFoundTitle)}</h1></header>` +
    `<p class="mp-subtitle">${escapeHtml(message)}</p>` +
    `<p><a href="${escapeHtml(seo.baseUrl)}/explore">${escapeHtml(labels.chrome.exploreTitle)}</a></p>` +
    `</main>`;
  return buildDocument(
    seo.locale,
    {
      title: `${labels.chrome.notFoundTitle} — Moira Marketplace`,
      description: message,
      canonical: `${seo.baseUrl}/explore`,
    },
    body,
  );
}

const GALLERY_SORTS: GallerySortOption[] = ["recent", "rating", "installs", "trending"];

/**
 * Parse the supported `/explore` query filters (minimal, mirroring marketplace-public):
 * `?official=true` (the canonical Official set), `?search=` and `?sort=`. The active
 * `official` flag is also returned as an {@link ExploreFilter} for the chips' state.
 */
function parseExploreQuery(req: Request): {
  query: { official?: boolean; search?: string; sort: GallerySortOption; limit: number };
  filter: ExploreFilter;
} {
  const q = req.query;
  const official = q.official === "true";
  const search = typeof q.search === "string" ? q.search : undefined;
  const sort = GALLERY_SORTS.includes(q.sort as GallerySortOption)
    ? (q.sort as GallerySortOption)
    : "recent";
  return {
    query: { official: official ? true : undefined, search, sort, limit: 100 },
    filter: { official },
  };
}

// GET /explore — gallery
router.get("/explore", apiLimiter, async (req: Request, res: Response) => {
  const seo = buildSeo(req, "/explore");
  try {
    // Session-aware: a signed-in viewer gets their own library/ownership annotations and
    // the signed-in header; anonymous (null) gets all-false annotations + crawler
    // fast-path. An invalid/expired session degrades to anonymous.
    const viewer = await resolveViewer(req);
    const { query, filter } = parseExploreQuery(req);
    const page = await getMarketplaceService().getGalleryAnnotated(query, viewer?.userId ?? null);
    const gallery = toGalleryView(page);
    const { html } = renderExploreToHtml(gallery, viewer, seo, filter);
    applyCacheHeaders(res, viewer);
    res.type("html").send(withHydration(html, { page: "explore", gallery, viewer, seo, filter }));
  } catch (error) {
    if (error instanceof MarketplaceDisabledError) {
      res
        .status(404)
        .type("html")
        .send(notFoundPage(seo, "The marketplace is not enabled on this instance."));
      return;
    }
    throw error;
  }
});

// GET /w/:handle/:slug — flow detail
router.get("/w/:handle/:slug", apiLimiter, async (req: Request, res: Response) => {
  const reference = `${req.params.handle}/${req.params.slug}`;
  const seo = buildSeo(req, `/w/${reference}`);
  try {
    const service = getMarketplaceService();
    // Session-aware: a signed-in viewer resolves with their own id (so an owner sees
    // their flow) and gets library/own pills; anonymous resolves listed+public only.
    const viewer = await resolveViewer(req);
    const annotated = await service.getDetailByReferenceAnnotated(
      reference,
      viewer?.userId ?? null,
    );
    void service.recordView(annotated.listing.id, viewer?.userId ?? null).catch(() => {});
    const detail = toDetailView(annotated);
    const { html } = renderDetailToHtml(detail, viewer, seo);
    applyCacheHeaders(res, viewer);
    res.type("html").send(withHydration(html, { page: "detail", detail, viewer, seo }));
  } catch (error) {
    if (isDomainError(error)) {
      res.status(404).type("html").send(notFoundPage(seo, "This workflow is not available."));
      return;
    }
    throw error;
  }
});

// GET /sitemap.xml — dynamic, canonical /w/{handle}/{slug} URLs
router.get("/sitemap.xml", apiLimiter, async (_req: Request, res: Response) => {
  const baseUrl = getBaseUrl();
  try {
    const refs = await getMarketplaceService().getSitemapRefs();
    const entries = [`  <url>\n    <loc>${baseUrl}/explore</loc>\n  </url>`].concat(
      refs
        .filter((r) => r.ownerHandle)
        .map(
          (r) =>
            `  <url>\n    <loc>${baseUrl}/w/${r.ownerHandle}/${r.slug}</loc>\n    <lastmod>${r.updatedAt.toISOString()}</lastmod>\n  </url>`,
        ),
    );
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</urlset>\n`;
    res.setHeader("Cache-Control", ANON_CACHE_CONTROL);
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.send(xml);
  } catch (error) {
    if (error instanceof MarketplaceDisabledError) {
      res.status(404).type("text").send("Marketplace not enabled");
      return;
    }
    throw error;
  }
});

export { router as marketplacePagesRoutes };
