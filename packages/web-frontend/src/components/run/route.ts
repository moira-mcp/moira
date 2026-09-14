/**
 * Pure helpers over the recorded route of the projection: the route grouped into stretches
 * inside one block (segments), per-block visit counts, and what a cursor means for a visit.
 * Everything reads `progress.route` and `progress.process`; nothing is inferred beyond grouping.
 */

import type { ExecutionRouteEntry } from "@mcp-moira/workflow-engine/progress-visual";
import type { RunBlock } from "./model";

export interface RouteSegment {
  index: number;
  blockId: string | null;
  /** Which entry into this block the segment is (1-based). */
  entry: number;
  visits: ExecutionRouteEntry[];
  /** The next segment re-enters an earlier block (by process order) or the same one. */
  loopsBackTo?: string;
}

/** Consecutive visits inside one block form a segment; segments keep route order. */
export function segmentsOf(
  route: readonly ExecutionRouteEntry[],
  blocks: readonly RunBlock[],
): RouteSegment[] {
  const order = new Map(blocks.map((b) => [b.id, b.index]));
  const entries = new Map<string | null, number>();
  const segments: RouteSegment[] = [];
  for (const visit of route) {
    const last = segments[segments.length - 1];
    if (last && last.blockId === visit.blockId) {
      last.visits.push(visit);
      continue;
    }
    const entry = (entries.get(visit.blockId) ?? 0) + 1;
    entries.set(visit.blockId, entry);
    segments.push({ index: segments.length, blockId: visit.blockId, entry, visits: [visit] });
  }
  for (let i = 0; i < segments.length - 1; i++) {
    const from = order.get(segments[i].blockId ?? "") ?? -1;
    const to = order.get(segments[i + 1].blockId ?? "") ?? -1;
    if (to <= from && segments[i + 1].blockId !== null)
      segments[i].loopsBackTo = segments[i + 1].blockId!;
  }
  return segments;
}

export interface BlockRouteStats {
  entries: number;
  visits: number;
  firstSeq?: number;
  lastSeq?: number;
}

/** Entries and visits per block up to the cursor (or the whole route). */
export function blockRouteStats(
  route: readonly ExecutionRouteEntry[],
  blocks: readonly RunBlock[],
  cursor: number | null,
): Map<string, BlockRouteStats> {
  const stats = new Map<string, BlockRouteStats>(
    blocks.map((b) => [b.id, { entries: 0, visits: 0 }]),
  );
  let previous: string | null | undefined;
  for (const visit of route) {
    if (cursor !== null && visit.seq > cursor) break;
    const s = visit.blockId ? stats.get(visit.blockId) : undefined;
    if (!s) continue;
    s.visits += 1;
    if (visit.blockId !== previous) s.entries += 1;
    s.firstSeq ??= visit.seq;
    s.lastSeq = visit.seq;
    previous = visit.blockId;
  }
  return stats;
}

/** The last visit sequence number of a route, or null when the route is empty. */
export function lastSeq(route: readonly ExecutionRouteEntry[]): number | null {
  return route.length ? route[route.length - 1].seq : null;
}

/** Clamp a requested cursor to the route; null means the whole run. */
export function clampCursor(
  raw: string | null,
  route: readonly ExecutionRouteEntry[],
): number | null {
  if (raw === null || route.length === 0) return null;
  const value = Number(raw);
  if (!Number.isInteger(value)) return null;
  const last = lastSeq(route)!;
  if (value >= last) return null;
  return Math.max(0, value);
}

/** Short text of what a visit changed: up to three `name = value` pairs and a remainder count. */
export function changesText(changed: readonly string[]): string {
  if (changed.length === 0) return "";
  const shown = changed.slice(0, 3).join(" · ");
  return changed.length > 3 ? `${shown} · +${changed.length - 3}` : shown;
}

/** The label of the edge a visit left through, from the block's transitions. */
export function exitLabel(
  visit: ExecutionRouteEntry,
  blocks: readonly RunBlock[],
): { label: string; to: string | null; cycle: boolean } | null {
  if (!visit.exitKey || !visit.blockId) return null;
  const edge = `${visit.nodeId}.${visit.exitKey}`;
  const block = blocks.find((b) => b.id === visit.blockId);
  const transition = block?.transitions.find((t) => t.edges.includes(edge));
  if (!transition) return null;
  return { label: transition.label, to: transition.to, cycle: Boolean(transition.cycle) };
}
