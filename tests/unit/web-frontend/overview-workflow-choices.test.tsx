/** @jest-environment jsdom */
import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { authClient } from "../../../packages/web-frontend/src/auth/better-auth-client";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";
import { Overview } from "../../../packages/web-frontend/src/pages/Overview";
import { GuideProvider } from "../../../packages/web-frontend/src/guides/GuideContext";
import { resetGuideProgress } from "../../../packages/web-frontend/src/guides/progress";
import { fakeUserSettings } from "./helpers/fake-user-settings";
import { LiveConnection } from "../../../packages/web-frontend/src/components/overview/liveConnection";

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
let admitted = true;
beforeEach(async () => {
  // The suite's classic JSX transformer expects React for components built with automatic JSX.
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  admitted = true;
  // Keep the tested retry in one accepted scope; the SDK's initial session observation
  // must settle before this fixture deliberately refuses the workflow choice read.
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (new URL(String(input), "http://localhost").pathname !== "/api/auth/get-session")
      throw new Error("Unexpected network request in workflow choice fixture");
    return Response.json(
      admitted
        ? {
            user: { id: "reader", email: "reader@example.test", name: "Reader" },
            session: {
              id: "reader-session",
              userId: "reader",
              expiresAt: "2099-01-01T00:00:00Z",
              updatedAt: "2026-01-01T00:00:00Z",
              createdAt: "2026-01-01T00:00:00Z",
            },
          }
        : null,
    );
  });
  await authClient.$store.atoms.session.get().refetch();
  resetGuideProgress();
  fakeUserSettings({ "ui.guide_progress": { firstRun: "declined" } });
  jest.spyOn(LiveConnection.prototype, "start").mockImplementation(() => undefined);
});

afterEach(async () => {
  cleanup();
  admitted = false;
  await authClient.$store.atoms.session.get().refetch();
  jest.restoreAllMocks();
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
  await i18n.changeLanguage("en");
});

describe("overview workflow choice failure recovery", () => {
  test.each([
    [
      "en",
      "Flow filter unavailable",
      "The flow list could not be loaded. Try again to filter by flow.",
      "Try again",
      "Filters",
    ],
    [
      "ru",
      "Фильтр по флоу недоступен",
      "Не удалось загрузить список флоу. Повторите загрузку, чтобы выбрать флоу в фильтре.",
      "Повторить",
      "Фильтры",
    ],
  ])(
    "keeps the overview usable and retries the choice list in %s",
    async (language, title, message, retry, filters) => {
      await i18n.changeLanguage(language);
      jest.spyOn(apiClient, "getOverview").mockResolvedValue({
        runs: [],
        total: 0,
        limit: 50,
        offset: 0,
        evaluatedAt: 1,
        effectiveTime: { kind: "period", period: "7d" },
      });
      const choices = jest
        .spyOn(apiClient, "getWorkflows")
        .mockRejectedValueOnce(new Error("Internal pagination failure"));
      choices.mockResolvedValue({
        workflows: [{ id: "flow-1", metadata: { name: "Readable flow" } }] as never,
        totalWorkflows: 1,
        validWorkflows: 1,
        invalidWorkflows: 0,
        lastScan: 1,
      });
      render(
        <MemoryRouter initialEntries={["/overview"]}>
          <I18nextProvider i18n={i18n}>
            <GuideProvider>
              <Overview />
            </GuideProvider>
          </I18nextProvider>
        </MemoryRouter>,
      );
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(title);
      expect(alert).toHaveTextContent(message);
      expect(alert).not.toHaveTextContent("Internal pagination failure");
      expect(screen.getByTestId("overview-total")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: retry }));
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      fireEvent.click(screen.getByRole("button", { name: filters }));
      expect(await screen.findByTestId("overview-filter-flow")).toBeInTheDocument();
      expect(choices).toHaveBeenCalledTimes(2);
    },
  );
});
