/**
 * Server-side i18n for Astro SSG
 *
 * This module provides synchronous i18n for Astro components during static site generation.
 * Astro components render at build time, so they need synchronous access to translations.
 *
 * Usage:
 * - For English page: import { t } from '~/i18n-server' (default export)
 * - For Russian page: import { createT } from '~/i18n-server'; const t = createT('ru');
 */

import en from "./locales/en.json";
import ru from "./locales/ru.json";

type Translations = typeof en;
type TranslationKey = string;

// Supported languages
export type Language = "en" | "ru";
export const DEFAULT_LANG: Language = "en";
export const SUPPORTED_LANGS: Language[] = ["en", "ru"];

// Translation resources
const resources: Record<string, Translations> = {
  en,
  ru,
};

// Docs paths per language (matches Starlight locale structure)
export const DOCS_PATHS: Record<Language, string> = {
  en: "/docs/getting-started/introduction/",
  ru: "/ru/docs/getting-started/introduction/",
};

// Docs base paths for building links to specific sections
export const DOCS_BASE_PATHS: Record<Language, string> = {
  en: "/docs",
  ru: "/ru/docs",
};

// Alternate page paths for hreflang
export const ALTERNATE_PATHS: Record<Language, string> = {
  en: "/",
  ru: "/ru/",
};

/**
 * Get nested property value from object using dot notation
 * Example: get(obj, 'hero.title') returns obj.hero.title
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return path.split(".").reduce((current: any, key) => current?.[key], obj);
}

/**
 * Create a translation function bound to a specific language
 * @param lang - Language code ('en' or 'ru')
 * @returns Translation function for the specified language
 */
export function createT(lang: Language = DEFAULT_LANG) {
  return function t(key: TranslationKey): string {
    const translations = resources[lang] || resources[DEFAULT_LANG];
    const value = getNestedValue(translations, key);

    if (value === undefined) {
      console.warn(`[i18n-server] Translation key not found: ${key} (lang: ${lang})`);
      return key;
    }

    return String(value);
  };
}

/**
 * Server-side translation function for Astro components (English by default)
 * @param key - Translation key in dot notation (e.g., 'hero.title')
 * @returns Translated string or the key if translation not found
 */
export const t = createT(DEFAULT_LANG);

/**
 * Get docs path for a specific language (intro page)
 * @param lang - Language code
 * @returns Docs intro path for the language
 */
export function getDocsPath(lang: Language = DEFAULT_LANG): string {
  return DOCS_PATHS[lang];
}

/**
 * Get docs base path for a specific language (for building section links)
 * @param lang - Language code
 * @returns Docs base path for the language
 */
export function getDocsBasePath(lang: Language = DEFAULT_LANG): string {
  return DOCS_BASE_PATHS[lang];
}

/**
 * Get alternate page path for hreflang
 * @param lang - Language code
 * @returns Alternate page path
 */
export function getAlternatePath(lang: Language = DEFAULT_LANG): string {
  return ALTERNATE_PATHS[lang];
}

export default {
  t,
  createT,
  getDocsPath,
  getDocsBasePath,
  getAlternatePath,
  DEFAULT_LANG,
  SUPPORTED_LANGS,
};
