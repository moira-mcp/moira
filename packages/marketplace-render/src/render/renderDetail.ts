/**
 * renderDetailToHtml — server render entry for a flow detail page. Takes the
 * already-fetched, viewer-annotated detail + the viewer + SEO context and returns a
 * complete HTML document string: semantic `<article>` markup (crawlable, JS-free),
 * localized counts/enums, and SEO `<head>` with `SoftwareApplication` +
 * `BreadcrumbList` JSON-LD.
 *
 * Pure: no I/O. Uses `react-dom/server` `renderToString` (React 18, non-streaming).
 */

import React from "react";
import { renderToString } from "react-dom/server";
import { ListingDetail } from "../components/ListingDetail.js";
import { makeLabels } from "../labels.js";
import { buildDocument } from "./document.js";
import { renderChrome } from "./chrome.js";
import { buildSoftwareApplicationJsonLd, buildBreadcrumbJsonLd } from "../seo/jsonld.js";
import type { DetailView, ViewerContext, SeoContext, RenderResult } from "../types.js";

/** Render a flow detail page to a full HTML document. */
export function renderDetailToHtml(
  detail: DetailView,
  viewer: ViewerContext | null,
  seo: SeoContext,
): RenderResult {
  const labels = makeLabels(seo.locale);
  const canonical = `${seo.baseUrl}/w/${detail.reference}`;

  const bodyHtml = renderToString(
    React.createElement(ListingDetail, {
      detail,
      labels,
      viewer,
      baseUrl: seo.baseUrl,
      appPrefix: seo.appPrefix ?? "",
    }),
  );
  const chrome = renderChrome(labels, viewer, seo, seo.currentPath ?? `/w/${detail.reference}`);

  const jsonLd = [
    buildSoftwareApplicationJsonLd(detail, seo),
    buildBreadcrumbJsonLd([
      { name: labels.chrome.exploreTitle, url: `${seo.baseUrl}/explore` },
      { name: detail.title, url: canonical },
    ]),
  ];

  const html = buildDocument(
    seo.locale,
    {
      title: `${detail.title} — Moira Marketplace`,
      description: detail.summary ?? `${detail.title}: a published Moira workflow you can adopt.`,
      canonical,
      ogType: "article",
      jsonLd,
    },
    bodyHtml,
    chrome,
  );

  return { html };
}
