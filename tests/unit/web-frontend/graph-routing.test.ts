/**
 * The technical graph's edge routing: simple forward links stay direct; routed links use reserved
 * inter-group corridors and shortest rectilinear paths around cards inside their source and target
 * groups. The tests cover local loops, both legacy direction fallbacks and every selectable preset,
 * and inspect the complete polyline from one card handle to the other.
 */

import { describe, expect, test } from "@jest/globals";
import {
  GRAPH_FLOW_ENTRY_STRIP,
  GRAPH_GROUP_HEADER,
  GRAPH_MARGIN,
  GRAPH_PRESET_DIRECTIONS,
  graphSpacing,
  layoutGraph,
  routeLinks,
  type LaidGroup,
} from "../../../packages/web-frontend/src/components/workflow/graphLayout";
import { LAYOUT_PRESETS } from "../../../packages/web-frontend/src/components/diagram/layoutPreset";
import {
  definitionBlocks,
  graphModel,
} from "../../../packages/web-frontend/src/components/run/graphModel";
import {
  roundedPath,
  routedPoints,
} from "../../../packages/web-frontend/src/components/workflow/graphNodes";
import { catalogGraph } from "../../helpers/catalog-graphs.js";
import type { WorkflowGraph as FrontendWorkflowGraph } from "../../../packages/web-frontend/src/types/workflow-types.js";

// Two blocks stacked top to bottom, cards running left to right (100 wide, 60 high), with enough
// internal and inter-block room for the local obstacle router and the shared outer lanes.
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

/**
 * A bundled flow as the frontend's own graph type, which requires the id the engine leaves
 * optional. Catalog entries always carry one; the slug is the fallback so the shape is total.
 */
function frontendGraph(slug: string): FrontendWorkflowGraph {
  const graph = catalogGraph(slug);
  return { ...graph, id: graph.id ?? slug } as FrontendWorkflowGraph;
}

describe("routeLinks", () => {
  const routes = routeLinks(links, steps, groups, groupOf, "RIGHT");

  test("a forward link inside a block is drawn straight", () => {
    expect(routes["a1.next"]).toBeUndefined();
  });

  test("a return inside a block gets an obstacle-aware side-port path", () => {
    const route = routes["a2.again"];
    expect(route.sidePorts).toBe(true);
    expect(route.lane.length).toBeGreaterThan(1);
    expect(route.stub).toBeGreaterThan(steps.get("a2")!.x + steps.get("a2")!.width);
    expect(route.side).toBeLessThan(steps.get("a1")!.x);
  });

  test("a self-loop stays local and does not consume a corridor lane", () => {
    expect(routes["a2.self"]).toBeUndefined();
  });

  test("a link into a later block runs in the gap after its source's block", () => {
    const route = routes["a2.done"];
    expect(route.lane.some(([, y]) => y > groups[0].y + groups[0].height && y < groups[1].y)).toBe(
      true,
    );
    expect(route.lane.some(([x]) => x < GRAPH_MARGIN)).toBe(true);
  });

  test("a return to an earlier block stays in the margin until the target's approach row", () => {
    const route = routes["b2.back"];
    expect(route.lane.some(([, y]) => y > groups[1].y + groups[1].height)).toBe(true);
    expect(route.lane.some(([x]) => x >= 0 && x < GRAPH_MARGIN)).toBe(true);
    expect(route.sidePorts).toBe(true);
  });

  test("the transposed fallback also produces on-canvas routes", () => {
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
    expect(row["a2.again"].lane.length).toBeGreaterThan(0);
    expect(row["a2.again"].lane.every(([x, y]) => x >= 0 && y >= 0)).toBe(true);
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

  test("an obstacle route drops repeated source and target waypoints", () => {
    const points = routedPoints(
      {
        stub: 120,
        lane: [
          [120, 50],
          [120, 80],
          [180, 80],
          [180, 100],
        ],
        side: 180,
        sidePorts: true,
      },
      true,
      100,
      50,
      200,
      100,
    );
    expect(points).toEqual([
      [100, 50],
      [120, 50],
      [120, 80],
      [180, 80],
      [180, 100],
      [200, 100],
    ]);
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
      const graph = frontendGraph(slug);
      const model = graphModel(graph, definitionBlocks(graph));
      const layout = await layoutGraph(model, direction);
      const groupById = new Map(layout.groups.map((g) => [g.id, g]));
      const cards = layout.steps.map((s) => {
        const g = s.parentId ? groupById.get(s.parentId) : undefined;
        return {
          id: s.id,
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
      // A lane keeps clear of every unrelated card. Crossing a group border is intentional: an
      // inter-group path moves from the outer margin into the target group's local router.
      const clearance = (
        x: number,
        y: number,
        b: { x0: number; y0: number; x1: number; y1: number },
      ) => Math.max(b.x0 - x, x - b.x1, b.y0 - y, y - b.y1);
      const tooClose: string[] = [];
      for (const [id, route] of Object.entries(layout.routes)) {
        for (const [x, y] of route.lane) {
          for (const c of cards) {
            if (Math.abs(clearance(x, y, c)) < 6) tooClose.push(id);
          }
        }
      }
      expect(tooClose).toEqual([]);
    },
    30000,
  );

  test("edges arriving at one card keep distinct complete routes", async () => {
    const graph = frontendGraph("software-development-flow");
    const model = graphModel(graph, definitionBlocks(graph));
    const layout = await layoutGraph(model, "DOWN");
    const paths = new Map<string, string[]>();
    for (const link of model.links) {
      const route = layout.routes[link.id];
      if (route)
        paths.set(link.target, [...(paths.get(link.target) ?? []), JSON.stringify(route.lane)]);
    }
    const busiest = [...paths.values()].sort((a, b) => b.length - a.length).slice(0, 4);
    expect(busiest[0].length).toBeGreaterThan(3);
    for (const routes of busiest) {
      expect(new Set(routes).size).toBe(routes.length);
    }
  }, 30000);

  test.each(flows.flatMap((slug) => LAYOUT_PRESETS.map((preset) => [slug, preset] as const)))(
    "%s in the %s preset keeps every complete routed path off other cards",
    async (slug, preset) => {
      const graph = frontendGraph(slug);
      const model = graphModel(graph, definitionBlocks(graph));
      const directions = GRAPH_PRESET_DIRECTIONS[preset];
      const layout = await layoutGraph(
        model,
        directions.outer,
        undefined,
        graphSpacing(preset),
        directions.inner,
      );
      const groupById = new Map(layout.groups.map((group) => [group.id, group]));
      const cards = new Map(
        layout.steps.map((step) => {
          const group = step.parentId ? groupById.get(step.parentId) : undefined;
          const x = step.x + (group?.x ?? 0);
          const y = step.y + (group?.y ?? 0);
          return [step.id, { x0: x, y0: y, x1: x + step.width, y1: y + step.height }];
        }),
      );
      const crossings: string[] = [];
      const headerCrossings: string[] = [];
      const offCanvas: string[] = [];
      for (const link of model.links) {
        const route = layout.routes[link.id];
        const source = cards.get(link.source);
        const target = cards.get(link.target);
        if (!route || !source || !target) continue;
        const points = routedPoints(
          route,
          directions.inner === "RIGHT",
          source.x1,
          (source.y0 + source.y1) / 2,
          target.x0,
          (target.y0 + target.y1) / 2,
        );
        for (const [x, y] of points) if (x < 0 || y < 0) offCanvas.push(link.id);
        for (let index = 1; index < points.length; index += 1) {
          const [x1, y1] = points[index - 1];
          const [x2, y2] = points[index];
          for (const [cardId, card] of cards) {
            const horizontal =
              y1 === y2 &&
              y1 > card.y0 &&
              y1 < card.y1 &&
              Math.min(x1, x2) < card.x1 &&
              Math.max(x1, x2) > card.x0;
            const vertical =
              x1 === x2 &&
              x1 > card.x0 &&
              x1 < card.x1 &&
              Math.min(y1, y2) < card.y1 &&
              Math.max(y1, y2) > card.y0;
            if (horizontal || vertical) crossings.push(`${link.id}:${cardId}`);
          }
          if (preset === "flow") {
            for (const group of layout.groups) {
              const protectedRight = group.x + group.width - GRAPH_FLOW_ENTRY_STRIP;
              const horizontal =
                y1 === y2 &&
                y1 > group.y &&
                y1 < group.y + GRAPH_GROUP_HEADER &&
                Math.min(x1, x2) < protectedRight &&
                Math.max(x1, x2) > group.x;
              const vertical =
                x1 === x2 &&
                x1 > group.x &&
                x1 < protectedRight &&
                Math.min(y1, y2) < group.y + GRAPH_GROUP_HEADER &&
                Math.max(y1, y2) > group.y;
              if (horizontal || vertical) headerCrossings.push(`${link.id}:${group.id}`);
            }
          }
        }
      }
      expect(crossings).toEqual([]);
      expect(headerCrossings).toEqual([]);
      expect(offCanvas).toEqual([]);
    },
    30000,
  );
});
