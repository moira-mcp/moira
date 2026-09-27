/**
 * A flow's level and its subject tags — the one place that tells them apart.
 *
 * The Workflow Management Flow records the level a flow was authored at as exactly one tag,
 * `complexity:simple`, `complexity:standard` or `complexity:complex`, among the flow's other tags.
 * That tag is not a subject: it says how thoroughly the flow was built, not what it is about. So no
 * renderer shows it as a tag chip or counts it among the tags, and no subject search or filter may
 * match it. Every place that shows or searches a flow's tags goes through `splitFlowTags`.
 *
 * Only the three known levels are a level. Any other `complexity:` value is neither a level nor a
 * subject: it shows no badge and no chip.
 */

export const FLOW_LEVELS = ["simple", "standard", "complex"] as const;

export type FlowLevel = (typeof FLOW_LEVELS)[number];

const LEVEL_PREFIX = "complexity:";

export interface FlowTags {
  /** The level the flow was authored at, or null when it carries no valid level tag. */
  level: FlowLevel | null;
  /** The flow's subject tags, in their stored order. */
  subjects: string[];
}

function isFlowLevel(value: string): value is FlowLevel {
  return (FLOW_LEVELS as readonly string[]).includes(value);
}

/** Splits a flow's stored tags into its level and its subject tags. */
export function splitFlowTags(tags: readonly (string | null | undefined)[] | undefined): FlowTags {
  let level: FlowLevel | null = null;
  const subjects: string[] = [];
  for (const tag of tags ?? []) {
    if (!tag) continue;
    if (!tag.startsWith(LEVEL_PREFIX)) {
      subjects.push(tag);
      continue;
    }
    const value = tag.slice(LEVEL_PREFIX.length);
    if (level === null && isFlowLevel(value)) level = value;
  }
  return { level, subjects };
}
