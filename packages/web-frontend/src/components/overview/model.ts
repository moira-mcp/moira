/**
 * The overview page's view model, as pure functions: which plan rows fit on a card, how a tree of
 * runs is laid out as groups, how the filters are kept in the URL, and how rows refreshed one by one
 * replace their old copies in the tree. Nothing here reads the engine's graph: every fact comes
 * from the overview rows (`GET /api/executions/overview`).
 */

import type {
  OverviewIdle,
  OverviewQuery,
  OverviewRun,
  OverviewSort,
  OverviewStatusFilter,
} from "../../services/api-client";

// ---------------------------------------------------------------------------------------------
// The plan window of a card
// ---------------------------------------------------------------------------------------------

/** One item the plan window may show: a list item, or a stage when the flow keeps no list. */
export interface PlanItem {
  /** Position in the whole list (zero-based). */
  index: number;
  title: string;
  done: boolean;
  current: boolean;
  durationMs: number | null;
}

export type PlanRow =
  | { kind: "above"; count: number }
  | { kind: "item"; item: PlanItem; twoLines: boolean }
  | { kind: "below"; count: number };

/** Characters of a one-line plan item on a card; a longer current item takes a second line. */
export const PLAN_LINE_CHARS = 34;

/** Lines a row takes: the current item may wrap to two lines, every other row takes one. */
function linesOf(item: PlanItem): number {
  return item.current && item.title.length > PLAN_LINE_CHARS ? 2 : 1;
}

/**
 * The rows of a card's plan in `slots` lines: a window centred on the current item — some items
 * above, some below, grown alternately while they fit — with what does not fit folded into "↑ N"
 * and "↓ N". `items` may itself be a window of a longer list (the overview sends at most five items
 * around the current one); `total` is the length of the whole list. Without a current item the
 * window stands on the last item of a finished run, else on the first item not done.
 */
export function planRows(
  items: readonly PlanItem[],
  total: number,
  slots: number,
  finished: boolean,
): PlanRow[] {
  if (items.length === 0) return [];
  const hiddenBefore = items[0].index;
  const hiddenAfter = Math.max(0, total - (items[items.length - 1].index + 1));
  let at = items.findIndex((item) => item.current);
  if (at < 0) {
    const firstOpen = items.findIndex((item) => !item.done);
    at = finished || firstOpen < 0 ? items.length - 1 : firstOpen;
  }
  const above = hiddenBefore + at;
  const below = hiddenAfter + (items.length - at - 1);
  const lines = (up: number, down: number) =>
    linesOf(items[at]) + up + down + (above > up ? 1 : 0) + (below > down ? 1 : 0);
  const reachableUp = at;
  const reachableDown = items.length - at - 1;
  let up = 0;
  let down = 0;
  for (let turn = 0; turn < items.length * 2; turn += 1) {
    const downFirst = turn % 2 === 0;
    const canDown = down < reachableDown && lines(up, down + 1) <= slots;
    const canUp = up < reachableUp && lines(up + 1, down) <= slots;
    if (downFirst && canDown) down += 1;
    else if (!downFirst && canUp) up += 1;
    else if (canDown) down += 1;
    else if (canUp) up += 1;
    else break;
  }
  const rows: PlanRow[] = [];
  if (above > up) rows.push({ kind: "above", count: above - up });
  for (let index = at - up; index <= at + down; index += 1) {
    rows.push({ kind: "item", item: items[index], twoLines: linesOf(items[index]) === 2 });
  }
  if (below > down) rows.push({ kind: "below", count: below - down });
  return rows;
}

/** The lines the rows take — never more than the slots they were fitted into. */
export function planLines(rows: readonly PlanRow[]): number {
  return rows.reduce((sum, row) => sum + (row.kind === "item" && row.twoLines ? 2 : 1), 0);
}

/** The stages of a run as plan items, for a flow that keeps stages but no list. */
export function stageItems(run: OverviewRun): PlanItem[] {
  if (!run.stages) return [];
  const finished = run.status === "completed";
  const active = run.stages.activeIndex;
  return run.stages.labels.map((title, index) => ({
    index,
    title,
    done: finished || (active !== null ? index < active : index < run.stages!.doneCount),
    current: !finished && active === index,
    durationMs: null,
  }));
}

/** What a card's plan area shows: the active block's list, the stages, or neither. */
export type CardPlan =
  | { kind: "list"; title: string; done: number | null; total: number | null; items: PlanItem[] }
  | { kind: "stages"; done: number; total: number; items: PlanItem[] }
  | { kind: "none" };

export function cardPlan(run: OverviewRun): CardPlan {
  if (run.list && run.list.items.length > 0) {
    return {
      kind: "list",
      title: run.list.title,
      done: run.list.done,
      total: run.list.total,
      items: run.list.items,
    };
  }
  if (run.stages && run.stages.labels.length > 0) {
    const items = stageItems(run);
    return {
      kind: "stages",
      done: items.filter((item) => item.done).length,
      total: items.length,
      items,
    };
  }
  return { kind: "none" };
}

/**
 * The row above the plan holds the waiting banner, or the stage strip when the plan below is a list.
 * Without it the plan gets its line.
 */
export function hasStripRow(run: OverviewRun): boolean {
  if (run.status === "waiting-user" && run.waitingForUser) return true;
  return cardPlan(run).kind === "list" && run.stages !== null && run.stages.labels.length > 0;
}

/** Lines of the plan area: six, or five when the strip row takes one. */
export function planSlots(run: OverviewRun): number {
  return hasStripRow(run) ? 5 : 6;
}

// ---------------------------------------------------------------------------------------------
// Groups: a run with child runs, a child with children of its own nested inside
// ---------------------------------------------------------------------------------------------

export type BoardNode =
  | { kind: "card"; run: OverviewRun; depth: number }
  | {
      kind: "group";
      run: OverviewRun;
      depth: number;
      /** Children without children of their own first (they share a row), then nested groups. */
      children: BoardNode[];
      /** Every run below this one. */
      descendants: number;
      /** A group on the third level or deeper starts folded. */
      foldable: boolean;
    };

/** From this depth (zero-based: the root is 0) a nested group starts folded. */
export const FOLD_FROM_DEPTH = 2;

function countDescendants(run: OverviewRun): number {
  return run.childRuns.reduce((sum, child) => sum + 1 + countDescendants(child), 0);
}

/**
 * The board node of a run: a card when it has no child runs, else a group of its card and its
 * children. The children keep the order the overview sends (unfinished first, then by latest
 * activity); those without children of their own come before nested groups, so they fill the row
 * beside the parent's card and no card stands alone between two full-width groups.
 */
export function boardNode(run: OverviewRun, depth = 0): BoardNode {
  if (run.childRuns.length === 0) return { kind: "card", run, depth };
  const leaves = run.childRuns.filter((child) => child.childRuns.length === 0);
  const branches = run.childRuns.filter((child) => child.childRuns.length > 0);
  return {
    kind: "group",
    run,
    depth,
    children: [...leaves, ...branches].map((child) => boardNode(child, depth + 1)),
    descendants: countDescendants(run),
    foldable: depth >= FOLD_FROM_DEPTH,
  };
}

/** Every run of the trees, each once, parents before children. */
export function flattenRuns(runs: readonly OverviewRun[]): OverviewRun[] {
  return runs.flatMap((run) => [run, ...flattenRuns(run.childRuns)]);
}

/** The run with this id anywhere in the trees. */
export function findRun(runs: readonly OverviewRun[], id: string): OverviewRun | null {
  for (const run of runs) {
    if (run.executionId === id) return run;
    const found = findRun(run.childRuns, id);
    if (found) return found;
  }
  return null;
}

/** The runs from a root down to this run's parent, or null when the run is not in the trees. */
export function ancestorsOf(runs: readonly OverviewRun[], id: string): OverviewRun[] | null {
  for (const run of runs) {
    if (run.executionId === id) return [];
    const below = ancestorsOf(run.childRuns, id);
    if (below) return [run, ...below];
  }
  return null;
}

/**
 * The trees with these rows put in place of their old copies. A refreshed row comes flat (`ids=`
 * answers rows outside any tree), so what depends on the row's place in the page's trees is kept
 * from the page: its child runs, whether it matches the filters or is shown only for its tree, and
 * the parent a root names when that parent is not on the page.
 */
export function replaceRows(
  runs: readonly OverviewRun[],
  fresh: ReadonlyMap<string, OverviewRun>,
): OverviewRun[] {
  return runs.map((run) => {
    const childRuns = replaceRows(run.childRuns, fresh);
    const row = fresh.get(run.executionId);
    return row
      ? { ...row, matches: run.matches, parent: run.parent, childRuns }
      : { ...run, childRuns };
  });
}

/** The trees without this run (and what hangs below it). */
export function withoutRun(runs: readonly OverviewRun[], id: string): OverviewRun[] {
  return runs
    .filter((run) => run.executionId !== id)
    .map((run) => ({ ...run, childRuns: withoutRun(run.childRuns, id) }));
}

// ---------------------------------------------------------------------------------------------
// Filters in the URL
// ---------------------------------------------------------------------------------------------

export type OverviewLayout = "grid" | "lanes";

export interface OverviewFilters {
  status: OverviewStatusFilter;
  idle: OverviewIdle | null;
  activeFrom: number | null;
  activeTo: number | null;
  workflowId: string | null;
  sort: OverviewSort;
  refusals: boolean;
  search: string;
  layout: OverviewLayout;
  page: number;
}

export const DEFAULT_FILTERS: OverviewFilters = {
  status: "active",
  idle: null,
  activeFrom: null,
  activeTo: null,
  workflowId: null,
  sort: "activity",
  refusals: false,
  search: "",
  layout: "grid",
  page: 1,
};

export const STATUS_FILTERS: readonly OverviewStatusFilter[] = [
  "active",
  "waiting-user",
  "waiting-agent",
  "locked",
  "completed",
  "all",
];
export const IDLE_FILTERS: readonly OverviewIdle[] = ["1h", "1d", "3d", "7d", "30d"];
export const SORTS: readonly OverviewSort[] = ["activity", "idle", "created"];
/** The idle interval of the "no movement for more than a week" chip. */
export const STALE_IDLE: OverviewIdle = "7d";
/** A run unfinished and without movement for longer than this reads as stale on its card. */
export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

function oneOf<T extends string>(value: string | null, allowed: readonly T[]): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function epoch(value: string | null): number | null {
  if (value === null || value === "") return null;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

/** The filters a URL carries; anything unknown or malformed reads as the default. */
export function filtersFromParams(params: URLSearchParams): OverviewFilters {
  const page = Number(params.get("page"));
  return {
    status: oneOf(params.get("status"), STATUS_FILTERS) ?? DEFAULT_FILTERS.status,
    idle: oneOf(params.get("idle"), IDLE_FILTERS),
    activeFrom: epoch(params.get("activeFrom")),
    activeTo: epoch(params.get("activeTo")),
    workflowId: params.get("workflowId") || null,
    sort: oneOf(params.get("sort"), SORTS) ?? DEFAULT_FILTERS.sort,
    refusals: params.get("refusals") === "true",
    search: params.get("q") ?? "",
    layout: oneOf(params.get("layout"), ["grid", "lanes"] as const) ?? DEFAULT_FILTERS.layout,
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/**
 * The filters written into URL parameters, defaults left out so a plain link stays plain; the
 * parameters that are not filters (the open panel, a running guide) are kept.
 */
export function paramsWithFilters(
  current: URLSearchParams,
  filters: OverviewFilters,
): URLSearchParams {
  const next = new URLSearchParams(current);
  const set = (key: string, value: string | null) => {
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
  };
  set("status", filters.status === DEFAULT_FILTERS.status ? null : filters.status);
  set("idle", filters.idle);
  set("activeFrom", filters.activeFrom === null ? null : String(filters.activeFrom));
  set("activeTo", filters.activeTo === null ? null : String(filters.activeTo));
  set("workflowId", filters.workflowId);
  set("sort", filters.sort === DEFAULT_FILTERS.sort ? null : filters.sort);
  set("refusals", filters.refusals ? "true" : null);
  set("q", filters.search.trim() || null);
  set("layout", filters.layout === DEFAULT_FILTERS.layout ? null : filters.layout);
  set("page", filters.page > 1 ? String(filters.page) : null);
  return next;
}

/** The number of filters set in the popover (the status switch and the search are outside it). */
export function popoverFilterCount(filters: OverviewFilters): number {
  return [
    filters.idle !== null && filters.idle !== STALE_IDLE,
    filters.activeFrom !== null || filters.activeTo !== null,
    filters.workflowId !== null,
    filters.sort !== DEFAULT_FILTERS.sort,
    filters.refusals,
  ].filter(Boolean).length;
}

/** The overview request for these filters and page size. */
export function overviewQuery(filters: OverviewFilters, pageSize: number): OverviewQuery {
  return {
    status: filters.status,
    ...(filters.refusals ? { refusals: true } : {}),
    ...(filters.workflowId ? { workflowId: filters.workflowId } : {}),
    ...(filters.search.trim() ? { search: filters.search.trim() } : {}),
    ...(filters.idle ? { idle: filters.idle } : {}),
    ...(filters.activeFrom !== null ? { activeFrom: filters.activeFrom } : {}),
    ...(filters.activeTo !== null ? { activeTo: filters.activeTo } : {}),
    sort: filters.sort,
    limit: pageSize,
    offset: (filters.page - 1) * pageSize,
  };
}

// ---------------------------------------------------------------------------------------------
// Time as a card words it
// ---------------------------------------------------------------------------------------------

export type AgeUnit = "now" | "min" | "h" | "d";

/** How long ago, in the one unit a card shows: under a minute is "now". */
export function ageOf(ms: number): { unit: AgeUnit; count: number } {
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (ms < minute) return { unit: "now", count: 0 };
  if (ms < hour) return { unit: "min", count: Math.round(ms / minute) };
  if (ms < day) return { unit: "h", count: Math.round(ms / hour) };
  return { unit: "d", count: Math.round(ms / day) };
}

/** The moment a card's age counts from: the latest activity of the run and all its descendants. */
export function activityOf(run: OverviewRun): number {
  return run.subtreeActivityAt ?? run.lastActivityAt ?? run.createdAt;
}

/** Unfinished and without movement for longer than `STALE_AFTER_MS`. */
export function isStale(run: OverviewRun, now: number): boolean {
  return run.status !== "completed" && now - activityOf(run) > STALE_AFTER_MS;
}
