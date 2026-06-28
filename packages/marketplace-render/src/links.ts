/**
 * Language-aware link helpers. The public catalog is stateless about language: the
 * active locale is threaded into every internal href as a `?lang=` query so navigation
 * stays in-language and each language has its own crawlable URL. `en` is the default and
 * canonical, so its internal links carry no query; `ru` links carry `?lang=ru`. The
 * language switcher always emits an explicit `?lang=` for both targets so it can switch
 * away from either language.
 */

import type { MarketplaceLocale } from "@mcp-moira/shared/i18n";

/** `""` for the default (en) locale, `"?lang=ru"` otherwise. */
export function langSuffix(locale: MarketplaceLocale): string {
  return locale === "en" ? "" : `?lang=${locale}`;
}

/** An internal href that preserves the active language (canonical/clean for en). */
export function withLang(path: string, locale: MarketplaceLocale): string {
  return `${path}${langSuffix(locale)}`;
}

/** The language-switch href: the same path, explicitly targeting `target`. */
export function langSwitchHref(currentPath: string, target: MarketplaceLocale): string {
  return `${currentPath}?lang=${target}`;
}

/** The active gallery partition/search for building an `/explore` href. */
export interface ExploreHrefParams {
  official?: boolean;
  community?: boolean;
  /** Preserve the active search term across chip navigation. */
  search?: string;
}

/**
 * The `/explore` gallery href for a given partition/search + locale. Combines the
 * `?official=true` / `?community=true` partition (omitted for the "All" view) and the
 * active `?search=` with the language query (omitted for the default `en`) so each chip is
 * a crawlable, SSR-navigable URL that preserves both the search and the active language.
 */
export function exploreHref(
  baseUrl: string,
  locale: MarketplaceLocale,
  params: ExploreHrefParams = {},
): string {
  const parts: string[] = [];
  if (params.official) parts.push("official=true");
  if (params.community) parts.push("community=true");
  if (params.search) parts.push(`search=${encodeURIComponent(params.search)}`);
  if (locale !== "en") parts.push(`lang=${locale}`);
  const query = parts.length > 0 ? `?${parts.join("&")}` : "";
  return `${baseUrl}/explore${query}`;
}

/**
 * The public export (download) href for a `handle/slug` reference. A plain link to the
 * purchase-gated public export endpoint — works with JS off (progressive enhancement)
 * and is available to anyone (the endpoint enforces access server-side).
 */
export function exportHref(baseUrl: string, reference: string): string {
  return `${baseUrl}/api/public/marketplace/listings/${reference}/export`;
}
