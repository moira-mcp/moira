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
} from "@mcp-moira/shared/i18n";

/** Static (non-countable) presentation strings, per locale. */
interface ChromeStrings {
  exploreTitle: string;
  exploreSubtitle: string;
  exploreEmpty: string;
  /** No-results copy when a search/filter is active (distinct from an empty catalog). */
  exploreNoMatch: string;
  /** Link that clears the active search/filters back to the full catalog. */
  clearSearch: string;
  /** Gallery filter chips: the unfiltered set, the Official set, the Community set. */
  filterAll: string;
  filterOfficial: string;
  filterCommunity: string;
  backToExplore: string;
  unrated: string;
  verified: string;
  by: string;
  inLibrary: string;
  yourListing: string;
  signInToAdd: string;
  tagsLabel: string;
  notFoundTitle: string;
  /**
   * "How to use" section (replaces the old MCP `start(...)` code hint). Moira is an MCP
   * utility — the END USER does not run MCP tools; they ADD the flow to their agent's
   * library (or export/import on self-host) and then ASK THEIR AGENT to run it in plain
   * language. These strings convey that human model, not a developer command.
   */
  howToUse: string;
  adoptStep: string;
  adoptCloud: string;
  adoptSelfHost: string;
  runStep: string;
  runLead: string;
  /** Imperative verb the user says to their agent (e.g. `run "<title>"`). */
  runVerb: string;
  /** Page-chrome strings (header/footer controls). */
  signIn: string;
  signOut: string;
  addToLibrary: string;
  /** Adopt button transient + failure states (storefront has no toast lib). */
  adding: string;
  adoptError: string;
  /** Export a flow as a `.json` file (works with JS off; gated server-side). */
  download: string;
  /** Import a workflow file into the library (self-host adoption path). */
  importFromFile: string;
  /** Inline failure message for the import-from-file control. */
  importError: string;
  /** Cross-app link back into the SPA for a signed-in viewer. */
  backToLibrary: string;
  themeToggleLabel: string;
  languageLabel: string;
  accountLabel: string;
  docsLabel: string;
  homeLabel: string;
  footerTagline: string;
}

const CHROME: Record<MarketplaceLocale, ChromeStrings> = {
  en: {
    exploreTitle: "Explore workflows",
    exploreSubtitle: "Ready-to-run agent processes you can adopt and run in your MCP client.",
    exploreEmpty: "No published workflows yet.",
    exploreNoMatch: "No workflows match your filters.",
    clearSearch: "Clear filters",
    filterAll: "All",
    filterOfficial: "Official",
    filterCommunity: "Community",
    backToExplore: "Explore",
    unrated: "Unrated",
    verified: "Verified",
    by: "by",
    inLibrary: "In your library",
    yourListing: "Your listing",
    signInToAdd: "Sign in to add",
    tagsLabel: "Tags",
    notFoundTitle: "Not found",
    howToUse: "How to use it",
    adoptStep: "Add it to your agent",
    adoptCloud: "Add it to your library so your agent can run it on demand.",
    adoptSelfHost: "Self-hosting? Export this workflow and import the file into your instance.",
    runStep: "Run it",
    runLead: "Then just ask your agent",
    runVerb: "run",
    signIn: "Sign in",
    signOut: "Sign out",
    addToLibrary: "Add to library",
    adding: "Adding…",
    adoptError: "Couldn't add it. Try again.",
    download: "Download",
    importFromFile: "Import from file",
    importError: "Couldn't import that file.",
    backToLibrary: "Back to library",
    themeToggleLabel: "Toggle theme",
    languageLabel: "Language",
    accountLabel: "Account",
    docsLabel: "Documentation",
    homeLabel: "Explore",
    footerTagline: "A catalog of agent-executable, validated workflows.",
  },
  ru: {
    exploreTitle: "Каталог воркфлоу",
    exploreSubtitle: "Готовые агентные процессы, которые можно добавить и запустить в MCP-клиенте.",
    exploreEmpty: "Пока нет опубликованных воркфлоу.",
    exploreNoMatch: "Нет воркфлоу по вашему запросу.",
    clearSearch: "Сбросить фильтры",
    filterAll: "Все",
    filterOfficial: "Официальные",
    filterCommunity: "Сообщество",
    backToExplore: "Каталог",
    unrated: "Без оценок",
    verified: "Проверено",
    by: "от",
    inLibrary: "В вашей библиотеке",
    yourListing: "Ваша публикация",
    signInToAdd: "Войдите, чтобы добавить",
    tagsLabel: "Теги",
    notFoundTitle: "Не найдено",
    howToUse: "Как использовать",
    adoptStep: "Добавьте для своего агента",
    adoptCloud: "Добавьте флоу в свою библиотеку, чтобы агент мог запускать его по запросу.",
    adoptSelfHost:
      "Используете self-host? Экспортируйте этот воркфлоу и импортируйте файл в свой инстанс.",
    runStep: "Запуск",
    runLead: "Затем просто попросите своего агента",
    runVerb: "запусти",
    signIn: "Войти",
    signOut: "Выйти",
    addToLibrary: "Добавить в библиотеку",
    adding: "Добавление…",
    adoptError: "Не удалось добавить. Попробуйте ещё раз.",
    download: "Скачать",
    importFromFile: "Импорт из файла",
    importError: "Не удалось импортировать файл.",
    backToLibrary: "Назад в библиотеку",
    themeToggleLabel: "Переключить тему",
    languageLabel: "Язык",
    accountLabel: "Аккаунт",
    docsLabel: "Документация",
    homeLabel: "Каталог",
    footerTagline: "Каталог проверенных воркфлоу, исполняемых агентами.",
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
  /** `"<n> results"` correctly pluralized for the locale (filtered/search count). */
  results(count: number): string;
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
    results: (count) => formatMarketplaceCount(locale, "results", count),
  };
}
