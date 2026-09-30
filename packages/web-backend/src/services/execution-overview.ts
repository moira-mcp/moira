/**
 * The rows of the overview of a person's runs.
 *
 * `ExecutionOverviewRepository` decides which runs a page shows and how they nest; this module
 * projects each of them into what a card shows. The page is projected in batch: its runs in one
 * query, the definitions of their flows in one (each loaded once, however many rows run it), the
 * notification marks in two — so the number of queries does not grow with the page. Node ids never
 * reach the row: the step is named as the run page names it, else by its block, else not at all.
 */

import {
  ExecutionNotificationRepository,
  ExecutionOverviewRepository,
  ExecutionRepository,
  WorkflowRepository,
  type ExecutionNotificationRow,
  type OverviewNode,
  type OverviewQuery,
  type OverviewStatus,
} from "@mcp-moira/shared";
import {
  isAgentDirectiveNode,
  projectExecutionRun,
  type ExecutionProgress,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import { stepNameIn } from "../utils/current-step.js";

/** Items of the active block's list shown around the current one. */
export const LIST_WINDOW = 5;

export interface OverviewNotificationMark {
  kind: "first" | "remind";
  state: string;
  sentAt: number | null;
  deliveryStatus: string | null;
  deliveredChannels: string[];
}

export type OverviewWaitingForUser =
  | { source: "gate"; label: string; notification: OverviewNotificationMark | null }
  | {
      source: "agent";
      question: string;
      options: string[];
      since: number;
      notification: OverviewNotificationMark | null;
    };

export interface OverviewRun {
  executionId: string;
  workflowId: string;
  workflowName: string | null;
  workflowVersion: string | null;
  title: string;
  status: OverviewStatus;
  /** False for a run shown only because it belongs to a matching tree (shown muted). */
  matches: boolean;
  waitingForUser: OverviewWaitingForUser | null;
  refusalCount: number;
  note: string | null;
  current: { stepName: string | null; directiveShownAt: number | null } | null;
  stages: { labels: string[]; activeIndex: number | null; doneCount: number } | null;
  list: {
    title: string;
    done: number | null;
    total: number | null;
    /** A window of the list around the current item. */
    items: Array<{
      index: number;
      title: string;
      done: boolean;
      current: boolean;
      durationMs: number | null;
    }>;
  } | null;
  lastActivityAt: number | null;
  subtreeActivityAt: number | null;
  createdAt: number;
  completedAt: number | null;
  parentExecutionId: string | null;
  /** For a root whose parent exists but is not shown in this tree: which run it continues. */
  parent: { executionId: string; title: string } | null;
  children: { total: number; unfinished: number };
  /** Child runs, in order: unfinished first, then by latest activity. */
  childRuns: OverviewRun[];
}

export interface OverviewResult {
  total: number;
  limit: number;
  offset: number;
  runs: OverviewRun[];
}

export interface OverviewDependencies {
  overview: ExecutionOverviewRepository;
  executions: ExecutionRepository;
  workflows: WorkflowRepository;
  notifications: ExecutionNotificationRepository;
  now?: () => number;
}

function mark(row: ExecutionNotificationRow | undefined): OverviewNotificationMark | null {
  if (!row) return null;
  return {
    kind: row.kind,
    state: row.state,
    sentAt: row.sentAt,
    deliveryStatus: row.deliveryStatus,
    deliveredChannels: row.deliveredChannels,
  };
}

/** The window of `size` items around the current one, shifted inward at the list's ends. */
function windowAround<T>(items: T[], current: number | null, size: number): T[] {
  if (items.length <= size) return items;
  const centre = current ?? 0;
  const start = Math.min(Math.max(0, centre - Math.floor(size / 2)), items.length - size);
  return items.slice(start, start + size);
}

/** Who the run waits for, for a flow without a progress view (the projection gives it otherwise). */
function waitingWithoutProgress(
  graph: WorkflowGraph | undefined,
  execution: WorkflowExecution,
):
  | { source: "gate"; label: string }
  | {
      source: "agent";
      question: string;
      options: string[];
      since: number;
    }
  | null {
  const question = execution.awaitingUser;
  if (question && question.nodeId === execution.currentNodeId) {
    return {
      source: "agent",
      question: question.question,
      options: question.options ?? [],
      since: question.since,
    };
  }
  if (!execution.gateWaiting) return null;
  const node = graph?.nodes.find((candidate) => candidate.id === execution.currentNodeId);
  const label =
    (node && isAgentDirectiveNode(node) ? node.humanGate?.label?.trim() : undefined) ||
    (graph && execution.currentNodeId ? stepNameIn(graph, execution.currentNodeId) : null) ||
    graph?.metadata.name ||
    "";
  return { source: "gate", label };
}

/** When the directive the run waits at was shown: the open visit's entry. */
function directiveShownAt(execution: WorkflowExecution): number | null {
  const waitingAt = execution.waitingForInputNodeId ?? null;
  if (!waitingAt) return null;
  const open = [...(execution.visits ?? [])]
    .reverse()
    .find((visit) => visit.nodeId === waitingAt && !visit.adjusted && visit.exitKey === null);
  return open?.enteredAt ?? null;
}

function projectRow(
  execution: WorkflowExecution,
  node: OverviewNode,
  flow: { name: string; graph: WorkflowGraph } | undefined,
  notification: ExecutionNotificationRow | undefined,
  now: number,
): OverviewRun {
  let progress: ExecutionProgress | null = null;
  if (flow) {
    try {
      progress = projectExecutionRun(flow.graph, execution, { now });
    } catch {
      progress = null;
    }
  }
  const graph = flow?.graph;
  const running = node.status !== "completed";
  const activeIndex = progress?.activeNodeId
    ? progress.nodes.findIndex((block) => block.id === progress!.activeNodeId)
    : -1;
  const activeBlock = activeIndex >= 0 ? progress!.nodes[activeIndex] : null;
  const list = activeBlock?.list ?? null;
  const waitingSource =
    node.status === "waiting-user"
      ? (progress?.waitingForUser ?? waitingWithoutProgress(graph, execution))
      : null;
  const stepId = execution.waitingForInputNodeId ?? execution.currentNodeId ?? null;
  return {
    executionId: execution.executionId,
    workflowId: execution.workflowId,
    workflowName: flow?.name ?? null,
    workflowVersion: execution.workflowVersion ?? null,
    title: progress?.taskTitle || execution.note || flow?.name || execution.workflowId,
    status: node.status,
    matches: node.matches,
    waitingForUser: waitingSource ? { ...waitingSource, notification: mark(notification) } : null,
    refusalCount: execution.refusalCount ?? 0,
    note: execution.note ?? null,
    current:
      running && stepId
        ? {
            stepName: (graph ? stepNameIn(graph, stepId) : null) ?? activeBlock?.label ?? null,
            directiveShownAt: directiveShownAt(execution),
          }
        : null,
    stages: progress
      ? {
          labels: progress.nodes.map((block) => block.label),
          activeIndex: activeIndex >= 0 ? activeIndex : null,
          doneCount: progress.nodes.filter(
            (block) => block.status === "done" || block.status === "repeated",
          ).length,
        }
      : null,
    list:
      list && activeBlock
        ? {
            title: activeBlock.label,
            done: list.done,
            total: list.total,
            items: windowAround(list.items ?? [], list.current, LIST_WINDOW).map((item) => ({
              index: item.index,
              title: item.title,
              done: item.done,
              current: item.current,
              durationMs: item.durationMs,
            })),
          }
        : null,
    lastActivityAt: execution.lastActivityAt ?? null,
    subtreeActivityAt: execution.lastActivityAt ?? null,
    createdAt: execution.createdAt,
    completedAt: execution.completedAt ?? null,
    parentExecutionId: execution.parentExecutionId ?? null,
    parent: null,
    children: { total: 0, unfinished: 0 },
    childRuns: [],
  };
}

/** Project the given overview nodes, nest them, and name the parents of roots that continue one. */
async function projectNodes(
  nodes: OverviewNode[],
  roots: string[],
  userId: string,
  deps: OverviewDependencies,
): Promise<OverviewRun[]> {
  const now = deps.now?.() ?? Date.now();
  const ids = nodes.map((node) => node.executionId);
  const rootParents = nodes
    .filter((node) => roots.includes(node.executionId) && node.parentExecutionId)
    .map((node) => node.parentExecutionId!);
  const executions = await deps.executions.getMany([...ids, ...rootParents]);
  const byId = new Map(executions.map((execution) => [execution.executionId, execution]));
  const flows = await deps.workflows.getManyForUser(
    executions.map((execution) => execution.workflowId),
    userId,
  );
  const marks = deps.notifications.latestForCurrentWaits(
    nodes.filter((node) => node.status === "waiting-user").map((node) => node.executionId),
    now,
  );

  const rows = new Map<string, OverviewRun>();
  for (const node of nodes) {
    const execution = byId.get(node.executionId);
    if (!execution) continue;
    rows.set(
      node.executionId,
      projectRow(
        execution,
        node,
        flows.get(execution.workflowId),
        marks.get(node.executionId),
        now,
      ),
    );
  }
  // Nest: every non-root under its parent, children unfinished first, then by latest activity.
  for (const node of nodes) {
    if (roots.includes(node.executionId)) continue;
    const row = rows.get(node.executionId);
    const parent = node.parentExecutionId ? rows.get(node.parentExecutionId) : undefined;
    if (row && parent) parent.childRuns.push(row);
  }
  const subtreeActivity = (row: OverviewRun): number | null => {
    let latest = row.lastActivityAt;
    for (const child of row.childRuns) {
      const childLatest = subtreeActivity(child);
      if (childLatest !== null && (latest === null || childLatest > latest)) latest = childLatest;
    }
    row.subtreeActivityAt = latest;
    row.children = {
      total: row.childRuns.length,
      unfinished: row.childRuns.filter((child) => child.status !== "completed").length,
    };
    row.childRuns.sort(
      (a, b) =>
        Number(a.status === "completed") - Number(b.status === "completed") ||
        (b.subtreeActivityAt ?? 0) - (a.subtreeActivityAt ?? 0),
    );
    return latest;
  };
  const result: OverviewRun[] = [];
  for (const rootId of roots) {
    const row = rows.get(rootId);
    if (!row) continue;
    subtreeActivity(row);
    const parent = row.parentExecutionId ? byId.get(row.parentExecutionId) : undefined;
    if (parent && parent.userId === userId) {
      row.parent = {
        executionId: parent.executionId,
        title: parent.note || flows.get(parent.workflowId)?.name || parent.workflowId,
      };
    }
    result.push(row);
  }
  return result;
}

/** One page of the overview. */
export async function overviewPage(
  query: OverviewQuery,
  deps: OverviewDependencies,
): Promise<OverviewResult> {
  const page = deps.overview.page(query);
  return {
    total: page.total,
    limit: query.limit,
    offset: query.offset,
    runs: await projectNodes(page.nodes, page.roots, query.userId, deps),
  };
}

/**
 * Single rows by id, projected the same way, without nesting — for refreshing the cards whose runs
 * changed. Each row still carries its subtree's latest activity and its children counts. Other
 * users' runs and unknown ids are left out.
 */
export async function overviewRows(
  userId: string,
  executionIds: string[],
  deps: OverviewDependencies,
): Promise<OverviewRun[]> {
  const facts = deps.overview.statuses(userId, executionIds);
  const nodes: OverviewNode[] = facts.map((fact) => ({
    executionId: fact.executionId,
    parentExecutionId: null,
    rootId: fact.executionId,
    depth: 0,
    status: fact.status,
    matches: true,
    lastActivityAt: fact.lastActivityAt,
  }));
  const runs = await projectNodes(
    nodes,
    nodes.map((node) => node.executionId),
    userId,
    deps,
  );
  const byId = new Map(facts.map((fact) => [fact.executionId, fact]));
  // A refreshed row reports its own parent link, not a nesting decision; its subtree comes from SQL.
  return runs.map((run) => ({
    ...run,
    parent: null,
    subtreeActivityAt: byId.get(run.executionId)?.subtreeActivityAt ?? run.lastActivityAt,
    children: byId.get(run.executionId)?.children ?? run.children,
  }));
}
