/** @jest-environment jsdom */
/**
 * What a layout preset means on the technical graph.
 *
 * The map and the graph share one preset, stored per browser, but they answer it differently: the
 * graph reads it as two directions — how the block groups are stacked and how the steps run inside
 * a group — and as a scale on the gaps between cards, layers and groups. The cards keep their ports
 * on the left and the right in every preset, so when the steps run top to bottom the edge has to
 * leave the right port, drop into the lane and come back in beside the target's left edge; that
 * variant of `routedPoints` is checked here beside the presets that select it.
 */

import { describe, expect, jest, test, beforeAll } from "@jest/globals";
import React from "react";
import { LAYOUT_PRESETS } from "../../../packages/web-frontend/src/components/diagram/layoutPreset";
import {
  GRAPH_PRESET_DIRECTIONS,
  graphSpacing,
} from "../../../packages/web-frontend/src/components/workflow/graphLayout";

jest.unstable_mockModule("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Top: "top", Right: "right", Bottom: "bottom" },
  BaseEdge: () => null,
  Background: () => null,
  MiniMap: () => null,
  ControlButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  getSmoothStepPath: () => ["", 0, 0],
  useStore: () => "",
}));

let routedPoints: typeof import("../../../packages/web-frontend/src/components/workflow/graphNodes.js").routedPoints;

beforeAll(async () => {
  ({ routedPoints } =
    await import("../../../packages/web-frontend/src/components/workflow/graphNodes.js"));
});

describe("the gaps a graph preset asks for", () => {
  test("compact tightens every gap and flow opens every gap, against the default", () => {
    const base = graphSpacing("default");
    const compact = graphSpacing("compact");
    const flow = graphSpacing("flow");
    for (const gap of ["node", "layer", "group"] as const) {
      expect([gap, compact[gap] < base[gap]]).toEqual([gap, true]);
      expect([gap, flow[gap] > base[gap]]).toEqual([gap, true]);
      // A gap is a whole number of pixels and never collapses to nothing.
      expect([gap, Number.isInteger(compact[gap]) && compact[gap] > 0]).toEqual([gap, true]);
    }
  });

  test("the stacked preset changes the directions, not the gaps", () => {
    expect(graphSpacing("vertical")).toEqual(graphSpacing("default"));
    expect(GRAPH_PRESET_DIRECTIONS.vertical).not.toEqual(GRAPH_PRESET_DIRECTIONS.default);
  });
});

describe("the directions a graph preset asks for", () => {
  test("every preset the reader can choose has a direction pair", () => {
    expect(Object.keys(GRAPH_PRESET_DIRECTIONS).sort()).toEqual(
      LAYOUT_PRESETS.map((preset) => preset.id).sort(),
    );
  });

  test("only the flow preset puts the block groups in a row; only the stacked one turns the steps", () => {
    const inRow = LAYOUT_PRESETS.map((p) => p.id).filter(
      (id) => GRAPH_PRESET_DIRECTIONS[id].outer === "RIGHT",
    );
    expect(inRow).toEqual(["flow"]);
    const turned = LAYOUT_PRESETS.map((p) => p.id).filter(
      (id) => GRAPH_PRESET_DIRECTIONS[id].inner === "DOWN",
    );
    expect(turned).toEqual(["vertical"]);
  });
});

describe("a routed edge between two step cards", () => {
  const route = { stub: 300, lane: [[320, 500]] as Array<[number, number]>, side: 700 };

  test("runs along the card axis when the steps run left to right", () => {
    expect(routedPoints(route, true, 100, 50, 900, 800)).toEqual([
      [100, 50],
      [300, 50],
      [320, 500],
      [700, 800],
      [900, 800],
    ]);
  });

  test("leaves the right port and comes back in beside the target when the steps are stacked", () => {
    // The cards keep their ports on the sides, so the line steps out of the right port, drops to
    // the laid stub row, follows the lane and comes down beside the target's left edge.
    const points = routedPoints(route, false, 100, 50, 900, 800);
    expect(points[0]).toEqual([100, 50]);
    expect(points[points.length - 1]).toEqual([900, 800]);
    const out = points[1][0];
    expect(out).toBeGreaterThan(100);
    expect(points[1]).toEqual([out, 50]);
    expect(points[2]).toEqual([out, 300]);
    expect(points[3]).toEqual([320, 500]);
    const into = points[4][0];
    expect(into).toBeLessThan(900);
    expect(points[4]).toEqual([into, 700]);
    expect(points[5]).toEqual([into, 800]);
  });
});
