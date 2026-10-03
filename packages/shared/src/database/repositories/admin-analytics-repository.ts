import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../schema.js";
import { analyticsBounds } from "../admin-analytics-query.js";
import { refusalCount, latestRefusalAt, successfulExecution } from "../execution-summary-sql.js";
import { storedTimestampMs } from "../timestamp-sql.js";
import { boundedAnalyticsSeries } from "../analytics-series.js";
import type {
  AnalyticsQuery,
  AnalyticsScope,
  AnalyticsOverview,
  AnalyticsUsers,
  AnalyticsRegistrations,
  AnalyticsAttention,
  AttentionExecution,
  AnalyticsTopWorkflows,
  AnalyticsPerson,
  AdminUserActivity,
  FlowUsage,
} from "../../types/admin-analytics.js";

/** Only accepted audit actions establish activity; account creation and blocked login do not. */
const successfulActivity = sql`a.action != 'auth:sign_up' AND NOT (a.action = 'auth:sign_in' AND CASE WHEN json_valid(a.metadata) THEN coalesce(json_extract(a.metadata, '$.blocked'), 0) ELSE 0 END = 1)`;
const refusals = refusalCount(sql`e.errors`);
const successful = successfulExecution(sql`e.state`, sql`e.stopReason`, sql`e.errors`);
const lastError = latestRefusalAt(sql`e.errors`);
const lastStep = sql`(SELECT max(a.createdAt) FROM auditLog a WHERE a.resourceId = e.executionId AND a.resource = 'execution' AND a.action = 'execution:step')`;
const sessionActivity = (now: number) =>
  sql`(SELECT max(${storedTimestampMs(sql`s.refreshedAt`)}) FROM session s WHERE s.userId = u.id AND ${storedTimestampMs(sql`s.expiresAt`)} > ${now} AND ${storedTimestampMs(sql`s.refreshedAt`)} < ${now})`;
const auditActivity = (now: number) =>
  sql`(SELECT max(a.createdAt) FROM auditLog a WHERE a.userId = u.id AND a.createdAt < ${now} AND ${successfulActivity})`;
const userActivity = (now: number) =>
  sql`coalesce(max(${auditActivity(now)},${sessionActivity(now)}),${auditActivity(now)},${sessionActivity(now)})`;
const registrationAt = storedTimestampMs(sql`u.createdAt`);

export class AdminAnalyticsRepository {
  constructor(
    private db: BetterSQLite3Database<typeof schema>,
    private clock: () => number = Date.now,
  ) {}

  private included(query: AnalyticsQuery): SQL {
    return query.exclusions.mode === "default-admins"
      ? sql`coalesce(u.isAdmin,0) = 0`
      : query.exclusions.userIds.length
        ? sql`u.id NOT IN (${sql.join(
            query.exclusions.userIds.map((id) => sql`${id}`),
            sql`,`,
          )})`
        : sql`1 = 1`;
  }
  private scope(query: AnalyticsQuery, now: number): AnalyticsScope {
    const effectiveCount = this.db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM user u WHERE NOT (${this.included(query)})`,
    )!.count;
    return {
      timeRange: query.range,
      ...analyticsBounds(query.range, now),
      asOf: now,
      exclusions:
        query.exclusions.mode === "default-admins"
          ? { mode: "default-admins", effectiveCount }
          : { ...query.exclusions, effectiveCount },
    };
  }
  private period(query: AnalyticsQuery, now: number): SQL {
    const { startAt, endAt } = analyticsBounds(query.range, now);
    return sql`e.createdAt >= ${startAt} AND e.createdAt < ${endAt}`;
  }

  overview(query: AnalyticsQuery): AnalyticsOverview {
    const now = this.clock();
    const scope = this.scope(query, now);
    const totals = this.db.get<{
      totalExecutions: number;
      activeExecutions: number;
      completedExecutions: number;
      failedExecutions: number;
      successfulExecutions: number;
      activeUsers: number;
      avgDurationMs: number;
    }>(
      sql`SELECT count(*) AS totalExecutions, coalesce(sum(e.state='running'),0) AS activeExecutions, coalesce(sum(e.state='completed'),0) AS completedExecutions, coalesce(sum(e.state='completed' AND ${refusals}>0),0) AS failedExecutions, coalesce(sum(${successful}),0) AS successfulExecutions, count(DISTINCT e.userId) AS activeUsers, coalesce(round(avg(CASE WHEN e.state='completed' AND e.completedAt >= e.createdAt THEN e.completedAt-e.createdAt END)),0) AS avgDurationMs FROM workflowExecution e JOIN user u ON u.id=e.userId WHERE ${this.included(query)} AND ${this.period(query, now)}`,
    )!;
    const totalUsers = this.db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM user u WHERE ${this.included(query)}`,
    )!.count;
    const totalWorkflows = this.db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM workflow w JOIN user u ON u.id=w.userId WHERE coalesce(w.deleted,0)=0 AND ${this.included(query)}`,
    )!.count;
    const history = boundedAnalyticsSeries<AnalyticsOverview["overTime"][number]>(
      this.db,
      sql`SELECT date(e.createdAt/1000,'unixepoch') AS date, count(*) AS count, sum(e.state='completed') AS completed, sum(e.state='completed' AND ${refusals}>0) AS failed FROM workflowExecution e JOIN user u ON u.id=e.userId WHERE ${this.included(query)} AND ${this.period(query, now)} GROUP BY date ORDER BY date`,
    );
    return {
      scope,
      timeRange: query.range,
      totalUsers,
      totalWorkflows,
      ...totals,
      successRate: totals.completedExecutions
        ? Math.round((totals.successfulExecutions / totals.completedExecutions) * 10000) / 100
        : 0,
      overTime: history.points,
      overTimeWindow: history.window,
    };
  }

  private people(
    query: AnalyticsQuery,
    now: number,
    condition: SQL,
    order: SQL,
  ): { users: AnalyticsPerson[]; total: number } {
    const where = sql`${this.included(query)} AND (${condition})`;
    const total = this.db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM user u WHERE ${where}`,
    )!.count;
    const users = this.db.all<AnalyticsPerson>(
      sql`SELECT u.id AS userId,u.name,u.email,${registrationAt} AS registeredAt, ${userActivity(now)} AS lastActivityAt, (SELECT max(a.createdAt) FROM auditLog a WHERE a.userId=u.id AND a.action='execution:step' AND a.resource='execution') AS lastStepAt, ${sessionActivity(now)} AS recentSessionAt, (SELECT count(*) FROM workflowExecution e WHERE e.userId=u.id AND ${this.period(query, now)}) AS executionCount, (SELECT count(*) FROM workflowExecution e WHERE e.userId=u.id AND e.state='running') AS runningExecutions FROM user u WHERE ${where} ORDER BY ${order},u.id LIMIT ${Math.min(query.limit, 100)} OFFSET ${query.offset}`,
    );
    const flows = this.flowUsage(
      users.map((person) => person.userId),
      query,
      now,
    );
    const current = new Map<string, AnalyticsPerson["currentExecutions"]>();
    if (users.length) {
      const rows = this.db.all<AnalyticsPerson["currentExecutions"][number] & { userId: string }>(
        sql`SELECT userId,executionId,workflowId,workflowName,currentNodeId,lastStepAt FROM (SELECT e.userId,e.executionId,e.workflowId,coalesce(w.name,e.workflowId) AS workflowName,e.currentNodeId,${lastStep} AS lastStepAt,row_number() OVER (PARTITION BY e.userId ORDER BY ${lastStep} DESC,e.executionId) AS rank FROM workflowExecution e LEFT JOIN workflow w ON w.id=e.workflowId WHERE e.state='running' AND e.userId IN (${sql.join(
          users.map((person) => sql`${person.userId}`),
          sql`,`,
        )})) WHERE rank<=2`,
      );
      for (const { userId, ...execution } of rows)
        current.set(userId, [...(current.get(userId) ?? []), execution]);
    }
    return {
      users: users.map((person) => ({
        ...person,
        topWorkflows: flows.get(person.userId) ?? [],
        currentExecutions: current.get(person.userId) ?? [],
      })),
      total,
    };
  }
  private flowUsage(ids: string[], query: AnalyticsQuery, now: number): Map<string, FlowUsage[]> {
    const result = new Map<string, FlowUsage[]>();
    if (!ids.length) return result;
    const rows = this.db.all<FlowUsage & { userId: string }>(
      sql`SELECT userId,workflowId,workflowName,executionCount,lastRunAt FROM (SELECT e.userId,e.workflowId,coalesce(w.name,e.workflowId) AS workflowName,count(*) AS executionCount,max(e.createdAt) AS lastRunAt,row_number() OVER (PARTITION BY e.userId ORDER BY count(*) DESC,max(e.createdAt) DESC,e.workflowId) AS rank FROM workflowExecution e LEFT JOIN workflow w ON w.id=e.workflowId WHERE e.userId IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`,`,
      )}) AND ${this.period(query, now)} GROUP BY e.userId,e.workflowId) WHERE rank<=3`,
    );
    for (const { userId, ...flow } of rows)
      result.set(userId, [...(result.get(userId) ?? []), flow]);
    return result;
  }
  users(query: AnalyticsQuery): AnalyticsUsers {
    const now = this.clock();
    const scope = this.scope(query, now);
    // The session predicate uses the request clock, not SQLite's wall clock, for deterministic boundaries.
    const recent = sql`(${auditActivity(now)} >= ${scope.startAt}) OR (${sessionActivity(now)} >= ${scope.startAt})`;
    const people = this.people(query, now, recent, sql`lastActivityAt DESC`);
    const overview = this.overviewAt(query, now);
    const topUsers = this.db.all<AnalyticsUsers["topUsers"][number]>(
      sql`SELECT u.id AS userId,u.email,u.name,u.email AS userEmail,u.name AS userName,count(*) AS executionCount,(SELECT count(*) FROM workflow w WHERE w.userId=u.id AND coalesce(w.deleted,0)=0) AS workflowCount FROM workflowExecution e JOIN user u ON u.id=e.userId WHERE ${this.included(query)} AND ${this.period(query, now)} GROUP BY u.id ORDER BY executionCount DESC,u.id LIMIT 10`,
    );
    return {
      scope,
      timeRange: query.range,
      totalUsers: overview.totalUsers,
      activeUsers: overview.activeUsers,
      newUsers: this.registrationCount(query, now),
      activePeople: people.users,
      activePeopleTotal: people.total,
      topUsers,
    };
  }
  private overviewAt(
    query: AnalyticsQuery,
    now: number,
  ): { totalUsers: number; activeUsers: number } {
    return {
      totalUsers: this.db.get<{ count: number }>(
        sql`SELECT count(*) AS count FROM user u WHERE ${this.included(query)}`,
      )!.count,
      activeUsers: this.db.get<{ count: number }>(
        sql`SELECT count(DISTINCT e.userId) AS count FROM workflowExecution e JOIN user u ON u.id=e.userId WHERE ${this.included(query)} AND ${this.period(query, now)}`,
      )!.count,
    };
  }
  private registrationCount(query: AnalyticsQuery, now: number): number {
    const { startAt, endAt } = analyticsBounds(query.range, now);
    return this.db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM user u WHERE ${this.included(query)} AND ${registrationAt}>=${startAt} AND ${registrationAt}<${endAt}`,
    )!.count;
  }
  registrations(query: AnalyticsQuery): AnalyticsRegistrations {
    const now = this.clock();
    const scope = this.scope(query, now);
    const result = this.people(
      query,
      now,
      sql`${registrationAt}>=${scope.startAt} AND ${registrationAt}<${now}`,
      sql`registeredAt DESC`,
    );
    return { ...result, scope, timeRange: query.range };
  }

  /** Registration cohorts share the absolute timestamp/exclusion rules of the dashboard. */
  conversion(query: AnalyticsQuery) {
    const now = this.clock();
    const scope = this.scope(query, now);
    const cohort = sql`${this.included(query)} AND ${registrationAt}>=${scope.startAt} AND ${registrationAt}<${scope.endAt}`;
    const [counts] = this.db.all<{
      registered: number;
      verified: number;
      first: number;
      active: number;
    }>(
      sql`SELECT count(*) AS registered, coalesce(sum(u.emailVerified=1),0) AS verified, coalesce(sum(EXISTS(SELECT 1 FROM workflowExecution e WHERE e.userId=u.id AND e.createdAt<${now})),0) AS first, coalesce(sum((SELECT count(*) FROM workflowExecution e WHERE e.userId=u.id AND e.createdAt<${now})>=2),0) AS active FROM user u WHERE ${cohort}`,
    );
    const trend = boundedAnalyticsSeries<{ date: string; value: number }>(
      this.db,
      sql`SELECT date(${registrationAt}/1000,'unixepoch') AS date, count(*) AS value FROM user u WHERE ${cohort} GROUP BY date`,
    );
    return {
      scope,
      timeRange: query.range,
      funnel: [
        { stage: "registered", label: "Registered", count: counts.registered },
        { stage: "verified", label: "Email Verified", count: counts.verified },
        { stage: "first_workflow", label: "Started Workflow", count: counts.first },
        { stage: "active", label: "Active (2+ runs)", count: counts.active },
      ],
      registrationTrend: trend.points,
      registrationTrendWindow: trend.window,
    };
  }

  engagement(query: AnalyticsQuery) {
    const now = this.clock();
    const scope = this.scope(query, now);
    const where = sql`${this.included(query)} AND ${this.period(query, now)}`;
    const stats = this.db.get<{ users: number; runs: number }>(
      sql`SELECT count(DISTINCT e.userId) AS users,count(*) AS runs FROM workflowExecution e JOIN user u ON u.id=e.userId WHERE ${where}`,
    )!;
    let returningUsersCount: number | null = null;
    if (query.range !== "all") {
      const previousStart = scope.startAt - (scope.endAt - scope.startAt);
      returningUsersCount = this.db.get<{ count: number }>(
        sql`SELECT count(DISTINCT e.userId) AS count FROM workflowExecution e JOIN user u ON u.id=e.userId WHERE ${where} AND EXISTS(SELECT 1 FROM workflowExecution previous WHERE previous.userId=e.userId AND previous.createdAt>=${previousStart} AND previous.createdAt<${scope.startAt})`,
      )!.count;
    }
    const first = this.db.get<{ value: number | null }>(
      sql`SELECT avg((first.firstAt-${registrationAt})/86400000.0) AS value FROM user u JOIN (SELECT userId,min(createdAt) AS firstAt FROM workflowExecution WHERE createdAt<${now} GROUP BY userId) first ON first.userId=u.id WHERE ${this.included(query)} AND ${registrationAt}>=${scope.startAt} AND ${registrationAt}<${scope.endAt} AND first.firstAt>=${registrationAt}`,
    )!.value;
    const trend = boundedAnalyticsSeries<{ date: string; value: number }>(
      this.db,
      sql`SELECT date(e.createdAt/1000,'unixepoch') AS date,count(DISTINCT e.userId) AS value FROM workflowExecution e JOIN user u ON u.id=e.userId WHERE ${where} GROUP BY date`,
    );
    return {
      scope,
      timeRange: query.range,
      returningUsersCount,
      returningUsersRate:
        returningUsersCount === null
          ? null
          : stats.users
            ? Math.round((returningUsersCount / stats.users) * 10000) / 100
            : 0,
      totalActiveUsers: stats.users,
      avgExecutionsPerUser: stats.users ? Math.round((stats.runs / stats.users) * 100) / 100 : 0,
      avgTimeToFirstWorkflowDays: first === null ? null : Math.round(first * 100) / 100,
      activeUsersTrend: trend.points,
      activeUsersTrendWindow: trend.window,
    };
  }

  /** System event metrics deliberately do not inherit user analytics exclusions. */
  operational(
    range: AnalyticsQuery["range"],
    requestedGranularity: "auto" | "daily" | "hourly",
    filters: { action?: string; source?: string; resource?: string } = {},
  ) {
    const now = this.clock();
    const bounds = analyticsBounds(range, now);
    const granularity =
      requestedGranularity === "auto"
        ? range === "today" || range === "week"
          ? "hourly"
          : "daily"
        : requestedGranularity;
    const grouping = (column: SQL) =>
      granularity === "hourly"
        ? sql`strftime('%Y-%m-%d %H:00',${column}/1000,'unixepoch')`
        : sql`date(${column}/1000,'unixepoch')`;
    const extra: SQL[] = [];
    if (filters.action) extra.push(sql`a.action=${filters.action}`);
    if (filters.source) extra.push(sql`a.source=${filters.source}`);
    if (filters.resource) extra.push(sql`a.resource=${filters.resource}`);
    const auditWindow = sql`a.createdAt>=${bounds.startAt} AND a.createdAt<${bounds.endAt}${extra.length ? sql` AND ${sql.join(extra, sql` AND `)}` : sql``}`;
    const currentAudit = sql`a.createdAt>=${now - 60000} AND a.createdAt<${now}${extra.length ? sql` AND ${sql.join(extra, sql` AND `)}` : sql``}`;
    const auditDate = grouping(sql`a.createdAt`);
    const auditSeries = (value: SQL, where = auditWindow) =>
      sql`SELECT ${auditDate} AS date,${value} AS value FROM auditLog a WHERE ${where} GROUP BY date`;
    const metrics: Array<{
      name: string;
      value: number | null;
      unit: string;
      available: boolean;
      unavailableReason?: string;
      timeSeries?: Array<{ date: string; value: number }>;
      timeSeriesWindow?: import("../../types/admin-analytics.js").AnalyticsSeriesWindow;
    }> = [];
    const metric = (name: string, unit: string, grouped: SQL, current?: SQL) => {
      try {
        const history = boundedAnalyticsSeries<{ date: string; value: number }>(
          this.db,
          grouped,
          granularity,
        );
        const value = current
          ? this.db.get<{ value: number }>(current)!.value
          : this.db.get<{ value: number }>(
              sql`SELECT coalesce(sum(value),0) AS value FROM (${grouped})`,
            )!.value;
        metrics.push({
          name,
          unit,
          value,
          available: true,
          timeSeries: history.points,
          timeSeriesWindow: history.window,
        });
      } catch {
        metrics.push({
          name,
          unit,
          value: null,
          available: false,
          unavailableReason: name.startsWith("workflows_")
            ? "Failed to query workflow executions"
            : "Failed to query audit log",
        });
      }
    };
    metric("unique_users_per_day", "users", auditSeries(sql`count(DISTINCT a.userId)`));
    metric("total_calls_per_day", "calls", auditSeries(sql`count(*)`));
    metric(
      "calls_per_second",
      "req/s",
      auditSeries(sql`count(*)`),
      sql`SELECT round(count(*)/60.0,2) AS value FROM auditLog a WHERE ${currentAudit}`,
    );
    const started = sql`SELECT ${grouping(sql`e.createdAt`)} AS date,count(*) AS value FROM workflowExecution e WHERE e.createdAt>=${bounds.startAt} AND e.createdAt<${bounds.endAt} GROUP BY date`;
    const completed = sql`SELECT ${grouping(sql`e.completedAt`)} AS date,count(*) AS value FROM workflowExecution e WHERE e.state='completed' AND e.completedAt>=${bounds.startAt} AND e.completedAt<${bounds.endAt} GROUP BY date`;
    metric("workflows_started_per_day", "workflows", started);
    metric("workflows_completed_per_day", "workflows", completed);
    metric(
      "mcp_calls_per_second",
      "req/s",
      auditSeries(sql`count(*)`, sql`${auditWindow} AND a.source='mcp'`),
      sql`SELECT round(count(*)/60.0,2) AS value FROM auditLog a WHERE ${currentAudit} AND a.source='mcp'`,
    );
    const breakdowns: {
      byAction: Array<{ label: string; count: number }>;
      bySource: Array<{ label: string; count: number }>;
      byResource: Array<{ label: string; count: number }>;
    } = { byAction: [], bySource: [], byResource: [] };
    try {
      breakdowns.byAction = this.db.all(
        sql`SELECT a.action AS label,count(*) AS count FROM auditLog a WHERE ${auditWindow} GROUP BY a.action ORDER BY count DESC LIMIT 15`,
      );
      breakdowns.bySource = this.db.all(
        sql`SELECT coalesce(a.source,'unknown') AS label,count(*) AS count FROM auditLog a WHERE ${auditWindow} GROUP BY a.source ORDER BY count DESC`,
      );
      breakdowns.byResource = this.db.all(
        sql`SELECT coalesce(a.resource,'unknown') AS label,count(*) AS count FROM auditLog a WHERE ${auditWindow} GROUP BY a.resource ORDER BY count DESC`,
      );
    } catch {
      /* Optional breakdowns preserve their existing best-effort contract. */
    }
    return {
      metrics,
      breakdowns,
      timeRange: range,
      granularity,
      activeFilters: {
        action: filters.action ?? null,
        source: filters.source ?? null,
        resource: filters.resource ?? null,
      },
    };
  }
  topWorkflows(query: AnalyticsQuery): AnalyticsTopWorkflows {
    const now = this.clock();
    const total = this.db.get<{ count: number }>(
      sql`SELECT count(DISTINCT e.workflowId) AS count FROM workflowExecution e JOIN user u ON u.id=e.userId WHERE ${this.included(query)} AND ${this.period(query, now)}`,
    )!.count;
    const rows = this.db.all<{
      workflowId: string;
      workflowName: string;
      executionCount: number;
      completedCount: number;
      failedCount: number;
      successfulCount: number;
      avgDurationMs: number;
      participantCount: number;
      lastRunAt: number | null;
    }>(
      sql`SELECT e.workflowId,coalesce(w.name,e.workflowId) AS workflowName,count(*) AS executionCount,sum(e.state='completed') AS completedCount,sum(e.state='completed' AND ${refusals}>0) AS failedCount,sum(${successful}) AS successfulCount,count(DISTINCT e.userId) AS participantCount,max(e.createdAt) AS lastRunAt,coalesce(round(avg(CASE WHEN e.state='completed' AND e.completedAt>=e.createdAt THEN e.completedAt-e.createdAt END)),0) AS avgDurationMs FROM workflowExecution e JOIN user u ON u.id=e.userId LEFT JOIN workflow w ON w.id=e.workflowId WHERE ${this.included(query)} AND ${this.period(query, now)} GROUP BY e.workflowId ORDER BY executionCount DESC,e.workflowId LIMIT ${Math.min(query.limit, 20)} OFFSET ${query.offset}`,
    );
    const owners = new Map<string, AnalyticsTopWorkflows["workflows"][number]["topUsers"]>();
    if (rows.length) {
      const participants = this.db.all<{
        workflowId: string;
        userId: string;
        name: string | null;
        email: string;
        executionCount: number;
      }>(
        sql`SELECT workflowId,userId,name,email,executionCount FROM (SELECT e.workflowId,u.id AS userId,u.name,u.email,count(*) AS executionCount,row_number() OVER (PARTITION BY e.workflowId ORDER BY count(*) DESC,u.id) AS rank FROM workflowExecution e JOIN user u ON u.id=e.userId WHERE ${this.included(query)} AND ${this.period(query, now)} AND e.workflowId IN (${sql.join(
          rows.map((row) => sql`${row.workflowId}`),
          sql`,`,
        )}) GROUP BY e.workflowId,u.id) WHERE rank<=3`,
      );
      for (const { workflowId, ...person } of participants)
        owners.set(workflowId, [...(owners.get(workflowId) ?? []), person]);
    }
    return {
      scope: this.scope(query, now),
      timeRange: query.range,
      total,
      workflows: rows.map(({ successfulCount, ...row }) => ({
        ...row,
        topUsers: owners.get(row.workflowId) ?? [],
        successRate: row.completedCount
          ? Math.round((successfulCount / row.completedCount) * 10000) / 100
          : 0,
      })),
    };
  }
  attention(query: AnalyticsQuery): AnalyticsAttention {
    const now = this.clock();
    const scope = this.scope(query, now);
    const lockTime = sql`(SELECT max(l.createdAt) FROM executionLock l WHERE l.executionId=e.executionId AND l.status='active')`;
    const inPeriod = (value: SQL) => sql`${value} >= ${scope.startAt} AND ${value} < ${now}`;
    const locked = sql`e.state='running' AND ${inPeriod(lockTime)}`;
    const refusal = sql`${inPeriod(lastError)}`;
    const stale = sql`e.state='running' AND e.waitingForInputNodeId IS NOT NULL AND ${lastStep}<${now - 3600000} AND ${inPeriod(lastStep)}`;
    const where = sql`${this.included(query)} AND ((${locked}) OR (${refusal}) OR (${stale}))`;
    const total = this.db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM workflowExecution e JOIN user u ON u.id=e.userId WHERE ${where}`,
    )!.count;
    const rows = this.db.all<Omit<AttentionExecution, "hasActiveLock"> & { hasActiveLock: number }>(
      sql`SELECT e.executionId,e.workflowId,coalesce(w.name,e.workflowId) AS workflowName,e.userId,u.name AS userName,u.email AS userEmail,CASE WHEN e.state='running' AND ${lockTime} IS NOT NULL THEN 'locked' ELSE e.state END AS status,e.note,e.currentNodeId,${lastStep} AS lastStepAt,${lastError} AS lastErrorAt,(e.state='running' AND ${lockTime} IS NOT NULL) AS hasActiveLock,${refusals} AS errorCount,CASE WHEN ${locked} THEN 'locked' WHEN ${refusal} THEN 'refusal' ELSE 'stale-input' END AS reason FROM workflowExecution e JOIN user u ON u.id=e.userId LEFT JOIN workflow w ON w.id=e.workflowId WHERE ${where} ORDER BY CASE WHEN ${locked} THEN ${lockTime} WHEN ${refusal} THEN ${lastError} ELSE ${lastStep} END DESC,e.executionId LIMIT ${query.limit} OFFSET ${query.offset}`,
    );
    return {
      scope,
      timeRange: query.range,
      total,
      executions: rows.map((row) => ({ ...row, hasActiveLock: Boolean(row.hasActiveLock) })),
    };
  }
  /** Page-scoped lifetime management enrichment, independent of analytics exclusions. */
  userActivities(ids: string[]): Map<string, AdminUserActivity> {
    const result = new Map<string, AdminUserActivity>();
    if (!ids.length) return result;
    const query: AnalyticsQuery = {
      range: "all",
      exclusions: { mode: "custom", userIds: [] },
      limit: 100,
      offset: 0,
    };
    const people = this.people(
      query,
      this.clock(),
      sql`u.id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`,`,
      )})`,
      sql`u.id`,
    );
    for (const person of people.users)
      result.set(person.userId, {
        lastActivityAt: person.lastActivityAt,
        lastStepAt: person.lastStepAt,
        executionsCount: person.executionCount,
        topWorkflows: person.topWorkflows,
      });
    return result;
  }
}
