/** Bounded, context-free projections consumed by the administration UI. */
export type AnalyticsRange =
  "15m" | "30m" | "hour" | "day" | "today" | "week" | "month" | "year" | "all";
export type AnalyticsExclusions =
  { mode: "default-admins" } | { mode: "custom"; userIds: string[] };
export interface AnalyticsQuery {
  range: AnalyticsRange;
  exclusions: AnalyticsExclusions;
  limit: number;
  offset: number;
}
export interface AnalyticsScope {
  timeRange: AnalyticsRange;
  startAt: number;
  endAt: number;
  asOf: number;
  exclusions:
    | { mode: "default-admins"; effectiveCount: number }
    | { mode: "custom"; userIds: string[]; effectiveCount: number };
}
/** Honest bounds of the observed buckets transferred for one chart, independently of full-period totals. */
export interface AnalyticsSeriesWindow {
  granularity: "daily" | "hourly";
  limit: number;
  totalBuckets: number;
  limited: boolean;
  firstDate: string | null;
  lastDate: string | null;
}
export interface FlowUsage {
  workflowId: string;
  workflowName: string;
  executionCount: number;
  lastRunAt: number | null;
}
export interface AnalyticsPerson {
  userId: string;
  name: string | null;
  email: string;
  registeredAt: number | null;
  lastActivityAt: number | null;
  lastStepAt: number | null;
  recentSessionAt: number | null;
  executionCount: number;
  runningExecutions: number;
  topWorkflows: FlowUsage[];
  currentExecutions: Array<{
    executionId: string;
    workflowId: string;
    workflowName: string;
    currentNodeId: string | null;
    lastStepAt: number | null;
  }>;
}
export interface AnalyticsOverview {
  scope: AnalyticsScope;
  timeRange: AnalyticsRange;
  totalUsers: number;
  totalWorkflows: number;
  totalExecutions: number;
  activeUsers: number;
  activeExecutions: number;
  completedExecutions: number;
  failedExecutions: number;
  successfulExecutions: number;
  successRate: number;
  avgDurationMs: number;
  overTime: Array<{ date: string; count: number; completed: number; failed: number }>;
  overTimeWindow: AnalyticsSeriesWindow;
}
export interface AnalyticsUsers {
  scope: AnalyticsScope;
  timeRange: AnalyticsRange;
  totalUsers: number;
  activeUsers: number;
  newUsers: number;
  activePeople: AnalyticsPerson[];
  activePeopleTotal: number;
  topUsers: Array<{
    userId: string;
    email: string;
    name: string | null;
    userEmail: string;
    userName: string | null;
    executionCount: number;
    workflowCount: number;
  }>;
}
export interface AnalyticsRegistrations {
  scope: AnalyticsScope;
  timeRange: AnalyticsRange;
  users: AnalyticsPerson[];
  total: number;
}
export interface AttentionExecution {
  executionId: string;
  workflowId: string;
  workflowName: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  status: "running" | "completed" | "locked";
  note: string | null;
  currentNodeId: string | null;
  lastStepAt: number | null;
  lastErrorAt: number | null;
  hasActiveLock: boolean;
  errorCount: number;
  reason: "locked" | "refusal" | "stale-input";
}
export interface AnalyticsAttention {
  scope: AnalyticsScope;
  timeRange: AnalyticsRange;
  executions: AttentionExecution[];
  total: number;
}
export interface AnalyticsTopWorkflow {
  workflowId: string;
  workflowName: string;
  executionCount: number;
  completedCount: number;
  failedCount: number;
  successRate: number;
  avgDurationMs: number;
  participantCount: number;
  lastRunAt: number | null;
  topUsers: Array<{ userId: string; name: string | null; email: string; executionCount: number }>;
}
export interface AnalyticsTopWorkflows {
  scope: AnalyticsScope;
  timeRange: AnalyticsRange;
  workflows: AnalyticsTopWorkflow[];
  total: number;
}
export interface AdminUserActivity {
  lastActivityAt: number | null;
  lastStepAt: number | null;
  executionsCount: number;
  topWorkflows: FlowUsage[];
}
export interface ExecutionSummary {
  executionId: string;
  workflowId: string;
  workflowName: string | null;
  userId: string;
  userEmail: string | null;
  userName: string | null;
  status: "running" | "completed" | "locked";
  currentNodeId: string | null;
  note: string | null;
  stopReason: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  completedAt: number | null;
  error: string | null;
  hasActiveLock: boolean;
  errorCount: number;
  lastStepAt: number | null;
}
