/**
 * @jest-environment jsdom
 *
 * A flow in the list shows the level it was authored at as one badge of its own, in the reader's
 * language, and its tag chips and their "+N" count hold the subject tags only.
 */

import React from "react";
import { afterEach, describe, expect, test } from "@jest/globals";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { WorkflowCard } from "../../../packages/web-frontend/src/components/workflow/WorkflowCard";
import type { WorkflowFileInfo } from "../../../packages/web-frontend/src/types/workflow-types";

function flow(tags: string[]): WorkflowFileInfo {
  return {
    id: "flow-1",
    slug: "onboarding-checklist",
    ownerHandle: "someone",
    ownerName: "someone",
    visibility: "private",
    filePath: "",
    metadata: { name: "Onboarding", version: "1.0.0", description: "Welcome a teammate", tags },
    validation: { isValid: true, errors: [], warnings: [], status: "valid" },
    lastModified: 0,
    revision: 1,
    fileSize: 0,
  };
}

function draw(tags: string[]): void {
  render(
    <I18nextProvider i18n={i18n}>
      <WorkflowCard workflow={flow(tags)} />
    </I18nextProvider>,
  );
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("WorkflowCard level badge", () => {
  test.each([
    ["en", "Simple"],
    ["ru", "Простой"],
  ] as const)("in %s the level reads %s, apart from the subject chips", async (language, name) => {
    await i18n.changeLanguage(language);
    // Four subject tags and the level: three chips show, and "+1" counts the fourth subject only.
    draw(["onboarding", "complexity:simple", "checklist", "people", "hr"]);

    const badges = screen.getAllByTestId("workflow-card-level");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent(name);
    expect(badges[0]).toHaveAttribute("data-level", "simple");

    const chips = screen.getByTestId("workflow-card-tags");
    expect(chips).not.toHaveTextContent("complexity");
    expect(within(chips).getByText("onboarding")).toBeInTheDocument();
    expect(within(chips).getByText("checklist")).toBeInTheDocument();
    expect(within(chips).getByText("people")).toBeInTheDocument();
    expect(within(chips).getByText("+1")).toBeInTheDocument();
  });

  test("a flow without a valid level tag shows no badge", () => {
    draw(["onboarding"]);
    expect(screen.queryByTestId("workflow-card-level")).toBeNull();
    cleanup();
    draw(["complexity:extreme", "onboarding"]);
    expect(screen.queryByTestId("workflow-card-level")).toBeNull();
    expect(screen.getByTestId("workflow-card-tags")).toHaveTextContent("onboarding");
    expect(screen.getByTestId("workflow-card-tags")).not.toHaveTextContent("complexity");
  });
});
