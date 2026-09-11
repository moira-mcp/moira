/**
 * Run traces — what the engine would have to record for the process view to show a run truthfully.
 *
 * A trace is an ordered list of node visits. Each visit says which node ran, which connection key
 * it left through, which variables it changed, and whether it ended in a wait for a person. The
 * prototype has no engine log, so traces are simulated by walking the real annotated graph: agent
 * steps return scripted values, condition nodes are evaluated from those values with the workflow's
 * own operators, expressions are applied, and every visit is therefore a real node reached through
 * a real edge. `runStateFromTrace` projects a trace (optionally cut at a cursor) onto block states.
 */

import type { AuthoredNode, BlockRunState, ProcessProjection } from "./model";

export interface TraceVisit {
  seq: number;
  nodeId: string;
  /** Connection key taken on exit; null when the trace ends on this visit. */
  exitKey: string | null;
  /** Variables (global) and step outputs (`node.field`) set at this visit. */
  changes: Record<string, unknown>;
  /** The visit ended in a wait for a person's decision. */
  waited?: boolean;
  /** Short human note for this visit, e.g. "unit 3 of 5". */
  note?: string;
  /** The visit was produced by a runtime adjustment (a value set or a decision supplied by a person). */
  adjusted?: boolean;
}

export type TraceStatus = "running" | "waiting" | "completed" | "stopped";

export interface RunTrace {
  id: string;
  slug: string;
  title: string;
  description: string;
  initial: Record<string, unknown>;
  visits: TraceVisit[];
  status: TraceStatus;
}

export type StepScript = (
  visitIndex: number,
  ctx: TraceContext,
) =>
  | {
      outputs?: Record<string, unknown>;
      waited?: boolean;
      note?: string;
      teleportTo?: string;
      /** End the trace on this visit (the run is still going, this is where it is now). */
      stop?: boolean;
    }
  | "stop";

export interface TraceScript {
  id: string;
  title: string;
  description: string;
  initial: Record<string, unknown>;
  /** Scripted returns of agent steps, by node id; the visit index counts that node's visits. */
  steps: Record<string, StepScript>;
  /** Safety bound on visits so a wrong script cannot loop forever. */
  maxVisits?: number;
}

export interface TraceContext {
  variables: Record<string, unknown>;
  outputs: Record<string, Record<string, unknown>>;
}

// --- Condition and expression evaluation, mirroring the engine's structured-condition operators.

type Operand = { contextPath: string } | unknown;

function resolve(ctx: TraceContext, operand: Operand): unknown {
  if (operand && typeof operand === "object" && "contextPath" in (operand as object)) {
    const path = (operand as { contextPath: string }).contextPath;
    const dot = path.indexOf(".");
    if (dot === -1) return ctx.variables[path];
    return ctx.outputs[path.slice(0, dot)]?.[path.slice(dot + 1)];
  }
  return operand;
}

export function evaluateCondition(ctx: TraceContext, condition: unknown): boolean {
  const c = condition as {
    operator: string;
    left?: Operand;
    right?: Operand;
    conditions?: unknown[];
    condition?: unknown;
    value?: Operand;
  };
  switch (c.operator) {
    case "and":
      return (c.conditions ?? []).every((x) => evaluateCondition(ctx, x));
    case "or":
      return (c.conditions ?? []).some((x) => evaluateCondition(ctx, x));
    case "not":
      return !evaluateCondition(ctx, c.condition);
    case "exists": {
      const v = resolve(ctx, c.value);
      return v !== undefined && v !== null && v !== "";
    }
  }
  const left = resolve(ctx, c.left);
  const right = resolve(ctx, c.right);
  switch (c.operator) {
    case "eq":
      return left === right;
    case "neq":
      return left !== right;
    case "gt":
      return Number(left) > Number(right);
    case "gte":
      return Number(left) >= Number(right);
    case "lt":
      return Number(left) < Number(right);
    case "lte":
      return Number(left) <= Number(right);
    case "contains":
      return String(left).includes(String(right));
  }
  throw new Error(`Unsupported operator ${c.operator}`);
}

/** `a = b + 1`, `a = 1`, `a = b` — the arithmetic subset the bundled flows use. */
export function applyExpression(ctx: TraceContext, expression: string): Record<string, unknown> {
  const m = /^\s*([\w.]+)\s*=\s*(.+?)\s*$/.exec(expression);
  if (!m) throw new Error(`Unsupported expression ${expression}`);
  const [, target, rhs] = m;
  const term = (t: string): number => {
    const trimmed = t.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    const v = resolve(ctx, { contextPath: trimmed });
    return Number(v ?? 0);
  };
  const parts = rhs.split(/\s*([+\-*/])\s*/);
  let value = term(parts[0]);
  for (let i = 1; i < parts.length; i += 2) {
    const op = parts[i];
    const next = term(parts[i + 1]);
    value =
      op === "+"
        ? value + next
        : op === "-"
          ? value - next
          : op === "*"
            ? value * next
            : value / next;
  }
  ctx.variables[target] = value;
  return { [target]: value };
}

// --- Simulation.

export function simulateTrace(
  slug: string,
  authored: AuthoredNode[],
  script: TraceScript,
): RunTrace {
  const byId = new Map(authored.map((n) => [n.id, n]));
  const start = authored.find((n) => n.type === "start");
  if (!start) throw new Error(`${slug}: no start node`);
  const ctx: TraceContext = { variables: { ...script.initial }, outputs: {} };
  const visitsOf = new Map<string, number>();
  const visits: TraceVisit[] = [];
  let status: TraceStatus = "running";
  let current: AuthoredNode | undefined = start;
  const max = script.maxVisits ?? 400;

  while (current && visits.length < max) {
    const node: AuthoredNode = current;
    const index = visitsOf.get(node.id) ?? 0;
    visitsOf.set(node.id, index + 1);
    const visit: TraceVisit = { seq: visits.length, nodeId: node.id, exitKey: null, changes: {} };
    visits.push(visit);
    let exitKey: string | null = null;
    let jumpTo: string | undefined;

    if (node.type === "condition") {
      exitKey = evaluateCondition(ctx, node.condition) ? "true" : "false";
    } else if (node.type === "expression") {
      for (const e of node.expressions ?? []) Object.assign(visit.changes, applyExpression(ctx, e));
      exitKey = "default";
    } else if (node.type === "end") {
      status = node.id === "end" ? "completed" : "stopped";
      break;
    } else if (node.type === "agent-directive" || node.type === "teleport") {
      const step = script.steps[node.id];
      const result = step ? step(index, ctx) : {};
      if (result === "stop") {
        status = "running";
        break;
      }
      const outputs = result.outputs ?? {};
      ctx.outputs[node.id] = { ...(ctx.outputs[node.id] ?? {}), ...outputs };
      for (const [k, v] of Object.entries(outputs)) {
        if (k.startsWith("progress_") || k in ctx.variables) {
          ctx.variables[k] = v;
          visit.changes[k] = v;
        } else visit.changes[`${node.id}.${k}`] = v;
      }
      if (result.note) visit.note = result.note;
      if (result.waited) {
        visit.waited = true;
        // A wait that the script does not resolve ends the trace on this visit.
        if (!("outputs" in result) || Object.keys(outputs).length === 0) {
          status = "waiting";
          break;
        }
      }
      if (result.stop) {
        status = "running";
        break;
      }
      if (result.teleportTo) jumpTo = result.teleportTo;
      exitKey = Object.keys(node.connections)[0] ?? null;
    } else {
      exitKey = Object.keys(node.connections)[0] ?? null;
    }

    if (jumpTo) {
      visit.exitKey = `teleport:${jumpTo}`;
      current = byId.get(jumpTo);
      continue;
    }
    visit.exitKey = exitKey;
    const nextId = exitKey ? node.connections[exitKey] : undefined;
    current = nextId ? byId.get(nextId) : undefined;
    if (!current) break;
  }
  if (visits.length >= max) throw new Error(`${slug}/${script.id}: visit bound reached`);
  return {
    id: script.id,
    slug,
    title: script.title,
    description: script.description,
    initial: script.initial,
    visits,
    status,
  };
}

/** Every consecutive pair of visits is a real edge (or a declared teleport). */
export function verifyTrace(authored: AuthoredNode[], trace: RunTrace): string[] {
  const byId = new Map(authored.map((n) => [n.id, n]));
  const problems: string[] = [];
  for (let i = 0; i < trace.visits.length - 1; i++) {
    const a = trace.visits[i];
    const b = trace.visits[i + 1];
    const node = byId.get(a.nodeId);
    if (!node) {
      problems.push(`visit ${a.seq}: unknown node ${a.nodeId}`);
      continue;
    }
    if (a.exitKey?.startsWith("teleport:")) {
      if (a.exitKey.slice(9) !== b.nodeId) problems.push(`visit ${a.seq}: teleport mismatch`);
      continue;
    }
    if (!a.exitKey || node.connections[a.exitKey] !== b.nodeId)
      problems.push(`visit ${a.seq}: ${a.nodeId}.${a.exitKey} does not lead to ${b.nodeId}`);
  }
  return problems;
}

// --- Projection onto blocks.

export interface BlockVisitStats {
  /** Times the run entered the block from outside (or started in it). */
  entries: number;
  /** Node visits inside the block. */
  nodeVisits: number;
  /** Visits of steps that do work (not start, condition, expression); zero means passed through. */
  substantiveVisits: number;
  /** Highest visit count of any one node in the block — how many passes the block's loop made. */
  iterations: number;
  firstSeq?: number;
  lastSeq?: number;
}

const ROUTING_TYPES = new Set(["start", "condition", "expression"]);

export function blockStats(
  projection: ProcessProjection,
  trace: RunTrace,
  at?: number,
): Map<string, BlockVisitStats> {
  const owner = new Map<string, string>();
  for (const b of projection.blocks) for (const id of b.nodeIds) owner.set(id, b.id);
  const typeOf = new Map(projection.authored.map((n) => [n.id, n.type]));
  const stats = new Map<string, BlockVisitStats>(
    projection.blocks.map((b) => [
      b.id,
      { entries: 0, nodeVisits: 0, substantiveVisits: 0, iterations: 0 },
    ]),
  );
  const perNode = new Map<string, number>();
  const visits = at === undefined ? trace.visits : trace.visits.slice(0, at + 1);
  let previousBlock: string | undefined;
  for (const visit of visits) {
    const block = owner.get(visit.nodeId);
    if (!block) continue;
    const s = stats.get(block)!;
    s.nodeVisits += 1;
    const routing = ROUTING_TYPES.has(typeOf.get(visit.nodeId) ?? "");
    if (!routing) s.substantiveVisits += 1;
    const count = (perNode.get(visit.nodeId) ?? 0) + 1;
    perNode.set(visit.nodeId, count);
    // Passes are counted on working steps; a routing check runs once more than the loop body.
    if (!routing || s.substantiveVisits === 0) s.iterations = Math.max(s.iterations, count);
    if (block !== previousBlock) s.entries += 1;
    s.firstSeq ??= visit.seq;
    s.lastSeq = visit.seq;
    previousBlock = block;
  }
  return stats;
}

/**
 * Block states from a trace: the block of the last visit is active (waiting when that visit waited
 * and the trace ends there); visited blocks are done, or repeated with the pass count of their most
 * visited node; blocks where only routing nodes ran, and unvisited blocks the run has already passed
 * in process order, are skipped; the rest are pending. Nothing unvisited is ever reported done.
 */
export function runStateFromTrace(
  projection: ProcessProjection,
  trace: RunTrace,
  at?: number,
): Record<string, BlockRunState> {
  const stats = blockStats(projection, trace, at);
  const visits = at === undefined ? trace.visits : trace.visits.slice(0, at + 1);
  const last = visits[visits.length - 1];
  const owner = new Map<string, string>();
  for (const b of projection.blocks) for (const id of b.nodeIds) owner.set(id, b.id);
  const currentBlock = last ? owner.get(last.nodeId) : undefined;
  const ended = at === undefined || at >= trace.visits.length - 1;
  const finished = ended && (trace.status === "completed" || trace.status === "stopped");
  const order = projection.blocks.map((b) => b.id);
  const maxVisitedIndex = Math.max(
    -1,
    ...order.map((id, i) => ((stats.get(id)?.entries ?? 0) > 0 ? i : -1)),
  );
  const lastNote = [...visits]
    .reverse()
    .find((v) => v.note && owner.get(v.nodeId) === currentBlock)?.note;

  const run: Record<string, BlockRunState> = {};
  order.forEach((id, index) => {
    const s = stats.get(id)!;
    if (s.entries === 0) {
      run[id] = { status: index < maxVisitedIndex ? "skipped" : "pending" };
      return;
    }
    if (id === currentBlock && !finished) {
      run[id] = {
        status: ended && trace.status === "waiting" && last?.waited ? "waiting" : "active",
        iterations: s.iterations,
        currentNodeId: last?.nodeId,
        ...(lastNote ? { note: lastNote } : {}),
      };
      return;
    }
    if (s.substantiveVisits === 0) {
      // Only routing nodes ran here: the run passed through without doing the block's work.
      run[id] = { status: "skipped" };
      return;
    }
    run[id] =
      s.iterations > 1 ? { status: "repeated", iterations: s.iterations } : { status: "done" };
  });
  return run;
}

/**
 * What the engine's current index-based projection would report for the same run: every block
 * before the active one "completed". Returns the blocks it would misreport as completed although
 * the trace never visited them — evidence for the engine change the assessment records.
 */
export function indexProjectionMisreports(
  projection: ProcessProjection,
  trace: RunTrace,
  at?: number,
): string[] {
  const stats = blockStats(projection, trace, at);
  const visits = at === undefined ? trace.visits : trace.visits.slice(0, at + 1);
  const last = visits[visits.length - 1];
  const owner = new Map<string, string>();
  for (const b of projection.blocks) for (const id of b.nodeIds) owner.set(id, b.id);
  const activeIndex = last
    ? projection.blocks.findIndex((b) => b.id === owner.get(last.nodeId))
    : -1;
  return projection.blocks
    .filter((b, i) => i < activeIndex && (stats.get(b.id)?.entries ?? 0) === 0)
    .map((b) => b.id);
}
