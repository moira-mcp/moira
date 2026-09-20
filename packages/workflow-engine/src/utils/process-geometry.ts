/**
 * The geometry between two ports once `layoutBlocks` has chosen the lanes: how a line gets from a
 * port on a card's border to its lane and back, in the rows layout and in the stacked (transposed)
 * one; which column beside a card each lane edge's vertical takes so two never share a line; and
 * the rounded polyline every edge is drawn with. Pure; the map draws these paths in React Flow and
 * the progress picture draws the same paths in its SVG.
 */

import type { LaidOutEdge } from "./process-layout.js";
import { transitionKey } from "./process-layout.js";

/** A polyline with rounded corners as an SVG path: `M … L … Q … L …`. */
export function roundedPath(points: ReadonlyArray<[number, number]>, radius = 10): string {
  if (points.length < 2) return "";
  const parts = [`M ${points[0][0]} ${points[0][1]}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const [nx, ny] = points[i + 1];
    const inLen = Math.hypot(cx - px, cy - py);
    const outLen = Math.hypot(nx - cx, ny - cy);
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (r <= 0 || inLen === 0 || outLen === 0) {
      parts.push(`L ${cx} ${cy}`);
      continue;
    }
    const ax = cx - ((cx - px) / inLen) * r;
    const ay = cy - ((cy - py) / inLen) * r;
    const bx = cx + ((nx - cx) / outLen) * r;
    const by = cy + ((ny - cy) / outLen) * r;
    parts.push(`L ${ax} ${ay} Q ${cx} ${cy} ${bx} ${by}`);
  }
  const [lx, ly] = points[points.length - 1];
  parts.push(`L ${lx} ${ly}`);
  return parts.join(" ");
}

/** The points of a laid path (`M x y L x y …`), so a lane can be read back from it. */
function pathPoints(path: string): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (const match of path.matchAll(/[ML]\s*(-?[\d.]+)\s+(-?[\d.]+)/g)) {
    points.push([Number(match[1]), Number(match[2])]);
  }
  return points;
}

/** How far an edge runs out of its port before it turns. */
const PORT_STUB = 20;
const SELF_LOOP_DIP = 26;
/** Distance between the verticals of two edges leaving or entering neighbouring ports. */
const PORT_COLUMN_STEP = 10;

export interface PortSlots {
  outRank: number;
  inRank: number;
}

export interface PortedPath {
  points: Array<[number, number]>;
  labelX: number;
  labelY: number;
}

/**
 * The stacked layout (blocks top to bottom, lanes in the gaps between columns) is the row layout
 * transposed, so its laid path leaves the source's bottom edge and reaches the target's top edge.
 * The ports stay on the sides: the edge leaves the right port, runs a stub out (one column per
 * port rank), drops into the laid path, and at the far end comes down beside the target's left
 * edge and enters its left port.
 */
export function stackedPoints(
  laid: LaidOutEdge,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  slots: PortSlots,
): PortedPath {
  const logical = pathPoints(laid.path).map(([x, y]) => [y, x] as [number, number]);
  const outX = sx + PORT_STUB + slots.outRank * PORT_COLUMN_STEP;
  const inX = tx - PORT_STUB - slots.inRank * PORT_COLUMN_STEP;
  // The laid path's first and last points sit on the source's bottom and the target's top edge;
  // the points after and before them are straight below and above, in the row gaps.
  const inner = logical.slice(1, -1);
  if (inner.length === 0) {
    const midY = (sy + ty) / 2;
    const points: Array<[number, number]> = [
      [sx, sy],
      [outX, sy],
      [outX, midY],
      [inX, midY],
      [inX, ty],
      [tx, ty],
    ];
    return { points, labelX: (outX + inX) / 2, labelY: midY };
  }
  const first = inner[0];
  const last = inner[inner.length - 1];
  const points: Array<[number, number]> = [
    [sx, sy],
    [outX, sy],
    [outX, first[1]],
    ...inner.slice(1, -1),
    [inX, last[1]],
    [inX, ty],
    [tx, ty],
  ];
  // The label sits on the longest run of the path.
  let best = 0;
  let bestLength = -1;
  for (let i = 0; i + 1 < points.length; i++) {
    const length =
      Math.abs(points[i + 1][0] - points[i][0]) + Math.abs(points[i + 1][1] - points[i][1]);
    if (length > bestLength) {
      bestLength = length;
      best = i;
    }
  }
  return {
    points,
    labelX: (points[best][0] + points[best + 1][0]) / 2,
    labelY: (points[best][1] + points[best + 1][1]) / 2,
  };
}

/**
 * The edge from its source port to its target port on the rows layout: a forward elbow keeps its
 * vertical in the gap the layout chose; a skip, a hub bundle or a return keeps the lane the layout
 * gave it and reaches it from the ports through short stubs, its vertical in a column of its own
 * beside the card (`portRanks`); a transition back to the block itself dips under its bottom port.
 */
export function portedPoints(
  laid: LaidOutEdge,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  slots: PortSlots,
): PortedPath {
  const points = pathPoints(laid.path);
  if (laid.from === laid.to) {
    const dip = Math.max(sy, ty) + SELF_LOOP_DIP;
    return {
      points: [
        [sx, sy],
        [sx, dip],
        [tx, dip],
        [tx, ty],
      ],
      labelX: (sx + tx) / 2,
      labelY: dip + 10,
    };
  }
  if (laid.kind === "forward") {
    const midX = points.length >= 3 ? points[1][0] : (sx + tx) / 2;
    const pts: Array<[number, number]> =
      Math.abs(sy - ty) < 1
        ? [
            [sx, sy],
            [tx, ty],
          ]
        : [
            [sx, sy],
            [midX, sy],
            [midX, ty],
            [tx, ty],
          ];
    return { points: pts, labelX: midX, labelY: Math.min(sy, ty) - 4 };
  }
  const ys = points.map((p) => p[1]);
  const laneY = laid.laneY ?? (laid.kind === "cycle" ? Math.max(...ys) : Math.min(...ys));
  const out = sx + PORT_STUB + slots.outRank * PORT_COLUMN_STEP;
  const into = tx - PORT_STUB - slots.inRank * PORT_COLUMN_STEP;
  return {
    points: [
      [sx, sy],
      [out, sy],
      [out, laneY],
      [into, laneY],
      [into, ty],
      [tx, ty],
    ],
    labelX: (out + into) / 2,
    labelY: laneY,
  };
}

/** The path between two ports: the stacked routing when the layout was transposed, else the rows'. */
export function portedPath(
  laid: LaidOutEdge,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  vertical = false,
  slots: PortSlots = { outRank: 0, inRank: 0 },
): { path: string; labelX: number; labelY: number } {
  const routed =
    vertical && laid.from !== laid.to
      ? stackedPoints(laid, sx, sy, tx, ty, slots)
      : portedPoints(laid, sx, sy, tx, ty, slots);
  return { path: roundedPath(routed.points), labelX: routed.labelX, labelY: routed.labelY };
}

/**
 * Column ranks of the lane edges at every card, per side. For one card and one side, the edges
 * split into those whose lane lies above the card and those whose lane lies below; each group
 * takes its own range of columns (the above group innermost), and within a group the ports are
 * ordered so the port furthest from the lane is outermost.
 */
export function portRanks(
  edges: readonly LaidOutEdge[],
  ports: ReadonlyMap<string, { outputs: string[]; inputs: string[] }>,
  blockY: ReadonlyMap<string, number>,
): { out: Map<string, number>; in: Map<string, number> } {
  const out = new Map<string, number>();
  const inn = new Map<string, number>();
  type Item = { id: string; index: number; above: boolean };
  const bySource = new Map<string, Item[]>();
  const byTarget = new Map<string, Item[]>();
  for (const laid of edges) {
    if (laid.kind === "forward" || laid.from === laid.to || laid.laneY === undefined) continue;
    const key = transitionKey(laid.from, laid.transition);
    const outIndex = ports.get(laid.from)?.outputs.indexOf(key) ?? -1;
    const inIndex = ports.get(laid.to)?.inputs.indexOf(key) ?? -1;
    bySource.set(laid.from, [
      ...(bySource.get(laid.from) ?? []),
      { id: laid.id, index: outIndex, above: laid.laneY < (blockY.get(laid.from) ?? 0) },
    ]);
    byTarget.set(laid.to, [
      ...(byTarget.get(laid.to) ?? []),
      { id: laid.id, index: inIndex, above: laid.laneY < (blockY.get(laid.to) ?? 0) },
    ]);
  }
  const assign = (groups: Map<string, Item[]>, into: Map<string, number>) => {
    for (const items of groups.values()) {
      // Above the card: the lowest port travels furthest, so it goes outermost — descending
      // index. Below: the highest port travels furthest — ascending index.
      const above = items.filter((i) => i.above).sort((a, b) => b.index - a.index);
      const below = items.filter((i) => !i.above).sort((a, b) => a.index - b.index);
      above.forEach((item, rank) => into.set(item.id, rank));
      below.forEach((item, rank) => into.set(item.id, above.length + rank));
    }
  };
  assign(bySource, out);
  assign(byTarget, inn);
  return { out, in: inn };
}
