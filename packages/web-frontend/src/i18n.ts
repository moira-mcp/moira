import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "./locales/en.json";
import ru from "./locales/ru.json";

/**
 * Language configuration
 * To add a new language:
 * 1. Create locales/{code}.json file
 * 2. Import it above
 * 3. Add entry to LANGUAGES config below
 * 4. Add translation to resources
 */
export interface LanguageConfig {
  code: string;
  flag: string;
  // Label comes from locales: layout.languages.{code}
}

export const LANGUAGES: LanguageConfig[] = [
  { code: "en", flag: "🇬🇧" },
  { code: "ru", flag: "🇷🇺" },
];

export const SUPPORTED_LANGUAGE_CODES = LANGUAGES.map((l) => l.code);

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: en,
      },
      ru: {
        translation: ru,
      },
    },
    supportedLngs: SUPPORTED_LANGUAGE_CODES,
    fallbackLng: ["en"],
    detection: {
      // Priority: URL param > localStorage > browser
      // querystring detects ?lang=ru/en parameter
      order: ["querystring", "localStorage", "navigator"],
      lookupQuerystring: "lang",
      caches: ["localStorage"],
    },
  });

export default i18n;
