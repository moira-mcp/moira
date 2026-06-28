/**
 * renderExploreToHtml — server render entry for the gallery page. Takes already-fetched,
 * viewer-annotated gallery data + the viewer + SEO context and returns a complete HTML
 * document string: semantic `<main>`/`<ul>` markup (crawlable, JS-free), localized
 * counts/enums, and SEO `<head>` with `ItemList` + `BreadcrumbList` JSON-LD.
 *
 * Pure: no I/O. Uses `react-dom/server` `renderToString` (React 18, non-streaming).
 */

import React from "react";
import { renderToString } from "react-dom/server";
import { ExploreGallery } from "../components/ExploreGallery.js";
import { makeLabels } from "../labels.js";
import { buildDocument } from "./document.js";
import { renderChrome } from "./chrome.js";
import { buildItemListJsonLd, buildBreadcrumbJsonLd } from "../seo/jsonld.js";
import type {
  GalleryView,
  ViewerContext,
  SeoContext,
  RenderResult,
  ExploreFilter,
  GalleryFacets,
} from "../types.js";

/** Render the gallery page to a full HTML document. */
export function renderExploreToHtml(
  gallery: GalleryView,
  viewer: ViewerContext | null,
  seo: SeoContext,
  filter?: ExploreFilter,
  facets?: GalleryFacets,
): RenderResult {
  const labels = makeLabels(seo.locale);
  const canonical = `${seo.baseUrl}/explore`;

  const bodyHtml = renderToString(
    React.createElement(ExploreGallery, {
      gallery,
      labels,
      viewer,
      baseUrl: seo.baseUrl,
      filter,
      facets,
    }),
  );
  const chrome = renderChrome(labels, viewer, seo, seo.currentPath ?? "/explore");

  const jsonLd = [
    buildItemListJsonLd(gallery, seo),
    buildBreadcrumbJsonLd([{ name: labels.chrome.exploreTitle, url: canonical }]),
  ];

  const html = buildDocument(
    seo.locale,
    {
      title: `${labels.chrome.exploreTitle} — Moira Marketplace`,
      description: labels.chrome.exploreSubtitle,
      canonical,
      ogType: "website",
      jsonLd,
    },
    bodyHtml,
    chrome,
  );

  return { html };
}
