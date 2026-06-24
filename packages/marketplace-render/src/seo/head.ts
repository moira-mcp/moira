/**
 * Per-page `<head>` SEO builder: `<title>`, meta description, canonical link,
 * OpenGraph + Twitter card tags, and the optional JSON-LD block. Emits a single
 * escaped HTML string (the values are interpolated into attributes, so they go through
 * {@link escapeHtml}; the JSON-LD payload is `<`-escaped via {@link serializeJsonLd}).
 *
 * Carries over the interim `marketplace-pages.ts` head completeness (description clamp,
 * canonical, OG + Twitter) and is the single source of `<head>` markup for both render
 * functions.
 */

import { escapeHtml } from "./escape.js";

/** Max characters of meta/OG description (search engines truncate beyond ~320). */
const DESCRIPTION_MAX = 320;

/** Inputs for the head builder. */
export interface HeadOptions {
  title: string;
  description: string;
  canonical: string;
  /** OpenGraph object type (`website` for the gallery, `article` for a detail page). */
  ogType?: string;
  /** Already-serialized, `<`-escaped JSON-LD payloads to embed (one `<script>` each). */
  jsonLd?: string[];
}

/** Build the full `<head>` inner HTML for a page (everything inside `<head>…</head>`). */
export function buildHead(options: HeadOptions): string {
  const description = escapeHtml(options.description).slice(0, DESCRIPTION_MAX);
  const title = escapeHtml(options.title);
  const canonical = escapeHtml(options.canonical);
  const ogType = escapeHtml(options.ogType ?? "website");
  const jsonLdBlocks = (options.jsonLd ?? [])
    .map((block) => `<script type="application/ld+json">${block}</script>`)
    .join("");

  return [
    `<meta charset="utf-8" />`,
    `<meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<link rel="canonical" href="${canonical}" />`,
    `<meta property="og:type" content="${ogType}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:url" content="${canonical}" />`,
    `<meta name="twitter:card" content="summary" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    jsonLdBlocks,
  ].join("\n");
}
