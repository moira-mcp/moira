/**
 * renderChrome — renders the page header + footer to HTML strings for {@link
 * buildDocument}. Shared by the gallery and detail render entries so both pages carry
 * the same session-aware top bar (brand, theme toggle, EN/RU switch, auth control) and
 * footer. Pure: `renderToString` of the pure {@link PageHeader}/{@link PageFooter}.
 */

import React from "react";
import { renderToString } from "react-dom/server";
import { PageHeader } from "../components/PageHeader.js";
import { PageFooter } from "../components/PageFooter.js";
import type { Labels } from "../labels.js";
import type { ViewerContext, SeoContext } from "../types.js";
import type { DocumentChrome } from "./document.js";

/** Build the header/footer HTML for a page at `currentPath`. */
export function renderChrome(
  labels: Labels,
  viewer: ViewerContext | null,
  seo: SeoContext,
  currentPath: string,
): DocumentChrome {
  const appPrefix = seo.appPrefix ?? "";
  const headerHtml = renderToString(
    React.createElement(PageHeader, {
      labels,
      viewer,
      locale: seo.locale,
      baseUrl: seo.baseUrl,
      currentPath,
      appPrefix,
    }),
  );
  const footerHtml = renderToString(
    React.createElement(PageFooter, {
      labels,
      locale: seo.locale,
      baseUrl: seo.baseUrl,
      appPrefix,
    }),
  );
  return { headerHtml, footerHtml };
}
