import { isRefusal } from "./execution-error.js";

/** Reader state; the execution engine's stored status is unchanged. */
export type OverviewStatus = "waiting-user" | "waiting-agent" | "locked" | "completed" | "stopped";
export type OverviewStatusFilter = "active" | OverviewStatus | "all";
export type OverviewSort = "activity" | "idle" | "created";
export type OverviewPeriod = "7d" | "30d" | "all";
export interface OverviewChildCounts {
  total: number;
  unfinished: number;
}
export type OverviewIdle = "1h" | "1d" | "3d" | "7d" | "30d";
export type OverviewTimeFilter =
  | { kind: "period"; period: OverviewPeriod }
  | { kind: "idle"; idle: OverviewIdle }
  | { kind: "range"; activeFrom: number | null; activeTo: number | null };

export type ExecutionStopCapability =
  | { available: true; revision: number }
  | { available: false; revision: number; reason: "not-owner" | "in-flight" | "terminal" }
  | { available: false; revision: null; reason: "unavailable" };

export interface ExecutionManagementFields {
  revision: number | null;
  displayStatus: OverviewStatus;
  stopReason: string | null;
  stopCapability: ExecutionStopCapability;
}

export interface ExecutionStopRequest {
  expectedRevision: number;
  reason: string;
}

export interface ExecutionStopResult {
  executionId: string;
  stopped: true;
  stopReason: string;
  revision: number;
  changed: boolean;
  displayStatus: "stopped";
  stopCapability: { available: false; revision: number; reason: "terminal" };
}

export type ExecutionStopRefusal = "stale" | "in-flight" | "terminal";
export interface ExecutionStopConflictDetails {
  stopRefusal: ExecutionStopRefusal;
  currentRevision: number;
  stopCapability: ExecutionStopCapability;
}

export interface ExecutionManagementHeader {
  executionId: string;
  workflowId: string;
  userId: string;
  status: string;
  revision: number | null;
  stopReason: string | null;
  hasExecutingAttempt: boolean;
  hasActiveLock: boolean;
  gateWaiting: boolean;
  awaitingUser: boolean;
  createdAt: number | null;
  lastActivityAt: number | null;
}

export interface OverviewQuery {
  userId: string;
  status: OverviewStatusFilter;
  refusalsOnly?: boolean;
  workflowId?: string;
  search?: string;
  idleSince?: number;
  activeSince?: number;
  activeUntil?: number;
  sort: OverviewSort;
  limit: number;
  offset: number;
}

export interface OverviewQueryInput extends Omit<
  OverviewQuery,
  "status" | "sort" | "limit" | "offset" | "idleSince" | "activeSince" | "activeUntil"
> {
  status?: OverviewStatusFilter;
  sort?: OverviewSort;
  limit?: number;
  offset?: number;
  period?: OverviewPeriod;
  idle?: OverviewIdle;
  activeFrom?: number;
  activeTo?: number;
}

export interface ResolvedOverviewQuery extends OverviewQuery {
  now: number;
  effectiveTime: OverviewTimeFilter;
}

export type ExecutionOutcome =
  "active" | "completed" | "completed-with-refusals" | "stopped" | "other";
export interface ExecutionOutcomeInput {
  status: string;
  stopReason?: string | null;
  errors?: readonly { errorType?: string }[] | null;
}

/** An intentional stop is neither a genuine completion nor a refusal outcome. */
export function classifyExecutionOutcome(execution: ExecutionOutcomeInput): ExecutionOutcome {
  if (execution.stopReason !== null && execution.stopReason !== undefined) return "stopped";
  if (execution.status === "completed")
    return execution.errors?.some(isRefusal) ? "completed-with-refusals" : "completed";
  if (execution.status === "running" || execution.status === "waiting") return "active";
  return "other";
}

export function executionDisplayStatus(
  execution: Pick<
    ExecutionManagementHeader,
    "status" | "stopReason" | "hasActiveLock" | "gateWaiting" | "awaitingUser"
  >,
): OverviewStatus {
  if (execution.stopReason !== null) return "stopped";
  if (execution.status === "completed" || execution.status === "failed") return "completed";
  if (execution.hasActiveLock) return "locked";
  return execution.gateWaiting || execution.awaitingUser ? "waiting-user" : "waiting-agent";
}

/** Advisory snapshot only; the persisted mutation repeats its owner/revision/attempt guards. */
export function executionStopCapability(
  execution: Pick<
    ExecutionManagementHeader,
    "status" | "revision" | "userId" | "hasExecutingAttempt"
  > & { stopReason?: string | null },
  actorId: string,
): ExecutionStopCapability {
  const revision = execution.revision;
  if (revision === null || !Number.isSafeInteger(revision) || revision < 0)
    return { available: false, revision: null, reason: "unavailable" };
  if (execution.userId !== actorId) return { available: false, revision, reason: "not-owner" };
  if (
    execution.stopReason != null ||
    (execution.status !== "running" && execution.status !== "waiting")
  )
    return { available: false, revision, reason: "terminal" };
  if (execution.hasExecutingAttempt) return { available: false, revision, reason: "in-flight" };
  return { available: true, revision };
}

export function executionManagementFields(
  execution: Pick<
    ExecutionManagementHeader,
    | "status"
    | "revision"
    | "stopReason"
    | "userId"
    | "hasExecutingAttempt"
    | "hasActiveLock"
    | "gateWaiting"
    | "awaitingUser"
  >,
  actorId: string,
): ExecutionManagementFields {
  const stopCapability = executionStopCapability(execution, actorId);
  return {
    revision: stopCapability.revision,
    displayStatus: executionDisplayStatus(execution),
    stopReason: execution.stopReason,
    stopCapability,
  };
}

export const OVERVIEW_DAY_MS = 86_400_000;
export const OVERVIEW_HOUR_MS = 3_600_000;
export const OVERVIEW_IDLE_MS: Readonly<Record<OverviewIdle, number>> = {
  "1h": OVERVIEW_HOUR_MS,
  "1d": OVERVIEW_DAY_MS,
  "3d": 3 * OVERVIEW_DAY_MS,
  "7d": 7 * OVERVIEW_DAY_MS,
  "30d": 30 * OVERVIEW_DAY_MS,
};

/** Relative periods and advanced filters resolve against one request clock. */
export function resolveOverviewQuery(
  input: OverviewQueryInput,
  now: number,
): ResolvedOverviewQuery {
  const hasRange = input.activeFrom !== undefined || input.activeTo !== undefined;
  if (
    (input.idle !== undefined && hasRange) ||
    ((input.idle !== undefined || hasRange) && input.period !== undefined && input.period !== "all")
  )
    throw new RangeError("Choose a period, an idle filter or an activity range");
  if (!Number.isFinite(now) || now < 0) throw new RangeError("Invalid overview clock");
  for (const value of [input.activeFrom, input.activeTo])
    if (value !== undefined && (!Number.isFinite(value) || value < 0))
      throw new RangeError("Invalid activity range");
  if (
    input.activeFrom !== undefined &&
    input.activeTo !== undefined &&
    input.activeFrom > input.activeTo
  )
    throw new RangeError("Activity range starts after it ends");
  const period = input.period ?? (input.idle !== undefined || hasRange ? "all" : "7d");
  const effectiveTime: OverviewTimeFilter =
    input.idle !== undefined
      ? { kind: "idle", idle: input.idle }
      : hasRange
        ? { kind: "range", activeFrom: input.activeFrom ?? null, activeTo: input.activeTo ?? null }
        : { kind: "period", period };
  return {
    userId: input.userId,
    status: input.status ?? "active",
    sort: input.sort ?? "activity",
    limit: input.limit ?? 50,
    offset: input.offset ?? 0,
    refusalsOnly: input.refusalsOnly,
    workflowId: input.workflowId,
    search: input.search,
    activeSince: hasRange
      ? input.activeFrom
      : period === "all"
        ? undefined
        : now - (period === "7d" ? 7 : 30) * OVERVIEW_DAY_MS,
    activeUntil: hasRange ? input.activeTo : undefined,
    idleSince: input.idle === undefined ? undefined : now - OVERVIEW_IDLE_MS[input.idle],
    now,
    effectiveTime,
  };
}
