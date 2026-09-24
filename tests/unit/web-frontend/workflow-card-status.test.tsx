/**
 * @jest-environment jsdom
 *
 * A flow in the list carries a status badge only when its status needs attention, and a flow no
 * one has validated yet reads "Not checked" / «Не проверен» — the same words the status filter
 * uses — instead of passing for invalid.
 */

import React from "react";
import { afterEach, describe, expect, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import i18n from "../../../packages/web-frontend/src/i18n";
import { WorkflowCard } from "../../../packages/web-frontend/src/components/workflow/WorkflowCard";
import type { WorkflowFileInfo } from "../../../packages/web-frontend/src/types/workflow-types";

function flow(status: "valid" | "invalid" | "unknown"): WorkflowFileInfo {
  return {
    id: "flow-1",
    slug: "some-flow",
    ownerHandle: "someone",
    ownerName: "someone",
    visibility: "private",
    filePath: "",
    metadata: { name: "Some Flow", version: "1.0.0", description: "What it does" },
    validation: {
      isValid: status === "valid",
      errors: [],
      warnings: [],
      status,
    },
    lastModified: 0,
    revision: 1,
    fileSize: 0,
  };
}

function draw(status: "valid" | "invalid" | "unknown"): void {
  render(
    <I18nextProvider i18n={i18n}>
      <WorkflowCard workflow={flow(status)} />
    </I18nextProvider>,
  );
}

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("WorkflowCard status badge", () => {
  test.each([
    ["en", "Not checked", "Not checked"],
    ["ru", "Не проверен", "Не проверенные"],
  ] as const)(
    "in %s a never-validated flow reads %s, matching the filter's %s",
    async (language, badge, filter) => {
      await i18n.changeLanguage(language);
      draw("unknown");
      expect(screen.getByTestId("workflow-card-unknown")).toHaveTextContent(badge);
      expect(screen.queryByTestId("workflow-card-invalid")).toBeNull();
      expect(i18n.t("components.searchFilters.unknown")).toBe(filter);
    },
  );

  test("a valid flow carries no status badge; an invalid one says so", async () => {
    draw("valid");
    expect(screen.queryByTestId("workflow-card-unknown")).toBeNull();
    expect(screen.queryByTestId("workflow-card-invalid")).toBeNull();
    cleanup();
    draw("invalid");
    expect(screen.getByTestId("workflow-card-invalid")).toBeInTheDocument();
  });
});
