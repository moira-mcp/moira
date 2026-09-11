/**
 * Variable values of a recorded run, and runtime adjustments to it.
 *
 * Everything here reads the trace: current values are the initial values plus every change up to
 * the cursor, a variable's history is the list of visits that changed it, and a block's usage is
 * what its visits wrote and what its routing nodes read. Runtime adjustments act on the *run* —
 * a value overridden now, or a decision supplied at the current wait — and are represented as extra
 * visits appended to the trace, so the route shows them and the flow definition is never touched.
 */

import type { AuthoredNode, ProcessProjection } from "./model";
import {
  applyExpression,
  evaluateCondition,
  type RunTrace,
  type TraceContext,
  type TraceVisit,
} from "./trace";

export interface ValueChange {
  seq: number;
  nodeId: string;
  value: unknown;
  adjusted?: boolean;
}

export interface VariableState {
  name: string;
  /** Global variable (no dot) or a step output ("node.field"). */
  kind: "variable" | "output";
  current: unknown;
  history: ValueChange[];
  /** Set when the current value came from a runtime adjustment. */
  adjusted: boolean;
}

function visitsUpTo(trace: RunTrace, at?: number): TraceVisit[] {
  return at === undefined ? trace.visits : trace.visits.slice(0, at + 1);
}

/** Every variable and step output with its value at the cursor and its full history. */
export function variableStates(trace: RunTrace, at?: number): VariableState[] {
  const states = new Map<string, VariableState>();
  for (const [name, value] of Object.entries(trace.initial)) {
    states.set(name, { name, kind: "variable", current: value, history: [], adjusted: false });
  }
  for (const visit of visitsUpTo(trace, at)) {
    for (const [name, value] of Object.entries(visit.changes)) {
      const state = states.get(name) ?? {
        name,
        kind: name.includes(".") ? "output" : "variable",
        current: undefined,
        history: [],
        adjusted: false,
      };
      state.current = value;
      state.adjusted = Boolean(visit.adjusted);
      state.history.push({ seq: visit.seq, nodeId: visit.nodeId, value, adjusted: visit.adjusted });
      states.set(name, state);
    }
  }
  return [...states.values()].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "variable" ? -1 : 1,
  );
}

/** What a block's visits wrote (with visit numbers) and what its routing nodes read. */
export function blockVariableUsage(
  projection: ProcessProjection,
  trace: RunTrace,
  blockId: string,
  at?: number,
): { writes: Array<ValueChange & { name: string }>; reads: string[] } {
  const block = projection.blocks.find((b) => b.id === blockId);
  if (!block) return { writes: [], reads: [] };
  const members = new Set(block.nodeIds);
  const writes: Array<ValueChange & { name: string }> = [];
  for (const visit of visitsUpTo(trace, at)) {
    if (!members.has(visit.nodeId)) continue;
    for (const [name, value] of Object.entries(visit.changes)) {
      writes.push({ name, seq: visit.seq, nodeId: visit.nodeId, value, adjusted: visit.adjusted });
    }
  }
  const reads = new Set<string>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if ("contextPath" in (value as object)) {
      reads.add((value as { contextPath: string }).contextPath);
      return;
    }
    for (const v of Object.values(value as Record<string, unknown>)) collect(v);
  };
  for (const node of projection.authored) {
    if (!members.has(node.id)) continue;
    collect(node.condition);
    for (const e of node.expressions ?? []) {
      const rhs = e.split("=")[1] ?? "";
      for (const term of rhs.split(/[+\-*/]/)) {
        const name = term.trim();
        if (name && !/^-?\d+(\.\d+)?$/.test(name)) reads.add(name);
      }
    }
  }
  return { writes, reads: [...reads].sort() };
}

// --- Runtime adjustments.

export interface RuntimeAdjustments {
  /** Values set on the running execution, applied at the current position. */
  overrides: Record<string, unknown>;
  /** A decision supplied at the current wait: the waiting step's returned fields. */
  decision: Record<string, unknown> | null;
}

export const NO_ADJUSTMENTS: RuntimeAdjustments = { overrides: {}, decision: null };

export function countAdjustments(a: RuntimeAdjustments): number {
  return Object.keys(a.overrides).length + (a.decision ? 1 : 0);
}

/** Rebuild the simulator context at the end of a trace by replaying its changes. */
function contextOf(trace: RunTrace): TraceContext {
  const ctx: TraceContext = { variables: { ...trace.initial }, outputs: {} };
  for (const visit of trace.visits) {
    for (const [name, value] of Object.entries(visit.changes)) {
      const dot = name.indexOf(".");
      if (dot === -1) ctx.variables[name] = value;
      else {
        const node = name.slice(0, dot);
        ctx.outputs[node] = { ...(ctx.outputs[node] ?? {}), [name.slice(dot + 1)]: value };
      }
    }
  }
  return ctx;
}

/**
 * The trace with runtime adjustments appended: overrides become one adjustment visit on the
 * current node; a decision at a wait resolves the waiting step and follows the graph through the
 * routing nodes to the next working step, each as a visit marked `adjusted`.
 */
export function applyAdjustments(
  authored: AuthoredNode[],
  trace: RunTrace,
  adjustments: RuntimeAdjustments,
): RunTrace {
  if (countAdjustments(adjustments) === 0) return trace;
  const byId = new Map(authored.map((n) => [n.id, n]));
  const visits = trace.visits.map((v) => ({ ...v, changes: { ...v.changes } }));
  let status = trace.status;
  const last = visits[visits.length - 1];
  if (!last) return trace;

  if (Object.keys(adjustments.overrides).length) {
    visits.push({
      seq: visits.length,
      nodeId: last.nodeId,
      exitKey: null,
      changes: { ...adjustments.overrides },
      adjusted: true,
      note: "runtime adjustment",
    });
  }

  if (adjustments.decision && trace.status === "waiting") {
    const waiting = byId.get(last.nodeId);
    const ctx = contextOf({ ...trace, visits });
    for (const [k, v] of Object.entries(adjustments.overrides)) ctx.variables[k] = v;
    const resolved = visits[visits.length - 1];
    // The decision resolves the waiting step: its fields become that step's outputs.
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(adjustments.decision)) {
      const key = k.startsWith("progress_") || k in ctx.variables ? k : `${last.nodeId}.${k}`;
      changes[key] = v;
      if (key.includes(".")) {
        ctx.outputs[last.nodeId] = { ...(ctx.outputs[last.nodeId] ?? {}), [k]: v };
      } else ctx.variables[k] = v;
    }
    Object.assign(resolved.changes, changes);
    resolved.adjusted = true;
    resolved.note = "decision supplied";
    let exitKey = waiting ? (Object.keys(waiting.connections)[0] ?? null) : null;
    resolved.exitKey = exitKey;
    let current = exitKey && waiting ? byId.get(waiting.connections[exitKey]) : undefined;
    let guard = 0;
    while (current && guard++ < 50) {
      const visit: TraceVisit = {
        seq: visits.length,
        nodeId: current.id,
        exitKey: null,
        changes: {},
        adjusted: true,
      };
      visits.push(visit);
      if (current.type === "condition")
        exitKey = evaluateCondition(ctx, current.condition) ? "true" : "false";
      else if (current.type === "expression") {
        for (const e of current.expressions ?? [])
          Object.assign(visit.changes, applyExpression(ctx, e));
        exitKey = "default";
      } else if (current.type === "end") {
        status = current.id === "end" ? "completed" : "stopped";
        break;
      } else {
        // Next working step: the run would pause here for the agent.
        status = "running";
        break;
      }
      visit.exitKey = exitKey;
      current = exitKey ? byId.get(current.connections[exitKey]) : undefined;
    }
  }
  return { ...trace, visits, status };
}
