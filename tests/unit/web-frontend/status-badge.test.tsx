/**
 * @jest-environment jsdom
 *
 * An execution's status badge speaks the reader's language: the list items of Executions and
 * the administrator's executions show it, and a raw English status in a Russian interface reads
 * as a leftover.
 */

import React from "react";
import { afterEach, describe, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { StatusBadge } from "../../../packages/web-frontend/src/components/status-badge";

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("StatusBadge", () => {
  test.each([
    ["en", "running", "Running"],
    ["en", "completed", "Completed"],
    ["ru", "running", "Выполняется"],
    ["ru", "completed", "Завершён"],
    ["ru", "failed", "Ошибка"],
  ] as const)("in %s, %s reads %s", async (language, status, label) => {
    await i18n.changeLanguage(language);
    render(
      <I18nextProvider i18n={i18n}>
        <StatusBadge status={status} />
      </I18nextProvider>,
    );
    expect(screen.getByText(label)).toHaveAttribute("data-status", status);
  });
});
