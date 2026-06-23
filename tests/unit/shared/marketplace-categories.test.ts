/**
 * Unit tests for the fixed marketplace category set.
 */

import { describe, it, expect } from "@jest/globals";
import {
  MARKETPLACE_CATEGORIES,
  MARKETPLACE_CATEGORY_IDS,
  DEFAULT_MARKETPLACE_CATEGORY,
  isValidMarketplaceCategory,
  normalizeMarketplaceCategory,
} from "@mcp-moira/shared";

describe("marketplace categories", () => {
  it("defines a non-empty, uniquely-ided category set", () => {
    expect(MARKETPLACE_CATEGORIES.length).toBeGreaterThan(0);
    const ids = MARKETPLACE_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    for (const cat of MARKETPLACE_CATEGORIES) {
      expect(cat.label.length).toBeGreaterThan(0);
    }
  });

  it("keeps 'other' as the catch-all and last category", () => {
    expect(DEFAULT_MARKETPLACE_CATEGORY).toBe("other");
    const last = MARKETPLACE_CATEGORIES[MARKETPLACE_CATEGORIES.length - 1];
    expect(last.id).toBe("other");
  });

  it("derives MARKETPLACE_CATEGORY_IDS from the category set", () => {
    expect(MARKETPLACE_CATEGORY_IDS).toEqual(MARKETPLACE_CATEGORIES.map((c) => c.id));
  });

  describe("isValidMarketplaceCategory", () => {
    it("accepts a known category id", () => {
      expect(isValidMarketplaceCategory("development")).toBe(true);
      expect(isValidMarketplaceCategory("other")).toBe(true);
    });

    it("rejects an unknown category id", () => {
      expect(isValidMarketplaceCategory("nonsense")).toBe(false);
      expect(isValidMarketplaceCategory("")).toBe(false);
    });
  });

  describe("normalizeMarketplaceCategory", () => {
    it("returns a valid id unchanged", () => {
      expect(normalizeMarketplaceCategory("research")).toBe("research");
    });

    it("falls back to the default for invalid / empty / nullish input", () => {
      expect(normalizeMarketplaceCategory("nonsense")).toBe("other");
      expect(normalizeMarketplaceCategory("")).toBe("other");
      expect(normalizeMarketplaceCategory(null)).toBe("other");
      expect(normalizeMarketplaceCategory(undefined)).toBe("other");
    });
  });
});
