/** @jest-environment jsdom */
/**
 * The map: the header band, the diagram in the middle and the contents beside it. The header names
 * the run (task title, the title the run rendered, its goal and the projection's fact chips); the
 * contents list every block of the process in order with its position, its pass count and the
 * progress of the list it is bound to; the diagram's cards carry the same run facts — how many
 * passes, the time spent in the block, the time on the pass running now and the bound list's
 * done/total — and a block the run has not measured shows no timing at all rather than a zero.
 *
 * The layout the E2E pass found broken is checked here too, as far as jsdom can: the view's
 * explanation costs one collapsed row (its body is not even in the document until it is opened,
 * and the choice is remembered in `localStorage`), the diagram's box clips its own content, no
 * minimap is mounted over the blocks, and on a phone the map is one column — a fixed-height
 * diagram with the contents after it in document order.
 *
 * The ELK layout is stubbed (its own suite is `run-layout`), and the React Flow substrate is
 * replaced by a stub that renders each node through the diagram's own node component, so the real
 * card markup is under test without the canvas.
 */
import { describe, expect, jest, test, beforeAll, beforeEach } from "@jest/globals";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import React from "react";
import i18n from "../../../packages/web-frontend/src/i18n";
import type {
  ExecutionProgress,
  RunBlock,
  WorkflowVersionStatistics,
} from "../../../packages/web-frontend/src/components/run/model.js";
import { catalogGraph } from "../../helpers/catalog-graphs.js";
import { deriveProcess } from "../../../packages/workflow-engine/src/utils/process-derivation.js";

const BLOCK_WIDTH = 260;

/** The projection of a bundled flow, with run state on the first three blocks. */
function projectionOf(slug: string): ExecutionProgress {
  const graph = catalogGraph(slug);
  const process = deriveProcess(graph)!;
  const nodes = process.blocks.map((block, index) => ({
    id: block.id,
    label: block.label,
    state: (index === 0 ? "completed" : index === 1 ? "current" : "pending") as
      "completed" | "current" | "pending",
    status: (index === 0 ? "repeated" : index === 1 ? "active" : "pending") as
      "repeated" | "active" | "pending",
    iterations: index === 0 ? 3 : index === 1 ? 1 : 0,
    visits: index === 0 ? 3 : index === 1 ? 1 : 0,
    currentNodeId: index === 1 ? block.nodeIds[0] : null,
    connections: {},
    primaryNodeIds: block.nodeIds,
    focusNodeId: null,
    content: { summary: null, details: [], outcome: null, next: null },
    timing:
      index === 0
        ? {
            passes: [
              {
                seq: 1,
                nodeId: block.nodeIds[0],
                enteredAt: 0,
                leftAt: 90_000,
                durationMs: 90_000,
                open: false,
                itemIndex: null,
              },
            ],
            totalMs: 90_000,
            currentMs: null,
            recorded: true,
          }
        : index === 1
          ? {
              passes: [
                {
                  seq: 2,
                  nodeId: block.nodeIds[0],
                  enteredAt: 100_000,
                  leftAt: null,
                  durationMs: 30_000,
                  open: true,
                  itemIndex: 0,
                },
              ],
              totalMs: 30_000,
              currentMs: 30_000,
              recorded: true,
            }
          : { passes: [], totalMs: null, currentMs: null, recorded: false },
    list:
      index === 1
        ? {
            items: [
              { index: 0, title: "first", done: true, current: false, durationMs: 10_000 },
              { index: 1, title: "second", done: false, current: true, durationMs: 20_000 },
              { index: 2, title: "third", done: false, current: false, durationMs: null },
            ],
            done: 1,
            total: 3,
            current: 1,
            currentTitle: "second",
          }
        : null,
  }));
  return {
    taskTitle: graph.metadata.name,
    title: "Robust Task · retry 2",
    goal: "Finish the unit without leaving the flow",
    facts: [
      { label: "Attempt", value: "2 of 3", tone: "neutral" as const },
      { label: "Review", value: "failed", tone: "critical" as const },
    ],
    activeNodeId: nodes[1]?.id ?? null,
    nodes,
    workflowVersion: graph.metadata.version,
    executionWorkflowVersion: graph.metadata.version,
    projectedAt: 130_000,
    waitingFor: null,
    executionRevision: 3,
    executionStatus: "running",
    diagnostics: [],
    process,
    route: [],
    variables: [],
    routeRecorded: true,
    cursor: null,
    source: "trace",
  } as ExecutionProgress;
}

// The React Flow substrate: the map's own node component renders each laid-out node, so the card
// markup is real while the canvas, its gestures and its edges are not part of this test.
jest.unstable_mockModule("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Top: "top", Right: "right", Bottom: "bottom" },
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Background: () => null,
  // Rendered as a marker so a minimap mounted over the blocks would be visible to the test.
  MiniMap: () => <div data-testid="diagram-minimap" />,
}));
jest.unstable_mockModule(
  "../../../packages/web-frontend/src/components/diagram/DiagramViewport",
  () => ({
    DiagramViewport: ({
      nodes,
      nodeTypes,
      children,
    }: {
      nodes: Array<{ id: string; type: string; data: unknown }>;
      nodeTypes: Record<string, React.ComponentType<{ id: string; data: unknown }>>;
      children?: React.ReactNode;
    }) => (
      <div data-testid="diagram-nodes">
        {nodes.map((node) => {
          const Node = nodeTypes[node.type];
          return <Node key={node.id} id={node.id} data={node.data} />;
        })}
        {children}
      </div>
    ),
  }),
);
jest.unstable_mockModule("@/hooks/useTheme", () => ({
  useTheme: () => ({ theme: "light", actualTheme: "light", setTheme: () => {} }),
}));
// The ELK layout is asynchronous and has its own suite; here every block sits on one row.
jest.unstable_mockModule("../../../packages/web-frontend/src/components/run/layout", () => ({
  BLOCK_WIDTH,
  LABEL_MAX_WIDTH: 160,
  layoutBlocks: (blocks: RunBlock[]) =>
    Promise.resolve({
      blocks: blocks.map((block, index) => ({
        id: block.id,
        x: index * 320,
        y: 0,
        width: BLOCK_WIDTH,
        height: 150,
      })),
      edges: [],
      hubIds: [],
      width: blocks.length * 320,
      height: 150,
    }),
}));

let MapView: typeof import("../../../packages/web-frontend/src/components/run/MapView.js").MapView;
let runBlocks: typeof import("../../../packages/web-frontend/src/components/run/model.js").runBlocks;

beforeAll(async () => {
  ({ MapView } = await import("../../../packages/web-frontend/src/components/run/MapView.js"));
  ({ runBlocks } = await import("../../../packages/web-frontend/src/components/run/model.js"));
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  window.localStorage.clear();
});

async function renderMap(
  overrides: Partial<ReturnType<typeof projectionOf>> = {},
  statistics: WorkflowVersionStatistics | null = null,
): Promise<ReturnType<typeof runBlocks>> {
  const progress = { ...projectionOf("robust-task"), ...overrides };
  const blocks = runBlocks(progress, statistics);
  render(
    <I18nextProvider i18n={i18n}>
      <MapView
        progress={progress}
        blocks={blocks}
        route={[]}
        cursor={null}
        onSetCursor={() => {}}
        selectedBlockId={blocks[1].id}
        onSelectBlock={() => {}}
      />
    </I18nextProvider>,
  );
  // The layout resolves on a microtask; the diagram renders its nodes right after.
  await screen.findByTestId("diagram-nodes");
  return blocks;
}

describe("the map view", () => {
  test("names the run above the diagram: task, rendered title, goal and the projection's facts", async () => {
    await renderMap();
    const header = screen.getByTestId("run-header-facts");
    expect(header.querySelector("[data-fact='taskTitle']")?.textContent).toBe("Robust Task");
    expect(header.querySelector("[data-fact='title']")?.textContent).toBe("Robust Task · retry 2");
    expect(header.querySelector("[data-fact='goal']")?.textContent).toBe(
      "Finish the unit without leaving the flow",
    );
    const chips = within(screen.getByTestId("run-header-fact-chips")).getAllByTitle(/:/);
    expect(chips.map((chip) => chip.textContent)).toEqual(["Attempt2 of 3", "Reviewfailed"]);
    expect(chips.map((chip) => chip.getAttribute("data-fact-tone"))).toEqual([
      "neutral",
      "critical",
    ]);
  });

  test("the contents name a block's typical run time when the version's statistics carry one", async () => {
    const base = projectionOf("robust-task");
    const first = base.process.blocks[0].id;
    const sample = (medianMs: number | null, sampleCount: number) => ({
      sampleCount,
      medianMs,
      p25Ms: medianMs,
      p75Ms: medianMs,
      minMs: medianMs,
      maxMs: medianMs,
    });
    const statistics: WorkflowVersionStatistics = {
      workflowId: "robust-task",
      workflowVersion: base.workflowVersion,
      computedAt: 0,
      sampledRuns: 3,
      versionNotRecorded: 0,
      blocks: [
        {
          blockId: first,
          pass: sample(40_000, 3),
          run: sample(120_000, 3),
          typicalPasses: 1,
          items: [],
        },
        // The service emits an entry for every block; an unsampled one names no typical time.
        {
          blockId: base.process.blocks[1].id,
          pass: sample(null, 0),
          run: sample(null, 0),
          typicalPasses: null,
          items: [],
        },
      ],
    };
    await renderMap({}, statistics);
    const row = screen.getByTestId(`map-contents-${first}`);
    expect(row.querySelector("[data-contents-typical]")?.textContent).toBe("2 min");
    expect(document.querySelectorAll("[data-contents-typical]")).toHaveLength(1);
  });

  test("words the cards' durations in the interface language", async () => {
    await i18n.changeLanguage("ru");
    try {
      await renderMap();
      const totals = [...document.querySelectorAll("[data-block-total]")].map((n) => n.textContent);
      expect(totals.length).toBeGreaterThan(0);
      for (const total of totals) expect(total).toMatch(/\d+ (с|мин|ч)/);
      expect(document.body.textContent).not.toMatch(/\d+ (s|min)\b/);
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  test("prints the title once when the projection fell back to the task title", async () => {
    // A run without a rendered title gets the workflow name as `title`, the same text as
    // `taskTitle`; the header shows it once, not as two identical lines.
    await renderMap({ title: "Robust Task" });
    const header = screen.getByTestId("run-header-facts");
    expect(header.querySelector("[data-fact='taskTitle']")?.textContent).toBe("Robust Task");
    expect(header.querySelector("[data-fact='title']")).toBeNull();
  });

  test("the view's explanation costs one collapsed row and remembers being opened", async () => {
    await renderMap();
    const toggle = screen.getByTestId("guidance-map-toggle");
    // Closed by default: the body is not in the document at all, so it takes no height from the
    // diagram — the defect was a callout block above the canvas.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("guidance-map-body")).toBeNull();
    fireEvent.click(toggle);
    expect(screen.getByTestId("guidance-map-body").textContent).toContain("Blocks are laid out");
    expect(window.localStorage.getItem("moira.map.guide:pages.runPage.modeGuide")).toBe("open");
    // A reader who opened it once gets it open on the next visit.
    cleanup();
    await renderMap();
    expect(screen.getByTestId("guidance-map-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  test("the diagram clips its own box, mounts no minimap and stacks the contents beneath it", async () => {
    await renderMap();
    // A block laid out beyond the fitted viewport must not reach over the contents beside it.
    expect(screen.getByTestId("canvas-view").className).toContain("overflow-hidden");
    // The contents sidebar is the navigation; a minimap would only cover the blocks.
    expect(screen.queryByTestId("diagram-minimap")).toBeNull();
    // On a phone the map is one column: a diagram of fixed readable height, the contents after it
    // in document order, and no `h-full` that would squeeze the column into the page's leftovers.
    const view = screen.getByTestId("map-view");
    const diagram = screen.getByTestId("canvas-view").closest("div.h-\\[55vh\\]");
    const contents = screen.getByTestId("map-contents");
    expect(diagram).not.toBeNull();
    expect(view.className).not.toMatch(/(^| )h-full( |$)/);
    expect(view.className).toContain("lg:h-full");
    expect(
      diagram!.compareDocumentPosition(contents) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("lists every block of the process in the contents, in order and with its counts", async () => {
    const blocks = await renderMap();
    const contents = screen.getByTestId("map-contents-list");
    const rows = within(contents).getAllByRole("button");
    expect(rows).toHaveLength(blocks.length);
    expect(rows.map((row) => row.getAttribute("data-block-id"))).toEqual(blocks.map((b) => b.id));
    for (const [index, row] of rows.entries()) {
      expect(row.textContent).toContain(`${index + 1}.`);
      expect(row.textContent).toContain(blocks[index].name);
      expect(row.getAttribute("data-status")).toBe(blocks[index].status);
    }
    // The repeated block shows its pass count, the bound one its list progress.
    expect(rows[0].textContent).toContain("×3");
    expect(within(rows[1]).getByTitle(/items done/i).textContent).toBe("1/3");
    // The selected block is the one the page marks, and the active block is the current step.
    expect(rows[1].getAttribute("aria-pressed")).toBe("true");
    expect(rows[1].getAttribute("aria-current")).toBe("step");
    // The finder is part of the contents, so a step can be traced back to its block.
    expect(screen.getByTestId("map-node-finder").tagName).toBe("INPUT");
  });

  test("the diagram's cards carry the pass count, the times and the bound list's progress", async () => {
    const blocks = await renderMap();
    const cards = screen
      .getByTestId("diagram-nodes")
      .querySelectorAll<HTMLElement>("[data-block-id]");
    expect(cards).toHaveLength(blocks.length);
    const [done, active, pending] = [...cards];

    // A block that ran three times and took a minute and a half: the count and the total, no
    // "current", because no pass of it is open.
    expect(done.textContent).toContain("×3");
    expect(done.getAttribute("data-status")).toBe("repeated");
    expect(within(done).getByTitle(/time spent in this block/i).textContent).toContain(
      "1 min 30 s",
    );
    expect(within(done).queryByTitle(/pass running now/i)).toBeNull();

    // The block the run is in: its total, the open pass's own time and the list's done/total.
    expect(within(active).getByTitle(/time spent in this block/i).textContent).toContain("30 s");
    expect(within(active).getByTitle(/pass running now/i).textContent).toContain("30 s");
    expect(within(active).getByTitle(/items done/i).textContent).toContain("1/3");

    // A block the run has not entered says nothing about time rather than "0 s".
    expect(within(pending).queryByTitle(/time spent in this block/i)).toBeNull();
    expect(within(pending).queryByTitle(/pass running now/i)).toBeNull();
    expect(pending.textContent).not.toContain("0 s");
  });
});
