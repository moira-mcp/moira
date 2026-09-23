/**
 * A documentation link opens the page in the reader's language: English at the documentation
 * site's root, Russian under `/ru`, and anything that is not a root documentation path untouched.
 */

import { describe, expect, test } from "@jest/globals";
import { localizedDocsPath } from "../../../packages/web-frontend/src/lib/docs-path";

describe("localizedDocsPath", () => {
  test.each([
    ["/docs/integration/telegram-setup/", "ru", "/ru/docs/integration/telegram-setup/"],
    ["/docs/integration/telegram-setup/", "ru-RU", "/ru/docs/integration/telegram-setup/"],
    ["/docs/", "ru", "/ru/docs/"],
    ["/docs", "ru", "/ru/docs"],
    ["/docs/getting-started/quickstart/", "en", "/docs/getting-started/quickstart/"],
    ["/docs/getting-started/quickstart/", "en-US", "/docs/getting-started/quickstart/"],
    ["/docs/", undefined, "/docs/"],
    // A language the documentation site does not serve falls back to its English root.
    ["/docs/", "de", "/docs/"],
  ])("%s in %s is %s", (path, language, expected) => {
    expect(localizedDocsPath(path, language)).toBe(expected);
  });

  test.each([
    ["an external URL", "https://core.telegram.org/bots"],
    ["a path already in Russian", "/ru/docs/integration/telegram-setup/"],
    ["an application route", "/settings"],
    ["a path that only starts like the docs", "/docsearch/"],
  ])("leaves %s unchanged", (_label, path) => {
    expect(localizedDocsPath(path, "ru")).toBe(path);
  });
});
