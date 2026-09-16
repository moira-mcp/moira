/**
 * Layered layout of the block graph for the canvas mode.
 *
 * Forward transitions define the layering (ELK layered, left to right, so the drawing follows
 * process direction across a wide viewport). ELK owns the drawn columns (`rank`); the vertical
 * coordinate is then replaced by rows derived from the process (`blockRows`): the main sequence on
 * one row, each side branch on a row of its own — two branches share a row only when their column
 * spans are disjoint — and an off-sequence hub or a loop-only block on a row of its own beneath.
 * Edges are then routed by kind so nothing crosses a block:
 *
 * - adjacent-rank forward edges are elbows whose vertical run sits in the gap between ranks;
 * - forward edges that skip ranks travel along lanes above the graph; where the vertical to or
 *   from the lane would pierce a block on a row between, it moves into the gap beside the column;
 * - cycles travel along lanes below the graph, dashed, one lane per cycle, with the same detour;
 * - transitions into a hub — a block that many blocks exit into, such as "Replan" or "Stopped" —
 *   are bundled: one muted edge per source and hub, leaving the source's right edge, rising in the
 *   gap after its rank to a channel above the graph that the hub owns, and dropping in the gap
 *   before the hub's rank into one port on the hub's left edge. Vertical runs stay in the gaps
 *   between ranks, so a bundle never crosses a block placed above its source or its hub. The
 *   labels stay as exit chips inside the source block, the way process diagrams use off-page
 *   connectors.
 *
 * The layout is a pure function of its input: ELK is run with a fixed seed and only forward edges,
 * so the same blocks always yield the same placement. The engine is loaded on first use so the
 * page pays for it only when the canvas opens.
 */

import type { RunBlock, RunTransition } from "./model";
import { PARALLEL_CHIP_MIN } from "./chips";

export const BLOCK_WIDTH = 560;
const BLOCK_BASE_HEIGHT = 74;
const LINE_HEIGHT = 18;
const NAME_LINE_HEIGHT = 20;
const CHARS_PER_LINE = 38;
const NAME_CHARS_PER_LINE = 22;
/** The card clamps its name to this many lines (`line-clamp-2` in `CanvasView`). */
const MAX_NAME_LINES = 2;
const MAX_DESCRIPTION_LINES = 3;
const BASE_NODE_SEP = 40;
/** The least gap between ranks; it grows to hold the widest label pill drawn at rest in a gap. */
const MIN_RANK_SEP = 150;
/** A forward label pill is truncated beyond this width (the `max-w` of the pill in `CanvasView`). */
export const LABEL_MAX_WIDTH = 200;
/** Label metric of the pill's 11 px medium face: an upper bound per character plus the padding. */
const LABEL_CHAR_WIDTH = 6.4;
const LABEL_PADDING = 18;
/** Clear space between a pill at rest and the blocks on either side of its gap. */
const LABEL_CLEARANCE = 10;
const BASE_LANE_GAP = 40;
const BASE_LANE_STEP = 26;
const SELF_LOOP_DEPTH = 36;
const MARGIN = 24;
/** How far into the gap between ranks a hub bundle's vertical run sits, off the label pills' centre. */
const HUB_GAP_INSET = 24;
/** The hub port sits this far below the hub's top on its left edge, clear of skip-lane landings. */
const HUB_PORT_INSET = 24;
/**
 * How far into a gap a skip's or a return's vertical sits when it has to leave its block's column
 * to clear a block on a row between; distinct from the hub bundles' inset so the runs never share
 * a line.
 */
const SKIP_GAP_INSET = 44;
const RETURN_GAP_INSET = 64;

export interface LaidOutBlock {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The drawn column, from ELK. */
  rank: number;
  /** The row from `blockRows`: 0 the main sequence, negative above it, positive below. */
  row: number;
}

export interface LaidOutEdge {
  id: string;
  from: string;
  to: string;
  /** The transition drawn; for a hub bundle, the first of the source's transitions into the hub. */
  transition: RunTransition;
  kind: "forward" | "skip" | "cycle" | "hub";
  /** SVG path in graph coordinates. */
  path: string;
  labelX: number;
  labelY: number;
  labelAnchor: "center" | "above" | "below";
  /** How many adjacent forward transitions share this edge's pair of blocks (forward edges). */
  parallelCount?: number;
  /** The y of the lane a skip, hub or return edge travels along, in the gap it was given. */
  laneY?: number;
}

export interface BlockLayout {
  blocks: LaidOutBlock[];
  edges: LaidOutEdge[];
  hubIds: string[];
  width: number;
  height: number;
  /** The blocks were laid out horizontally and swapped: edge paths and lanes are in that space. */
  transposed?: boolean;
}

function lineCount(text: string, charsPerLine: number, max: number): number {
  return Math.min(max, Math.max(1, Math.ceil(text.length / charsPerLine)));
}

/** Height is a pure function of the block's text so layout stays deterministic. */
/** Chips (hub exits, skips, returns) wrap inside the block; two fit one row at the block width
 * when their names are short, a chip named longer than this takes a row of its own. */
const CHIPS_PER_ROW = 2;
const CHIP_SHARED_ROW_CHARS = 14;
const CHIP_ROW_HEIGHT = 24;

/** Rows the chips take: long-named chips one each, the short ones two per row. */
export function chipRowCount(chipNames: readonly string[]): number {
  const long = chipNames.filter((name) => name.length > CHIP_SHARED_ROW_CHARS).length;
  return long + Math.ceil((chipNames.length - long) / CHIPS_PER_ROW);
}
/** Parallel forward transitions between one pair of blocks spread by this much per transition. */
const PARALLEL_STEP = 26;

export function estimateBlockHeight(
  name: string,
  description: string,
  hasNote: boolean,
  chipNames: readonly string[],
): number {
  return (
    BLOCK_BASE_HEIGHT +
    lineCount(name, NAME_CHARS_PER_LINE, MAX_NAME_LINES) * NAME_LINE_HEIGHT +
    lineCount(description, CHARS_PER_LINE, MAX_DESCRIPTION_LINES) * LINE_HEIGHT +
    (hasNote ? LINE_HEIGHT : 0) +
    chipRowCount(chipNames) * CHIP_ROW_HEIGHT
  );
}

/**
 * A ported block card is as tall as its longer port column (one row per transition in or out,
 * the transitions to itself on a band beneath) or its header, whichever is more.
 */
export function estimatePortedBlockHeight(
  inCount: number,
  outCount: number,
  selfCount: number,
  description: string,
): number {
  const rows = Math.max(inCount, outCount, 1);
  const header = 76 + lineCount(description, 44, 2) * LINE_HEIGHT + 30;
  return Math.max(header, rows * 34 + 24) + (selfCount > 0 ? 36 : 0) + 8;
}

interface Placed {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How many adjacent forward transitions join each `from->to` pair (cycles and hubs excluded). */
function parallelCounts(
  blocks: readonly RunBlock[],
  hubs: ReadonlySet<string>,
): Map<string, number> {
  const parallel = new Map<string, number>();
  for (const block of blocks) {
    for (const tr of block.transitions) {
      if (tr.cycle || hubs.has(tr.to)) continue;
      const pair = `${block.id}->${tr.to}`;
      parallel.set(pair, (parallel.get(pair) ?? 0) + 1);
    }
  }
  return parallel;
}

/** The width a label pill takes at rest, bounded by the pill's own cap. */
export function labelPillWidth(label: string): number {
  return Math.min(LABEL_MAX_WIDTH, label.length * LABEL_CHAR_WIDTH + LABEL_PADDING);
}

/**
 * The gap between ranks: at least `MIN_RANK_SEP`, and wide enough that every forward label drawn
 * at rest — an adjacent transition whose pair is not folded into a forward chip — sits between its
 * blocks with clearance on both sides, so no pill runs under the next card.
 */
export function rankSeparation(blocks: readonly RunBlock[], hubIds: readonly string[]): number {
  const hubs = new Set(hubIds);
  const indexOf = new Map(blocks.map((b) => [b.id, b.index]));
  const parallel = parallelCounts(blocks, hubs);
  let widest = 0;
  for (const block of blocks) {
    for (const tr of block.transitions) {
      if (tr.cycle || hubs.has(tr.to) || indexOf.get(tr.to) !== block.index + 1) continue;
      if ((parallel.get(`${block.id}->${tr.to}`) ?? 1) >= PARALLEL_CHIP_MIN) continue;
      widest = Math.max(widest, labelPillWidth(tr.label));
    }
  }
  return Math.max(MIN_RANK_SEP, Math.ceil(widest + 2 * LABEL_CLEARANCE));
}

/** Layer the blocks with ELK over their forward (non-cycle) transitions. */
async function placeBlocks(
  blocks: readonly RunBlock[],
  sizes: ReadonlyMap<string, { width: number; height: number }>,
  rankSep: number,
  nodeSep: number = BASE_NODE_SEP,
): Promise<Placed[]> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const ids = new Set(blocks.map((b) => b.id));
  const edges = blocks.flatMap((block) =>
    block.transitions
      .filter((t) => !t.cycle && t.to !== block.id && ids.has(t.to))
      .map((t) => ({ id: `${block.id}->${t.to}`, sources: [block.id], targets: [t.to] })),
  );
  const seen = new Set<string>();
  const laid = await elk.layout({
    id: "process",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.randomSeed": "1",
      "elk.spacing.nodeNode": String(nodeSep),
      "elk.layered.spacing.nodeNodeBetweenLayers": String(rankSep),
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.padding": `[top=${MARGIN},left=${MARGIN},bottom=${MARGIN},right=${MARGIN}]`,
    },
    children: blocks.map((block) => ({ id: block.id, ...sizes.get(block.id)! })),
    edges: edges.filter((edge) => (seen.has(edge.id) ? false : (seen.add(edge.id), true))),
  });
  return (laid.children ?? []).map((child) => ({
    id: child.id,
    x: child.x ?? 0,
    y: child.y ?? 0,
    width: child.width ?? BLOCK_WIDTH,
    height: child.height ?? BLOCK_BASE_HEIGHT,
  }));
}

/**
 * The row of every block, a pure function of the blocks, their forward transitions and the drawn
 * columns (`rankOf`); loops and self-loops shape no row. Row 0 is the main sequence — the longest
 * forward chain from the start block, a tie between successors going to the higher process index
 * so the row follows the process toward its end rather than into a repair. A side branch is a
 * maximal chain of off-sequence blocks that are neither hubs nor loop-only, linked by forward
 * transitions; its column span runs from the column of its entry to the column of its rejoin.
 * Branches are placed in process order of their entry column, a branch entered from another
 * branch after the one it leaves; each new row alternates below and above the sequence, and a
 * branch joins an existing row only when its span is disjoint from every span already on it. An
 * off-sequence hub and a loop-only block (no forward transition into it, and not the start) each
 * take a row of their own beneath every branch row, hubs first, in process order.
 */
export function blockRows(
  blocks: readonly RunBlock[],
  hubIds: readonly string[],
  rankOf: ReadonlyMap<string, number>,
): Map<string, number> {
  const ordered = [...blocks].sort((a, b) => a.index - b.index);
  const indexOf = new Map(ordered.map((b) => [b.id, b.index]));
  const hubs = new Set(hubIds);
  const forward = new Map<string, string[]>();
  const forwardIn = new Map<string, string[]>();
  for (const block of ordered) {
    const targets: string[] = [];
    for (const tr of block.transitions) {
      if (tr.cycle || tr.to === block.id || !indexOf.has(tr.to) || targets.includes(tr.to))
        continue;
      targets.push(tr.to);
      forwardIn.set(tr.to, [...(forwardIn.get(tr.to) ?? []), block.id]);
    }
    forward.set(block.id, targets);
  }
  const rows = new Map<string, number>();
  if (ordered.length === 0) return rows;
  const start = ordered[0];
  const loopOnly = new Set(
    ordered.filter((b) => b !== start && (forwardIn.get(b.id) ?? []).length === 0).map((b) => b.id),
  );

  // The longest forward chain from the start, over transitions that advance the process index.
  const later = (id: string) =>
    (forward.get(id) ?? []).filter((to) => indexOf.get(to)! > indexOf.get(id)!);
  const longest = new Map<string, number>();
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const id = ordered[i].id;
    longest.set(id, 1 + Math.max(0, ...later(id).map((to) => longest.get(to)!)));
  }
  const sequence: string[] = [];
  for (let id: string | undefined = start.id; id;) {
    sequence.push(id);
    const next = later(id);
    const best = Math.max(0, ...next.map((to) => longest.get(to)!));
    id = next
      .filter((to) => longest.get(to) === best)
      .sort((a, b) => indexOf.get(b)! - indexOf.get(a)!)[0];
  }
  for (const id of sequence) rows.set(id, 0);

  // Side branches: maximal forward-linked chains of the remaining ordinary blocks.
  const pool = new Set(
    ordered.map((b) => b.id).filter((id) => !rows.has(id) && !hubs.has(id) && !loopOnly.has(id)),
  );
  const branches: string[][] = [];
  const taken = new Set<string>();
  for (const id of pool) {
    if (taken.has(id)) continue;
    const chain = [id];
    taken.add(id);
    for (let tail = id; ;) {
      const next = (forward.get(tail) ?? []).find((to) => pool.has(to) && !taken.has(to));
      if (!next) break;
      chain.push(next);
      taken.add(next);
      tail = next;
    }
    branches.push(chain);
  }
  const branchOf = new Map(branches.flatMap((chain, i) => chain.map((id) => [id, i] as const)));
  const spans = branches.map((chain) => {
    const own = chain.map((id) => rankOf.get(id) ?? 0);
    const entries = chain
      .flatMap((id) => forwardIn.get(id) ?? [])
      .filter((from) => !chain.includes(from))
      .map((from) => rankOf.get(from) ?? 0);
    const exits = chain
      .flatMap((id) => forward.get(id) ?? [])
      .filter((to) => !chain.includes(to))
      .map((to) => rankOf.get(to) ?? 0);
    return { from: Math.min(...own, ...entries), to: Math.max(...own, ...exits) };
  });
  const entryBranches = branches.map(
    (chain) =>
      new Set(
        chain
          .flatMap((id) => forwardIn.get(id) ?? [])
          .map((from) => branchOf.get(from))
          .filter((i): i is number => i !== undefined && !chain.includes(branches[i][0])),
      ),
  );
  const byEntry = branches
    .map((_, i) => i)
    .sort(
      (a, b) =>
        spans[a].from - spans[b].from ||
        indexOf.get(branches[a][0])! - indexOf.get(branches[b][0])!,
    );
  const placed: number[] = [];
  while (placed.length < branches.length) {
    const next =
      byEntry.find(
        (i) => !placed.includes(i) && [...entryBranches[i]].every((e) => placed.includes(e)),
      ) ?? byEntry.find((i) => !placed.includes(i))!;
    placed.push(next);
  }
  const branchRows: Array<{ row: number; spans: Array<{ from: number; to: number }> }> = [];
  let below = 0;
  let above = 0;
  for (const i of placed) {
    const span = spans[i];
    let row = branchRows.find((r) => r.spans.every((s) => s.to < span.from || span.to < s.from));
    if (!row) {
      const number = branchRows.length % 2 === 0 ? (below += 1) : -(above += 1);
      row = { row: number, spans: [] };
      branchRows.push(row);
    }
    row.spans.push(span);
    for (const id of branches[i]) rows.set(id, row.row);
  }
  for (const id of ordered.map((b) => b.id)) {
    if (!rows.has(id) && hubs.has(id)) rows.set(id, (below += 1));
  }
  for (const id of ordered.map((b) => b.id)) {
    if (!rows.has(id)) rows.set(id, (below += 1));
  }
  return rows;
}

/** How far a block's self-loops dip beneath it (zero without a self-loop). */
function selfLoopExtent(block: RunBlock): number {
  const loops = block.transitions.filter((tr) => tr.to === block.id).length;
  return loops === 0 ? 0 : SELF_LOOP_DEPTH + (loops - 1) * PARALLEL_STEP;
}

/** Whether the segment from (ax, ay) to (bx, by) passes through a block other than the excluded ones. */
export function crossesBlock(
  blocks: readonly Placed[],
  exclude: readonly string[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
): boolean {
  return blocks.some(
    (b) =>
      !exclude.includes(b.id) &&
      Math.min(ax, bx) < b.x + b.width &&
      Math.max(ax, bx) > b.x &&
      Math.min(ay, by) < b.y + b.height &&
      Math.max(ay, by) > b.y,
  );
}

/** Where every bundled hub edge enters a hub: a point near the top of its left edge. */
export function hubPort(block: Pick<LaidOutBlock, "x" | "y">): { x: number; y: number } {
  return { x: block.x, y: block.y + HUB_PORT_INSET };
}

export interface LayoutBlocksOptions {
  /**
   * `default`: the process rows with lanes in their gaps. `compact`: the same rows with tighter
   * gaps. `flow`: ELK's own vertical placement, no rows forced. `vertical`: the default layout
   * transposed, blocks stacked top to bottom with ports on their top and bottom edges.
   */
  preset?: "default" | "compact" | "flow" | "vertical";
}

export async function layoutBlocks(
  blocks: readonly RunBlock[],
  hubIds: readonly string[],
  options: LayoutBlocksOptions = {},
): Promise<BlockLayout> {
  const preset = options.preset ?? "default";
  const vertical = preset === "vertical";
  const tight = preset === "compact";
  const NODE_SEP = tight ? 16 : BASE_NODE_SEP;
  const LANE_GAP = tight ? 16 : BASE_LANE_GAP;
  const LANE_STEP = tight ? 18 : BASE_LANE_STEP;
  const hubs = new Set(hubIds);
  const indexOf = new Map(blocks.map((b) => [b.id, b.index]));
  const sizes = new Map<string, { width: number; height: number }>();
  for (const block of blocks) {
    // Every connector away from the rail (hub exit, skip, return) is a chip inside the block.
    const inCount = blocks.reduce(
      (n, other) =>
        other.id === block.id ? n : n + other.transitions.filter((t) => t.to === block.id).length,
      0,
    );
    const outCount = block.transitions.filter((t) => t.to !== block.id).length;
    const selfCount = block.transitions.filter((t) => t.to === block.id).length;
    sizes.set(block.id, {
      width: BLOCK_WIDTH,
      height: estimatePortedBlockHeight(inCount, outCount, selfCount, block.description),
    });
  }
  const rankSep = rankSeparation(blocks, hubIds);
  // A vertical layout is the horizontal one transposed: the blocks are laid out with their sizes
  // swapped and every coordinate is swapped back at the end.
  if (vertical) {
    for (const [id, size] of sizes) sizes.set(id, { width: size.height, height: size.width });
  }
  const placed = await placeBlocks(blocks, sizes, rankSep, NODE_SEP);
  const placedById = new Map(placed.map((p) => [p.id, p]));
  const xs = [...new Set(placed.map((p) => Math.round(p.x)))].sort((a, b) => a - b);
  const rankOf = new Map(placed.map((p) => [p.id, xs.indexOf(Math.round(p.x))]));
  // ELK's vertical placement is discarded: every block takes the top edge of its row. A row is as
  // tall as its tallest block with its self-loops, plus the node gap, so a self-loop never dips
  // into the row beneath; rows above the sequence stack upward from it, rows below downward.
  const rowOf =
    preset === "flow"
      ? new Map(blocks.map((b) => [b.id, Math.round(placedById.get(b.id)!.y)]))
      : blockRows(blocks, hubIds, rankOf);
  const rowContent = new Map<number, number>();
  for (const block of blocks) {
    const row = rowOf.get(block.id)!;
    const extent = sizes.get(block.id)!.height + selfLoopExtent(block);
    rowContent.set(row, Math.max(rowContent.get(row) ?? 0, extent));
  }
  const rows = [...rowContent.keys()].sort((a, b) => a - b);
  const rowIndex = new Map(rows.map((row, i) => [row, i]));

  // Every edge that leaves the process line travels along a lane in a gap between two rows: when
  // its blocks share a row, a skip or hub bundle takes the gap above that row and a return the gap
  // beneath it; when they sit on two rows, every kind takes the gap between those rows. Gap g lies between rows[g - 1] and rows[g]; g = 0 is above the top
  // row, g = rows.length below the bottom one. The lanes are counted first so every gap is given
  // the room its lanes need, and only then are the rows placed.
  interface Lane {
    gap: number;
    slot: number;
  }
  const laneOf = new Map<string, Lane>();
  const gapLanes = new Map<number, number>();
  const bundled = new Set<string>();
  // Bundles into one hub share one lane per gap: every source's line joins the hub's channel
  // instead of taking a lane of its own, so a hub with many sources costs one lane, not many.
  const hubLane = new Map<string, Lane>();
  const takeLane = (id: string, gap: number, hubId?: string) => {
    const shared = hubId ? hubLane.get(`${gap}:${hubId}`) : undefined;
    if (shared) {
      laneOf.set(id, shared);
      return;
    }
    const slot = gapLanes.get(gap) ?? 0;
    gapLanes.set(gap, slot + 1);
    const lane = { gap, slot };
    laneOf.set(id, lane);
    if (hubId) hubLane.set(`${gap}:${hubId}`, lane);
  };
  for (const block of blocks) {
    for (const transition of block.transitions) {
      if (!placedById.has(transition.to) || transition.to === block.id) continue;
      const rs = rowIndex.get(rowOf.get(block.id)!)!;
      const rt = rowIndex.get(rowOf.get(transition.to)!)!;
      const adjacent = indexOf.get(transition.to)! <= block.index + 1;
      if (!transition.cycle && hubs.has(transition.to) && !adjacent) {
        const bundleId = `${block.id}->${transition.to}:hub`;
        if (bundled.has(bundleId)) continue;
        bundled.add(bundleId);
        takeLane(bundleId, rs === rt ? rs : Math.min(rs, rt) + 1, transition.to);
        continue;
      }
      const id = `${block.id}->${transition.to}:${transition.label}`;
      if (!transition.cycle) {
        if (indexOf.get(transition.to)! <= block.index + 1) continue; // an adjacent elbow
        // Blocks on two rows: the lane runs in the gap between them (just under the upper one),
        // so neither vertical crosses a row. Blocks on one row: the gap above it.
        takeLane(id, rs === rt ? rs : Math.min(rs, rt) + 1);
      } else {
        // A return on one row: the gap beneath it; on two rows: the gap between them.
        takeLane(id, rs === rt ? rs + 1 : Math.min(rs, rt) + 1);
      }
    }
  }
  const gapSize = (gap: number) => {
    const lanes = gapLanes.get(gap) ?? 0;
    return lanes > 0 ? LANE_GAP + lanes * LANE_STEP + LANE_GAP : NODE_SEP;
  };
  const rowTop = new Map<number, number>();
  let cursor = MARGIN + (gapLanes.get(0) ? gapSize(0) : 0);
  rows.forEach((row, i) => {
    if (i > 0) cursor += gapSize(i);
    rowTop.set(row, cursor);
    cursor += rowContent.get(row)!;
  });
  const bottomOfRows = cursor;
  /** The y of lane `slot` in gap `gap`: lanes fill the gap from its upper edge. */
  const laneYOf = (lane: Lane) => {
    const gapTop =
      lane.gap === 0
        ? MARGIN
        : rowTop.get(rows[lane.gap - 1])! + rowContent.get(rows[lane.gap - 1])!;
    return gapTop + LANE_GAP + lane.slot * LANE_STEP + LANE_STEP / 2;
  };

  const laidBlocks: LaidOutBlock[] = blocks.map((block) => {
    const p = placedById.get(block.id)!;
    const row = rowOf.get(block.id)!;
    return {
      id: block.id,
      x: p.x,
      y: rowTop.get(row)!,
      width: p.width,
      height: p.height,
      rank: rankOf.get(block.id)!,
      row,
    };
  });
  const byId = new Map(laidBlocks.map((b) => [b.id, b]));

  const edges: LaidOutEdge[] = [];
  // Adjacent forward transitions that join the same pair of blocks share the gap between them:
  // each takes its own horizontal line and its own label row so nothing stacks on one point.
  const parallel = parallelCounts(blocks, hubs);
  const parallelIndex = new Map<string, number>();
  const seenBundle = new Set<string>();

  for (const block of blocks) {
    const source = byId.get(block.id)!;
    for (const transition of block.transitions) {
      const target = byId.get(transition.to);
      if (!target) continue;
      const id = `${block.id}->${transition.to}:${transition.label}`;
      const x1 = source.x + source.width;
      const y1 = source.y + source.height / 2;
      const x2 = target.x;
      const y2 = target.y + target.height / 2;

      // The step right before a hub reaches it like any neighbour, with an elbow in the gap;
      // only sources further back join the hub's bundle lane.
      const adjacentToHub = indexOf.get(transition.to)! <= block.index + 1;
      if (!transition.cycle && hubs.has(transition.to) && !adjacentToHub) {
        const bundleId = `${block.id}->${transition.to}:hub`;
        if (seenBundle.has(bundleId)) continue; // one edge per source and hub; the ports carry the labels
        seenBundle.add(bundleId);
        const laneY = laneYOf(laneOf.get(bundleId)!);
        const xa = x1 + HUB_GAP_INSET;
        const xb = x2 - HUB_GAP_INSET;
        edges.push({
          id: bundleId,
          from: block.id,
          to: transition.to,
          transition,
          kind: "hub",
          path: `M ${x1} ${y1} L ${xa} ${y1} L ${xa} ${laneY} L ${xb} ${laneY} L ${xb} ${y2} L ${x2} ${y2}`,
          labelX: (xa + xb) / 2,
          labelY: laneY,
          labelAnchor: "above",
          laneY,
        });
        continue;
      }

      if (!transition.cycle) {
        if (indexOf.get(transition.to)! <= block.index + 1) {
          const pair = `${block.id}->${transition.to}`;
          const count = parallel.get(pair) ?? 1;
          const index = parallelIndex.get(pair) ?? 0;
          parallelIndex.set(pair, index + 1);
          const offset = (index - (count - 1) / 2) * PARALLEL_STEP;
          const ya = y1 + offset;
          const yb = y2 + offset;
          // The vertical run sits in the middle of the gap after the source's column.
          const midX = x1 + rankSep / 2;
          const path =
            Math.abs(ya - yb) < 1
              ? `M ${x1} ${ya} L ${x2} ${yb}`
              : `M ${x1} ${ya} L ${midX} ${ya} L ${midX} ${yb} L ${x2} ${yb}`;
          edges.push({
            id,
            from: block.id,
            to: transition.to,
            transition,
            kind: "forward",
            path,
            labelX: midX,
            labelY: ya - 4,
            labelAnchor: "above",
            parallelCount: count,
          });
        } else {
          const laneY = laneYOf(laneOf.get(id)!);
          const xa = x1 + SKIP_GAP_INSET;
          const xb = x2 - SKIP_GAP_INSET;
          edges.push({
            id,
            from: block.id,
            to: transition.to,
            transition,
            kind: "skip",
            path: `M ${x1} ${y1} L ${xa} ${y1} L ${xa} ${laneY} L ${xb} ${laneY} L ${xb} ${y2} L ${x2} ${y2}`,
            labelX: (xa + xb) / 2,
            labelY: laneY,
            labelAnchor: "above",
            laneY,
          });
        }
        continue;
      }

      if (transition.to === block.id) {
        // Several self-loops of one block dip further one by one, each with its own label row.
        const selfIndex = parallelIndex.get(`${block.id}->${block.id}:self`) ?? 0;
        parallelIndex.set(`${block.id}->${block.id}:self`, selfIndex + 1);
        const y = source.y + source.height;
        const xLeft = source.x + source.width * 0.35;
        const xRight = source.x + source.width * 0.65;
        const dip = y + SELF_LOOP_DEPTH + selfIndex * PARALLEL_STEP;
        const path = `M ${xRight} ${y} L ${xRight} ${dip} L ${xLeft} ${dip} L ${xLeft} ${y}`;
        edges.push({
          id,
          from: block.id,
          to: transition.to,
          transition,
          kind: "cycle",
          path,
          labelX: (xLeft + xRight) / 2,
          labelY: dip + 4,
          labelAnchor: "below",
        });
        continue;
      }

      // A return: out of the source's right port, down (or up) in the gap after its column to
      // the lane in the gap beneath the lower of the two rows, back along it, and up into the
      // target's left port from the gap before its column.
      const laneY = laneYOf(laneOf.get(id)!);
      const xa = x1 + RETURN_GAP_INSET;
      const xb = x2 - RETURN_GAP_INSET;
      edges.push({
        id,
        from: block.id,
        to: transition.to,
        transition,
        kind: "cycle",
        path: `M ${x1} ${y1} L ${xa} ${y1} L ${xa} ${laneY} L ${xb} ${laneY} L ${xb} ${y2} L ${x2} ${y2}`,
        labelX: (xa + xb) / 2,
        labelY: laneY,
        labelAnchor: "above",
        laneY,
      });
    }
  }

  const bottomLanes = gapLanes.get(rows.length) ?? 0;
  const width = Math.max(...laidBlocks.map((b) => b.x + b.width)) + MARGIN;
  const height = bottomOfRows + (bottomLanes > 0 ? gapSize(rows.length) : 0) + MARGIN;
  if (vertical) {
    return {
      blocks: laidBlocks.map((b) => ({ ...b, x: b.y, y: b.x, width: b.height, height: b.width })),
      edges,
      hubIds: [...hubs],
      width: height,
      height: width,
      transposed: true,
    };
  }
  return { blocks: laidBlocks, edges, hubIds: [...hubs], width, height };
}

/** Pairs of blocks whose rectangles overlap; empty for a readable layout. */
export function overlappingBlocks(layout: BlockLayout): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  const { blocks } = layout;
  for (let i = 0; i < blocks.length; i++) {
    for (let j = i + 1; j < blocks.length; j++) {
      const a = blocks[i];
      const b = blocks[j];
      const apart =
        a.x + a.width <= b.x ||
        b.x + b.width <= a.x ||
        a.y + a.height <= b.y ||
        b.y + b.height <= a.y;
      if (!apart) pairs.push([a.id, b.id]);
    }
  }
  return pairs;
}
