/**
 * The rows of the overview of a person's runs.
 *
 * `ExecutionOverviewRepository` decides which runs a page shows and how they nest; this module
 * projects each of them into what a card shows. Execution identities, definition-dependent values
 * and relevant visits are read in batches; fragment depth determines additional discovery reads,
 * not the number of rows. Flow definitions are loaded once per page and notification marks in two
 * batch queries. Node ids never
 * reach the row: the step is named as the run page names it, else by its block, else not at all.
 */

import {
  ExecutionNotificationRepository,
  ExecutionOverviewRepository,
  ExecutionRepository,
  ConflictError,
  WorkflowRepository,
  type ExecutionNotificationRow,
  type OverviewNode,
  type OverviewQuery,
  type OverviewStatus,
} from "@mcp-moira/shared";
import {
  isAgentDirectiveNode,
  projectExecutionRunSummary,
  resolveExecutionTaskTitle,
  progressReadDependencies,
  PROGRESS_SUMMARY_LIST_WINDOW,
  templateReadDependencies,
  type ExecutionProgressSummary,
  type WorkflowExecution,
  type WorkflowGraph,
} from "@mcp-moira/workflow-engine";
import {
  executionStopCapability,
  resolveOverviewQuery,
  type ExecutionStopCapability,
  type OverviewSort,
  type OverviewChildCounts,
  type OverviewTimeFilter,
  type ResolvedOverviewQuery,
} from "@mcp-moira/shared/execution-management";
import type { ExecutionStages } from "@mcp-moira/workflow-engine/progress-visual";
import { stepNameIn } from "../utils/current-step.js";

/** Items of the active block's list shown around the current one. */
export const LIST_WINDOW = PROGRESS_SUMMARY_LIST_WINDOW;

const MAX_PROGRESS_READ_RETRIES = 3;

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
  revision: number | null;
  stopCapability: ExecutionStopCapability;
  stopReason: string | null;
  /** False for a run shown only because it belongs to a matching tree (shown muted). */
  matches: boolean;
  waitingForUser: OverviewWaitingForUser | null;
  refusalCount: number;
  note: string | null;
  current: { stepName: string | null; directiveShownAt: number | null } | null;
  stages: ExecutionStages | null;
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
  createdAt: number | null;
  idleActivityAt: number | null;
  completedAt: number | null;
  parentExecutionId: string | null;
  /** For a root whose parent exists but is not shown in this tree: which run it continues. */
  parent: { executionId: string; title: string } | null;
  children: OverviewChildCounts;
  childrenTotal: OverviewChildCounts;
  /** Child runs follow the selected server ordering, with stable creation/id ties. */
  childRuns: OverviewRun[];
}

export interface OverviewResult {
  total: number;
  limit: number;
  offset: number;
  runs: OverviewRun[];
  evaluatedAt: number;
  effectiveTime: OverviewTimeFilter;
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
  hasExecutingAttempt: boolean,
): OverviewRun {
  let progress: ExecutionProgressSummary | null = null;
  if (flow) {
    try {
      progress = projectExecutionRunSummary(flow.graph, execution, { now });
    } catch {
      progress = null;
    }
  }
  const graph = flow?.graph;
  const running = node.status !== "completed" && node.status !== "stopped";
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
    title: progress?.taskTitle ?? resolveExecutionTaskTitle(graph, execution),
    status: node.status,
    revision:
      Number.isSafeInteger(execution.revision) && execution.revision >= 0
        ? execution.revision
        : null,
    stopCapability: executionStopCapability(
      { ...execution, hasExecutingAttempt },
      execution.userId,
    ),
    stopReason: execution.stopReason ?? null,
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
          entries: progress.nodes.map(({ id, label, status }) => ({ id, label, status })),
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
    lastActivityAt: node.lastActivityAt,
    subtreeActivityAt: node.subtreeActivityAt,
    idleActivityAt: node.idleActivityAt,
    createdAt: node.createdAt,
    completedAt: execution.completedAt ?? null,
    parentExecutionId: execution.parentExecutionId ?? null,
    parent: null,
    children: { total: 0, unfinished: 0 },
    childrenTotal: node.childrenTotal,
    childRuns: [],
  };
}

/** Project the given overview nodes, nest them, and name the parents of roots that continue one. */
async function projectNodes(
  nodes: OverviewNode[],
  roots: string[],
  userId: string,
  deps: OverviewDependencies,
  sort: OverviewSort = "activity",
): Promise<OverviewRun[]> {
  const now = deps.now?.() ?? Date.now();
  const ids = nodes.map((node) => node.executionId);
  const rootParents = nodes
    .filter((node) => roots.includes(node.executionId) && node.parentExecutionId)
    .map((node) => node.parentExecutionId!);
  const references = await deps.executions.getManyWorkflowReferences([...ids, ...rootParents]);
  let executions: WorkflowExecution[] = [];
  const flows = await deps.workflows.getManyForUser(
    references.map((execution) => execution.workflowId),
    userId,
  );
  // Expand runtime fragment dependencies in batches. Already-read values decide only what
  // additional inputs are needed; rendering and fragment trust remain the shared engine's job.
  const requested = new Map<string, string>();
  const unstableDiscoveryReads = new Map<string, number>();
  for (;;) {
    const loadedById = new Map(executions.map((execution) => [execution.executionId, execution]));
    const reads = references.map((execution) => {
      const flow = flows.get(execution.workflowId);
      const dependencies = flow
        ? progressReadDependencies(
            flow.graph,
            loadedById.get(execution.executionId)?.globalContext.variables,
          )
        : { variables: [] as string[], historyRoots: [] as string[], arrayWindows: [] };
      return {
        executionId: execution.executionId,
        ...dependencies,
        visits: false,
        arrayWindows: dependencies.arrayWindows.map((window) => ({ ...window, start: 0, size: 0 })),
      };
    });
    const missing = reads.filter((read) => {
      return requested.get(read.executionId) !== JSON.stringify(read);
    });
    if (!missing.length) break;
    const previousRequests = new Map(requested);
    const missingById = new Map(missing.map((read) => [read.executionId, read]));
    for (const read of missing) requested.set(read.executionId, JSON.stringify(read));
    const loaded = await deps.executions.getManyForProgress(
      missing.map((read) => read.executionId),
      missing,
    );
    for (const execution of loaded) {
      const previous = loadedById.get(execution.executionId);
      if (!previous) continue;
      const previousScope = JSON.parse(previousRequests.get(execution.executionId)!) as {
        variables: string[] | null;
      };
      const scope = missingById.get(execution.executionId)!;
      const previousVariables = previous.globalContext.variables;
      const currentVariables = execution.globalContext.variables;
      const sharedNames = (previousScope.variables ?? Object.keys(previousVariables)).filter(
        (name) => scope.variables === null || scope.variables.includes(name),
      );
      const fragmentsChanged = sharedNames.some((name) => {
        const before = Object.hasOwn(previousVariables, name) ? previousVariables[name] : undefined;
        const after = Object.hasOwn(currentVariables, name) ? currentVariables[name] : undefined;
        return (
          before !== after &&
          ((typeof before === "string" && before.includes("{{")) ||
            (typeof after === "string" && after.includes("{{")))
        );
      });
      // Stable dependency growth can need many batches. Bound changing snapshots instead of
      // cutting off a valid static closure; a writer extending the next unseen dependency is
      // also detected by the row's state generation/write timestamp.
      if (
        previous.revision !== execution.revision ||
        previous.updatedAt !== execution.updatedAt ||
        fragmentsChanged
      ) {
        const attempts = (unstableDiscoveryReads.get(execution.executionId) ?? 0) + 1;
        unstableDiscoveryReads.set(execution.executionId, attempts);
        if (attempts > MAX_PROGRESS_READ_RETRIES) {
          throw new ConflictError("Execution progress changed while reading; retry");
        }
      }
    }
    const next = new Map(loaded.map((execution) => [execution.executionId, execution]));
    executions = executions.length
      ? executions.map((execution) => next.get(execution.executionId) ?? execution)
      : loaded;
  }
  const finalReadsFor = (rows: WorkflowExecution[]) =>
    rows.map((execution) => {
      const flow = flows.get(execution.workflowId);
      return {
        executionId: execution.executionId,
        visits: ids.includes(execution.executionId),
        ...(flow
          ? progressReadDependencies(flow.graph, execution.globalContext.variables)
          : { variables: [], historyRoots: [], arrayWindows: [] }),
      };
    });
  let finalReads = finalReadsFor(executions);
  for (let attempt = 0; ; attempt++) {
    executions = await deps.executions.getManyForProgress(
      executions.map((execution) => execution.executionId),
      finalReads,
    );
    const observed = finalReadsFor(executions);
    const requestedById = new Map(finalReads.map((read) => [read.executionId, read]));
    const changed = observed.some((read) => {
      const requested = requestedById.get(read.executionId)!;
      const missingVariable =
        requested.variables !== null &&
        (read.variables === null ||
          read.variables.some((name) => !requested.variables!.includes(name)));
      return (
        missingVariable ||
        (requested.arrayWindows.length > 0 &&
          JSON.stringify(requested.arrayWindows) !== JSON.stringify(read.arrayWindows))
      );
    });
    if (!changed) break;
    if (attempt >= MAX_PROGRESS_READ_RETRIES)
      throw new ConflictError("Execution progress changed while reading; retry");
    // A moving cursor can invalidate a discovered window. Under sustained updates read the
    // needed list as a whole once, so its counters and items come from the same SQLite row.
    // Unrelated context and journals remain excluded. Changing fragment dependencies still
    // requires a stable read; never return a heading assembled from missing inputs.
    finalReads = attempt >= 1 ? observed.map((read) => ({ ...read, arrayWindows: [] })) : observed;
  }
  const byId = new Map(executions.map((execution) => [execution.executionId, execution]));
  const executing = new Set(await deps.executions.getExecutingIds(ids));
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
        executing.has(execution.executionId),
      ),
    );
  }
  // SQL supplies an acyclic display placement; persisted parent links remain separately inspectable.
  for (const node of nodes) {
    if (roots.includes(node.executionId)) continue;
    const row = rows.get(node.executionId);
    const parent = node.parentExecutionId ? rows.get(node.parentExecutionId) : undefined;
    if (row && parent) parent.childRuns.push(row);
  }
  for (const row of rows.values()) {
    row.children = {
      total: row.childRuns.length,
      unfinished: row.childRuns.filter(
        (child) => child.status !== "completed" && child.status !== "stopped",
      ).length,
    };
    row.childRuns.sort(
      (a, b) =>
        (sort === "created"
          ? 0
          : sort === "idle"
            ? (a.idleActivityAt ?? 0) - (b.idleActivityAt ?? 0)
            : Math.floor((b.subtreeActivityAt ?? 0) / 3_600_000) -
              Math.floor((a.subtreeActivityAt ?? 0) / 3_600_000)) ||
        (b.createdAt ?? 0) - (a.createdAt ?? 0) ||
        (a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0),
    );
  }
  const result: OverviewRun[] = [];
  for (const rootId of roots) {
    const row = rows.get(rootId);
    if (!row) continue;
    const parent = row.parentExecutionId ? byId.get(row.parentExecutionId) : undefined;
    if (parent && parent.userId === userId && !rows.has(parent.executionId)) {
      row.parent = {
        executionId: parent.executionId,
        title: resolveExecutionTaskTitle(flows.get(parent.workflowId)?.graph, parent),
      };
    }
    result.push(row);
  }
  return result;
}

/** Common selective heading read for already-authorized IDs and exact overview search. */
export async function readExecutionTaskTitles(
  executionIds: string[],
  userId: string,
  deps: Pick<OverviewDependencies, "executions" | "workflows">,
  checkGeneration: () => void = () => {},
  snapshots?: readonly WorkflowExecution[],
): Promise<Map<string, string>> {
  const executions = new Map<string, WorkflowExecution>();
  const read = async (
    ids: string[],
    specifications?: Parameters<ExecutionRepository["getManyForProgress"]>[1],
  ) => {
    for (let start = 0; start < ids.length; start += 500) {
      const chunk = ids.slice(start, start + 500);
      const requested = specifications?.filter((specification) =>
        chunk.includes(specification.executionId),
      );
      for (const execution of await deps.executions.getManyForProgress(chunk, requested, "title"))
        executions.set(execution.executionId, execution);
      checkGeneration();
    }
  };
  if (snapshots) {
    const requested = new Set(executionIds);
    for (const execution of snapshots)
      if (execution.userId === userId && requested.has(execution.executionId))
        executions.set(execution.executionId, execution);
  } else await read(executionIds);
  const legacy = [...executions.values()].filter((execution) => !execution.taskIdentity);
  const definitions = await deps.workflows.getManyForTaskTitles(
    legacy.map((execution) => execution.workflowId),
    userId,
  );
  checkGeneration();
  const variableRequests = new Map<string, string>();
  const defaultRequests = new Map<string, string>();
  for (;;) {
    const reads = legacy.map((execution) => {
      const current = executions.get(execution.executionId)!;
      const definition = definitions.get(execution.workflowId)?.definition;
      return {
        executionId: execution.executionId,
        workflowId: execution.workflowId,
        variables: definition?.progress?.title
          ? templateReadDependencies(
              [definition.progress.title],
              definition.variableRegistry,
              current.globalContext.variables,
            )
          : [],
        historyRoots: [],
        visits: false,
      };
    });
    const scopes = new Map<string, Set<string> | null>();
    for (const spec of reads) {
      if (!definitions.get(spec.workflowId)?.current) continue;
      const previous = scopes.get(spec.workflowId);
      if (previous === null || spec.variables === null) scopes.set(spec.workflowId, null);
      else scopes.set(spec.workflowId, new Set([...(previous ?? []), ...spec.variables]));
    }
    const defaults = [...scopes]
      .map(([workflowId, variables]) => ({
        workflowId,
        variables: variables === null ? null : [...variables].sort(),
      }))
      .filter((spec) => defaultRequests.get(spec.workflowId) !== JSON.stringify(spec.variables));
    if (defaults.length) {
      const values = await deps.workflows.getTaskTitleDefaultsForUser(defaults, userId);
      checkGeneration();
      for (const spec of defaults) {
        defaultRequests.set(spec.workflowId, JSON.stringify(spec.variables));
        const definition = definitions.get(spec.workflowId);
        if (definition) definition.definition.variableRegistry = values.get(spec.workflowId) ?? {};
      }
    }
    // A full caller snapshot already contains its complete context. Missing values must remain
    // missing there: reading them from storage would mix this snapshot with a later generation.
    const missing = snapshots
      ? []
      : reads.filter(
          (spec) => variableRequests.get(spec.executionId) !== JSON.stringify(spec.variables),
        );
    if (missing.length) {
      await read(
        missing.map((spec) => spec.executionId),
        missing,
      );
      for (const spec of missing)
        variableRequests.set(spec.executionId, JSON.stringify(spec.variables));
    }
    if (!defaults.length && !missing.length) break;
  }
  return new Map(
    [...executions.values()].map((execution) => [
      execution.executionId,
      resolveExecutionTaskTitle(definitions.get(execution.workflowId)?.definition, execution),
    ]),
  );
}

/** Selective legacy headings are resolved before SQL membership, never after pagination. */
async function matchingTaskTitles(
  query: ResolvedOverviewQuery,
  deps: OverviewDependencies,
  version: string,
): Promise<string[]> {
  if (!query.search) return [];
  const candidates = deps.overview.searchCandidates(query);
  const titles = await readExecutionTaskTitles(
    candidates.map((candidate) => candidate.executionId),
    query.userId,
    deps,
    () => {
      if (deps.overview.readVersion() !== version)
        throw new ConflictError("Execution overview changed while reading; retry");
    },
  );
  const needle = query.search.toLowerCase();
  return [...titles]
    .filter(([_id, title]) => title.toLowerCase().includes(needle))
    .map(([id]) => id);
}

/** One request clock for inclusive selection, canonical projection and notification facts. */
export async function overviewPage(
  query: OverviewQuery | ResolvedOverviewQuery,
  deps: OverviewDependencies,
): Promise<OverviewResult> {
  const now = "now" in query ? query.now : (deps.now?.() ?? Date.now());
  const advanced =
    query.activeSince !== undefined ||
    query.activeUntil !== undefined ||
    query.idleSince !== undefined;
  const resolved: ResolvedOverviewQuery =
    "effectiveTime" in query
      ? query
      : {
          ...resolveOverviewQuery({ ...query, period: advanced ? "all" : undefined }, now),
          ...query,
          now,
          effectiveTime: advanced
            ? {
                kind: "range",
                activeFrom: query.activeSince ?? null,
                activeTo: query.activeUntil ?? query.idleSince ?? null,
              }
            : { kind: "period", period: "7d" },
        };
  const requestDeps = { ...deps, now: () => now };
  for (let attempt = 0; ; attempt++) {
    const version = deps.overview.readVersion();
    try {
      const headings = await matchingTaskTitles(resolved, requestDeps, version);
      const page = deps.overview.page(resolved, headings);
      const runs = await projectNodes(
        page.nodes,
        page.roots,
        query.userId,
        requestDeps,
        resolved.sort,
      );
      if (deps.overview.readVersion() !== version)
        throw new ConflictError("Execution overview changed while reading; retry");
      return {
        total: page.total,
        limit: query.limit,
        offset: query.offset,
        runs,
        evaluatedAt: now,
        effectiveTime: resolved.effectiveTime,
      };
    } catch (error) {
      if (!(error instanceof ConflictError) || attempt >= MAX_PROGRESS_READ_RETRIES) throw error;
    }
  }
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
    createdAt: fact.createdAt,
    subtreeActivityAt: fact.subtreeActivityAt,
    idleActivityAt: fact.idleActivityAt,
    childrenTotal: fact.children,
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
    idleActivityAt: byId.get(run.executionId)?.idleActivityAt ?? run.idleActivityAt,
    childrenTotal: byId.get(run.executionId)?.children ?? run.childrenTotal,
    children: { total: 0, unfinished: 0 },
  }));
}
