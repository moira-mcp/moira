/** @jest-environment jsdom */
/**
 * On a phone the lanes view is a vertical stepper, not a diagram: every non-adjacent forward
 * transition is shown as a forward chip beside the return chips, and no connector SVG is drawn.
 */
import { describe, expect, jest, test, beforeAll } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import React from "react";
import i18n from "../../../packages/web-frontend/src/i18n";
import { runBlocks } from "../../../packages/web-frontend/src/components/run/model.js";
import type { ExecutionProgress } from "../../../packages/web-frontend/src/types/workflow-types.js";
import { findCatalogEntryBySlug } from "../../../packages/shared/src/services/workflow-catalog.js";
import { deriveProcess } from "../../../packages/workflow-engine/src/utils/process-derivation.js";
import type { WorkflowGraph } from "../../../packages/workflow-engine/src/types/base-types.js";

function projectionOf(slug: string): ExecutionProgress {
  const graph = findCatalogEntryBySlug(slug)!.graph as WorkflowGraph;
  const process = deriveProcess(graph)!;
  return {
    taskTitle: graph.metadata.name,
    title: null,
    goal: null,
    facts: [],
    activeNodeId: null,
    nodes: process.blocks.map((block) => ({
      id: block.id,
      label: block.label,
      state: "pending",
      status: "pending",
      iterations: 0,
      visits: 0,
      currentNodeId: null,
      connections: {},
      primaryNodeIds: block.nodeIds,
      focusNodeId: null,
      content: { summary: null, details: [], outcome: null, next: null },
    })),
    workflowVersion: graph.metadata.version,
    executionRevision: 0,
    executionStatus: "running",
    diagnostics: [],
    process,
    route: [],
    variables: [],
    routeRecorded: false,
    cursor: null,
    source: "trace",
  } as ExecutionProgress;
}

// Until `useIsMobile` has read the viewport the view renders its horizontal branch once, and
// that branch mounts React Flow through `DiagramViewport`, which the unit runner cannot load
// (the project stubs `@xyflow/react` in every component test); the stepper under test never
// renders either, so both are stubbed here.
jest.unstable_mockModule("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Top: "top", Right: "right", Bottom: "bottom" },
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.unstable_mockModule(
  "../../../packages/web-frontend/src/components/diagram/DiagramViewport",
  () => ({ DiagramViewport: () => null }),
);
// The rail reads the theme for React Flow's colour mode; the provider is not part of this test.
jest.unstable_mockModule("@/hooks/useTheme", () => ({
  useTheme: () => ({ theme: "light", actualTheme: "light", setTheme: () => {} }),
}));

let LanesView: typeof import("../../../packages/web-frontend/src/components/run/LanesView.js").LanesView;

beforeAll(async () => {
  ({ LanesView } = await import("../../../packages/web-frontend/src/components/run/LanesView.js"));
  await i18n.changeLanguage("en");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 400 });
});

describe("lanes view on a phone", () => {
  test("shows every non-adjacent forward transition as a chip and draws no connector", () => {
    const progress = projectionOf("robust-task");
    const blocks = runBlocks(progress);
    const skipping = blocks.flatMap((b) =>
      b.transitions.filter((tr) => {
        const target = blocks.find((x) => x.id === tr.to);
        return !tr.cycle && target !== undefined && target.index > b.index + 1;
      }),
    );
    expect(skipping.length).toBeGreaterThan(0);
    render(
      <I18nextProvider i18n={i18n}>
        <LanesView
          progress={progress}
          blocks={blocks}
          selectedBlockId={null}
          onSelectBlock={() => {}}
        />
      </I18nextProvider>,
    );
    const stepper = screen.getByRole("list", { name: /rail|stepper|blocks/i });
    expect(
      stepper.closest("[data-lanes-orientation]")?.getAttribute("data-lanes-orientation"),
    ).toBe("vertical");
    const forwardChips = document.querySelectorAll('[data-link="chip"]');
    expect(forwardChips).toHaveLength(skipping.length);
    for (const tr of skipping) {
      const target = blocks.find((x) => x.id === tr.to)!;
      expect(
        [...forwardChips].some(
          (chip) => chip.textContent?.includes(tr.label) && chip.textContent.includes(target.name),
        ),
      ).toBe(true);
    }
    expect(document.querySelector('[data-testid="lanes-rail"]')).toBeNull();
    expect(document.querySelector("[data-arc]:not([data-arc='chip'])")).toBeNull();
  });
});
