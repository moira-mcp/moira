/**
 * Pluralization / declension primitive (project-level, framework-free).
 *
 * Languages with plural categories (e.g. Russian: 1 шаг / 2 шага / 5 шагов) cannot be
 * pluralized by a single fixed noun form. This module resolves the correct CLDR plural
 * category for a locale+count and formats a count with the matching word form.
 *
 * It depends only on the platform `Intl.PluralRules` — no i18n framework — so BOTH the
 * SPA (which also has i18next for its own keys) and the server-side render layer (which
 * does NOT run i18next) can produce identical forms from the same data.
 */

/** CLDR plural categories. `other` is always required as the fallback. */
export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/** The word forms for a countable noun, keyed by CLDR plural category. */
export type PluralForms = Partial<Record<PluralCategory, string>> & { other: string };

const pluralRulesCache = new Map<string, Intl.PluralRules>();

function pluralRules(locale: string): Intl.PluralRules {
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules;
}

/** The CLDR plural category for `count` in `locale` (e.g. ru/5 → "many"). */
export function pluralCategory(locale: string, count: number): PluralCategory {
  return pluralRules(locale).select(count) as PluralCategory;
}

/**
 * The correct word form for `count` in `locale`, falling back to `other` when the
 * resolved category has no explicit form.
 */
export function selectForm(locale: string, count: number, forms: PluralForms): string {
  return forms[pluralCategory(locale, count)] ?? forms.other;
}

/** `"<count> <correct word form>"` for the locale (e.g. ru/5/шаг → "5 шагов"). */
export function formatCount(locale: string, count: number, forms: PluralForms): string {
  return `${count} ${selectForm(locale, count, forms)}`;
}
