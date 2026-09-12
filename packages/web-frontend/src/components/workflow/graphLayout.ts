/**
 * Layout of the technical graph: one tinted group per process block, the groups stacked in process
 * order (top to bottom, or left to right for "Horizontal"), the steps inside a group laid out by
 * ELK layered across the stacking direction (left to right inside a stacked group, top to bottom
 * inside a group in a row), so a block reads like a lane of its steps. Node sizes are the step
 * cards' estimated sizes; positions come back relative to the group for React Flow's `parentId`.
 * Without a process view the steps are laid out flat along the stacking direction.
 */

import type { GraphModel } from "../run/graphModel";

export const GRAPH_CARD_WIDTH = 320;
/** Room left before the first group along the card axis, where cross-block return lanes run. */
export const GRAPH_MARGIN = 48;
const GRAPH_GROUP_PADDING = 16;
const GRAPH_GROUP_HEADER = 36;
const NODE_GAP = 20;
const LAYER_GAP = 48;
const GROUP_GAP = 56;
/** Distance between two edge lanes sharing a corridor. */
const LANE_STEP = 12;
/** How far an edge leaves its source card before turning, and stops before its target card. */
const EDGE_STUB = 12;
const EDGE_APPROACH = 8;
/** Where a block's first corridor lane runs, measured from the block's far edge. */
const CORRIDOR_INSET = 14;

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
  const routes: Record<string, GraphRoute> = {};
  for (const link of routed) {
    const s = box(steps.get(link.source)!);
    const t = box(steps.get(link.target)!);
    const sg = groupOf.get(link.source);
    const tg = groupOf.get(link.target);
    const stub = s.a1 + EDGE_STUB;
    const side = t.a0 - EDGE_APPROACH;
    const sBox = sg ? groupBox.get(sg) : undefined;
    const tBox = tg ? groupBox.get(tg) : undefined;
    if (sBox && sg === tg) {
      const laneB = sBox.b1 - CORRIDOR_INSET - nextLane(bottomLanes, sg!) * LANE_STEP;
      routes[link.id] = { stub, lane: [point(stub, laneB), point(side, laneB)], side };
    } else if (sBox && tBox && groupIndex.get(tg!)! > groupIndex.get(sg!)!) {
      const laneB = sBox.b1 + GROUP_GAP / 2 + nextLane(gapLanes, sg!) * LANE_STEP;
      routes[link.id] = { stub, lane: [point(stub, laneB), point(side, laneB)], side };
    } else if (sBox && tBox) {
      const laneS = sBox.b1 + GROUP_GAP / 2 + nextLane(gapLanes, sg!) * LANE_STEP;
      const outer = GRAPH_MARGIN - LANE_STEP * (marginLanes + 1);
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

/** How many lanes a block's bottom corridor must hold: its own routed links and the returns into it. */
function corridorLanes(
  links: ReadonlyArray<{ source: string; target: string; kind: string }>,
  groupOf: ReadonlyMap<string, string>,
  groupIndex: ReadonlyMap<string, number>,
  backwardInside: (link: { source: string; target: string }) => boolean,
): Map<string, number> {
  const lanes = new Map<string, number>();
  for (const link of links) {
    const sg = groupOf.get(link.source);
    const tg = groupOf.get(link.target);
    if (!sg || !tg) continue;
    if (sg === tg) {
      if (link.kind === "return" || backwardInside(link)) lanes.set(sg, (lanes.get(sg) ?? 0) + 1);
    } else if (groupIndex.get(tg)! < groupIndex.get(sg)!) {
      lanes.set(tg, (lanes.get(tg) ?? 0) + 1);
    }
  }
  return lanes;
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
}): number {
  const summaryLines = step.summary ? Math.min(4, Math.ceil(step.summary.length / 30)) : 0;
  const evidenceRows = step.evidence.length ? Math.ceil(step.evidence.length / 1.5) + 0.5 : 0;
  const chipRows = step.connectionCount ? Math.ceil(step.connectionCount / 1.5) : 0;
  return 52 + summaryLines * 20 + evidenceRows * 22 + chipRows * 26;
}

export async function layoutGraph(
  model: GraphModel,
  direction: "DOWN" | "RIGHT",
  /** Card heights the browser measured, overriding the estimates (a second pass). */
  measuredHeights?: ReadonlyMap<string, number>,
): Promise<GraphLayout> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const stepById = new Map(model.steps.map((s) => [s.id, s]));
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
    "elk.spacing.nodeNode": String(NODE_GAP),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(LAYER_GAP),
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
  const lanes = corridorLanes(model.links, groupOf, groupIndex, (link) => {
    const s = relative.get(link.source);
    const t = relative.get(link.target);
    if (!s || !t) return false;
    return innerDirection === "RIGHT" ? t.x <= s.x : t.y <= s.y;
  });
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
      const width = inner.width + 2 * GRAPH_GROUP_PADDING + (direction === "RIGHT" ? corridor : 0);
      const height =
        inner.height +
        2 * GRAPH_GROUP_PADDING +
        GRAPH_GROUP_HEADER +
        (direction === "DOWN" ? corridor : 0);
      const x = direction === "DOWN" ? GRAPH_MARGIN : cursor;
      const y = direction === "DOWN" ? cursor : GRAPH_MARGIN;
      groups.push({ id: set.blockId, x, y, width, height });
      for (const step of inner.steps) {
        steps.push({
          ...step,
          x: step.x + GRAPH_GROUP_PADDING,
          y: step.y + GRAPH_GROUP_PADDING + GRAPH_GROUP_HEADER,
          parentId: set.blockId,
        });
      }
      cursor += (direction === "DOWN" ? height : width) + GROUP_GAP;
    } else {
      const x = direction === "DOWN" ? GRAPH_MARGIN : cursor;
      const y = direction === "DOWN" ? cursor : GRAPH_MARGIN;
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
    routes: routeLinks(model.links, absolute, groups, groupOf, innerDirection),
  };
}
