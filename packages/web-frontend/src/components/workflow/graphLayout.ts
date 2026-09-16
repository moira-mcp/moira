/**
 * Layout of the technical graph: one tinted group per process block, the groups stacked in process
 * order (top to bottom, or left to right for "Horizontal"), the steps inside a group laid out by
 * ELK layered across the stacking direction (left to right inside a stacked group, top to bottom
 * inside a group in a row), so a block reads like a lane of its steps. Node sizes are the step
 * cards' estimated sizes; positions come back relative to the group for React Flow's `parentId`.
 * Without a process view the steps are laid out flat along the stacking direction.
 */

import type { GraphModel } from "../run/graphModel";

export const GRAPH_CARD_WIDTH = 660;
/** Least room before the first group along the card axis, where cross-block return lanes run. */
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
const GRAPH_GROUP_HEADER = 36;
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

/**
 * How many lanes every corridor must hold, counted before the groups are placed so that each
 * corridor is given the room its lanes need: a block's own corridor (its backward links inside
 * the block and the returns arriving into it), the gap after a block (every link leaving it for
 * another block) and the margin before the first block (every return to an earlier block).
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
  groupIndex: ReadonlyMap<string, number>,
  backwardInside: (link: { source: string; target: string }) => boolean,
): LaneCounts {
  const bottom = new Map<string, number>();
  const gap = new Map<string, number>();
  const arrivals = new Map<string, number>();
  let margin = 0;
  const bump = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const link of links) {
    const sg = groupOf.get(link.source);
    const tg = groupOf.get(link.target);
    if (!sg || !tg) continue;
    if (sg === tg) {
      if (link.kind === "return" || backwardInside(link)) {
        bump(bottom, sg);
        bump(arrivals, link.target);
      }
    } else if (groupIndex.get(tg)! > groupIndex.get(sg)!) {
      bump(gap, sg);
      bump(arrivals, link.target);
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
 * leaves along the card axis to `stub`, turns onto the first lane, follows the `lane` waypoints
 * (absolute), turns at `side` (a card-axis coordinate before the target) and enters the target's
 * input. Edges inside a block run in the block's bottom corridor (right corridor when the blocks
 * are in a row); edges into another block run in the gap after their source's block; a return
 * to an earlier block climbs along the margin before the groups.
 */
export interface GraphRoute {
  stub: number;
  lane: Array<[number, number]>;
  side: number;
}

export interface GraphLayout {
  groups: LaidGroup[];
  steps: LaidStep[];
  /** Routes by link id for the links that are not drawn straight. */
  routes: Record<string, GraphRoute>;
  /** The room actually left before the first group, which the return lanes run in. */
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

/**
 * Route the links that cannot run straight (a return, a link into another block, a link ELK laid
 * backwards) around the cards. Pure: positions in, routes out; `groupOf` names the group of a
 * step, `groups` are in process order. Coordinates are absolute; `cardDirection` is the direction
 * the cards run in (the handles sit on their left and right for `RIGHT`, top and bottom for
 * `DOWN`).
 */
export function routeLinks(
  links: ReadonlyArray<{ id: string; source: string; target: string; kind: string }>,
  steps: ReadonlyMap<string, { x: number; y: number; width: number; height: number }>,
  groups: ReadonlyArray<LaidGroup>,
  groupOf: ReadonlyMap<string, string>,
  cardDirection: "DOWN" | "RIGHT",
  /** The room left before the first group, which the return lanes share. */
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
  const routed = links.filter((link) => {
    const s = steps.get(link.source);
    const t = steps.get(link.target);
    if (!s || !t) return false;
    const sg = groupOf.get(link.source);
    const tg = groupOf.get(link.target);
    if (link.kind === "return" || sg !== tg) return true;
    return box(t).a0 <= box(s).a0;
  });
  // Lanes are handed out per corridor in link order: a block's bottom corridor serves its own
  // routed links and the returns that come back into it; the gap after a block serves the links
  // that leave it; the margin serves every return to an earlier block.
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
    if (groupIndex.get(tg)! < groupIndex.get(sg)!) marginTotal += 1;
  }
  /** The b coordinate of lane `index` of `total`, centred in the gap after group `id`. */
  const gapLane = (id: string, from: number, index: number, total: number): number => {
    const next = groups[groupIndex.get(id)! + 1];
    const to = next ? box(next).b0 : from + BASE_GROUP_GAP;
    const span = (total - 1) * LANE_STEP;
    return from + Math.max(LANE_CLEARANCE, (to - from - span) / 2) + index * LANE_STEP;
  };
  const routes: Record<string, GraphRoute> = {};
  // Every edge arriving at one card turns up to it in its own column, so several arrivals do not
  // climb the same line and pile their arrowheads on one point. Cards of one column start at
  // different columns, because their approaches share the run from the corridor up to their row.
  const arrivals = new Map<string, number>();
  const cardOffset = new Map<string, number>();
  const columnCards = new Map<string, number>();
  for (const link of routed) {
    const s = box(steps.get(link.source)!);
    const t = box(steps.get(link.target)!);
    const sg = groupOf.get(link.source);
    const tg = groupOf.get(link.target);
    const stub = s.a1 + EDGE_STUB;
    // The column is chosen from the arrival's index within its own card, so a card's arrivals
    // never share one, and from an offset given to the card inside its column of cards, so two
    // cards of one column do not start at the same line.
    const column = String(Math.round(t.a0));
    if (!cardOffset.has(link.target)) {
      cardOffset.set(link.target, nextLane(columnCards, column) % APPROACH_COLUMNS);
    }
    const index =
      (nextLane(arrivals, link.target) + cardOffset.get(link.target)!) % APPROACH_COLUMNS;
    const side = t.a0 - EDGE_APPROACH - index * APPROACH_STEP;
    const sBox = sg ? groupBox.get(sg) : undefined;
    const tBox = tg ? groupBox.get(tg) : undefined;
    if (sBox && sg === tg) {
      const laneB = sBox.b1 - CORRIDOR_INSET - nextLane(bottomLanes, sg!) * LANE_STEP;
      routes[link.id] = { stub, lane: [point(stub, laneB), point(side, laneB)], side };
    } else if (sBox && tBox && groupIndex.get(tg!)! > groupIndex.get(sg!)!) {
      const laneB = gapLane(sg!, sBox.b1, nextLane(gapLanes, sg!), gapTotal.get(sg!) ?? 1);
      routes[link.id] = { stub, lane: [point(stub, laneB), point(side, laneB)], side };
    } else if (sBox && tBox) {
      const laneS = gapLane(sg!, sBox.b1, nextLane(gapLanes, sg!), gapTotal.get(sg!) ?? 1);
      // Return lanes share the margin before the first group, spread inside it rather than
      // marching off the canvas once there are more returns than the margin was sized for.
      const span = (marginTotal - 1) * MARGIN_LANE_STEP;
      const first = Math.max(LANE_CLEARANCE, (margin - span) / 2);
      const outer = first + marginLanes * MARGIN_LANE_STEP;
      marginLanes += 1;
      const laneT = tBox.b1 - CORRIDOR_INSET - nextLane(bottomLanes, tg!) * LANE_STEP;
      routes[link.id] = {
        stub,
        lane: [point(stub, laneS), point(outer, laneS), point(outer, laneT), point(side, laneT)],
        side,
      };
    } else {
      const laneB = Math.max(s.b1, t.b1) + NODE_GAP;
      routes[link.id] = { stub, lane: [point(stub, laneB), point(side, laneB)], side };
    }
  }
  return routes;
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
  const innerDirection = grouped ? (direction === "DOWN" ? "RIGHT" : "DOWN") : direction;
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
  const groupIndex = new Map(model.blocks.map((b, i) => [b.id, i]));
  const relative = new Map<string, LaidStep>();
  inners.forEach((inner) => inner.steps.forEach((step) => relative.set(step.id, step)));
  const plan = laneCounts(model.links, groupOf, groupIndex, (link) => {
    const s = relative.get(link.source);
    const t = relative.get(link.target);
    if (!s || !t) return false;
    return innerDirection === "RIGHT" ? t.x <= s.x : t.y <= s.y;
  });
  const lanes = plan.bottom;
  // Every corridor is given the room its lanes need before anything is placed: the margin before
  // the first group holds the returns, the gap after a group holds the links leaving it.
  const margin =
    plan.margin > 0
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
      const laneCount = lanes.get(set.blockId) ?? 0;
      const corridor = laneCount
        ? laneCount * LANE_STEP + CORRIDOR_INSET - GRAPH_GROUP_PADDING / 2
        : 0;
      // Edges arrive along the card axis: from the left when the cards run right, from the top
      // when they run down. That side gets the entry padding.
      const entry = entryOf(set.blockId);
      const entryLeft = direction === "DOWN" ? entry : GRAPH_GROUP_PADDING;
      const entryTop = direction === "DOWN" ? GRAPH_GROUP_PADDING : entry;
      const width =
        inner.width + entryLeft + GRAPH_GROUP_PADDING + (direction === "RIGHT" ? corridor : 0);
      const height =
        inner.height +
        entryTop +
        GRAPH_GROUP_PADDING +
        GRAPH_GROUP_HEADER +
        (direction === "DOWN" ? corridor : 0);
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
  const groupPos = new Map(groups.map((g) => [g.id, g]));
  const absolute = new Map(
    steps.map((step) => {
      const g = step.parentId ? groupPos.get(step.parentId) : undefined;
      return [
        step.id,
        {
          x: step.x + (g?.x ?? 0),
          y: step.y + (g?.y ?? 0),
          width: step.width,
          height: step.height,
        },
      ];
    }),
  );
  return {
    groups,
    steps,
    routes: routeLinks(model.links, absolute, groups, groupOf, innerDirection, margin),
    margin,
  };
}
