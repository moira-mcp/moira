/**
 * Server-rendered PUBLIC marketplace pages (SEO) — mounted at the ROOT (not /api),
 * no auth, behind `apiLimiter`. Rendered server-side from the LIVE database per
 * request, so a flow published a second ago is immediately listed and crawlable with
 * no image rebuild (the freshness requirement). The HTML is fully readable with
 * JavaScript off (progressive enhancement); the SPA is linked for interactivity.
 *
 *   GET /explore              gallery of listed flows (crawlable HTML + meta)
 *   GET /w/:handle/:slug      flow detail (HTML + OpenGraph + JSON-LD)
 *   GET /sitemap.xml          dynamic sitemap (/explore + every /w/{handle}/{slug})
 *
 * nginx routes these paths to the web-backend instead of the SPA catch-all
 * (config/nginx-root.conf + config/nginx-app.conf).
 */

import { Router, Request, Response } from "express";
import {
  getMarketplaceService,
  getBaseUrl,
  isDomainError,
  MarketplaceDisabledError,
  type GalleryItem,
  type ListingDetail,
} from "@mcp-moira/shared";
import { apiLimiter } from "../middleware/rate-limit-middleware.js";

const router = Router();

// Render fresh per request, but let crawlers/CDNs cache the HTML briefly.
const PAGE_CACHE_CONTROL = "public, max-age=60";

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Make a JSON string safe to embed inside a <script> element: escape `<` so a value
 * like "</script>" cannot break out of the tag. (U+2028/U+2029 need no handling — the
 * block is parsed as JSON-LD data, not executed as a JS string literal.)
 */
function jsonLdSafe(json: string): string {
  return json.replace(/</g, "\\u003c");
}

function parseTags(tags: string): string[] {
  try {
    const parsed = JSON.parse(tags || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

interface HeadOptions {
  title: string;
  description: string;
  canonical: string;
  ogType?: string;
  jsonLd?: string;
}

/** A SEO-complete HTML document shell. */
function layout(head: HeadOptions, body: string): string {
  const description = esc(head.description).slice(0, 320);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(head.title)}</title>
<meta name="description" content="${description}" />
<link rel="canonical" href="${esc(head.canonical)}" />
<meta property="og:type" content="${esc(head.ogType ?? "website")}" />
<meta property="og:title" content="${esc(head.title)}" />
<meta property="og:description" content="${description}" />
<meta property="og:url" content="${esc(head.canonical)}" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${esc(head.title)}" />
<meta name="twitter:description" content="${description}" />
${head.jsonLd ? `<script type="application/ld+json">${jsonLdSafe(head.jsonLd)}</script>` : ""}
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2328; margin: 0; line-height: 1.55; background: #fff; }
  .wrap { max-width: 980px; margin: 0 auto; padding: 28px 20px 64px; }
  a { color: #0969da; text-decoration: none; } a:hover { text-decoration: underline; }
  header.site { border-bottom: 1px solid #d0d7de; padding-bottom: 14px; margin-bottom: 22px; }
  header.site h1 { font-size: 1.4rem; margin: 0; }
  .muted { color: #656d76; }
  ul.flows { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; }
  li.flow { border: 1px solid #d0d7de; border-radius: 10px; padding: 16px 18px; }
  li.flow h2 { font-size: 1.05rem; margin: 0 0 4px; }
  .meta { color: #656d76; font-size: 0.85rem; margin-top: 8px; }
  .badge { display: inline-block; font-size: 0.75rem; border: 1px solid #d0d7de; border-radius: 999px; padding: 1px 8px; margin-right: 6px; }
  .detail h1 { font-size: 1.5rem; margin: 0 0 6px; }
  code { background: #f6f8fa; padding: 1px 5px; border-radius: 5px; font-family: ui-monospace, Menlo, Consolas, monospace; }
</style>
</head>
<body>
<div class="wrap">
${body}
</div>
</body>
</html>
`;
}

function flowCard(item: GalleryItem, baseUrl: string): string {
  const ref = item.ownerHandle ? `${item.ownerHandle}/${item.slug}` : item.slug;
  const url = `${baseUrl}/w/${esc(ref)}`;
  const rating =
    item.ratingCount > 0 ? `★ ${item.ratingAvg.toFixed(1)} (${item.ratingCount})` : "Unrated";
  return `<li class="flow">
  <h2><a href="${url}">${esc(item.title)}</a></h2>
  ${item.summary ? `<p class="muted">${esc(item.summary)}</p>` : ""}
  <div class="meta">
    ${item.verified ? `<span class="badge">verified</span>` : ""}
    <span class="badge">${esc(item.category)}</span>
    ${rating} · ${item.installCount} installs${item.ownerHandle ? ` · by ${esc(item.ownerHandle)}` : ""}
  </div>
</li>`;
}

function renderGallery(items: GalleryItem[], total: number, baseUrl: string): string {
  const list =
    items.length > 0
      ? `<ul class="flows">${items.map((i) => flowCard(i, baseUrl)).join("\n")}</ul>`
      : `<p class="muted">No published workflows yet.</p>`;
  const body = `<header class="site"><h1>Explore workflows</h1>
  <p class="muted">${total} published workflow${total === 1 ? "" : "s"} in the marketplace.</p></header>
  ${list}`;
  return layout(
    {
      title: "Explore workflows — Moira Marketplace",
      description:
        "Browse published Moira workflows: ready-to-run agent processes you can adopt and run in your MCP client.",
      canonical: `${baseUrl}/explore`,
    },
    body,
  );
}

function detailJsonLd(detail: ListingDetail, baseUrl: string): string {
  const l = detail.listing;
  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: l.title,
    description: l.summary ?? `${l.title} — a Moira workflow`,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Any",
    url: `${baseUrl}/w/${detail.startRef}`,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  };
  if (detail.ownerHandle) data.author = { "@type": "Person", name: detail.ownerHandle };
  if (l.ratingCount > 0) {
    data.aggregateRating = {
      "@type": "AggregateRating",
      ratingValue: l.ratingAvg.toFixed(1),
      ratingCount: l.ratingCount,
    };
  }
  return JSON.stringify(data);
}

function renderDetail(detail: ListingDetail, baseUrl: string): string {
  const l = detail.listing;
  const tags = parseTags(l.tags);
  const nodeCount = Array.isArray(detail.workflow.nodes) ? detail.workflow.nodes.length : 0;
  const rating =
    l.ratingCount > 0 ? `★ ${l.ratingAvg.toFixed(1)} (${l.ratingCount} ratings)` : "Unrated";
  const body = `<header class="site"><a href="${baseUrl}/explore">← Explore</a></header>
  <div class="detail">
    <h1>${esc(l.title)}</h1>
    <div class="meta">
      ${l.verified ? `<span class="badge">verified</span>` : ""}
      <span class="badge">${esc(l.category)}</span>
      ${rating} · ${l.installCount} installs${detail.ownerHandle ? ` · by ${esc(detail.ownerHandle)}` : ""}
    </div>
    ${l.summary ? `<p>${esc(l.summary)}</p>` : ""}
    <p class="muted">${nodeCount} step${nodeCount === 1 ? "" : "s"}.${tags.length ? ` Tags: ${tags.map(esc).join(", ")}.` : ""}</p>
    <p>Run it in your MCP client: <code>start("${esc(detail.startRef)}")</code> (add it first with <code>marketplace add</code>).</p>
  </div>`;
  return layout(
    {
      title: `${l.title} — Moira Marketplace`,
      description: l.summary ?? `${l.title}: a published Moira workflow you can adopt and run.`,
      canonical: `${baseUrl}/w/${detail.startRef}`,
      ogType: "article",
      jsonLd: detailJsonLd(detail, baseUrl),
    },
    body,
  );
}

function disabledOrMissingPage(baseUrl: string, message: string): string {
  return layout(
    {
      title: "Not found — Moira Marketplace",
      description: message,
      canonical: `${baseUrl}/explore`,
    },
    `<header class="site"><h1>Not found</h1></header><p class="muted">${esc(message)}</p>
     <p><a href="${baseUrl}/explore">Explore workflows</a></p>`,
  );
}

const ANONYMOUS = "__anonymous__";

// GET /explore — gallery
router.get("/explore", apiLimiter, async (_req: Request, res: Response) => {
  const baseUrl = getBaseUrl();
  try {
    const page = await getMarketplaceService().getGallery({ sort: "recent", limit: 100 });
    res.setHeader("Cache-Control", PAGE_CACHE_CONTROL);
    res.type("html").send(renderGallery(page.items, page.total, baseUrl));
  } catch (error) {
    if (error instanceof MarketplaceDisabledError) {
      res
        .status(404)
        .type("html")
        .send(disabledOrMissingPage(baseUrl, "The marketplace is not enabled on this instance."));
      return;
    }
    throw error;
  }
});

// GET /w/:handle/:slug — flow detail
router.get("/w/:handle/:slug", apiLimiter, async (req: Request, res: Response) => {
  const baseUrl = getBaseUrl();
  const reference = `${req.params.handle}/${req.params.slug}`;
  try {
    const service = getMarketplaceService();
    const detail = await service.getDetailByReference(reference, ANONYMOUS);
    void service.recordView(detail.listing.id, null).catch(() => {});
    res.setHeader("Cache-Control", PAGE_CACHE_CONTROL);
    res.type("html").send(renderDetail(detail, baseUrl));
  } catch (error) {
    if (isDomainError(error)) {
      res
        .status(404)
        .type("html")
        .send(disabledOrMissingPage(baseUrl, "This workflow is not available."));
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
