import i18n from "../../../packages/web-frontend/src/i18n";
import { describe, test, expect } from "@jest/globals";

describe("i18n", () => {
  test("should be initialized", () => {
    expect(i18n).toBeDefined();
  });

  test("should have English and Russian languages", () => {
    expect(i18n.options.supportedLngs).toContain("en");
    expect(i18n.options.supportedLngs).toContain("ru");
  });

  test("should have English as fallback language", () => {
    expect(i18n.options.fallbackLng).toEqual(["en"]);
  });
});
