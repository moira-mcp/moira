/**
 * Layout of the technical graph: one tinted group per process block, the groups stacked in process
 * order (top to bottom, or left to right for "Horizontal"). ELK lays out branching steps for the
 * horizontal-card presets; the vertical preset uses one stable card column so every side port can
 * reach its shared corridor. Routed edges combine reserved inter-group lanes with a rectilinear
 * shortest path around the cards inside each group. Positions come back relative to the group for
 * React Flow's `parentId`; without a process view the steps are laid out as one flat set.
 */

import type { GraphModel } from "../run/graphModel";
import type { LayoutPreset } from "../diagram/layoutPreset";

/**
 * What a layout preset means on the graph: how the block groups are stacked (`outer`) and how the
 * steps run inside a group (`inner`). Cards keep their ports on the left and right in every case.
 */
export const GRAPH_PRESET_DIRECTIONS: Record<
  LayoutPreset,
  { outer: "DOWN" | "RIGHT"; inner: "DOWN" | "RIGHT" }
> = {
  default: { outer: "DOWN", inner: "RIGHT" },
  compact: { outer: "DOWN", inner: "RIGHT" },
  flow: { outer: "RIGHT", inner: "RIGHT" },
  vertical: { outer: "DOWN", inner: "DOWN" },
};

export const GRAPH_CARD_WIDTH = 660;
/** Least room before the groups, where inter-group lanes run. */
export const GRAPH_MARGIN = 48;
const GRAPH_GROUP_PADDING = 16;
/**
 * Extra room inside a group on the side the edges arrive from, so an arrowhead lands in open
 * space instead of on the group's border, where several of them crowd the same few pixels.
 */
const GRAPH_GROUP_ENTRY = 34;
/** Distance between the approach columns of two edges arriving at the same column of cards. */
const APPROACH_STEP = 9;
/** At most this many approach columns per column of cards, so they stay inside their gap. */
export const APPROACH_COLUMNS = 4;
/** Distance between two return lanes in the margin, which holds one lane per return. */
const MARGIN_LANE_STEP = 8;
export const GRAPH_GROUP_HEADER = 36;
const BASE_NODE_GAP = 20;
const BASE_LAYER_GAP = 76;
const BASE_GROUP_GAP = 56;
/** The gaps a preset scales: `compact` tightens them, `flow` gives the groups more air. */
export interface GraphSpacing {
  node: number;
  layer: number;
  group: number;
}
export function graphSpacing(preset: "default" | "compact" | "flow" | "vertical"): GraphSpacing {
  const scale = preset === "compact" ? 0.55 : preset === "flow" ? 1.35 : 1;
  return {
    node: Math.round(BASE_NODE_GAP * scale),
    layer: Math.round(BASE_LAYER_GAP * scale),
    group: Math.round(BASE_GROUP_GAP * scale),
  };
}
const NODE_GAP = BASE_NODE_GAP;
/** Distance between two edge lanes sharing a corridor. */
const LANE_STEP = 12;
/**
 * How far an edge leaves its source card before it turns, and how far before its target card its
 * approach column runs: far enough that a line never turns flush against a card's edge.
 */
const EDGE_STUB = 24;
const EDGE_APPROACH = 24;
/** Where a block's first corridor lane runs, measured from the block's far edge. */
const CORRIDOR_INSET = 14;
/** Space kept between the outermost lane of a corridor and whatever bounds the corridor. */
const LANE_CLEARANCE = 10;
/** Title-free strip on the right of a horizontal group, used to enter past its header. */
export const GRAPH_FLOW_ENTRY_STRIP =
  EDGE_APPROACH + (APPROACH_COLUMNS - 1) * APPROACH_STEP + 2 * LANE_CLEARANCE;

/**
 * How many lanes every corridor must hold, counted before the groups are placed so that each
 * corridor is given the room its lanes need: a block's own corridor (its backward links inside
 * the block and inter-group links arriving into it), the gap after a block (every link leaving it
 * for another block) and the margin before the first block (every inter-group link).
 */
export interface LaneCounts {
  bottom: Map<string, number>;
  gap: Map<string, number>;
  margin: number;
  /** Per block, the most routed edges any one of its cards receives: its approach columns. */
  approach: Map<string, number>;
}

export function laneCounts(
  links: ReadonlyArray<{ source: string; target: string; kind: string }>,
  groupOf: ReadonlyMap<string, string>,
  backwardInside: (link: { source: string; target: string }) => boolean,
): LaneCounts {
  const bottom = new Map<string, number>();
  const gap = new Map<string, number>();
  const arrivals = new Map<string, number>();
  let margin = 0;
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const link of links) {
    if (link.source === link.target) continue;
    const sg = groupOf.get(link.source);
    const tg = groupOf.get(link.target);
    if (!sg || !tg) continue;
    if (sg === tg) {
      if (link.kind === "return" || backwardInside(link)) {
        bump(bottom, sg);
        bump(arrivals, link.target);
      }
    } else {
      bump(gap, sg);
      bump(bottom, tg);
      bump(arrivals, link.target);
      margin += 1;
    }
  }
  const approach = new Map<string, number>();
  for (const [id, count] of arrivals) {
    const g = groupOf.get(id);
    if (g) approach.set(g, Math.max(approach.get(g) ?? 0, count));
  }
  return { bottom, gap, margin, approach };
}

/** The room a corridor of `lanes` lanes needs. */
export function corridorSize(lanes: number, least: number): number {
  return lanes > 0 ? Math.max(least, (lanes - 1) * LANE_STEP + 2 * LANE_CLEARANCE) : least;
}

export interface LaidGroup {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LaidStep {
  id: string;
  /** Relative to the group when `parentId` is set, absolute otherwise. */
  x: number;
  y: number;
  width: number;
  height: number;
  parentId: string | null;
}

/**
 * The way an edge that cannot run straight to its target is drawn: from the source's output it
 * leaves to `stub`, follows the absolute `lane` waypoints and enters from `side`. A route can mix
 * shared inter-group corridors with obstacle-aware local paths around the cards in its source and
 * target groups.
 */
export interface GraphRoute {
  stub: number;
  lane: Array<[number, number]>;
  side: number;
  /** This route always leaves and enters through the cards' side ports. */
  sidePorts?: boolean;
}

export interface GraphLayout {
  groups: LaidGroup[];
  steps: LaidStep[];
  /** Routes by link id for the links that are not drawn straight. */
  routes: Record<string, GraphRoute>;
  /** The room actually left before the groups, which the inter-group lanes run in. */
  margin: number;
}

interface Box {
  /** Along the card axis (x when blocks stack top to bottom). */
  a0: number;
  a1: number;
  /** Along the stacking axis. */
  b0: number;
  b1: number;
}

type RoutePoint = [number, number];
interface RouteObstacle {
  id: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface QueueItem {
  key: number;
  distance: number;
  score: number;
}

/** A tiny binary min-heap: sorting the complete A* frontier at every step dominated large graphs. */
class RouteQueue {
  private readonly items: QueueItem[] = [];

  get length(): number {
    return this.items.length;
  }

  push(item: QueueItem): void {
    let index = this.items.push(item) - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].score <= item.score) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop(): QueueItem {
    const first = this.items[0];
    const last = this.items.pop()!;
    if (this.items.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.items.length) break;
      const right = left + 1;
      const child =
        right < this.items.length && this.items[right].score < this.items[left].score
          ? right
          : left;
      if (this.items[child].score >= last.score) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

interface ObstacleRouter {
  path(start: RoutePoint, end: RoutePoint): RoutePoint[];
}

/**
 * Build one clearance grid for every card group, then reuse it for all of that group's routes.
 * The grid contains every route endpoint up front; this changes the old per-edge O(cards²) setup
 * into one setup per group. Points and segments through rectangle interiors are marked once, so A*
 * only does constant-time neighbour checks.
 */
function createObstacleRouter(
  cards: ReadonlyArray<RouteObstacle>,
  endpoints: ReadonlyArray<RoutePoint>,
): ObstacleRouter {
  const obstacles = cards.map((card) => ({
    ...card,
    x0: card.x0 - LANE_CLEARANCE,
    y0: card.y0 - LANE_CLEARANCE,
    x1: card.x1 + LANE_CLEARANCE,
    y1: card.y1 + LANE_CLEARANCE,
  }));
  const xs = [
    ...new Set([...endpoints.map(([x]) => x), ...obstacles.flatMap((o) => [o.x0, o.x1])]),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set([...endpoints.map(([, y]) => y), ...obstacles.flatMap((o) => [o.y0, o.y1])]),
  ].sort((a, b) => a - b);
  const width = xs.length;
  const height = ys.length;
  const xIndex = new Map(xs.map((value, index) => [value, index]));
  const yIndex = new Map(ys.map((value, index) => [value, index]));
  const blockedPoint = new Uint8Array(width * height);
  const blockedHorizontal = new Uint8Array(Math.max(0, width - 1) * height);
  const blockedVertical = new Uint8Array(width * Math.max(0, height - 1));
  for (const obstacle of obstacles) {
    const x0 = xIndex.get(obstacle.x0)!;
    const x1 = xIndex.get(obstacle.x1)!;
    const y0 = yIndex.get(obstacle.y0)!;
    const y1 = yIndex.get(obstacle.y1)!;
    for (let yi = y0 + 1; yi < y1; yi += 1) {
      for (let xi = x0 + 1; xi < x1; xi += 1) blockedPoint[yi * width + xi] = 1;
      for (let xi = x0; xi < x1; xi += 1) blockedHorizontal[yi * (width - 1) + xi] = 1;
    }
    for (let xi = x0 + 1; xi < x1; xi += 1) {
      for (let yi = y0; yi < y1; yi += 1) blockedVertical[yi * width + xi] = 1;
    }
  }

  const pointOf = (pointIndex: number): RoutePoint => [
    xs[pointIndex % width],
    ys[Math.floor(pointIndex / width)],
  ];
  const compact = (path: RoutePoint[]): RoutePoint[] =>
    path.filter((point, index) => {
      if (index === 0 || index === path.length - 1) return true;
      const before = path[index - 1];
      const after = path[index + 1];
      return !(
        (before[0] === point[0] && point[0] === after[0]) ||
        (before[1] === point[1] && point[1] === after[1])
      );
    });

  return {
    path(start, end) {
      const startXi = xIndex.get(start[0]);
      const startYi = yIndex.get(start[1]);
      const endXi = xIndex.get(end[0]);
      const endYi = yIndex.get(end[1]);
      if (
        startXi === undefined ||
        startYi === undefined ||
        endXi === undefined ||
        endYi === undefined
      ) {
        throw new Error("Obstacle route endpoint was not included in its reusable grid");
      }
      const startPoint = startYi * width + startXi;
      const endPoint = endYi * width + endXi;
      const startKey = startPoint * 3 + 2;
      const distance = new Map<number, number>([[startKey, 0]]);
      const previous = new Map<number, number>();
      const open = new RouteQueue();
      open.push({ key: startKey, distance: 0, score: 0 });
      let finish: number | null = null;
      while (open.length > 0) {
        const current = open.pop();
        if (current.distance !== distance.get(current.key)) continue;
        const direction = current.key % 3;
        const pointIndex = Math.floor(current.key / 3);
        if (pointIndex === endPoint) {
          finish = current.key;
          break;
        }
        const xi = pointIndex % width;
        const yi = Math.floor(pointIndex / width);
        const candidates: Array<[number, number, 0 | 1, boolean]> = [
          [xi - 1, yi, 0, xi <= 0 || Boolean(blockedHorizontal[yi * (width - 1) + xi - 1])],
          [xi + 1, yi, 0, xi >= width - 1 || Boolean(blockedHorizontal[yi * (width - 1) + xi])],
          [xi, yi - 1, 1, yi <= 0 || Boolean(blockedVertical[(yi - 1) * width + xi])],
          [xi, yi + 1, 1, yi >= height - 1 || Boolean(blockedVertical[yi * width + xi])],
        ];
        for (const [nextXi, nextYi, nextDirection, segmentBlocked] of candidates) {
          if (segmentBlocked) continue;
          const nextPoint = nextYi * width + nextXi;
          if (blockedPoint[nextPoint]) continue;
          const step =
            Math.abs(xs[nextXi] - xs[xi]) +
            Math.abs(ys[nextYi] - ys[yi]) +
            (direction !== 2 && direction !== nextDirection ? EDGE_STUB : 0);
          const candidate = current.distance + step;
          const nextKey = nextPoint * 3 + nextDirection;
          if (candidate >= (distance.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;
          distance.set(nextKey, candidate);
          previous.set(nextKey, current.key);
          const heuristic = Math.abs(end[0] - xs[nextXi]) + Math.abs(end[1] - ys[nextYi]);
          open.push({ key: nextKey, distance: candidate, score: candidate + heuristic });
        }
      }
      if (finish === null) {
        throw new Error(`No card-safe graph route from ${start.join(",")} to ${end.join(",")}`);
      }
      const path: RoutePoint[] = [];
      for (let key: number | undefined = finish; key !== undefined; key = previous.get(key)) {
        path.push(pointOf(Math.floor(key / 3)));
      }
      path.reverse();
      return compact(path);
    },
  };
}

function withoutRepeatedPoints(points: RoutePoint[]): RoutePoint[] {
  return points.filter(
    (point, index) =>
      index === 0 || point[0] !== points[index - 1][0] || point[1] !== points[index - 1][1],
  );
}

/**
 * Route the links that cannot run straight (a return, a link into another block, a link ELK laid
 * backwards) around the cards. Pure: positions in, routes out; `groupOf` names the group of a
 * step and `groups` are in process order. Coordinates are absolute; `cardDirection` is the
 * direction in which cards advance inside a group. Cards keep side ports in every preset.
 */
export function routeLinks(
  links: ReadonlyArray<{ id: string; source: string; target: string; kind: string }>,
  steps: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
  groups: ReadonlyArray<LaidGroup>,
  groupOf: ReadonlyMap<string, string>,
  cardDirection: "DOWN" | "RIGHT",
  /** The room left before the first group, which inter-group lanes share. */
  margin: number = GRAPH_MARGIN,
): Record<string, GraphRoute> {
  const down = cardDirection === "RIGHT";
  const box = (r: { x: number; y: number; width: number; height: number }): Box =>
    down
      ? { a0: r.x, a1: r.x + r.width, b0: r.y, b1: r.y + r.height }
      : { a0: r.y, a1: r.y + r.height, b0: r.x, b1: r.x + r.width };
  const point = (a: number, b: number): [number, number] => (down ? [a, b] : [b, a]);
  const groupIndex = new Map(groups.map((g, i) => [g.id, i]));
  const groupBox = new Map(groups.map((g) => [g.id, box(g)]));
  const cardsByGroup = new Map<string, RouteObstacle[]>();
  for (const [id, step] of steps) {
    const group = groupOf.get(id);
    if (!group) continue;
    cardsByGroup.set(group, [
      ...(cardsByGroup.get(group) ?? []),
      { id, x0: step.x, y0: step.y, x1: step.x + step.width, y1: step.y + step.height },
    ]);
  }
  const routed = links.filter((link) => {
    if (link.source === link.target) return false;
    const s = steps.get(link.source);
    const t = steps.get(link.target);
    if (!s || !t) return false;
    const sg = groupOf.get(link.source);
    const tg = groupOf.get(link.target);
    if (link.kind === "return" || sg !== tg) return true;
    return box(t).a0 <= box(s).a0;
  });
  // Lanes are handed out per corridor in link order: a block's bottom corridor serves local and
  // arriving routes, the gap after a block serves links that leave it, and the outer margin keeps
  // every inter-group path away from intermediate groups.
  const bottomLanes = new Map<string, number>();
  const gapLanes = new Map<string, number>();
  let marginLanes = 0;
  const nextLane = (map: Map<string, number>, key: string): number => {
    const n = map.get(key) ?? 0;
    map.set(key, n + 1);
    return n;
  };
  // How many lanes every gap and the margin end up holding, so each set can be centred in the
  // room the layout reserved for it instead of running on from its first lane.
  const gapTotal = new Map<string, number>();
  let marginTotal = 0;
  for (const link of routed) {
    const sg = groupOf.get(link.source);
    const tg = groupOf.get(link.target);
    if (!sg || !tg || sg === tg) continue;
    gapTotal.set(sg, (gapTotal.get(sg) ?? 0) + 1);
    marginTotal += 1;
  }
  /** The b coordinate of lane `index` of `total`, centred in the gap after group `id`. */
  const gapLane = (id: string, from: number, index: number, total: number): number => {
    const next = groups[groupIndex.get(id)! + 1];
    const to = next ? box(next).b0 : from + BASE_GROUP_GAP;
    const span = (total - 1) * LANE_STEP;
    return from + Math.max(LANE_CLEARANCE, (to - from - span) / 2) + index * LANE_STEP;
  };
  // Every edge arriving at one card turns up to it in its own column, so several arrivals do not
  // climb the same line and pile their arrowheads on one point. Cards of one column start at
  // different columns, because their approaches share the run from the corridor up to their row.
  const arrivals = new Map<string, number>();
  const cardOffset = new Map<string, number>();
  const columnCards = new Map<string, number>();
  interface PlannedRoute {
    link: (typeof routed)[number];
    s: Box;
    t: Box;
    sg?: string;
    tg?: string;
    sBox?: Box;
    tBox?: Box;
    stub: number;
    side: number;
    index: number;
    laneS?: number;
    laneT?: number;
    outer?: number;
    sourceEntry?: RoutePoint;
    targetEntry?: RoutePoint;
  }
  const plans: PlannedRoute[] = [];
  for (const link of routed) {
    const s = box(steps.get(link.source)!);
    const t = box(steps.get(link.target)!);
    const sg = groupOf.get(link.source);
    const tg = groupOf.get(link.target);
    const stub = s.a1 + (down ? LANE_CLEARANCE : EDGE_STUB);
    // The column is chosen from the arrival's index within its own card, so a card's arrivals
    // never share one, and from an offset given to the card inside its column of cards, so two
    // cards of one column do not start at the same line.
    const column = String(Math.round(t.a0));
    if (!cardOffset.has(link.target)) {
      cardOffset.set(link.target, nextLane(columnCards, column) % APPROACH_COLUMNS);
    }
    const index =
      (nextLane(arrivals, link.target) + cardOffset.get(link.target)!) % APPROACH_COLUMNS;
    const side = down ? t.a0 - LANE_CLEARANCE : t.a0 - EDGE_APPROACH - index * APPROACH_STEP;
    const sBox = sg ? groupBox.get(sg) : undefined;
    const tBox = tg ? groupBox.get(tg) : undefined;
    const plan: PlannedRoute = { link, s, t, sg, tg, sBox, tBox, stub, side, index };
    if (sBox && sg === tg) {
      if (!down) plan.laneT = sBox.b1 - CORRIDOR_INSET - nextLane(bottomLanes, sg!) * LANE_STEP;
    } else if (sBox && tBox) {
      const laneS = gapLane(sg!, sBox.b1, nextLane(gapLanes, sg!), gapTotal.get(sg!) ?? 1);
      // Every inter-group route stays in the outer margin until it reaches the target group's own
      // corridor. Turning onto the target's approach beside the source group would cross every
      // intermediate group when the target is far away.
      const span = (marginTotal - 1) * MARGIN_LANE_STEP;
      const first = Math.max(LANE_CLEARANCE, (margin - span) / 2);
      const outer = first + marginLanes * MARGIN_LANE_STEP;
      marginLanes += 1;
      const laneT = tBox.b1 - CORRIDOR_INSET - nextLane(bottomLanes, tg!) * LANE_STEP;
      plan.laneS = laneS;
      plan.laneT = laneT;
      plan.outer = outer;
      if (down) {
        plan.sourceEntry = point(sBox.a0 + LANE_CLEARANCE, laneS);
        plan.targetEntry = point(tBox.a0 + LANE_CLEARANCE + index * APPROACH_STEP, laneT);
      }
    }
    plans.push(plan);
  }

  const endpointsByGroup = new Map<string, RoutePoint[]>();
  const addEndpoint = (group: string | undefined, endpoint: RoutePoint | undefined): void => {
    if (!group || !endpoint) return;
    endpointsByGroup.set(group, [...(endpointsByGroup.get(group) ?? []), endpoint]);
  };
  if (down) {
    for (const plan of plans) {
      const start = point(plan.stub, (plan.s.b0 + plan.s.b1) / 2);
      const end = point(plan.side, (plan.t.b0 + plan.t.b1) / 2);
      if (plan.sBox && plan.sg === plan.tg) {
        addEndpoint(plan.sg, start);
        addEndpoint(plan.sg, end);
      } else if (plan.sBox && plan.tBox) {
        addEndpoint(plan.sg, start);
        addEndpoint(plan.sg, plan.sourceEntry);
        addEndpoint(plan.tg, plan.targetEntry);
        addEndpoint(plan.tg, end);
      }
    }
  }
  const routers = new Map<string, ObstacleRouter>();
  for (const [group, endpoints] of endpointsByGroup) {
    routers.set(group, createObstacleRouter(cardsByGroup.get(group) ?? [], endpoints));
  }

  const routes: Record<string, GraphRoute> = {};
  for (const plan of plans) {
    const { link, s, t, sg, tg, sBox, tBox, stub, side } = plan;
    if (sBox && sg === tg) {
      if (down) {
        routes[link.id] = {
          stub,
          lane: routers
            .get(sg!)!
            .path(point(stub, (s.b0 + s.b1) / 2), point(side, (t.b0 + t.b1) / 2)),
          side,
          sidePorts: true,
        };
      } else {
        routes[link.id] = {
          stub,
          lane: [point(stub, plan.laneT!), point(side, plan.laneT!)],
          side,
        };
      }
    } else if (sBox && tBox) {
      if (down) {
        const sourcePath = routers
          .get(sg!)!
          .path(point(stub, (s.b0 + s.b1) / 2), plan.sourceEntry!);
        const targetPath = routers
          .get(tg!)!
          .path(plan.targetEntry!, point(side, (t.b0 + t.b1) / 2));
        routes[link.id] = {
          stub,
          lane: withoutRepeatedPoints([
            ...sourcePath,
            point(plan.outer!, plan.laneS!),
            point(plan.outer!, plan.laneT!),
            ...targetPath,
          ]),
          side,
          sidePorts: true,
        };
      } else {
        routes[link.id] = {
          stub,
          lane: [
            point(stub, plan.laneS!),
            point(plan.outer!, plan.laneS!),
            point(plan.outer!, plan.laneT!),
            point(side, plan.laneT!),
          ],
          side,
        };
      }
    } else {
      const laneB = Math.max(s.b1, t.b1) + NODE_GAP;
      routes[link.id] = { stub, lane: [point(stub, laneB), point(side, laneB)], side };
    }
  }
  return routes;
}

interface SameAxisRoutes {
  routes: Record<string, GraphRoute>;
  /** Space before a horizontal row of groups for the shared top lanes. */
  margin: number;
  /** Furthest x coordinate used by the shared right lanes of a vertical stack. */
  right: number;
}

/**
 * Same-axis presets need a different topology from the perpendicular corridor router above.
 * Groups in a row share lanes above every group. Groups in a column share lanes to the right of
 * every group; the vertical preset deliberately lays each block's cards in one column, so a card
 * can reach that corridor without crossing a sibling card.
 */
function routeSameAxisLinks(
  links: ReadonlyArray<{ id: string; source: string; target: string; kind: string }>,
  steps: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
  groups: ReadonlyArray<LaidGroup>,
  groupOf: ReadonlyMap<string, string>,
  direction: "DOWN" | "RIGHT",
): SameAxisRoutes {
  const arrivals = new Map<string, number>();
  const laneIntervals: Array<Array<[number, number]>> = [];
  const nextApproach = (target: string): number => {
    const index = arrivals.get(target) ?? 0;
    arrivals.set(target, index + 1);
    return index % APPROACH_COLUMNS;
  };
  const nextLane = (from: number, to: number): number => {
    const interval: [number, number] = [Math.min(from, to), Math.max(from, to)];
    let lane = laneIntervals.findIndex((occupied) =>
      occupied.every(
        ([a, b]) => interval[1] < a - LANE_CLEARANCE || interval[0] > b + LANE_CLEARANCE,
      ),
    );
    if (lane < 0) {
      lane = laneIntervals.length;
      laneIntervals.push([]);
    }
    laneIntervals[lane].push(interval);
    return lane;
  };
  const pending: Array<{
    id: string;
    source: string;
    target: string;
    sourceGroup: string;
    targetGroup: string;
    stub: number;
    side: number;
    entry: number;
    turn: number;
    lane: number;
  }> = [];
  const maxRight = Math.max(0, ...groups.map((group) => group.x + group.width));
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const cardsByGroup = new Map<string, RouteObstacle[]>();
  for (const [id, step] of steps) {
    const group = groupOf.get(id);
    if (!group) continue;
    cardsByGroup.set(group, [
      ...(cardsByGroup.get(group) ?? []),
      { id, x0: step.x, y0: step.y, x1: step.x + step.width, y1: step.y + step.height },
    ]);
  }

  for (const link of links) {
    if (link.source === link.target) continue;
    const source = steps.get(link.source);
    const target = steps.get(link.target);
    if (!source || !target) continue;
    const sourceGroup = groupOf.get(link.source);
    const targetGroupId = groupOf.get(link.target);
    if (!sourceGroup || !targetGroupId) continue;
    const sameGroup = sourceGroup === targetGroupId;
    if (direction === "RIGHT" && sameGroup && link.kind !== "return" && target.x > source.x)
      continue;

    const approach = nextApproach(link.target);
    const side =
      target.x -
      (direction === "RIGHT" ? LANE_CLEARANCE : EDGE_APPROACH + approach * APPROACH_STEP);
    if (direction === "RIGHT") {
      const stub = source.x + source.width + LANE_CLEARANCE;
      const laidSourceGroup = groupById.get(sourceGroup);
      const laidTargetGroup = groupById.get(targetGroupId);
      if (!laidSourceGroup || !laidTargetGroup) continue;
      const sourceExit = laidSourceGroup.x + laidSourceGroup.width - LANE_CLEARANCE;
      const targetEntry =
        laidTargetGroup.x + laidTargetGroup.width - LANE_CLEARANCE - approach * APPROACH_STEP;
      pending.push({
        id: link.id,
        source: link.source,
        target: link.target,
        sourceGroup,
        targetGroup: targetGroupId,
        stub,
        side,
        entry: targetEntry,
        turn: target.y - EDGE_STUB,
        lane: nextLane(sourceExit, targetEntry),
      });
    } else {
      const sourceY = source.y + source.height / 2;
      const turn = target.y - EDGE_STUB;
      pending.push({
        id: link.id,
        source: link.source,
        target: link.target,
        sourceGroup,
        targetGroup: targetGroupId,
        stub: 0,
        side,
        entry: 0,
        turn,
        lane: nextLane(sourceY, turn),
      });
    }
  }

  const endpointsByGroup = new Map<string, RoutePoint[]>();
  const addEndpoint = (group: string, point: RoutePoint): void => {
    endpointsByGroup.set(group, [...(endpointsByGroup.get(group) ?? []), point]);
  };
  if (direction === "RIGHT") {
    for (const route of pending) {
      const source = steps.get(route.source)!;
      const target = steps.get(route.target)!;
      const sourceGroup = groupById.get(route.sourceGroup)!;
      const targetGroup = groupById.get(route.targetGroup)!;
      const sourceExit: RoutePoint = [
        sourceGroup.x + sourceGroup.width - LANE_CLEARANCE,
        sourceGroup.y - LANE_CLEARANCE,
      ];
      const targetEntry: RoutePoint = [route.entry, targetGroup.y - LANE_CLEARANCE];
      addEndpoint(route.sourceGroup, [route.stub, source.y + source.height / 2]);
      addEndpoint(route.sourceGroup, sourceExit);
      addEndpoint(route.targetGroup, targetEntry);
      addEndpoint(route.targetGroup, [route.side, target.y + target.height / 2]);
    }
  }
  const routers = new Map<string, ObstacleRouter>();
  for (const [group, endpoints] of endpointsByGroup) {
    const laidGroup = groupById.get(group)!;
    const header: RouteObstacle = {
      id: `${group}:header`,
      x0: laidGroup.x,
      y0: laidGroup.y,
      x1: laidGroup.x + laidGroup.width - GRAPH_FLOW_ENTRY_STRIP,
      y1: laidGroup.y + GRAPH_GROUP_HEADER,
    };
    routers.set(
      group,
      createObstacleRouter([...(cardsByGroup.get(group) ?? []), header], endpoints),
    );
  }

  const routes: Record<string, GraphRoute> = {};
  let right = maxRight;
  for (const route of pending) {
    if (direction === "RIGHT") {
      const laneY = LANE_CLEARANCE + route.lane * MARGIN_LANE_STEP;
      const source = steps.get(route.source)!;
      const target = steps.get(route.target)!;
      const sourceGroup = groupById.get(route.sourceGroup)!;
      const targetGroup = groupById.get(route.targetGroup)!;
      const sourceExit: RoutePoint = [
        sourceGroup.x + sourceGroup.width - LANE_CLEARANCE,
        sourceGroup.y - LANE_CLEARANCE,
      ];
      const targetEntry: RoutePoint = [route.entry, targetGroup.y - LANE_CLEARANCE];
      const sourcePath = routers
        .get(route.sourceGroup)!
        .path([route.stub, source.y + source.height / 2], sourceExit);
      const targetPath = routers
        .get(route.targetGroup)!
        .path(targetEntry, [route.side, target.y + target.height / 2]);
      routes[route.id] = {
        stub: route.stub,
        lane: withoutRepeatedPoints([
          ...sourcePath,
          [sourceExit[0], laneY],
          [targetEntry[0], laneY],
          ...targetPath,
        ]),
        side: route.side,
        sidePorts: true,
      };
    } else {
      const laneX = maxRight + EDGE_STUB + route.lane * LANE_STEP;
      right = Math.max(right, laneX + LANE_CLEARANCE);
      routes[route.id] = {
        stub: laneX,
        lane: [
          [laneX, route.turn],
          [route.side, route.turn],
        ],
        side: route.side,
        sidePorts: true,
      };
    }
  }
  return {
    routes,
    margin:
      direction === "RIGHT"
        ? Math.max(GRAPH_MARGIN, laneIntervals.length * MARGIN_LANE_STEP + 2 * LANE_CLEARANCE)
        : GRAPH_MARGIN,
    right,
  };
}

/**
 * A card's height from what it shows: the title row, the summary's wrapped lines, the evidence
 * chips (about one and a half per row of the body beside the badge column) and the connection
 * chips. Generous rather than tight: a card taller than its estimate would overlap its
 * neighbour, a shorter one only leaves air.
 */
export function estimateStepHeight(step: {
  summary: string;
  evidence: readonly unknown[];
  connectionCount: number;
  /** Edges the card names instead of drawing; they take chip rows of their own. */
  arrivalCount?: number;
  /** Ported card: the card is as tall as its longer port column, plus the self-loop band. */
  inCount?: number;
  outCount?: number;
  selfCount?: number;
}): number {
  const rows = Math.max(step.inCount ?? 0, step.outCount ?? 0, 1);
  const descriptionLines = step.summary ? Math.min(2, Math.ceil(step.summary.length / 40)) : 0;
  const centre = 24 + descriptionLines * 20 + 30;
  const ports = rows * 34 + 24;
  return 48 + Math.max(centre, ports) + ((step.selfCount ?? 0) > 0 ? 36 : 0) + 8;
}

export async function layoutGraph(
  model: GraphModel,
  direction: "DOWN" | "RIGHT",
  /** Card heights the browser measured, overriding the estimates (a second pass). */
  measuredHeights?: ReadonlyMap<string, number>,
  spacing: GraphSpacing = graphSpacing("default"),
  /** The direction the steps run inside a group; by default across the stacking direction. */
  innerDirectionOverride?: "DOWN" | "RIGHT",
): Promise<GraphLayout> {
  const GROUP_GAP = spacing.group;
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const stepById = new Map(model.steps.map((s) => [s.id, s]));
  // A card also holds a chip for every edge arriving at it that the graph names instead of
  // drawing; the estimate counts them, or the first pass lays the cards out too short.
  const arrivalCounts = new Map<string, number>();
  const outCounts = new Map<string, number>();
  const selfCounts = new Map<string, number>();
  for (const link of model.links) {
    if (link.source === link.target) {
      selfCounts.set(link.source, (selfCounts.get(link.source) ?? 0) + 1);
      continue;
    }
    arrivalCounts.set(link.target, (arrivalCounts.get(link.target) ?? 0) + 1);
    outCounts.set(link.source, (outCounts.get(link.source) ?? 0) + 1);
  }
  const sizeOf = (id: string) => {
    const step = stepById.get(id)!;
    return {
      width: GRAPH_CARD_WIDTH,
      height:
        measuredHeights?.get(id) ??
        estimateStepHeight({
          summary: step.step.summary,
          evidence: step.step.evidence,
          connectionCount: step.connections.length,
          arrivalCount: arrivalCounts.get(id) ?? 0,
          inCount: arrivalCounts.get(id) ?? 0,
          outCount: outCounts.get(id) ?? 0,
          selfCount: selfCounts.get(id) ?? 0,
        }),
    };
  };
  const grouped = model.blocks.length > 0;
  // Inside a group the steps run across the stacking direction; a flat graph runs along it.
  const innerDirection =
    innerDirectionOverride ?? (grouped ? (direction === "DOWN" ? "RIGHT" : "DOWN") : direction);
  const layoutOptions = {
    "elk.algorithm": "layered",
    "elk.direction": innerDirection,
    "elk.randomSeed": "1",
    "elk.spacing.nodeNode": String(spacing.node),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(spacing.layer),
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.cycleBreaking.strategy": "MODEL_ORDER",
    "elk.padding": "[top=0,left=0,bottom=0,right=0]",
  };
  // Cycle edges are drawn but do not pull the layout backwards; only edges inside one block
  // shape that block's layout.
  const seen = new Set<string>();
  const forward = model.links.filter((l) => {
    const key = `${l.source}->${l.target}`;
    if (l.kind === "return" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  /** Lay one set of steps out flat; returns the box size and positions relative to its origin. */
  async function layoutSet(
    ids: string[],
  ): Promise<{ width: number; height: number; steps: LaidStep[] }> {
    // With groups and cards both running down, one stable card column leaves an unobstructed
    // corridor on either side. ELK's normal layered layout puts siblings beside one another;
    // their side ports would then have to draw through a sibling to reach the shared corridor.
    if (grouped && direction === "DOWN" && innerDirection === "DOWN") {
      let y = 0;
      const steps = ids.map((id) => {
        const size = sizeOf(id);
        const step: LaidStep = { id, x: 0, y, ...size, parentId: null };
        y += size.height + spacing.layer;
        return step;
      });
      return {
        width: Math.max(0, ...steps.map((step) => step.width)),
        height: Math.max(0, y - spacing.layer),
        steps,
      };
    }
    const members = new Set(ids);
    const laid = await elk.layout({
      id: "set",
      layoutOptions,
      children: ids.map((id) => ({ id, ...sizeOf(id) })),
      edges: forward
        .filter((l) => members.has(l.source) && members.has(l.target))
        .map((l) => ({ id: l.id, sources: [l.source], targets: [l.target] })),
    });
    const children = laid.children ?? [];
    return {
      width: Math.max(0, ...children.map((c) => (c.x ?? 0) + (c.width ?? 0))),
      height: Math.max(0, ...children.map((c) => (c.y ?? 0) + (c.height ?? 0))),
      steps: children.map((child) => ({
        id: child.id,
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: child.width ?? GRAPH_CARD_WIDTH,
        height: child.height ?? 0,
        parentId: null,
      })),
    };
  }

  // Groups in process order, stacked along the layout direction; steps a block does not own
  // form one flat set after the groups.
  const owned = new Set(model.blocks.flatMap((b) => b.nodeIds));
  const sets: Array<{ blockId: string | null; ids: string[] }> = [
    ...model.blocks.map((block) => ({
      blockId: block.id,
      ids: block.nodeIds.filter((id) => stepById.has(id)),
    })),
    { blockId: null, ids: model.steps.filter((s) => !owned.has(s.id)).map((s) => s.id) },
  ].filter((set) => set.ids.length > 0);
  const inners = await Promise.all(sets.map((set) => layoutSet(set.ids)));
  // A block's corridor for routed edges (below its cards, or to their right in a row) grows with
  // the lanes it must hold.
  const groupOf = new Map<string, string>();
  sets.forEach((set) => {
    if (set.blockId) set.ids.forEach((id) => groupOf.set(id, set.blockId!));
  });
  const relative = new Map<string, LaidStep>();
  inners.forEach((inner) => inner.steps.forEach((step) => relative.set(step.id, step)));
  const plan = laneCounts(model.links, groupOf, (link) => {
    const s = relative.get(link.source);
    const t = relative.get(link.target);
    if (!s || !t) return false;
    return innerDirection === "RIGHT" ? t.x <= s.x : t.y <= s.y;
  });
  const lanes = plan.bottom;
  const sameAxis = grouped && direction === innerDirection;
  // Every corridor is given the room its lanes need before anything is placed: the margin before
  // the first group holds the returns, the gap after a group holds the links leaving it.
  let margin =
    !sameAxis && plan.margin > 0
      ? Math.max(GRAPH_MARGIN, (plan.margin - 1) * MARGIN_LANE_STEP + 2 * LANE_CLEARANCE)
      : GRAPH_MARGIN;
  // A block that receives routed edges holds their approach columns on its entry side; a block
  // that receives none stays narrow.
  const entryOf = (blockId: string): number =>
    (plan.approach.get(blockId) ?? 0) > 0
      ? EDGE_APPROACH + (APPROACH_COLUMNS - 1) * APPROACH_STEP + LANE_CLEARANCE
      : GRAPH_GROUP_ENTRY;
  const groups: LaidGroup[] = [];
  const steps: LaidStep[] = [];
  let cursor = 24;
  sets.forEach((set, index) => {
    const inner = inners[index];
    if (set.blockId) {
      const laneCount = sameAxis ? 0 : (lanes.get(set.blockId) ?? 0);
      const corridor = laneCount
        ? laneCount * LANE_STEP + CORRIDOR_INSET - GRAPH_GROUP_PADDING / 2
        : 0;
      // Edges arrive along the card axis: from the left when the cards run right, from the top
      // when they run down. That side gets the entry padding.
      const entry = entryOf(set.blockId);
      const entryLeft = sameAxis || direction === "DOWN" ? entry : GRAPH_GROUP_PADDING;
      const entryTop = !sameAxis && direction === "RIGHT" ? entry : GRAPH_GROUP_PADDING;
      const width =
        inner.width +
        entryLeft +
        GRAPH_GROUP_PADDING +
        (innerDirection === "DOWN" ? corridor : 0) +
        (sameAxis && direction === "RIGHT" ? GRAPH_FLOW_ENTRY_STRIP : 0);
      const height =
        inner.height +
        entryTop +
        GRAPH_GROUP_PADDING +
        GRAPH_GROUP_HEADER +
        (innerDirection === "RIGHT" ? corridor : 0);
      const x = direction === "DOWN" ? margin : cursor;
      const y = direction === "DOWN" ? cursor : margin;
      groups.push({ id: set.blockId, x, y, width, height });
      for (const step of inner.steps) {
        steps.push({
          ...step,
          x: step.x + entryLeft,
          y: step.y + entryTop + GRAPH_GROUP_HEADER,
          parentId: set.blockId,
        });
      }
      cursor +=
        (direction === "DOWN" ? height : width) +
        corridorSize(plan.gap.get(set.blockId) ?? 0, GROUP_GAP);
    } else {
      const x = direction === "DOWN" ? margin : cursor;
      const y = direction === "DOWN" ? cursor : margin;
      for (const step of inner.steps) steps.push({ ...step, x: step.x + x, y: step.y + y });
      cursor += (direction === "DOWN" ? inner.height : inner.width) + GROUP_GAP;
    }
  });
  const absoluteSteps = () => {
    const groupPos = new Map(groups.map((group) => [group.id, group]));
    return new Map(
      steps.map((step) => {
        const group = step.parentId ? groupPos.get(step.parentId) : undefined;
        return [
          step.id,
          {
            x: step.x + (group?.x ?? 0),
            y: step.y + (group?.y ?? 0),
            width: step.width,
            height: step.height,
          },
        ];
      }),
    );
  };
  let absolute = absoluteSteps();
  let routes: Record<string, GraphRoute>;
  if (sameAxis) {
    let sameAxisLayout = routeSameAxisLinks(model.links, absolute, groups, groupOf, direction);
    if (direction === "RIGHT" && sameAxisLayout.margin > margin) {
      const shift = sameAxisLayout.margin - margin;
      margin = sameAxisLayout.margin;
      groups.forEach((group) => {
        group.y += shift;
      });
      absolute = absoluteSteps();
      sameAxisLayout = routeSameAxisLinks(model.links, absolute, groups, groupOf, direction);
    }
    if (direction === "DOWN") {
      groups.forEach((group) => {
        group.width = Math.max(group.width, sameAxisLayout.right - group.x + LANE_CLEARANCE);
      });
    }
    routes = sameAxisLayout.routes;
  } else {
    routes = routeLinks(model.links, absolute, groups, groupOf, innerDirection, margin);
  }
  return {
    groups,
    steps,
    routes,
    margin,
  };
}
