/**
 * Server-rendered PUBLIC marketplace pages (SEO) — mounted at the ROOT (not /api),
 * no auth, behind `apiLimiter`. Rendered server-side from the LIVE database per
 * request via the `@mcp-moira/marketplace-render` package: the SAME React components
 * are rendered to an HTML string here and hydrated in the browser by the
 * `marketplace-hydrate` bundle. A flow published a second ago is immediately listed
 * and crawlable with no image rebuild (the freshness requirement). The HTML is fully
 * readable with JavaScript off (progressive enhancement); hydration only upgrades
 * interactivity.
 *
 *   GET /explore              gallery of listed flows (component-rendered HTML + meta)
 *   GET /w/:handle/:slug      flow detail (HTML + OpenGraph + JSON-LD)
 *   GET /sitemap.xml          dynamic sitemap (/explore + every /w/{handle}/{slug})
 *
 * This SUPERSEDES the interim string-template implementation: the hand-written
 * `layout()/flowCard()/renderGallery()/renderDetail()` helpers are gone — markup now
 * comes from the render package's components and SEO builders.
 *
 * Anonymous viewer only (this is Step 11): every page renders for `viewer = null`
 * (no library/ownership pills). Session-aware rendering is Step 12.
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
} from "@mcp-moira/marketplace-render";
import { apiLimiter } from "../middleware/rate-limit-middleware.js";

const router = Router();

// Render fresh per request, but let crawlers/CDNs cache the anonymous HTML briefly.
const PAGE_CACHE_CONTROL = "public, max-age=60";

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
  viewer: null;
  seo: SeoContext;
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

/** Pick the render locale from Accept-Language (anonymous viewer has no cookie state). */
function pickLocale(req: Request): MarketplaceLocale {
  const accept = (req.headers["accept-language"] || "").toString();
  const first = accept.split(",")[0]?.trim() ?? "";
  return toMarketplaceLocale(first);
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

// GET /explore — gallery
router.get("/explore", apiLimiter, async (req: Request, res: Response) => {
  const seo: SeoContext = { baseUrl: getBaseUrl(), locale: pickLocale(req) };
  try {
    // Anonymous viewer (null) → all-false annotations, crawler fast-path.
    const page = await getMarketplaceService().getGalleryAnnotated(
      { sort: "recent", limit: 100 },
      null,
    );
    const gallery = toGalleryView(page);
    const { html } = renderExploreToHtml(gallery, null, seo);
    res.setHeader("Cache-Control", PAGE_CACHE_CONTROL);
    res
      .type("html")
      .send(withHydration(html, { page: "explore", gallery, viewer: null, seo }));
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
  const seo: SeoContext = { baseUrl: getBaseUrl(), locale: pickLocale(req) };
  const reference = `${req.params.handle}/${req.params.slug}`;
  try {
    const service = getMarketplaceService();
    // Anonymous viewer (null) → resolves only listed+public flows, no library/own pills.
    const annotated = await service.getDetailByReferenceAnnotated(reference, null);
    void service.recordView(annotated.listing.id, null).catch(() => {});
    const detail = toDetailView(annotated);
    const { html } = renderDetailToHtml(detail, null, seo);
    res.setHeader("Cache-Control", PAGE_CACHE_CONTROL);
    res.type("html").send(withHydration(html, { page: "detail", detail, viewer: null, seo }));
  } catch (error) {
    if (isDomainError(error)) {
      res
        .status(404)
        .type("html")
        .send(notFoundPage(seo, "This workflow is not available."));
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
    res.setHeader("Cache-Control", PAGE_CACHE_CONTROL);
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
