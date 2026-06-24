/**
 * Document shell — wraps a server-rendered body fragment in a complete HTML document
 * with the SEO `<head>` (built by {@link buildHead}) and the critical CSS. Kept as a
 * string template (not a React component) because `<!DOCTYPE html>` and the raw `<head>`
 * markup are document-level concerns, not part of the hydratable React tree. The body
 * fragment is already a sanitized `renderToString` output.
 */

import { buildHead, type HeadOptions } from "../seo/head.js";
import { escapeHtml } from "../seo/escape.js";
import type { MarketplaceLocale } from "@mcp-moira/shared/i18n";

/** Critical inline CSS — JS-free, SEO-fast first paint (ported from the interim shell). */
const CRITICAL_CSS = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2328; margin: 0; line-height: 1.55; background: #fff; }
  .mp-wrap { max-width: 980px; margin: 0 auto; padding: 28px 20px 64px; }
  a { color: #0969da; text-decoration: none; } a:hover { text-decoration: underline; }
  .mp-header { border-bottom: 1px solid #d0d7de; padding-bottom: 14px; margin-bottom: 22px; }
  .mp-header h1 { font-size: 1.4rem; margin: 0; }
  .mp-subtitle, .mp-total, .mp-card-summary { color: #656d76; }
  .mp-card-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; }
  .mp-card { border: 1px solid #d0d7de; border-radius: 10px; padding: 16px 18px; }
  .mp-card-title { font-size: 1.05rem; margin: 0 0 4px; }
  .mp-card-meta, .mp-detail-meta { color: #656d76; font-size: 0.85rem; margin-top: 8px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
  .mp-detail-stats { color: #656d76; font-size: 0.85rem; margin-top: 8px; }
  .mp-badge { display: inline-block; font-size: 0.75rem; border: 1px solid #d0d7de; border-radius: 999px; padding: 1px 8px; }
  .mp-pill { display: inline-block; font-size: 0.75rem; border-radius: 999px; padding: 1px 8px; margin-top: 8px; background: #ddf4ff; }
  .mp-detail-title { font-size: 1.5rem; margin: 0 0 6px; }
  code { background: #f6f8fa; padding: 1px 5px; border-radius: 5px; font-family: ui-monospace, Menlo, Consolas, monospace; }
`;

/** Wrap a rendered body fragment in a full SEO-complete HTML document. */
export function buildDocument(
  locale: MarketplaceLocale,
  head: HeadOptions,
  bodyHtml: string,
): string {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}">
<head>
${buildHead(head)}
<style>${CRITICAL_CSS}</style>
</head>
<body>
<div class="mp-wrap" id="root">${bodyHtml}</div>
</body>
</html>
`;
}
