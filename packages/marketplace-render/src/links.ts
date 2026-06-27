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

/**
 * The `/explore` gallery href for a given filter + locale. Combines the `?official=true`
 * filter (omitted for the "All" view) with the language query (omitted for the default
 * `en`) so each chip is a crawlable, SSR-navigable URL that preserves the active language.
 */
export function exploreHref(baseUrl: string, locale: MarketplaceLocale, official: boolean): string {
  const params: string[] = [];
  if (official) params.push("official=true");
  if (locale !== "en") params.push(`lang=${locale}`);
  const query = params.length > 0 ? `?${params.join("&")}` : "";
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
