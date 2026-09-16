/**
 * Timings and bound lists of a run projection, derived from the route and the variables.
 *
 * A pass is a visit of a block's working step (routing nodes are not passes, unless the block is
 * made of routing nodes alone), closed when it has an exit key and open while the run is on it.
 * A closed pass lasts `leftAt − enteredAt`; an open one is measured to `now`; a visit recorded
 * before timestamps existed lasts `null`, never 0. A block bound to a list reports the list as
 * the run's variables hold it at the cursor — items, the finished count, the total and the item
 * in progress — and attributes each pass to the item the `current` path pointed at when the pass
 * began, so every item can carry the time spent on it. Nothing here knows a plan, a checklist or
 * any flow: the block says what it reads, the run supplies the values. Pure.
 */

import type { ProgressListBinding } from "../interfaces/core-interfaces.js";
import type { ExecutionVisit } from "../types/base-types.js";
import { PathResolver } from "./path-resolver.js";
import type {
  ExecutionBlockList,
  ExecutionBlockTiming,
  ExecutionPassTiming,
  ExecutionProgress,
  ExecutionVariableState,
} from "./execution-progress-contract.js";

/** Which visits are passes of which block; shared with the status projection. */
export interface PassSelector {
  blockOf(nodeId: string): string | undefined;
  isPass(visit: ExecutionVisit): boolean;
}

function durationOf(entered: number | null, left: number | null, open: boolean, now: number) {
  if (entered === null) return null;
  if (left !== null) return Math.max(0, left - entered);
  return open ? Math.max(0, now - entered) : null;
}

/**
 * Per-block pass timings. `openVisitSeq` is the visit the run is on (the last engine visit when
 * the run is not finished, or the open wait it stopped on); only that visit is an open pass.
 */
export function blockTimings(
  blockIds: readonly string[],
  visits: readonly ExecutionVisit[],
  selector: PassSelector,
  openVisitSeq: number | null,
  now: number,
  itemIndexAt: (blockId: string, visit: ExecutionVisit) => number | null,
): Map<string, ExecutionBlockTiming> {
  const passes = new Map<string, ExecutionPassTiming[]>(blockIds.map((id) => [id, []]));
  for (const visit of visits) {
    const blockId = selector.blockOf(visit.nodeId);
    if (!blockId || !selector.isPass(visit)) continue;
    const list = passes.get(blockId);
    if (!list) continue;
    const open = visit.seq === openVisitSeq && visit.exitKey === null;
    const enteredAt = visit.enteredAt ?? null;
    const leftAt = visit.leftAt ?? null;
    list.push({
      seq: visit.seq,
      nodeId: visit.nodeId,
      enteredAt,
      leftAt,
      durationMs: durationOf(enteredAt, leftAt, open, now),
      open,
      itemIndex: itemIndexAt(blockId, visit),
    });
  }
  const result = new Map<string, ExecutionBlockTiming>();
  for (const [blockId, list] of passes) {
    const measured = list.filter((pass) => pass.durationMs !== null);
    const openPass = list.find((pass) => pass.open);
    result.set(blockId, {
      passes: list,
      totalMs: measured.length ? measured.reduce((sum, pass) => sum + pass.durationMs!, 0) : null,
      currentMs: openPass?.durationMs ?? null,
      recorded: list.some((pass) => pass.enteredAt !== null),
    });
  }
  return result;
}

/** The variables as one object: globals by name, node-local outputs nested under the node id. */
export function variablesObject(
  states: readonly ExecutionVariableState[],
): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  for (const state of states) {
    if (state.kind === "variable") {
      object[state.name] = state.current;
      continue;
    }
    const dot = state.name.indexOf(".");
    const node = state.name.slice(0, dot);
    const field = state.name.slice(dot + 1);
    const scope = (object[node] ??= {}) as Record<string, unknown>;
    if (typeof scope === "object" && scope !== null) scope[field] = state.current;
  }
  return object;
}

function readPath(variables: Record<string, unknown>, path: string | undefined): unknown {
  if (!path) return undefined;
  try {
    return PathResolver.resolveVariablePath(variables, path);
  } catch {
    return undefined;
  }
}

function asCount(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) return Number(value);
  return null;
}

function titleOf(item: unknown, titlePath: string | undefined): string {
  const value = titlePath ? readPath({ item }, `item.${titlePath}`) : item;
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Resolve a block's list from a variables object. Returns null when neither items nor a counter
 * resolves, with the reason in `diagnostic`.
 */
export function resolveBlockList(
  binding: ProgressListBinding,
  variables: Record<string, unknown>,
  itemDurations: ReadonlyMap<number, number>,
): { list: ExecutionBlockList | null; diagnostic: string | null } {
  const base = binding.indexBase ?? 1;
  const rawItems = readPath(variables, binding.items);
  const items = Array.isArray(rawItems) ? rawItems : null;
  const rawCurrent = asCount(readPath(variables, binding.current));
  const rawDone = asCount(readPath(variables, binding.done));
  const rawTotal = asCount(readPath(variables, binding.total));
  const total = rawTotal ?? (items ? items.length : null);
  if (items === null && rawCurrent === null && rawDone === null && total === null) {
    const named = (["items", "current", "done", "total"] as const)
      .filter((field) => binding[field])
      .map((field) => `${field}=${binding[field]}`)
      .join(", ");
    return { list: null, diagnostic: `list binding did not resolve (${named})` };
  }
  const clamp = (value: number) => Math.max(0, total === null ? value : Math.min(total, value));
  const current = rawCurrent === null ? null : rawCurrent - base;
  const done = rawDone !== null ? clamp(rawDone) : current !== null ? clamp(current) : null;
  const currentIndex =
    current !== null && (total === null || current < total) && current >= 0 ? current : null;
  const listItems = items
    ? items.map((item, index) => ({
        index,
        title: titleOf(item, binding.title),
        done: done !== null && index < done,
        current: index === currentIndex,
        durationMs: itemDurations.get(index) ?? null,
      }))
    : null;
  // A title path that names nothing on any item is an authoring slip worth a diagnostic; the
  // list is still shown, with empty titles.
  const titleMissing =
    binding.title !== undefined &&
    listItems !== null &&
    listItems.length > 0 &&
    listItems.every((item) => item.title === "");
  return {
    list: {
      items: listItems,
      done,
      total,
      current: currentIndex,
      currentTitle:
        currentIndex !== null && listItems ? (listItems[currentIndex]?.title ?? null) : null,
    },
    diagnostic: titleMissing
      ? `list.title '${binding.title}' resolves to nothing on the items of ${binding.items}`
      : null,
  };
}

/**
 * The bound-list item index a pass was working on: the `current` path as of the visit's start —
 * the last write before the visit, or the registry default when nothing had written it yet. A
 * pass before any write and without a default is attributed to no item (never to the value the
 * cursor holds now).
 */
export function itemIndexResolver(
  binding: ProgressListBinding | undefined,
  states: readonly ExecutionVariableState[],
  defaults: Record<string, unknown>,
): (visit: ExecutionVisit) => number | null {
  if (!binding?.current) return () => null;
  const path = binding.current;
  const base = binding.indexBase ?? 1;
  const root = path.split(/[.[]/u)[0];
  const rest = path.slice(root.length);
  const byName = new Map(states.map((state) => [state.name, state]));
  return (visit) => {
    // The root may be a global (history by name) or a node-local output (history by `node.field`).
    const direct = byName.get(root);
    let rootValue: unknown;
    if (direct) {
      const before = direct.history.filter((change) => change.seq < visit.seq);
      rootValue = before.length ? before[before.length - 1].value : defaults[root];
    } else {
      const nodeScope: Record<string, unknown> = {};
      for (const state of states) {
        if (!state.name.startsWith(`${root}.`)) continue;
        const before = state.history.filter((change) => change.seq < visit.seq);
        if (before.length) {
          nodeScope[state.name.slice(root.length + 1)] = before[before.length - 1].value;
        }
      }
      rootValue = Object.keys(nodeScope).length ? nodeScope : undefined;
    }
    const value = rest ? readPath({ [root]: rootValue }, path) : rootValue;
    const index = asCount(value);
    return index === null ? null : index - base;
  };
}

/**
 * The bound list nearest the run's position: the active block's when it binds one, otherwise the
 * bound block the route visited most recently. Null when no bound block was reached.
 */
export function nearestBoundList(progress: ExecutionProgress | null): ExecutionBlockList | null {
  if (!progress) return null;
  const active = progress.nodes.find((node) => node.id === progress.activeNodeId);
  if (active?.list) return active.list;
  const lastSeqByBlock = new Map<string, number>();
  for (const entry of progress.route) {
    if (entry.blockId) lastSeqByBlock.set(entry.blockId, entry.seq);
  }
  const candidates = progress.nodes
    .filter((node) => node.list && lastSeqByBlock.has(node.id))
    .sort((a, b) => lastSeqByBlock.get(b.id)! - lastSeqByBlock.get(a.id)!);
  return candidates[0]?.list ?? null;
}

/** `done/total: current item` for notification text; null when no bound list is near. */
export function boundListLine(progress: ExecutionProgress | null): string | null {
  const list = nearestBoundList(progress);
  if (!list || (list.done === null && list.total === null)) return null;
  const count = `${list.done ?? "?"}/${list.total ?? "?"}`;
  return list.currentTitle ? `📝 ${count}: ${list.currentTitle}` : `📝 ${count}`;
}

/**
 * Who the paused run waits for, with the block it waits in, for notification text: `🙋 waiting
 * for you: <block>` at a gate a person clears, `⏳ agent on the step: <block>` on a step the agent
 * must complete. Null while the run is not paused.
 */
export function waitingActorLine(progress: ExecutionProgress | null): string | null {
  if (!progress || progress.waitingFor === null) return null;
  const actor = progress.waitingFor === "user" ? "🙋 waiting for you" : "⏳ agent on the step";
  const block = progress.nodes.find((node) => node.id === progress.activeNodeId);
  return block ? `${actor}: ${block.label}` : actor;
}

/**
 * The progress lines of a notification footer, in order: the waiting actor (while the run is
 * paused), then the bound list nearest the run. Empty when neither applies.
 */
export function progressFooterLines(progress: ExecutionProgress | null): string[] {
  return [waitingActorLine(progress), boundListLine(progress)].filter(
    (line): line is string => line !== null,
  );
}
