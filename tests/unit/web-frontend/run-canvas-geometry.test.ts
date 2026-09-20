/**
 * The geometry the map's diagram draws between the ports of two cards, once the layout has decided
 * the lanes.
 *
 * The layout (`run-layout`) says where a block sits and which lane an edge travels; the engine's
 * `process-geometry`, reached through the map's `run/layout` door, says how the line gets from a
 * port on a card's border to that lane and back — the progress picture draws the same paths. Three rules are
 * under test: a lane edge leaves its source port sideways into a column of its own beside the card
 * (`portRanks`), so two edges at one card never share a vertical; the stacked preset is the same
 * layout transposed, so the drawn path leaves the right port and enters the left one while keeping
 * the lane the layout gave it; and a transition back to the card itself dips under its bottom port.
 */

import { describe, expect, test } from "@jest/globals";
import {
  portRanks,
  portedPoints,
  stackedPoints,
  type LaidOutEdge,
} from "../../../packages/web-frontend/src/components/run/layout.js";

const TRANSITION = { to: "b", label: "done", edges: ["a.done"] };

function laid(over: Partial<LaidOutEdge> = {}): LaidOutEdge {
  return {
    id: "a->b:done",
    from: "a",
    to: "b",
    transition: TRANSITION,
    kind: "skip",
    path: "M 0 0 L 0 0",
    labelX: 0,
    labelY: 0,
    labelAnchor: "above",
    ...over,
  } as LaidOutEdge;
}

describe("the path between two ports on the rows layout", () => {
  test("a lane edge leaves its port sideways, travels its lane and comes back in beside its target", () => {
    const routed = portedPoints(laid({ kind: "skip", laneY: 10 }), 100, 50, 500, 80, {
      outRank: 0,
      inRank: 0,
    });
    const [start, out, onLane, offLane, into, end] = routed.points;
    expect(start).toEqual([100, 50]);
    expect(end).toEqual([500, 80]);
    // Out of the source's right port into the gap beside the card, up to the lane.
    expect(out[0]).toBeGreaterThan(100);
    expect(out[1]).toBe(50);
    expect(onLane).toEqual([out[0], 10]);
    // Along the lane, then down beside the target's left edge into its port.
    expect(offLane[1]).toBe(10);
    expect(offLane[0]).toBeLessThan(500);
    expect(into).toEqual([offLane[0], 80]);
    expect(routed.labelY).toBe(10);
  });

  test("two edges at one card take columns of their own, the outer rank further from the card", () => {
    const inner = portedPoints(laid({ laneY: 10 }), 100, 50, 500, 80, { outRank: 0, inRank: 0 });
    const outer = portedPoints(laid({ laneY: 10 }), 100, 50, 500, 80, { outRank: 1, inRank: 2 });
    // The source's side: a higher rank runs further to the right of the card.
    expect(outer.points[1][0]).toBeGreaterThan(inner.points[1][0]);
    // The target's side: a higher rank runs further to the left of it.
    expect(outer.points[3][0]).toBeLessThan(inner.points[3][0]);
  });

  test("a forward step is a straight line between ports at one height and an elbow otherwise", () => {
    const level = portedPoints(
      laid({ kind: "forward", path: "M 100 50 L 500 50" }),
      100,
      50,
      500,
      50,
      { outRank: 0, inRank: 0 },
    );
    expect(level.points).toEqual([
      [100, 50],
      [500, 50],
    ]);
    // Ports at different heights: the vertical run stays where the layout put it, in the gap.
    const stepped = portedPoints(
      laid({ kind: "forward", path: "M 100 50 L 300 50 L 300 120 L 500 120" }),
      100,
      50,
      500,
      120,
      { outRank: 0, inRank: 0 },
    );
    expect(stepped.points).toEqual([
      [100, 50],
      [300, 50],
      [300, 120],
      [500, 120],
    ]);
  });

  test("a transition back to the same card dips under its bottom port and returns", () => {
    const self = portedPoints(
      laid({ id: "a->a:retry", to: "a", kind: "cycle" }),
      200,
      300,
      220,
      300,
      { outRank: 0, inRank: 0 },
    );
    expect(self.points[0]).toEqual([200, 300]);
    expect(self.points[3]).toEqual([220, 300]);
    const dip = self.points[1][1];
    expect(dip).toBeGreaterThan(300);
    expect(self.points[2]).toEqual([220, dip]);
    expect(self.labelY).toBeGreaterThan(dip);
  });
});

describe("the path between two ports on the stacked preset", () => {
  test("keeps the laid lane while leaving the right port and entering the left one", () => {
    // The stacked layout is the rows layout transposed, so the laid path is read with its
    // coordinates swapped: these waypoints are the lane the layout chose.
    const path = "M 10 20 L 30 20 L 30 80 L 200 80 L 200 60 L 220 60";
    const routed = stackedPoints(laid({ kind: "cycle", path }), 100, 400, 700, 900, {
      outRank: 0,
      inRank: 0,
    });
    const points = routed.points;
    expect(points[0]).toEqual([100, 400]);
    expect(points[points.length - 1]).toEqual([700, 900]);
    // Out of the source's right port, then down to the laid lane's first waypoint.
    expect(points[1][0]).toBeGreaterThan(100);
    expect(points[1][1]).toBe(400);
    expect(points[2]).toEqual([points[1][0], 30]);
    // The lane the layout laid, waypoint for waypoint, in the transposed space.
    expect(points.slice(3, 5)).toEqual([
      [80, 30],
      [80, 200],
    ]);
    // Down beside the target's left edge and in through its left port.
    const into = points[points.length - 2];
    expect(into[0]).toBeLessThan(700);
    expect(into[1]).toBe(900);
    expect(points[points.length - 3]).toEqual([into[0], 200]);
  });

  test("a laid path with no waypoints turns once, halfway between the two ports", () => {
    const routed = stackedPoints(laid({ path: "M 10 20 L 40 20" }), 100, 400, 700, 900, {
      outRank: 0,
      inRank: 0,
    });
    expect(routed.points[0]).toEqual([100, 400]);
    expect(routed.points[routed.points.length - 1]).toEqual([700, 900]);
    expect(routed.labelY).toBe(650);
    for (const point of routed.points) expect(point[1]).toBeGreaterThanOrEqual(400);
  });
});

describe("the columns the lane edges take beside one card", () => {
  test("edges reaching a card from above and from below take disjoint ranges, the nearer lane inside", () => {
    const keyOf = (index: number) => `a→b:t${index}`;
    const edges = [0, 1, 2, 3].map((index) =>
      laid({
        id: `e${index}`,
        transition: { ...TRANSITION, label: `t${index}` },
        // t1 and t2 travel a lane above the card, t0 and t3 one below it.
        laneY: index === 1 ? 10 : index === 2 ? 5 : index === 0 ? 500 : 400,
      }),
    );
    const ports = new Map([
      ["a", { outputs: [0, 1, 2, 3].map(keyOf), inputs: [] as string[] }],
      ["b", { outputs: [] as string[], inputs: [0, 1, 2, 3].map(keyOf) }],
    ]);
    const ranks = portRanks(edges, ports, new Map([["a", 100]]));
    // The two edges whose lane is above the card take the inner columns; among them the port
    // lower in the column travels furthest, so it goes outermost.
    expect(ranks.out.get("e2")).toBe(0);
    expect(ranks.out.get("e1")).toBe(1);
    // The two below take the columns after them, the higher port outermost.
    expect(ranks.out.get("e0")).toBe(2);
    expect(ranks.out.get("e3")).toBe(3);
    // Stated as the rule they serve: the ranges do not interleave, so no vertical crosses a
    // neighbouring port's horizontal.
    const above = [ranks.out.get("e1")!, ranks.out.get("e2")!];
    const below = [ranks.out.get("e0")!, ranks.out.get("e3")!];
    expect(Math.max(...above)).toBeLessThan(Math.min(...below));
  });

  test("a forward edge and a self-loop take no column: they never leave the gap beside the card", () => {
    const edges = [
      laid({ id: "fwd", kind: "forward", laneY: 10 }),
      laid({ id: "self", to: "a", kind: "cycle", laneY: 10 }),
      laid({ id: "lane", kind: "skip", laneY: 10 }),
    ];
    const ports = new Map([
      ["a", { outputs: ["a→b:done"], inputs: [] as string[] }],
      ["b", { outputs: [] as string[], inputs: ["a→b:done"] }],
    ]);
    const ranks = portRanks(edges, ports, new Map([["a", 100]]));
    expect(ranks.out.has("fwd")).toBe(false);
    expect(ranks.out.has("self")).toBe(false);
    expect(ranks.out.get("lane")).toBe(0);
  });
});
