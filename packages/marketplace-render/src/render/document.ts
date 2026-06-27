/**
 * Document shell — wraps the server-rendered page (chrome header + catalog body + footer)
 * in a complete HTML document with the SEO `<head>` (built by {@link buildHead}), the
 * critical CSS, and the no-flash theme bootstrap. Kept as a string template (not a React
 * component) because `<!DOCTYPE html>` and the raw `<head>` markup are document-level
 * concerns, not part of the hydratable React tree. The body fragments are already
 * sanitized `renderToString` output.
 *
 * The page is visually consistent with the SPA: the design tokens below are the same
 * oklch custom properties the app uses (`globals.css`), light in `:root` and dark in
 * `.dark`, so the public catalog shares one palette and dark mode without importing the
 * SPA's Tailwind build. The catalog body lives inside `#root` (React-hydrated); the
 * chrome header/footer are static markup the hydration entry enhances imperatively.
 */

import { buildHead, type HeadOptions } from "../seo/head.js";
import { escapeHtml } from "../seo/escape.js";
import type { MarketplaceLocale } from "@mcp-moira/shared/i18n";

/** Optional chrome (header/footer) HTML to render around the catalog body. */
export interface DocumentChrome {
  headerHtml: string;
  footerHtml: string;
}

/**
 * No-flash theme bootstrap. Runs synchronously in `<head>` before first paint and
 * mirrors the SPA's `useTheme`: reads localStorage `"theme"` (`light|dark|system`,
 * shared same-origin with the app) and resolves `system` via `prefers-color-scheme`,
 * then sets the matching class on `<html>`. With JS disabled the page defaults to the
 * light tokens in `:root` (fully readable). Static string — no user data interpolated.
 */
export const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("theme")||"system";var d=t==="dark"||(t==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.add(d?"dark":"light");}catch(e){}})();`;

/** Critical inline CSS: design tokens + reset + chrome + gallery + detail. JS-free. */
const CRITICAL_CSS = `
:root {
  --background: oklch(0.985 0.002 260); --foreground: oklch(0.145 0.015 260);
  --card: oklch(1 0 0); --card-foreground: oklch(0.145 0.015 260);
  --primary: oklch(0.488 0.2 264); --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.96 0.008 264); --secondary-foreground: oklch(0.24 0.02 264);
  --muted: oklch(0.965 0.005 264); --muted-foreground: oklch(0.5 0.02 264);
  --accent: oklch(0.94 0.015 264); --accent-foreground: oklch(0.24 0.02 264);
  --success: oklch(0.517 0.174 142); --border: oklch(0.9 0.01 264);
  --ring: oklch(0.488 0.2 264); --radius: 0.5rem;
}
.dark {
  --background: oklch(0.19 0.012 260); --foreground: oklch(0.985 0 0);
  --card: oklch(0.22 0.012 260); --card-foreground: oklch(0.985 0 0);
  --primary: oklch(0.65 0.22 264); --primary-foreground: oklch(0.985 0 0);
  --secondary: oklch(0.3 0.015 260); --secondary-foreground: oklch(0.985 0 0);
  --muted: oklch(0.3 0.015 260); --muted-foreground: oklch(0.708 0.01 260);
  --accent: oklch(0.3 0.015 260); --accent-foreground: oklch(0.985 0 0);
  --success: oklch(0.448 0.15 150); --border: oklch(0.34 0.015 260);
  --ring: oklch(0.65 0.22 264);
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  background: var(--background); color: var(--foreground); line-height: 1.55;
  display: flex; flex-direction: column; min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }
code {
  background: var(--secondary); color: var(--secondary-foreground);
  padding: 1px 6px; border-radius: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em;
}

/* ---- Top bar ---- */
.mp-topbar {
  position: sticky; top: 0; z-index: 20;
  background: color-mix(in oklab, var(--background) 86%, transparent);
  backdrop-filter: saturate(1.4) blur(8px);
  border-bottom: 1px solid var(--border);
}
.mp-topbar-inner {
  max-width: 1080px; margin: 0 auto; padding: 10px 20px;
  display: flex; align-items: center; gap: 16px;
}
.mp-brand {
  display: inline-flex; align-items: center; gap: 8px;
  font-weight: 700; font-size: 1.1rem; color: var(--foreground);
}
.mp-brand:hover { text-decoration: none; }
.mp-brand-mark { color: var(--primary); font-size: 1.15rem; }
.mp-controls { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.mp-icon-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; padding: 0; cursor: pointer;
  background: transparent; color: var(--foreground);
  border: 1px solid var(--border); border-radius: 8px; font-size: 1rem; line-height: 1;
}
.mp-icon-btn:hover { background: var(--accent); }
.mp-lang { display: inline-flex; align-items: center; gap: 4px; font-size: 0.82rem; }
.mp-lang-opt { color: var(--muted-foreground); padding: 2px 4px; border-radius: 5px; }
.mp-lang-opt:hover { text-decoration: none; color: var(--foreground); }
.mp-lang-active { color: var(--foreground); font-weight: 700; }
.mp-lang-sep { color: var(--border); }
.mp-btn {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
  font-size: 0.85rem; font-weight: 600; padding: 7px 14px; border-radius: 8px;
  border: 1px solid transparent; line-height: 1;
}
.mp-btn:hover { text-decoration: none; }
.mp-btn-primary { background: var(--primary); color: var(--primary-foreground); }
.mp-btn-primary:hover { filter: brightness(1.06); }
.mp-btn-ghost { background: transparent; color: var(--foreground); border-color: var(--border); }
.mp-btn-ghost:hover { background: var(--accent); }
.mp-btn-sm { font-size: 0.8rem; padding: 5px 11px; }
.mp-btn:disabled { opacity: 0.6; cursor: default; filter: none; }
.mp-import-input { display: none; }
.mp-account { display: inline-flex; align-items: center; gap: 8px; }
.mp-avatar {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--primary); color: var(--primary-foreground);
  font-size: 0.72rem; font-weight: 700;
}
.mp-account-handle { font-size: 0.85rem; color: var(--muted-foreground); }

/* ---- Content wrap ---- */
.mp-wrap { width: 100%; max-width: 1080px; margin: 0 auto; padding: 44px 20px 64px; flex: 1 0 auto; }
.mp-header { margin-bottom: 32px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
.mp-header h1 { font-size: 2.2rem; line-height: 1.1; margin: 0 0 10px; letter-spacing: -0.025em; }
.mp-subtitle { color: var(--muted-foreground); margin: 0 0 14px; max-width: 60ch; font-size: 1.05rem; line-height: 1.55; }
.mp-total {
  color: var(--muted-foreground); font-size: 0.78rem; margin: 0; font-weight: 700;
  text-transform: uppercase; letter-spacing: 0.06em;
}

/* ---- Filter chips ---- */
.mp-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.mp-chip {
  display: inline-flex; align-items: center; font-size: 0.82rem; font-weight: 600;
  padding: 5px 14px; border-radius: 999px; cursor: pointer;
  background: var(--card); color: var(--muted-foreground); border: 1px solid var(--border);
}
.mp-chip:hover { text-decoration: none; color: var(--foreground); border-color: color-mix(in oklab, var(--primary) 40%, var(--border)); }
.mp-chip-active {
  background: var(--primary); color: var(--primary-foreground); border-color: transparent;
}
.mp-chip-active:hover { color: var(--primary-foreground); filter: brightness(1.06); }

/* ---- Gallery grid ---- */
.mp-card-list {
  list-style: none; padding: 0; margin: 0;
  display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
}
.mp-card {
  background: var(--card); color: var(--card-foreground);
  border: 1px solid var(--border); border-radius: 14px; padding: 20px 22px;
  display: flex; flex-direction: column; gap: 10px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}
.mp-card:hover {
  border-color: color-mix(in oklab, var(--primary) 45%, var(--border));
  box-shadow: 0 10px 30px -16px color-mix(in oklab, var(--primary) 50%, transparent);
  transform: translateY(-3px);
}
.mp-card-title { font-size: 1.12rem; font-weight: 650; margin: 0; line-height: 1.3; letter-spacing: -0.01em; }
.mp-card-title a { color: var(--foreground); }
.mp-card-title a:hover { color: var(--primary); text-decoration: none; }
.mp-card-summary {
  color: var(--muted-foreground); font-size: 0.9rem; margin: 0;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.mp-card-meta, .mp-detail-meta {
  color: var(--muted-foreground); font-size: 0.82rem; margin-top: auto;
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding-top: 4px;
}
.mp-badge {
  display: inline-flex; align-items: center; font-size: 0.72rem; font-weight: 600;
  border: 1px solid var(--border); border-radius: 999px; padding: 2px 9px; color: var(--foreground);
}
.mp-badge-verified { border-color: color-mix(in oklab, var(--success) 60%, var(--border)); color: var(--success); }
.mp-badge-category { background: var(--secondary); border-color: transparent; color: var(--secondary-foreground); }
.mp-rating { color: var(--foreground); }
.mp-rating-empty { color: var(--muted-foreground); }
.mp-owner { color: var(--muted-foreground); }
.mp-pill {
  display: inline-flex; align-self: flex-start; font-size: 0.72rem; font-weight: 600;
  border-radius: 999px; padding: 2px 10px; margin-top: 2px;
}
.mp-pill-library { background: color-mix(in oklab, var(--primary) 16%, transparent); color: var(--primary); }
.mp-pill-own { background: color-mix(in oklab, var(--success) 18%, transparent); color: var(--success); }

/* ---- Adopt / download action rows (card + detail) ---- */
.mp-card-actions {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
  margin-top: 6px; padding-top: 10px; border-top: 1px solid var(--border);
}
.mp-detail-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0 0 8px; }
.mp-adopt-error { font-size: 0.82rem; color: oklch(0.6 0.2 25); }

/* ---- Detail ---- */
.mp-detail { max-width: 760px; }
.mp-breadcrumb { font-size: 0.85rem; margin-bottom: 18px; }
.mp-breadcrumb a { color: var(--muted-foreground); }
.mp-breadcrumb a:hover { color: var(--primary); }
.mp-detail-title { font-size: 2.1rem; line-height: 1.15; margin: 0 0 14px; letter-spacing: -0.02em; }
.mp-detail .mp-detail-meta { margin-top: 0; margin-bottom: 18px; }
.mp-detail-summary { font-size: 1.08rem; line-height: 1.6; margin: 18px 0; color: var(--foreground); }
.mp-detail-stats { color: var(--muted-foreground); font-size: 0.9rem; margin: 10px 0 4px; }
.mp-detail-tags { color: var(--muted-foreground); }

/* ---- How-to-use panel (human adopt + run model; no MCP code command) ---- */
.mp-howto {
  background: var(--card); border: 1px solid var(--border); border-radius: 16px;
  padding: 24px 26px; margin: 28px 0 8px;
}
.mp-howto-title { font-size: 1.15rem; margin: 0 0 18px; letter-spacing: -0.01em; }
.mp-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 22px; }
.mp-step { display: grid; grid-template-columns: 32px 1fr; gap: 14px; align-items: start; }
.mp-step-num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 32px; height: 32px; border-radius: 50%; font-size: 0.95rem; font-weight: 700;
  background: color-mix(in oklab, var(--primary) 14%, transparent); color: var(--primary);
}
.mp-step-body { min-width: 0; }
.mp-step-title { font-size: 1rem; margin: 4px 0 8px; }
.mp-step-text { margin: 0 0 12px; color: var(--muted-foreground); }
.mp-step-note { margin: 12px 0 0; font-size: 0.85rem; color: var(--muted-foreground); }
.mp-say {
  margin: 0; padding: 12px 16px; border-radius: 10px;
  background: var(--secondary); color: var(--secondary-foreground);
  border-left: 3px solid var(--primary); font-size: 1.02rem; font-weight: 500;
}

/* ---- Footer ---- */
.mp-footer { border-top: 1px solid var(--border); flex-shrink: 0; }
.mp-footer-inner {
  max-width: 1080px; margin: 0 auto; padding: 22px 20px;
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px;
  font-size: 0.85rem; color: var(--muted-foreground);
}
.mp-footer-brand { font-weight: 700; color: var(--foreground); }
.mp-footer-tagline { flex: 1 1 auto; }
.mp-footer-links { display: flex; gap: 16px; }

/* ---- 404 ---- */
.mp-notfound { text-align: center; padding: 48px 0; }

@media (max-width: 560px) {
  .mp-account-handle { display: none; }
  .mp-header h1 { font-size: 1.45rem; }
  .mp-detail-title { font-size: 1.55rem; }
}
`;

/** Wrap a rendered body fragment (+ optional chrome) in a full SEO-complete document. */
export function buildDocument(
  locale: MarketplaceLocale,
  head: HeadOptions,
  bodyHtml: string,
  chrome?: DocumentChrome,
): string {
  const header = chrome ? chrome.headerHtml : "";
  const footer = chrome ? chrome.footerHtml : "";
  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}">
<head>
${buildHead(head)}
<style>${CRITICAL_CSS}</style>
<script>${THEME_BOOTSTRAP}</script>
</head>
<body>
${header}
<div class="mp-wrap" id="root">${bodyHtml}</div>
${footer}
</body>
</html>
`;
}
