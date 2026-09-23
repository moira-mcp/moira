/**
 * @jest-environment jsdom
 */

/**
 * The words a reader gets for a failed codespace request, and other server-facing text the Settings
 * page words itself: a known error code has its own message in each language, anything else the
 * caller's localized generic message — never the English sentence the server wrote for agents.
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import i18n from "../../../packages/web-frontend/src/i18n";
import { ApiClientError } from "../../../packages/web-frontend/src/services/api-client";
import {
  CODESPACE_ERROR_CODES,
  codespaceErrorMessage,
} from "../../../packages/web-frontend/src/lib/codespace-error-message";
import en from "../../../packages/web-frontend/src/locales/en.json";
import ru from "../../../packages/web-frontend/src/locales/ru.json";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

const FALLBACK = "pages.settings.codespaces.requestFailed";

function serverError(code: string, message: string) {
  return new ApiClientError(message, code as never, 429);
}

describe("codespaceErrorMessage", () => {
  test("a known code is worded in the reader's language, not in the server's English", async () => {
    await i18n.changeLanguage("ru");
    const error = serverError(
      "CODESPACE_POLICY_LIMIT",
      "A codespace quota or limit was reached. Per-user ceiling of 4 reached",
    );
    const message = codespaceErrorMessage(error, i18n.t, FALLBACK);
    expect(message).toBe(ru.common.codespaceErrors.CODESPACE_POLICY_LIMIT);
    expect(message).not.toMatch(/[A-Za-z]{4,} (quota|ceiling)/);
  });

  test.each([
    ["an unknown code", serverError("SOMETHING_NEW", "Brand new English failure")],
    ["a failure without a code", new Error("socket hang up")],
    ["a value that is not an error", "boom"],
  ])("%s gets the caller's localized generic message", async (_label, error) => {
    await i18n.changeLanguage("ru");
    expect(codespaceErrorMessage(error, i18n.t, FALLBACK)).toBe(
      ru.pages.settings.codespaces.requestFailed,
    );
  });

  test.each(CODESPACE_ERROR_CODES)("%s has a message in English and in Russian", (code) => {
    const english = (en.common.codespaceErrors as Record<string, string>)[code];
    const russian = (ru.common.codespaceErrors as Record<string, string>)[code];
    expect(english).toEqual(expect.any(String));
    expect(russian).toEqual(expect.any(String));
    expect(russian).not.toBe(english);
  });
});
