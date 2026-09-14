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
import { findCatalogEntryBySlug } from "@mcp-moira/shared";
import type { WorkflowGraph } from "@mcp-moira/workflow-engine";
import {
  APPROACH_COLUMNS,
  GRAPH_MARGIN,
  layoutGraph,
  routeLinks,
  type LaidGroup,
} from "../../../packages/web-frontend/src/components/workflow/graphLayout";
import {
  definitionBlocks,
  graphModel,
} from "../../../packages/web-frontend/src/components/run/graphModel";
import {
  roundedPath,
  routedPoints,
} from "../../../packages/web-frontend/src/components/workflow/graphNodes";

// Two blocks stacked top to bottom, cards running left to right (100 wide, 60 high); block a's
// box holds a three-lane corridor under its cards (two returns of its own and one into it) and,
// like the layout, an entry side wide enough for the approach columns of the edges arriving.
const ENTRY = 61;
const groups: LaidGroup[] = [
  { id: "a", x: GRAPH_MARGIN, y: 24, width: 345, height: 164 },
  { id: "b", x: GRAPH_MARGIN, y: 244, width: 345, height: 128 },
];
const step = (x: number, y: number) => ({ x, y, width: 100, height: 60 });
const steps = new Map([
  ["a1", step(GRAPH_MARGIN + ENTRY, 76)],
  ["a2", step(GRAPH_MARGIN + ENTRY + 148, 76)],
  ["b1", step(GRAPH_MARGIN + ENTRY, 296)],
  ["b2", step(GRAPH_MARGIN + ENTRY + 148, 296)],
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
    expect(route.stub).toBeGreaterThan(GRAPH_MARGIN + ENTRY + 148 + 100);
    expect(route.side).toBeLessThan(GRAPH_MARGIN + ENTRY);
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

/**
 * The corridors of a real layout: every lane of every routed edge must stay off the cards and on
 * the canvas. This is what the hand-routed corridors used to get wrong once a block had more
 * links than its corridor was sized for: lanes marched over the next block's cards, and the
 * returns of a large flow ran past the left edge of the canvas.
 */
describe("corridors of the bundled flows", () => {
  const flows = [
    "quick-task",
    "todo-list",
    "robust-task",
    "software-development-flow",
    "workflow-management-flow",
    "user-onboarding",
  ];
  const directions = ["DOWN", "RIGHT"] as const;
  test.each(flows.flatMap((slug) => directions.map((d) => [slug, d] as const)))(
    "%s laid %s keeps every lane off the cards and on the canvas",
    async (slug, direction) => {
      const graph = findCatalogEntryBySlug(slug)!.graph as WorkflowGraph;
      const model = graphModel(graph, definitionBlocks(graph));
      const layout = await layoutGraph(model, direction);
      const groupById = new Map(layout.groups.map((g) => [g.id, g]));
      const cards = layout.steps.map((s) => {
        const g = s.parentId ? groupById.get(s.parentId) : undefined;
        return {
          x0: s.x + (g?.x ?? 0),
          y0: s.y + (g?.y ?? 0),
          x1: s.x + (g?.x ?? 0) + s.width,
          y1: s.y + (g?.y ?? 0) + s.height,
        };
      });
      expect(cards.length).toBeGreaterThan(0);
      const crossings: string[] = [];
      const offCanvas: string[] = [];
      for (const [id, route] of Object.entries(layout.routes)) {
        for (const [x, y] of route.lane) if (x < 0 || y < 0) offCanvas.push(id);
        for (let i = 1; i < route.lane.length; i += 1) {
          const [x1, y1] = route.lane[i - 1];
          const [x2, y2] = route.lane[i];
          for (const c of cards) {
            const horizontal =
              y1 === y2 &&
              y1 > c.y0 &&
              y1 < c.y1 &&
              Math.min(x1, x2) < c.x1 &&
              Math.max(x1, x2) > c.x0;
            const vertical =
              x1 === x2 &&
              x1 > c.x0 &&
              x1 < c.x1 &&
              Math.min(y1, y2) < c.y1 &&
              Math.max(y1, y2) > c.y0;
            if (horizontal || vertical) crossings.push(id);
          }
        }
      }
      expect(crossings).toEqual([]);
      expect(offCanvas).toEqual([]);
      // A lane keeps clear of the cards and of the blocks' borders: a line that runs flush
      // against either reads as touching it instead of passing by.
      const borders = layout.groups.flatMap((g) => [
        { x0: g.x, y0: g.y, x1: g.x + g.width, y1: g.y + g.height },
      ]);
      const clearance = (
        x: number,
        y: number,
        b: { x0: number; y0: number; x1: number; y1: number },
      ) => Math.max(b.x0 - x, x - b.x1, b.y0 - y, y - b.y1);
      const tooClose: string[] = [];
      for (const [id, route] of Object.entries(layout.routes)) {
        for (const [x, y] of route.lane) {
          for (const c of cards) if (Math.abs(clearance(x, y, c)) < 6) tooClose.push(id);
          for (const b of borders) if (Math.abs(clearance(x, y, b)) < 4) tooClose.push(id);
        }
      }
      expect(tooClose).toEqual([]);
    },
    30000,
  );

  test("edges arriving at one card take their own approach columns", async () => {
    const graph = findCatalogEntryBySlug("software-development-flow")!.graph as WorkflowGraph;
    const model = graphModel(graph, definitionBlocks(graph));
    const layout = await layoutGraph(model, "DOWN");
    const sides = new Map<string, number[]>();
    for (const link of model.links) {
      const route = layout.routes[link.id];
      if (route) sides.set(link.target, [...(sides.get(link.target) ?? []), route.side]);
    }
    const busiest = [...sides.values()].sort((a, b) => b.length - a.length).slice(0, 4);
    expect(busiest[0].length).toBeGreaterThan(3);
    for (const columns of busiest) {
      const distinct = new Set(columns.map((s) => Math.round(s)));
      // Every arrival has its own column, or they fill the columns the entry side holds.
      expect(distinct.size).toBe(Math.min(columns.length, APPROACH_COLUMNS));
      expect(Math.max(...columns) - Math.min(...columns)).toBeGreaterThan(0);
    }
  }, 30000);
});
