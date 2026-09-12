/**
 * The technical graph's edge routing: a link that runs forward inside a block is drawn straight;
 * a return inside a block runs through the block's bottom corridor (below every card of the
 * block) and enters its target from before it; a link into a later block runs in the gap after
 * its source's block; a return to an earlier block climbs the margin before the groups and comes
 * in through the target block's corridor; lanes sharing a corridor do not coincide; the routed
 * polyline starts at the source handle and ends at the target handle; a row of blocks transposes
 * the same geometry.
 */

import { describe, expect, test } from "@jest/globals";
import {
  GRAPH_MARGIN,
  routeLinks,
  type LaidGroup,
} from "../../../packages/web-frontend/src/components/workflow/graphLayout";
import {
  roundedPath,
  routedPoints,
} from "../../../packages/web-frontend/src/components/workflow/graphNodes";

// Two blocks stacked top to bottom, cards running left to right (100 wide, 60 high); block a's
// box holds a three-lane corridor under its cards (two returns of its own and one into it),
// as the layout reserves.
const groups: LaidGroup[] = [
  { id: "a", x: GRAPH_MARGIN, y: 24, width: 300, height: 164 },
  { id: "b", x: GRAPH_MARGIN, y: 244, width: 300, height: 128 },
];
const step = (x: number, y: number) => ({ x, y, width: 100, height: 60 });
const steps = new Map([
  ["a1", step(GRAPH_MARGIN + 16, 76)],
  ["a2", step(GRAPH_MARGIN + 164, 76)],
  ["b1", step(GRAPH_MARGIN + 16, 296)],
  ["b2", step(GRAPH_MARGIN + 164, 296)],
]);
const groupOf = new Map([
  ["a1", "a"],
  ["a2", "a"],
  ["b1", "b"],
  ["b2", "b"],
]);
const links = [
  { id: "a1.next", source: "a1", target: "a2", kind: "forward" },
  { id: "a2.again", source: "a2", target: "a1", kind: "return" },
  { id: "a2.self", source: "a2", target: "a2", kind: "return" },
  { id: "a2.done", source: "a2", target: "b1", kind: "external" },
  { id: "b2.back", source: "b2", target: "a1", kind: "return" },
];

describe("routeLinks", () => {
  const routes = routeLinks(links, steps, groups, groupOf, "RIGHT");

  test("a forward link inside a block is drawn straight", () => {
    expect(routes["a1.next"]).toBeUndefined();
  });

  test("a return inside a block runs below the block's cards and enters before its target", () => {
    const route = routes["a2.again"];
    const cardsBottom = 76 + 60;
    const [, laneY] = route.lane[0];
    expect(laneY).toBeGreaterThan(cardsBottom);
    expect(laneY).toBeLessThan(groups[0].y + groups[0].height);
    expect(route.stub).toBeGreaterThan(GRAPH_MARGIN + 164 + 100);
    expect(route.side).toBeLessThan(GRAPH_MARGIN + 16);
    expect(route.side).toBeGreaterThanOrEqual(groups[0].x);
  });

  test("two returns sharing a corridor take different lanes", () => {
    expect(routes["a2.again"].lane[0][1]).not.toBe(routes["a2.self"].lane[0][1]);
  });

  test("a link into a later block runs in the gap after its source's block", () => {
    const [, laneY] = routes["a2.done"].lane[0];
    expect(laneY).toBeGreaterThan(groups[0].y + groups[0].height);
    expect(laneY).toBeLessThan(groups[1].y);
  });

  test("a return to an earlier block climbs the margin and enters through the target's corridor", () => {
    const route = routes["b2.back"];
    expect(route.lane).toHaveLength(4);
    const [[, laneS], [outerX], , [, laneT]] = route.lane;
    expect(laneS).toBeGreaterThan(groups[1].y + groups[1].height);
    expect(outerX).toBeLessThan(GRAPH_MARGIN);
    expect(outerX).toBeGreaterThanOrEqual(0);
    expect(laneT).toBeGreaterThan(76 + 60);
    expect(laneT).toBeLessThan(groups[0].y + groups[0].height);
    // The corridor of block a now holds three lanes, none coinciding.
    const lanesInA = [routes["a2.again"].lane[0][1], routes["a2.self"].lane[0][1], laneT];
    expect(new Set(lanesInA).size).toBe(3);
  });

  test("a row of blocks transposes the geometry", () => {
    const rowGroups = groups.map((g) => ({
      ...g,
      x: g.y,
      y: g.x,
      width: g.height,
      height: g.width,
    }));
    const rowSteps = new Map(
      [...steps].map(([id, s]) => [id, { x: s.y, y: s.x, width: s.height, height: s.width }]),
    );
    const row = routeLinks(links, rowSteps, rowGroups, groupOf, "DOWN");
    expect(row["a2.again"].lane[0][0]).toBe(routes["a2.again"].lane[0][1]);
    expect(row["a2.again"].lane[0][1]).toBe(routes["a2.again"].lane[0][0]);
  });
});

describe("routedPoints and roundedPath", () => {
  test("the polyline runs from the source handle through the route to the target handle", () => {
    const route = {
      stub: 300,
      lane: [[300, 150] as [number, number], [50, 150] as [number, number]],
      side: 50,
    };
    const points = routedPoints(route, true, 280, 100, 64, 100);
    expect(points[0]).toEqual([280, 100]);
    expect(points[1]).toEqual([300, 100]);
    expect(points[points.length - 2]).toEqual([50, 100]);
    expect(points[points.length - 1]).toEqual([64, 100]);
    const path = roundedPath(points);
    expect(path.startsWith("M 280 100")).toBe(true);
    expect(path.endsWith("L 64 100")).toBe(true);
    expect((path.match(/Q /g) ?? []).length).toBe(points.length - 2);
  });
});
