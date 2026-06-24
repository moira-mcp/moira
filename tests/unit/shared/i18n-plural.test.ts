/**
 * Unit tests for the shared pluralization/declension primitive and the canonical
 * marketplace label data. These guarantee grammatically correct EN/RU forms and full
 * enum coverage — the single source the server-side render layer reuses and the SPA
 * mirrors.
 */

import { describe, it, expect } from "@jest/globals";
import {
  pluralCategory,
  selectForm,
  formatCount,
  toMarketplaceLocale,
  MARKETPLACE_COUNTABLE_NOUNS,
  MARKETPLACE_ENUM_LABELS,
  formatMarketplaceCount,
  marketplaceEnumLabel,
  type MarketplaceCountNoun,
} from "@mcp-moira/shared";

describe("pluralCategory (CLDR)", () => {
  it("resolves English one/other", () => {
    expect(pluralCategory("en", 1)).toBe("one");
    expect(pluralCategory("en", 0)).toBe("other");
    expect(pluralCategory("en", 2)).toBe("other");
    expect(pluralCategory("en", 21)).toBe("other");
  });

  it("resolves Russian one/few/many across the boundaries", () => {
    expect(pluralCategory("ru", 1)).toBe("one");
    expect(pluralCategory("ru", 21)).toBe("one");
    expect(pluralCategory("ru", 2)).toBe("few");
    expect(pluralCategory("ru", 3)).toBe("few");
    expect(pluralCategory("ru", 4)).toBe("few");
    expect(pluralCategory("ru", 5)).toBe("many");
    expect(pluralCategory("ru", 11)).toBe("many");
    expect(pluralCategory("ru", 0)).toBe("many");
    expect(pluralCategory("ru", 25)).toBe("many");
  });
});

describe("selectForm / formatCount", () => {
  const ruSteps = { one: "шаг", few: "шага", many: "шагов", other: "шага" };
  it("selects the correct Russian form", () => {
    expect(selectForm("ru", 1, ruSteps)).toBe("шаг");
    expect(selectForm("ru", 2, ruSteps)).toBe("шага");
    expect(selectForm("ru", 5, ruSteps)).toBe("шагов");
    expect(selectForm("ru", 21, ruSteps)).toBe("шаг");
  });
  it("falls back to other when the resolved category is absent", () => {
    expect(selectForm("ru", 5, { one: "x", other: "fallback" })).toBe("fallback");
  });
  it("formats count + word", () => {
    expect(formatCount("ru", 5, ruSteps)).toBe("5 шагов");
    expect(formatCount("en", 1, { one: "step", other: "steps" })).toBe("1 step");
    expect(formatCount("en", 3, { one: "step", other: "steps" })).toBe("3 steps");
  });
});

describe("toMarketplaceLocale", () => {
  it("normalizes locale variants to a supported marketplace locale", () => {
    expect(toMarketplaceLocale("ru")).toBe("ru");
    expect(toMarketplaceLocale("ru-RU")).toBe("ru");
    expect(toMarketplaceLocale("RU")).toBe("ru");
    expect(toMarketplaceLocale("en")).toBe("en");
    expect(toMarketplaceLocale("en-US")).toBe("en");
    expect(toMarketplaceLocale("de")).toBe("en");
    expect(toMarketplaceLocale(null)).toBe("en");
    expect(toMarketplaceLocale(undefined)).toBe("en");
  });
});

describe("formatMarketplaceCount", () => {
  it("produces correct Russian declensions for steps", () => {
    expect(formatMarketplaceCount("ru", "steps", 1)).toBe("1 шаг");
    expect(formatMarketplaceCount("ru", "steps", 2)).toBe("2 шага");
    expect(formatMarketplaceCount("ru", "steps", 5)).toBe("5 шагов");
    expect(formatMarketplaceCount("ru-RU", "steps", 5)).toBe("5 шагов");
  });
  it("produces correct English plurals for installs", () => {
    expect(formatMarketplaceCount("en", "installs", 1)).toBe("1 install");
    expect(formatMarketplaceCount("en", "installs", 4)).toBe("4 installs");
  });
});

describe("countable noun coverage", () => {
  it("every noun defines en and ru forms with an `other` fallback", () => {
    const nouns = Object.keys(MARKETPLACE_COUNTABLE_NOUNS) as MarketplaceCountNoun[];
    expect(nouns.length).toBeGreaterThan(0);
    for (const noun of nouns) {
      for (const lng of ["en", "ru"] as const) {
        const forms = MARKETPLACE_COUNTABLE_NOUNS[noun][lng];
        expect(typeof forms.other).toBe("string");
        expect(forms.other.length).toBeGreaterThan(0);
        if (lng === "ru") {
          // Russian needs one/few/many to be grammatical
          expect(forms.one && forms.few && forms.many).toBeTruthy();
        }
      }
    }
  });
});

describe("marketplaceEnumLabel", () => {
  it("returns localized labels for category/status/kind", () => {
    expect(marketplaceEnumLabel("en", "category", "development")).toBe("Development");
    expect(marketplaceEnumLabel("ru", "category", "development")).toBe("Разработка");
    expect(marketplaceEnumLabel("ru", "status", "listed")).toBe("Опубликован");
    expect(marketplaceEnumLabel("en", "kind", "reference")).toBe("Reference");
    expect(marketplaceEnumLabel("ru", "kind", "copy")).toBe("Копия");
  });
  it("falls back to the raw value for unknown enum values", () => {
    expect(marketplaceEnumLabel("ru", "category", "nonexistent")).toBe("nonexistent");
  });
  it("every enum value has both en and ru labels (parity)", () => {
    for (const kind of ["category", "status", "kind"] as const) {
      const values = Object.keys(MARKETPLACE_ENUM_LABELS[kind]);
      expect(values.length).toBeGreaterThan(0);
      for (const value of values) {
        const label = MARKETPLACE_ENUM_LABELS[kind][value];
        expect(label.en.length).toBeGreaterThan(0);
        expect(label.ru.length).toBeGreaterThan(0);
        expect(label.en).not.toBe(label.ru); // genuinely translated, not copied
      }
    }
  });
});
