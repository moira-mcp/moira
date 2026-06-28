/**
 * Canonical EN+RU marketplace labels — the single source of truth for the marketplace's
 * countable nouns (with correct plural forms) and enum values (category / listing status /
 * library entry kind). The server-side render layer consumes these directly via
 * {@link formatMarketplaceCount} / {@link marketplaceEnumLabel}; the SPA mirrors the same
 * forms through its i18next resources, so both surfaces render identical text.
 */

import { formatCount, type PluralForms } from "./plural.js";

/** Locales the marketplace UI is localized into. */
export type MarketplaceLocale = "en" | "ru";

/** Normalize an arbitrary locale string (e.g. "ru-RU") to a supported marketplace locale. */
export function toMarketplaceLocale(locale: string | null | undefined): MarketplaceLocale {
  return locale?.slice(0, 2).toLowerCase() === "ru" ? "ru" : "en";
}

/** Countable nouns rendered with a leading count in the marketplace UI. */
export type MarketplaceCountNoun =
  | "installs"
  | "steps"
  | "ratings"
  | "reviews"
  | "published"
  | "results";

/** Correct plural word forms per locale for each countable noun. */
export const MARKETPLACE_COUNTABLE_NOUNS: Record<
  MarketplaceCountNoun,
  Record<MarketplaceLocale, PluralForms>
> = {
  installs: {
    en: { one: "install", other: "installs" },
    ru: { one: "установка", few: "установки", many: "установок", other: "установки" },
  },
  steps: {
    en: { one: "step", other: "steps" },
    ru: { one: "шаг", few: "шага", many: "шагов", other: "шага" },
  },
  ratings: {
    en: { one: "rating", other: "ratings" },
    ru: { one: "оценка", few: "оценки", many: "оценок", other: "оценки" },
  },
  reviews: {
    en: { one: "review", other: "reviews" },
    ru: { one: "отзыв", few: "отзыва", many: "отзывов", other: "отзыва" },
  },
  published: {
    en: { one: "published", other: "published" },
    ru: { one: "опубликован", few: "опубликовано", many: "опубликовано", other: "опубликовано" },
  },
  results: {
    en: { one: "result", other: "results" },
    ru: { one: "результат", few: "результата", many: "результатов", other: "результата" },
  },
};

/** `"<count> <correctly-pluralized noun>"` for the locale (e.g. ru/5/steps → "5 шагов"). */
export function formatMarketplaceCount(
  locale: string,
  noun: MarketplaceCountNoun,
  count: number,
): string {
  const lng = toMarketplaceLocale(locale);
  return formatCount(lng, count, MARKETPLACE_COUNTABLE_NOUNS[noun][lng]);
}

/** Enum families with localized display labels. */
export type MarketplaceEnumKind = "category" | "status" | "kind";

/** Localized labels for every enum value of every family. */
export const MARKETPLACE_ENUM_LABELS: Record<
  MarketplaceEnumKind,
  Record<string, Record<MarketplaceLocale, string>>
> = {
  category: {
    development: { en: "Development", ru: "Разработка" },
    research: { en: "Research", ru: "Исследования" },
    content: { en: "Content", ru: "Контент" },
    data: { en: "Data & Analysis", ru: "Данные и анализ" },
    design: { en: "Design & UX", ru: "Дизайн и UX" },
    testing: { en: "Testing & QA", ru: "Тестирование и QA" },
    marketing: { en: "Marketing", ru: "Маркетинг" },
    productivity: { en: "Productivity", ru: "Продуктивность" },
    other: { en: "Other", ru: "Другое" },
  },
  status: {
    listed: { en: "Listed", ru: "Опубликован" },
    unlisted: { en: "Unlisted", ru: "Снят с публикации" },
    pending: { en: "Pending", ru: "На модерации" },
    rejected: { en: "Rejected", ru: "Отклонён" },
    removed: { en: "Removed", ru: "Удалён" },
  },
  kind: {
    reference: { en: "Reference", ru: "Ссылка" },
    copy: { en: "Copy", ru: "Копия" },
  },
};

/**
 * The localized label for an enum value, falling back to the raw value for unknown
 * values (so an unexpected value renders readably rather than blank).
 */
export function marketplaceEnumLabel(
  locale: string,
  kind: MarketplaceEnumKind,
  value: string,
): string {
  return MARKETPLACE_ENUM_LABELS[kind][value]?.[toMarketplaceLocale(locale)] ?? value;
}
