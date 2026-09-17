/** @jest-environment jsdom */
/**
 * The map view: the diagram in the middle and the contents beside it. Naming the run is the page's
 * job now (its `PageHeader` sits above the view), so what the map owns is checked here — the
 * contents, the cards and the shape of the column.
 *
 * The contents list every block of the process in order with its index badge, its status, how many
 * times it ran, the progress of the list it is bound to and, when the version's statistics carry
 * one, the block's typical run time. The diagram's cards are ported cards: an index badge and the
 * block's name in the title band, the status badge beside it, and the run facts as chips — how many
 * passes, the time spent in the block, the time on the pass running now and the bound list's
 * done/total. A block the run has not measured shows no timing at all rather than a zero, and a
 * long name is clamped to two lines so it cannot push the facts out of the card.
 *
 * The layout the E2E pass found broken is checked here too, as far as jsdom can: the diagram's box
 * clips its own content, the minimap is mounted only while the reader's stored flag says so, and on
 * a phone the map is one column — a fixed-height diagram with the contents after it in document
 * order.
 *
 * The ELK layout is stubbed (its own suite is `run-layout`), and the React Flow substrate is
 * replaced by a stub that renders each node through the diagram's own node component, so the real
 * card markup is under test without the canvas.
 */
import { describe, expect, jest, test, beforeAll, beforeEach } from "@jest/globals";
import { cleanup, render, screen, within } from "@testing-library/react";
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
  ControlButton: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  getSmoothStepPath: () => ["", 0, 0],
  useStore: () => "",
  // Rendered as a marker so the minimap is visible to the test wherever it is mounted.
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
  PARALLEL_CHIP_MIN: 3,
  transitionKey: (from: string, transition: { to: string; label: string }) =>
    `${from}→${transition.to}:${transition.label}`,
  layoutBlocks: (blocks: RunBlock[]) =>
    Promise.resolve({
      blocks: blocks.map((block, index) => ({
        id: block.id,
        x: index * 320,
        y: 0,
        width: BLOCK_WIDTH,
        height: 150,
        rank: index,
        row: 0,
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

/** The card of one block inside the stubbed diagram. */
function cardOf(blockId: string): HTMLElement {
  return screen
    .getByTestId("diagram-nodes")
    .querySelector<HTMLElement>(`[data-block-id="${blockId}"]`)!;
}

describe("the map view", () => {
  test("lists every block of the process in the contents, in order and with its counts", async () => {
    const blocks = await renderMap();
    const contents = screen.getByTestId("map-contents-list");
    const rows = within(contents).getAllByRole("button");
    expect(rows).toHaveLength(blocks.length);
    expect(rows.map((row) => row.getAttribute("data-block-id"))).toEqual(blocks.map((b) => b.id));
    for (const [index, row] of rows.entries()) {
      // The position is the same badge the card carries, not a number typed into the row.
      expect(row.querySelector("[data-step-index]")?.textContent).toBe(String(index + 1));
      expect(row.textContent).toContain(blocks[index].name);
      expect(row.getAttribute("data-status")).toBe(blocks[index].status);
    }
    // The repeated block shows its pass count, the bound one its list progress.
    expect(rows[0].textContent).toContain("×3");
    expect(rows[1].querySelector("[data-contents-list]")?.textContent).toBe("1/3");
    // The selected block is the one the page marks, and the active block is the current step.
    expect(rows[1].getAttribute("aria-pressed")).toBe("true");
    expect(rows[1].getAttribute("aria-current")).toBe("step");
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

  test("an unresolved list counter reads — on the contents and the card, never 0", async () => {
    const base = projectionOf("robust-task");
    const bound = base.nodes.findIndex((node) => node.list !== null);
    const nodes = base.nodes.map((node, index) =>
      index === bound ? { ...node, list: { ...node.list!, done: null } } : node,
    );
    await renderMap({ nodes });
    const row = screen.getByTestId(`map-contents-${nodes[bound].id}`);
    expect(row.querySelector("[data-contents-list]")?.textContent).toBe("—/3");
    expect(cardOf(nodes[bound].id).textContent).toContain("—/3");
    expect(document.body.textContent).not.toContain("0/3");
  });

  test("the diagram's cards are ported cards carrying the pass count, the times and the bound list", async () => {
    const blocks = await renderMap();
    const cards = screen
      .getByTestId("diagram-nodes")
      .querySelectorAll<HTMLElement>("[data-block-id]");
    expect(cards).toHaveLength(blocks.length);
    const [done, active, pending] = [...cards];

    // The title band: the block's position as the same badge the contents carry, and its name.
    const band = (card: HTMLElement) => card.querySelector<HTMLElement>("[data-step-title]")!;
    expect(band(done).querySelector("[data-step-index]")?.textContent).toBe("1");
    expect(band(done).textContent).toContain(blocks[0].name);
    // The card's colour follows the run status, so the state reads without hovering anything.
    expect(done.getAttribute("data-tone")).toBe("done");
    expect(active.getAttribute("data-tone")).toBe("active");
    expect(pending.getAttribute("data-tone")).toBe("neutral");
    expect(active.getAttribute("data-current")).toBe("true");

    // A block that ran three times and took a minute and a half: the count and the total, no
    // "current", because no pass of it is open.
    expect(done.getAttribute("data-status")).toBe("repeated");
    const facts = (card: HTMLElement) => card.querySelector<HTMLElement>("[data-step-facts]")!;
    expect(facts(done).textContent).toContain("×3");
    expect(facts(done).textContent).toContain("1 min 30 s");

    // The block the run is in: the open pass's own time and the list's done/total.
    expect(facts(active).textContent).toContain("30 s");
    expect(facts(active).textContent).toContain("1/3");
    // The bound list is drawn on the card itself, item by item, each with the marker of its
    // state: a check for done, an arrow for the one in progress, a dot for the rest.
    const items = active.querySelectorAll("[data-block-list-items] li");
    expect([...items].map((item) => item.textContent)).toEqual(["✓first", "▶second", "·third"]);

    // A block the run has not entered says nothing about time rather than "0 s": its only fact
    // is how many steps it holds.
    expect(facts(pending).children).toHaveLength(1);
    expect(facts(pending).textContent).toContain("steps");
    expect(facts(pending).textContent).not.toMatch(/\b\d+ (s|min|h)\b/);
  });

  test("words the cards' durations in the interface language", async () => {
    await i18n.changeLanguage("ru");
    try {
      const blocks = await renderMap();
      const facts = cardOf(blocks[0].id).querySelector<HTMLElement>("[data-step-facts]")!;
      expect(facts.textContent).toMatch(/\d+ (с|мин|ч)/);
      expect(document.body.textContent).not.toMatch(/\d+ (s|min)\b/);
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  test("a card clamps a long block name to two lines and keeps the whole name in the band", async () => {
    const base = projectionOf("robust-task");
    const longName =
      "Reconcile the plan with the review findings and the user's late scope change".padEnd(
        90,
        "!",
      );
    expect(longName).toHaveLength(90);
    const nodes = base.nodes.map((node, index) =>
      index === 0 ? { ...node, label: longName } : node,
    );
    await renderMap({ nodes });
    const name = cardOf(nodes[0].id).querySelector<HTMLElement>("[data-step-title] .line-clamp-2")!;
    expect(name.textContent).toContain(longName);
    // jsdom lays nothing out: the clamp is the class the stylesheet turns into two lines, the
    // same rule the description uses; the geometry is checked in the browser by the E2E pass.
    expect(name.className).toContain("line-clamp-2");
  });

  test("the minimap is mounted only while the reader's stored flag keeps it on", async () => {
    // The contents sidebar is the navigation, so the minimap is the reader's choice — and the
    // choice is the one the toolbar's switch writes, not a fresh default on every visit.
    await renderMap();
    expect(screen.getByTestId("diagram-minimap")).toBeDefined();
    cleanup();
    window.localStorage.setItem("moira.diagram.minimap", "0");
    await renderMap();
    expect(screen.queryByTestId("diagram-minimap")).toBeNull();
  });

  test("the diagram clips its own box and stacks the contents beneath it on a phone", async () => {
    await renderMap();
    // A block laid out beyond the fitted viewport must not reach over the contents beside it.
    expect(screen.getByTestId("canvas-view").className).toContain("overflow-hidden");
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
});
