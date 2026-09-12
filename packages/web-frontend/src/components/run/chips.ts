/**
 * The chip model shared by the lanes rail, the canvas, the phone stepper and their edges: for
 * one source block, the transitions that the diagrams draw as connectors away from the rail —
 * returns (cycles), forward transitions that skip a block and exits into a hub — each with the
 * name of its target and the keys that identify the same transitions on their connectors, so
 * hovering a chip lights its connectors and hovering a connector lights it alone. Transitions of
 * one kind into one target fold into one chip (`×n`) carrying every label and key.
 */

import type { RunBlock, RunTransition } from "./model";

export type ChipKind = "return" | "skip" | "hub";

export interface TransitionChip {
  /** `from→to:label` of the first transition; the chip's identity. */
  key: string;
  /** The keys of every connector this chip stands for (one per transition, or one hub bundle). */
  keys: string[];
  kind: ChipKind;
  from: string;
  /** The first transition this chip stands for. */
  transition: RunTransition;
  /** Every label the chip stands for, one per transition. */
  labels: string[];
  targetName: string;
  /** One-based position of the target in process order, shown before the name for compactness. */
  targetNumber: number;
}

export function transitionKey(from: string, transition: Pick<RunTransition, "to" | "label">) {
  return `${from}→${transition.to}:${transition.label}`;
}

/** Folds transitions of one kind by target: one chip per target carrying every label and key. */
function foldByTarget(
  block: RunBlock,
  transitions: RunTransition[],
  kind: ChipKind,
  byId: Map<string, RunBlock>,
  keyOf: (transitions: RunTransition[]) => string[],
): TransitionChip[] {
  const groups = new Map<string, RunTransition[]>();
  for (const tr of transitions) {
    const group = groups.get(tr.to);
    if (group) group.push(tr);
    else groups.set(tr.to, [tr]);
  }
  return [...groups.values()].map((group) => ({
    key: transitionKey(block.id, group[0]),
    keys: keyOf(group),
    kind,
    from: block.id,
    transition: group[0],
    labels: group.map((tr) => tr.label),
    targetName: byId.get(group[0].to)!.name,
    targetNumber: byId.get(group[0].to)!.index + 1,
  }));
}

/** The return transitions of a block, one chip per target, in authored order. */
export function returnsOf(block: RunBlock, blocks: readonly RunBlock[]): TransitionChip[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  return foldByTarget(
    block,
    block.transitions.filter((tr) => tr.cycle && byId.has(tr.to)),
    "return",
    byId,
    (group) => group.map((tr) => transitionKey(block.id, tr)),
  );
}

/** The forward transitions of a block that skip at least one block, one chip per target. */
export function skipsOf(block: RunBlock, blocks: readonly RunBlock[]): TransitionChip[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  return foldByTarget(
    block,
    block.transitions.filter((tr) => {
      const target = byId.get(tr.to);
      return !tr.cycle && !!target && target.index > block.index + 1;
    }),
    "skip",
    byId,
    (group) => group.map((tr) => transitionKey(block.id, tr)),
  );
}

/**
 * Forward transitions into a hub block (one that many blocks lead to). The canvas draws one
 * bundled edge per source and hub, keyed by the source's first transition into it, so this is one
 * chip per source and hub carrying every label of the bundle.
 */
export function hubExitsOf(
  block: RunBlock,
  hubIds: readonly string[],
  blocks: readonly RunBlock[],
): TransitionChip[] {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const hubs = new Set(hubIds);
  return foldByTarget(
    block,
    block.transitions.filter(
      (tr) => !tr.cycle && hubs.has(tr.to) && tr.to !== block.id && byId.has(tr.to),
    ),
    "hub",
    byId,
    // One bundled edge per source and hub, keyed by the first transition into it.
    (group) => [transitionKey(block.id, group[0])],
  );
}

/**
 * Every chip of a block as the canvas shows them: hub exits first, then skips that do not enter a
 * hub, then returns. Lanes show the same set without the hub kind folded out (a hub is a lane).
 */
export function canvasChipsOf(
  block: RunBlock,
  hubIds: readonly string[],
  blocks: readonly RunBlock[],
): TransitionChip[] {
  const hubs = new Set(hubIds);
  return [
    ...hubExitsOf(block, hubIds, blocks),
    ...skipsOf(block, blocks).filter((chip) => !hubs.has(chip.transition.to)),
    ...returnsOf(block, blocks),
  ];
}

export function laneChipsOf(block: RunBlock, blocks: readonly RunBlock[]): TransitionChip[] {
  return [...returnsOf(block, blocks), ...skipsOf(block, blocks)];
}

/** What a lit chip says: every label, and for a single return its cause and what ends the loop. */
export function chipTitle(chip: TransitionChip, endsWhen: string): string {
  const { transition } = chip;
  return transition.cycle && chip.labels.length === 1
    ? `${transition.label} — ${transition.cycle.cause} — ${endsWhen} ${transition.cycle.exit}`
    : chip.labels.join(" · ");
}
