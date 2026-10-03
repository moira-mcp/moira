/** @jest-environment jsdom */

import React from "react";
import { afterEach, beforeAll, expect, jest, test } from "@jest/globals";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/jest-globals";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { GuideProvider } from "../../../packages/web-frontend/src/guides/GuideContext";
import i18n from "../../../packages/web-frontend/src/i18n";
import { EditBar } from "../../../packages/web-frontend/src/components/flow/EditBar";
import { pausedRunWarnings } from "../../../packages/web-frontend/src/components/flow/structure";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);

test("paused-run warnings name the canonical task or own flow and keep arbitrary notes separate", () => {
  const diff = [{ kind: "remove-node" as const, id: "review" }];
  const runs = [
    {
      executionId: "named-run",
      status: "running",
      currentNodeId: "review",
      waitingForInputNodeId: "review",
      taskTitle: "Publish the release",
      workflowName: "Release flow",
      note: "Ask about the rollout window",
    },
    {
      executionId: "legacy-run",
      status: "running",
      currentNodeId: "review",
      waitingForInputNodeId: "review",
      workflowName: "Legacy release flow",
      note: "This is arbitrary context",
    },
  ];
  const warnings = pausedRunWarnings(runs, diff);
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <GuideProvider>
          <EditBar
            diff={diff}
            canUndo={false}
            onUndo={jest.fn()}
            onReset={jest.fn()}
            gate={{ enabled: false, reason: "unchanged" }}
            processProblems={0}
            serverErrors={0}
            onRetry={jest.fn()}
            saving={false}
            onSave={jest.fn()}
            revision={1}
            saveError={null}
            runWarnings={warnings}
          />
        </GuideProvider>
      </MemoryRouter>
    </I18nextProvider>,
  );
  expect(screen.getByTestId("flow-edit-run-warnings")).toHaveTextContent("Publish the release");
  const named = screen.getByTestId("flow-edit-run-task-named-run");
  expect(named).toHaveTextContent("Publish the release");
  expect(named).not.toHaveTextContent("Ask about the rollout window");
  expect(screen.getByTestId("flow-edit-run-note-named-run")).toHaveTextContent(
    "Note: Ask about the rollout window",
  );
  expect(screen.getByTestId("flow-edit-run-task-legacy-run")).toHaveTextContent(
    "Legacy release flow",
  );
  expect(screen.getByTestId("flow-edit-run-note-legacy-run")).toHaveTextContent(
    "Note: This is arbitrary context",
  );
});
