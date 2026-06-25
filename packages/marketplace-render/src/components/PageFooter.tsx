/**
 * PageFooter — the public catalog's footer: brand mark, a short tagline, and a couple of
 * navigation links (Explore, Documentation). PURE + SSR-safe, token-styled, low-emphasis.
 */

import React from "react";
import type { Labels } from "../labels.js";
import type { MarketplaceLocale } from "@mcp-moira/shared/i18n";
import { withLang } from "../links.js";

export interface PageFooterProps {
  labels: Labels;
  locale: MarketplaceLocale;
  baseUrl: string;
  appPrefix: string;
}

export function PageFooter({
  labels,
  locale,
  baseUrl,
  appPrefix,
}: PageFooterProps): React.ReactElement {
  const docsHref = locale === "ru" ? `${appPrefix}/ru/docs` : `${appPrefix}/docs`;
  return (
    <footer className="mp-footer" data-mp="footer">
      <div className="mp-footer-inner">
        <span className="mp-footer-brand">
          <span aria-hidden="true">⚡</span> Moira
        </span>
        <span className="mp-footer-tagline">{labels.chrome.footerTagline}</span>
        <nav className="mp-footer-links" aria-label="Footer">
          <a href={withLang(`${baseUrl}/explore`, locale)}>{labels.chrome.homeLabel}</a>
          <a href={docsHref}>{labels.chrome.docsLabel}</a>
        </nav>
      </div>
    </footer>
  );
}
