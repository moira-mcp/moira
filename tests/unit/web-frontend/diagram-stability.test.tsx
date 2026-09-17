/** @jest-environment jsdom */
/**
 * What must not move under the reader.
 *
 * Both diagrams lay themselves out asynchronously, and both are re-rendered constantly: the run
 * page refetches its projection while the run advances, and the graph re-reports the sizes the
 * browser measured. Two rules keep that from redrawing the picture under the reader's hands. The
 * map lays out from the process shape alone, so a projection refresh that brings new block objects
 * of the same shape keeps the layout it already has — object identity included, since a new layout
 * object blanks the diagram and moves the camera. And the graph ignores sizes measured while the
 * document is hidden: a background tab measures cards at zero or wrong heights, and laying out from
 * those wrecks the graph before the reader comes back to it.
 */

import { describe, expect, jest, test, beforeAll, afterEach } from "@jest/globals";
import { cleanup, render, renderHook, waitFor } from "@testing-library/react";
import React from "react";
import type { RunBlock } from "../../../packages/web-frontend/src/components/run/model.js";

/** What React Flow's store reports as measured, under the test's control. */
let measuredSignature = "";

jest.unstable_mockModule("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Top: "top", Right: "right", Bottom: "bottom" },
  BaseEdge: () => null,
  Background: () => null,
  MiniMap: () => null,
  ControlButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  getSmoothStepPath: () => ["", 0, 0],
  useStore: () => measuredSignature,
}));
jest.unstable_mockModule(
  "../../../packages/web-frontend/src/components/diagram/DiagramViewport",
  () => ({ DiagramViewport: () => null }),
);

let useBlockLayout: typeof import("../../../packages/web-frontend/src/components/run/CanvasView.js").useBlockLayout;
let GraphMeasuredHeights: typeof import("../../../packages/web-frontend/src/components/workflow/graphNodes.js").GraphMeasuredHeights;

beforeAll(async () => {
  ({ useBlockLayout } =
    await import("../../../packages/web-frontend/src/components/run/CanvasView.js"));
  ({ GraphMeasuredHeights } =
    await import("../../../packages/web-frontend/src/components/workflow/graphNodes.js"));
});

afterEach(() => {
  cleanup();
});

/** Three blocks in a line; every projection refresh rebuilds objects of exactly this shape. */
function blocksOf(lastLabel = "done"): RunBlock[] {
  const make = (id: string, index: number, to: string | null, label: string): RunBlock => ({
    id,
    index,
    name: id,
    description: "",
    nodeIds: [id],
    transitions: to ? [{ to, label, edges: [`${id}.${to}`] }] : [],
    status: "pending",
    iterations: 0,
    visits: 0,
    currentNodeId: null,
    content: { summary: null, details: [], outcome: null, next: null },
    timing: { passes: [], totalMs: null, currentMs: null, recorded: false },
    list: null,
  });
  return [make("a", 0, "b", "next"), make("b", 1, "c", lastLabel), make("c", 2, null, "")];
}

describe("the map's layout across a projection refresh", () => {
  test("keeps the layout it has when the refresh brings the same process shape", async () => {
    const initial = blocksOf();
    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: RunBlock[] }) => useBlockLayout(blocks, [], "default"),
      { initialProps: { blocks: initial } },
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    const laid = result.current;
    // A refresh: new objects, same ids, names, descriptions and transitions.
    const refreshed = blocksOf();
    expect(refreshed[0]).not.toBe(initial[0]);
    expect(refreshed[0]).toEqual(initial[0]);
    rerender({ blocks: refreshed });
    rerender({ blocks: blocksOf() });
    await waitFor(() => expect(result.current).not.toBeNull());
    // The same object, not an equal one: a new object blanks the diagram and re-places the camera.
    expect(result.current).toBe(laid);
  });

  test("lays out again when the process itself changed", async () => {
    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: RunBlock[] }) => useBlockLayout(blocks, [], "default"),
      { initialProps: { blocks: blocksOf() } },
    );
    await waitFor(() => expect(result.current).not.toBeNull());
    const laid = result.current;
    rerender({ blocks: blocksOf("repaired") });
    await waitFor(() => expect(result.current).not.toBe(laid));
    expect(result.current!.blocks.map((b) => b.id)).toEqual(["a", "b", "c"]);
  });
});

describe("the graph's measured card heights", () => {
  const visibility = (state: "visible" | "hidden") =>
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });

  afterEach(() => visibility("visible"));

  test("reports the heights the browser measured while the document is visible", () => {
    visibility("visible");
    measuredSignature = `plan\u000080\u0001review\u0000120`;
    const reported: Array<Map<string, number>> = [];
    render(<GraphMeasuredHeights onMeasured={(heights) => reported.push(heights)} />);
    expect(reported).toHaveLength(1);
    expect([...reported[0].entries()]).toEqual([
      ["plan", 80],
      ["review", 120],
    ]);
  });

  test("ignores measurements taken while the document is hidden", () => {
    // A background tab or a window behind another one measures cards at wrong sizes; laying the
    // graph out from those is what the reader finds wrecked on coming back.
    visibility("hidden");
    measuredSignature = `plan\u000080\u0001review\u0000120`;
    const reported: Array<Map<string, number>> = [];
    render(<GraphMeasuredHeights onMeasured={(heights) => reported.push(heights)} />);
    expect(reported).toEqual([]);
  });

  test("ignores a run where a card came back too small to be a real card", () => {
    visibility("visible");
    measuredSignature = `plan\u000080\u0001review\u00000`;
    const reported: Array<Map<string, number>> = [];
    render(<GraphMeasuredHeights onMeasured={(heights) => reported.push(heights)} />);
    expect(reported).toEqual([]);
  });
});
