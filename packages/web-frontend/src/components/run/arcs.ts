/**
 * Return arcs of the lanes rail: every cycle transition drawn from its source lane to its target
 * lane beneath the rail, nested by span so arcs never cross. Pure geometry over block indices.
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

export const ARC_BASE = 22;
/** Each nesting depth adds a line plus the label pill that sits beneath it. */
export const ARC_STEP = 28;

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
  // Shorter spans nest inside longer ones: assign depth by span so arcs never cross each other.
  const sorted = [...raw].sort((a, b) => a.from - a.to - (b.from - b.to));
  const lanesUsed: Array<Array<[number, number]>> = [];
  return sorted.map((arc) => {
    const lo = Math.min(arc.from, arc.to);
    const hi = Math.max(arc.from, arc.to);
    let depth = 0;
    while (lanesUsed[depth]?.some(([a, b]) => lo <= b && a <= hi)) depth += 1;
    (lanesUsed[depth] ??= []).push([lo, hi]);
    return { ...arc, depth };
  });
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
