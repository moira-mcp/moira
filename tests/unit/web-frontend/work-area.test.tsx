/**
 * @jest-environment jsdom
 *
 * The home work area drawn from a summary: a run in progress carries a badge only when it needs
 * attention (a lock, refusals), a section with nothing in it says so in one line while the others
 * show their items, and a universal flow of the system owner offers its authored prompt rather than
 * the template built from a name.
 */

import React from "react";
import { afterEach, describe, expect, test } from "@jest/globals";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import i18n from "../../../packages/web-frontend/src/i18n";
import { WorkArea } from "../../../packages/web-frontend/src/components/home/WorkArea";
import type {
  ActiveWorkRun,
  WorkSummary,
} from "../../../packages/web-frontend/src/services/api-client";

afterEach(() => cleanup());

function run(id: string, extra: Partial<ActiveWorkRun> = {}): ActiveWorkRun {
  return {
    executionId: id,
    workflowId: "flow-1",
    workflowName: "Release checklist",
    note: null,
    status: "running",
    hasActiveLock: false,
    errorCount: 0,
    stepId: "notes",
    stepName: "Write the release notes",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...extra,
  };
}

function draw(summary: WorkSummary): void {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <WorkArea summary={summary} />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

describe("WorkArea", () => {
  test("a run in progress carries a badge only for a lock or refusals", () => {
    draw({
      activeRuns: [
        run("plain-0000"),
        run("locked-000", { status: "locked", hasActiveLock: true }),
        run("errors-000", { errorCount: 2 }),
      ],
      recentRuns: [],
      topFlows: [],
    });
    const plain = screen.getByTestId("work-active-plain-0000");
    expect(within(plain).queryByText("Running")).toBeNull();
    expect(within(plain).queryByText(/errors/)).toBeNull();
    expect(within(screen.getByTestId("work-active-locked-000")).getByText("Locked")).toBeVisible();
    expect(
      within(screen.getByTestId("work-active-errors-000")).getByText(/^2 errors$/),
    ).toBeVisible();
  });

  test("a step with a name shows it; one without reads as words from its id, not the raw id", () => {
    draw({
      activeRuns: [run("named-0000"), run("unnamed-00", { stepId: "get-task", stepName: null })],
      recentRuns: [],
      topFlows: [],
    });
    expect(
      within(screen.getByTestId("work-active-named-0000")).getByTestId("work-active-step"),
    ).toHaveTextContent("At: Write the release notes");
    expect(
      within(screen.getByTestId("work-active-unnamed-00")).getByTestId("work-active-step"),
    ).toHaveTextContent("At: Get task");
  });

  test("a section with nothing in it says so in one line while the others list their items", () => {
    draw({ activeRuns: [run("only-00000")], recentRuns: [], topFlows: [] });
    expect(screen.queryByTestId("work-empty")).toBeNull();
    expect(
      within(screen.getByTestId("work-in-progress")).getByText("Release checklist"),
    ).toBeVisible();
    expect(
      within(screen.getByTestId("work-recent")).getByText("No finished runs yet."),
    ).toBeVisible();
    expect(
      within(screen.getByTestId("work-flows")).getByText("The flows you run will be listed here."),
    ).toBeVisible();
  });

  test("a universal flow offers its authored prompt; another flow the template from its name", () => {
    draw({
      activeRuns: [],
      recentRuns: [],
      topFlows: [
        {
          id: "quick",
          ownerHandle: "moira",
          slug: "quick-task",
          name: "Quick Task",
          description: null,
          runs: 3,
          lastRunAt: Date.now(),
        },
        {
          id: "mine",
          ownerHandle: "anna",
          slug: "release-checklist",
          name: "Release checklist",
          description: null,
          runs: 1,
          lastRunAt: Date.now(),
        },
      ],
    });
    expect(
      within(screen.getByTestId("work-flow-quick")).getByTestId("work-flow-prompt"),
    ).toHaveTextContent("Use Moira's Quick Task for this: …");
    expect(
      within(screen.getByTestId("work-flow-mine")).getByTestId("work-flow-prompt"),
    ).toHaveTextContent("Use Moira to run Release checklist for this task: …");
  });

  test("a user with nothing yet sees the one empty state", () => {
    draw({ activeRuns: [], recentRuns: [], topFlows: [] });
    expect(screen.getByTestId("work-empty")).toBeVisible();
    expect(screen.queryByTestId("work-in-progress")).toBeNull();
  });
});
