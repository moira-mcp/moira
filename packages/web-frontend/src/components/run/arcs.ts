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

export const ARC_BASE = 22;
/** Each nesting depth adds a line plus the label pill that sits beneath it. */
export const ARC_STEP = 28;
export const LINK_BASE = 14;
/** Forward links carry at most a small text above the line, so they nest tighter than arcs. */
export const LINK_STEP = 18;
/** Width budget per label character at the 11px label size, used to decide whether a label fits. */
const LINK_LABEL_CHAR_WIDTH = 6.5;
const LINK_LABEL_PADDING = 24;

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

export function arcsHeight(arcs: readonly LaneArc[]): number {
  return arcs.length ? ARC_BASE + Math.max(...arcs.map((a) => a.depth)) * ARC_STEP + 34 : 0;
}

/**
 * A forward link rises from the source lane's top, runs along its channel above the rail and
 * drops onto the target lane's top; `height` is the SVG height so the rail's top edge is `y = height`.
 * `labelFits` says whether the label's estimated width sits inside the span; when it does not,
 * the source lane shows the label as a chip instead.
 */
export function linkGeometry(
  link: LaneLink,
  centerOf: (index: number) => number,
  height: number,
): { x1: number; x2: number; y: number; d: string; labelFits: boolean } {
  const x1 = centerOf(link.from) + 30;
  const x2 = centerOf(link.to) - 30;
  const y = height - LINK_BASE - link.depth * LINK_STEP;
  const labelFits =
    link.label.length * LINK_LABEL_CHAR_WIDTH + LINK_LABEL_PADDING <= Math.abs(x2 - x1);
  return {
    x1,
    x2,
    y,
    d: `M ${x1} ${height - 2} L ${x1} ${y} L ${x2} ${y} L ${x2} ${height - 2}`,
    labelFits,
  };
}

export function linksHeight(links: readonly LaneLink[]): number {
  return links.length ? LINK_BASE + Math.max(...links.map((l) => l.depth)) * LINK_STEP + 16 : 0;
}
