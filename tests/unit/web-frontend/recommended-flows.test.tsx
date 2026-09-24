/** @jest-environment jsdom */
/**
 * The recommended section shows a flow only when this instance has it as a system flow: it asks
 * the catalog once for the named slugs of the reader's language, and an entry the answer lacks —
 * or answers with a same-named flow of another owner — is not offered, since its card would open a
 * missing page or somebody else's flow. With nothing to offer, the section is not drawn at all.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import {
  RecommendedFlows,
  resetRecommendedLookups,
} from "../../../packages/web-frontend/src/components/onboarding/RecommendedFlows";
import { apiClient } from "../../../packages/web-frontend/src/services/api-client";

const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

type Listed = { slug: string; ownerHandle: string };

function answer(workflows: Listed[]) {
  return jest
    .spyOn(apiClient, "getWorkflows")
    .mockResolvedValue({ workflows, totalWorkflows: workflows.length } as never);
}

function renderSection(): void {
  render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <RecommendedFlows />
      </I18nextProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  (globalThis as typeof globalThis & { React?: typeof React }).React = React;
  resetRecommendedLookups();
});

afterEach(async () => {
  cleanup();
  jest.restoreAllMocks();
  await i18n.changeLanguage("en");
  const target = globalThis as typeof globalThis & { React?: typeof React };
  if (originalReact) target.React = originalReact;
  else delete target.React;
});

describe("RecommendedFlows", () => {
  test("offers only the system flows the catalog has, after one lookup of the reader's slugs", async () => {
    await i18n.changeLanguage("en");
    const lookup = answer([
      { slug: "example-simple-steps", ownerHandle: "moira" },
      { slug: "quick-task", ownerHandle: "moira" },
      // A user's own flow that happens to share a recommended slug is not the system's.
      { slug: "todo-list", ownerHandle: "someone" },
    ]);
    renderSection();

    await waitFor(() => expect(screen.getAllByTestId("recommended-flow")).toHaveLength(2));
    expect(
      screen.getAllByTestId("recommended-flow").map((card) => card.getAttribute("data-slug")),
    ).toEqual(["example-simple-steps", "quick-task"]);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0][0]).toMatchObject({
      slugs: [
        "example-simple-steps",
        "example-one-choice",
        "example-several-paths",
        "quick-task",
        "robust-task",
        "todo-list",
      ],
      visibility: "public",
    });
  });

  test("asks for the Russian examples when the interface is in Russian", async () => {
    await i18n.changeLanguage("ru");
    const lookup = answer([{ slug: "example-one-choice-ru", ownerHandle: "moira" }]);
    renderSection();

    await waitFor(() => expect(screen.getAllByTestId("recommended-flow")).toHaveLength(1));
    expect(screen.getByTestId("recommended-flow")).toHaveAttribute(
      "data-slug",
      "example-one-choice-ru",
    );
    expect((lookup.mock.calls[0][0] as { slugs: string[] }).slugs.slice(0, 3)).toEqual([
      "example-simple-steps-ru",
      "example-one-choice-ru",
      "example-several-paths-ru",
    ]);
  });

  test("a second mount in the same visit asks the catalog nothing again", async () => {
    await i18n.changeLanguage("en");
    const lookup = answer([{ slug: "quick-task", ownerHandle: "moira" }]);
    renderSection();
    await waitFor(() => expect(screen.getAllByTestId("recommended-flow")).toHaveLength(1));
    cleanup();
    renderSection();
    await waitFor(() => expect(screen.getAllByTestId("recommended-flow")).toHaveLength(1));
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test("draws nothing when none of the recommended flows exists here", async () => {
    await i18n.changeLanguage("en");
    const lookup = answer([]);
    renderSection();

    await waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("recommended-flows")).toBeNull());
  });
});
