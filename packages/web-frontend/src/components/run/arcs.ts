/**
 * Connectors of the lanes rail, as pure geometry over block indices:
 *
 * - return arcs — every cycle transition drawn from its source lane to its target lane beneath
 *   the rail, nested by span so arcs never cross;
 * - forward links — every forward transition that skips at least one lane, drawn above the rail
 *   the same way (the rail's adjacency already stands for a transition to the next lane). A hub
 *   receives links like any other block, so no block is left without a visible connection.
 */

import type { RunBlock } from "./model";

export interface LaneArc {
  from: number;
  to: number;
  label: string;
  depth: number;
  cause: string;
  exit: string;
}

export interface LaneLink {
  from: number;
  to: number;
  label: string;
  depth: number;
}

export const ARC_BASE = 14;
/** Each nesting depth adds one line: labels are shown on demand, not stacked under the lines. */
export const ARC_STEP = 12;
/** Room beneath the deepest arc for the arrowhead and the first lit label pill row. */
export const ARC_TAIL = 24;
export const LINK_BASE = 12;
export const LINK_STEP = 12;
/** Room above the highest link for the first lit label pill row. */
export const LINK_TAIL = 24;
/** Height of one lit label pill row beneath the arcs (or above the links). */
export const PILL_ROW = 20;

/** Shorter spans nest inside longer ones: assign depth by span so lines never cross each other. */
function nestBySpan<T extends { from: number; to: number }>(
  raw: readonly T[],
): Array<T & { depth: number }> {
  const sorted = [...raw].sort((a, b) => Math.abs(a.from - a.to) - Math.abs(b.from - b.to));
  const lanesUsed: Array<Array<[number, number]>> = [];
  return sorted.map((item) => {
    const lo = Math.min(item.from, item.to);
    const hi = Math.max(item.from, item.to);
    let depth = 0;
    while (lanesUsed[depth]?.some(([a, b]) => lo <= b && a <= hi)) depth += 1;
    (lanesUsed[depth] ??= []).push([lo, hi]);
    return { ...item, depth };
  });
}

export function buildArcs(blocks: readonly RunBlock[]): LaneArc[] {
  const index = new Map(blocks.map((b) => [b.id, b.index]));
  const raw = blocks.flatMap((b) =>
    b.transitions
      .filter((t) => t.cycle && index.has(t.to))
      .map((t) => ({
        from: b.index,
        to: index.get(t.to)!,
        label: t.label,
        cause: t.cycle!.cause,
        exit: t.cycle!.exit,
      })),
  );
  return nestBySpan(raw);
}

/** Forward transitions that skip at least one lane; adjacent ones are the rail itself. */
export function buildLinks(blocks: readonly RunBlock[]): LaneLink[] {
  const index = new Map(blocks.map((b) => [b.id, b.index]));
  const raw = blocks.flatMap((b) =>
    b.transitions
      .filter((t) => !t.cycle && index.has(t.to) && index.get(t.to)! > b.index + 1)
      .map((t) => ({ from: b.index, to: index.get(t.to)!, label: t.label })),
  );
  return nestBySpan(raw);
}

/** A self-loop is a short hook; a wider one keeps its label clear of the arrows. */
export function arcGeometry(
  arc: LaneArc,
  centerOf: (index: number) => number,
): { x1: number; x2: number; y: number; d: string } {
  const self = arc.from === arc.to;
  const x1 = centerOf(arc.from) + (self ? 30 : 0);
  const x2 = centerOf(arc.to) - (self ? 30 : 0);
  const y = ARC_BASE + arc.depth * ARC_STEP;
  return { x1, x2, y, d: `M ${x1} 2 L ${x1} ${y} L ${x2} ${y} L ${x2} 2` };
}

/**
 * The arcs band: the deepest line, the tail for its arrowhead and one pill, plus a row for every
 * further pill the source with the most arcs can light at once, so a revealed column of labels
 * stays inside the rail's viewport.
 */
export function arcsHeight(arcs: readonly LaneArc[]): number {
  if (!arcs.length) return 0;
  const perSource = new Map<number, number>();
  for (const arc of arcs) perSource.set(arc.from, (perSource.get(arc.from) ?? 0) + 1);
  const mostLit = Math.max(...perSource.values());
  return (
    ARC_BASE +
    Math.max(...arcs.map((a) => a.depth)) * ARC_STEP +
    ARC_TAIL +
    (mostLit - 1) * PILL_ROW
  );
}

/**
 * A forward link rises from the source lane's top, runs along its channel above the rail and
 * drops onto the target lane's top; `height` is the SVG height so the rail's top edge is `y = height`.
 * The label is not on the line: the source lane's chip names the target and lights the link.
 */
export function linkGeometry(
  link: LaneLink,
  centerOf: (index: number) => number,
  height: number,
): { x1: number; x2: number; y: number; d: string } {
  const x1 = centerOf(link.from) + 30;
  const x2 = centerOf(link.to) - 30;
  const y = height - LINK_BASE - link.depth * LINK_STEP;
  return { x1, x2, y, d: `M ${x1} ${height - 2} L ${x1} ${y} L ${x2} ${y} L ${x2} ${height - 2}` };
}

export function linksHeight(links: readonly LaneLink[]): number {
  if (!links.length) return 0;
  const perSource = new Map<number, number>();
  for (const link of links) perSource.set(link.from, (perSource.get(link.from) ?? 0) + 1);
  const mostLit = Math.max(...perSource.values());
  return (
    LINK_BASE +
    Math.max(...links.map((l) => l.depth)) * LINK_STEP +
    LINK_TAIL +
    (mostLit - 1) * PILL_ROW
  );
}

/**
 * Where the pills of the connectors lit at the same time go: one row each, starting just beyond
 * the outermost lit connector (the deepest arc, or the highest link), so pills never cover each
 * other however many connectors a chip folds or a selected lane owns. `direction` is +1 for arcs
 * (rows grow downward from the deepest arc) and -1 for links (rows grow upward).
 */
export function pillRows(
  lit: ReadonlyArray<{ key: string; y: number }>,
  direction: 1 | -1,
  row: number = PILL_ROW,
): Map<string, number> {
  if (lit.length === 0) return new Map();
  const ordered = [...lit].sort((a, b) => (direction === 1 ? b.y - a.y : a.y - b.y));
  const base = direction === 1 ? ordered[0].y + 3 : ordered[0].y - 3;
  return new Map(ordered.map((item, index) => [item.key, base + direction * index * row]));
}
