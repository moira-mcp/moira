/**
 * Locale-bound label helpers — a thin adapter over the shared i18n utility
 * (`formatMarketplaceCount` / `marketplaceEnumLabel` from `@mcp-moira/shared`). Counts
 * and enum values rendered by the catalog components MUST flow through here so server
 * output is correctly localized (EN + RU) — never raw enum strings or hand-pluralized
 * counts.
 *
 * The non-countable UI strings (page titles, CTAs, "Unrated", "by") are static EN/RU
 * dictionaries kept local to the render package — they are presentation chrome, not
 * the shared marketplace label data.
 */

import {
  formatMarketplaceCount,
  marketplaceEnumLabel,
  type MarketplaceLocale,
} from "@mcp-moira/shared";

/** Static (non-countable) presentation strings, per locale. */
interface ChromeStrings {
  exploreTitle: string;
  exploreSubtitle: string;
  exploreEmpty: string;
  backToExplore: string;
  unrated: string;
  verified: string;
  by: string;
  inLibrary: string;
  yourListing: string;
  signInToAdd: string;
  startHint: string;
  tagsLabel: string;
  notFoundTitle: string;
}

const CHROME: Record<MarketplaceLocale, ChromeStrings> = {
  en: {
    exploreTitle: "Explore workflows",
    exploreSubtitle: "Ready-to-run agent processes you can adopt and run in your MCP client.",
    exploreEmpty: "No published workflows yet.",
    backToExplore: "Explore",
    unrated: "Unrated",
    verified: "Verified",
    by: "by",
    inLibrary: "In your library",
    yourListing: "Your listing",
    signInToAdd: "Sign in to add",
    startHint: "Run it in your MCP client",
    tagsLabel: "Tags",
    notFoundTitle: "Not found",
  },
  ru: {
    exploreTitle: "Каталог воркфлоу",
    exploreSubtitle: "Готовые агентные процессы, которые можно добавить и запустить в MCP-клиенте.",
    exploreEmpty: "Пока нет опубликованных воркфлоу.",
    backToExplore: "Каталог",
    unrated: "Без оценок",
    verified: "Проверено",
    by: "от",
    inLibrary: "В вашей библиотеке",
    yourListing: "Ваша публикация",
    signInToAdd: "Войдите, чтобы добавить",
    startHint: "Запустите в вашем MCP-клиенте",
    tagsLabel: "Теги",
    notFoundTitle: "Не найдено",
  },
};

/** A locale-bound bundle of label functions used across the catalog components. */
export interface Labels {
  locale: MarketplaceLocale;
  /** Static presentation chrome for this locale. */
  chrome: ChromeStrings;
  /** Localized category label (falls back to the raw value for unknown categories). */
  category(value: string): string;
  /** Localized status label. */
  status(value: string): string;
  /** `"<n> installs"` correctly pluralized for the locale. */
  installs(count: number): string;
  /** `"<n> steps"` correctly pluralized for the locale. */
  steps(count: number): string;
  /** `"<n> ratings"` correctly pluralized for the locale. */
  ratings(count: number): string;
  /** `"<n> published"` correctly pluralized for the locale (gallery total). */
  published(count: number): string;
}

/** Build the locale-bound label bundle for a marketplace locale. */
export function makeLabels(locale: MarketplaceLocale): Labels {
  return {
    locale,
    chrome: CHROME[locale],
    category: (value) => marketplaceEnumLabel(locale, "category", value),
    status: (value) => marketplaceEnumLabel(locale, "status", value),
    installs: (count) => formatMarketplaceCount(locale, "installs", count),
    steps: (count) => formatMarketplaceCount(locale, "steps", count),
    ratings: (count) => formatMarketplaceCount(locale, "ratings", count),
    published: (count) => formatMarketplaceCount(locale, "published", count),
  };
}
