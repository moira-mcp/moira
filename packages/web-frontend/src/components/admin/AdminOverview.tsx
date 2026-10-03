import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type {
  AnalyticsRange,
  AnalyticsQuery,
  AnalyticsScope,
  AnalyticsExclusions,
  AnalyticsPerson,
} from "@mcp-moira/shared";
import { useResource } from "@/hooks/useResource";
import { useFeatures } from "@/hooks/useFeatures";
import { apiClient } from "@/services/api-client";
import { AnalyticsCard } from "./AnalyticsCard";
import { AnalyticsSeriesNotice } from "./AnalyticsSeriesNotice";
import { CardShell } from "@/components/cards/CardShell";
import { ExecutionStopProvider } from "@/components/execution/ExecutionStop";
import { ExecutionCard } from "@/components/cards/ExecutionCard";
import { normalizeExecution } from "@/components/cards/normalize-execution";
import { formatDate, formatRelativeTime } from "@/components/cards/format-utils";
import { Badge } from "@/components/ui/badge";
import { ROUTES } from "@/constants/routes";

const analysisRanges: AnalyticsRange[] = ["today", "week", "month"];
function useCard<T extends { scope: AnalyticsScope }>(
  accountId: string | null,
  exclusions: AnalyticsExclusions,
  initial: AnalyticsRange,
  read: (query: AnalyticsQuery) => Promise<T>,
) {
  const [range, setRange] = useState<AnalyticsRange>(initial);
  const query: AnalyticsQuery = { range, exclusions, limit: 6, offset: 0 };
  const key = accountId ? JSON.stringify({ accountId, ...query }) : null;
  const resource = useResource(key, (request) => read(JSON.parse(request) as AnalyticsQuery));
  return { range, setRange, resource };
}

export function AdminOverview({
  accountId,
  exclusions,
  onStopped,
}: {
  accountId: string | null;
  exclusions: AnalyticsExclusions;
  onStopped: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isEnabled } = useFeatures();
  const canManageUsers = isEnabled("userManagement");
  const canManageRuns = isEnabled("multiUserAdmin");
  const overview = useCard(accountId, exclusions, "month", (query) =>
    apiClient.getAdminAnalyticsOverview(query),
  );
  const active = useCard(accountId, exclusions, "30m", (query) =>
    apiClient.getAdminAnalyticsUsers(query),
  );
  const registrations = useCard(accountId, exclusions, "week", (query) =>
    apiClient.getAdminAnalyticsRegistrations(query),
  );
  const attention = useCard(accountId, exclusions, "week", (query) =>
    apiClient.getAdminAnalyticsAttention(query),
  );
  const flows = useCard(accountId, exclusions, "month", (query) =>
    apiClient.getAdminAnalyticsTopWorkflows(query),
  );
  const empty = <p className="py-4 text-sm text-muted-foreground">{t("adminOverview.empty")}</p>;
  const inventoryLink = (to: string, label: string) => (
    <Link
      to={to}
      className="block text-xs text-primary hover:underline"
      data-hint={t("adminOverview.fullInventory")}
    >
      {label} →{" "}
      <span className="block text-muted-foreground">{t("adminOverview.fullInventory")}</span>
    </Link>
  );
  const personCard = (person: AnalyticsPerson, registration: boolean) => (
    <CardShell
      key={person.userId}
      testId="admin-person-card"
      title={person.name || person.email}
      description={person.name ? person.email : undefined}
      onClick={
        canManageUsers
          ? () => navigate(`${ROUTES.ADMIN_USERS}/${encodeURIComponent(person.userId)}`)
          : undefined
      }
      note={
        registration
          ? person.registeredAt === null
            ? t("adminOverview.unknownRegistration")
            : t("adminOverview.registered", { when: formatDate(person.registeredAt) })
          : person.currentExecutions.length > 0
            ? person.currentExecutions
                .map(
                  (run) =>
                    `${run.workflowName}${run.currentNodeId ? ` · ${run.currentNodeId}` : ""}`,
                )
                .join("; ")
            : undefined
      }
      meta={
        <>
          <span>
            {person.lastActivityAt === null
              ? t("adminOverview.unknownActivity")
              : t("adminOverview.lastActivity", {
                  when: formatRelativeTime(person.lastActivityAt),
                })}
          </span>
          <span>{t("adminOverview.runs", { count: person.executionCount })}</span>
          <span>{t("adminOverview.currentRuns", { count: person.runningExecutions })}</span>
          {canManageUsers && <span>{t("adminOverview.accountDetails")}</span>}
          <span>
            {person.lastStepAt === null
              ? t("adminOverview.unknownStep")
              : t("adminOverview.lastStep", { when: formatRelativeTime(person.lastStepAt) })}
          </span>
        </>
      }
    />
  );
  return (
    <ExecutionStopProvider
      scopeKey={accountId ?? undefined}
      onStopped={async () => {
        await Promise.all([
          overview.resource.refresh(),
          active.resource.refresh(),
          registrations.resource.refresh(),
          attention.resource.refresh(),
          flows.resource.refresh(),
          onStopped(),
        ]);
      }}
    >
      <div className="space-y-4" data-testid="admin-overview">
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <AnalyticsCard
            id="active"
            title={t("adminOverview.active")}
            range={active.range}
            ranges={["15m", "30m", "hour"]}
            onRangeChange={active.setRange}
            resource={active.resource}
            hint={t("adminOverview.activeHint")}
          >
            {(data) => (
              <>
                {data.activePeople.length
                  ? data.activePeople.map((person) => personCard(person, false))
                  : empty}
                <p className="text-xs text-muted-foreground">
                  {t("adminOverview.showing", {
                    shown: data.activePeople.length,
                    total: data.activePeopleTotal,
                  })}
                </p>
                {canManageUsers && inventoryLink(ROUTES.ADMIN_USERS, t("adminOverview.allUsers"))}
              </>
            )}
          </AnalyticsCard>
          <AnalyticsCard
            id="attention"
            title={t("adminOverview.attention")}
            range={attention.range}
            ranges={["hour", "day", "week"]}
            onRangeChange={attention.setRange}
            resource={attention.resource}
          >
            {(data) => (
              <>
                {data.executions.length
                  ? data.executions.map((run) => (
                      <div key={run.executionId}>
                        <Badge variant="outline" className="mb-1 border-warning/30 text-warning">
                          {t(`adminOverview.reason.${run.reason}`)}
                        </Badge>
                        <ExecutionCard
                          execution={normalizeExecution({ ...run, note: run.note ?? undefined })}
                          onClick={
                            canManageRuns
                              ? () =>
                                  navigate(
                                    `${ROUTES.ADMIN_EXECUTIONS}/${encodeURIComponent(run.executionId)}`,
                                  )
                              : undefined
                          }
                        />
                      </div>
                    ))
                  : empty}
                <p className="text-xs text-muted-foreground">
                  {t("adminOverview.showing", { shown: data.executions.length, total: data.total })}
                </p>
                {canManageRuns &&
                  inventoryLink(ROUTES.ADMIN_EXECUTIONS, t("adminOverview.allExecutions"))}
              </>
            )}
          </AnalyticsCard>
          <AnalyticsCard
            id="flows"
            title={t("adminOverview.popular")}
            range={flows.range}
            ranges={analysisRanges}
            onRangeChange={flows.setRange}
            resource={flows.resource}
          >
            {(data) => (
              <>
                {data.workflows.length
                  ? data.workflows.map((flow) => (
                      <CardShell
                        key={flow.workflowId}
                        title={flow.workflowName}
                        testId="admin-popular-flow"
                        description={flow.topUsers
                          .map(
                            (person) => `${person.name || person.email} (${person.executionCount})`,
                          )
                          .join(" · ")}
                        meta={
                          <>
                            <span>{t("adminOverview.runs", { count: flow.executionCount })}</span>
                            <span>
                              {t("admin.analytics.status.completed")}: {flow.completedCount}
                            </span>
                            <span>
                              {t("admin.analytics.status.failed")}: {flow.failedCount}
                            </span>
                            <span>
                              {t("admin.analytics.status.stopped")}: {flow.stoppedCount}
                            </span>
                            <span>{t("admin.analytics.successRateHint")}</span>
                            <span>
                              {t("adminOverview.participants", { count: flow.participantCount })}
                            </span>
                            <span>
                              {flow.successRate.toFixed(1)}%{" "}
                              {t("admin.analytics.table.successRate")}
                              {flow.completedCount === 0 && (
                                <> · {t("admin.analytics.noCompletions")}</>
                              )}
                            </span>
                            <span>
                              {flow.lastRunAt === null ? "—" : formatRelativeTime(flow.lastRunAt)}
                            </span>
                          </>
                        }
                      />
                    ))
                  : empty}
                <p className="text-xs text-muted-foreground">
                  {t("adminOverview.showing", { shown: data.workflows.length, total: data.total })}
                </p>
                {canManageRuns &&
                  inventoryLink(ROUTES.ADMIN_WORKFLOWS, t("adminOverview.allFlows"))}
              </>
            )}
          </AnalyticsCard>
          <AnalyticsCard
            id="registrations"
            title={t("adminOverview.registrations")}
            range={registrations.range}
            ranges={analysisRanges}
            onRangeChange={registrations.setRange}
            resource={registrations.resource}
          >
            {(data) => (
              <>
                {data.users.length ? data.users.map((person) => personCard(person, true)) : empty}
                <p className="text-xs text-muted-foreground">
                  {t("adminOverview.showing", { shown: data.users.length, total: data.total })}
                </p>
                {canManageUsers && inventoryLink(ROUTES.ADMIN_USERS, t("adminOverview.allUsers"))}
              </>
            )}
          </AnalyticsCard>
        </div>
        <AnalyticsCard
          id="overview"
          title={t("adminOverview.analytics")}
          range={overview.range}
          ranges={analysisRanges}
          onRangeChange={overview.setRange}
          resource={overview.resource}
        >
          {(data) => {
            const chartMaximum = Math.max(1, ...data.overTime.map((point) => point.count));
            return (
              <>
                <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                  {[
                    [t("admin.analytics.cards.totalExecutions"), data.totalExecutions],
                    [t("adminOverview.success"), data.successfulExecutions],
                    [t("admin.analytics.status.completed"), data.completedExecutions],
                    [t("admin.analytics.status.failed"), data.failedExecutions],
                    [t("admin.analytics.status.stopped"), data.stoppedExecutions],
                    [t("admin.analytics.cards.successRate"), `${data.successRate.toFixed(1)}%`],
                    [t("adminOverview.activeOwners"), data.activeUsers],
                    [t("admin.analytics.status.active"), data.activeExecutions],
                  ].map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
                <p className="text-xs text-muted-foreground">
                  {t("admin.analytics.successRateHint")}
                </p>
                {data.completedExecutions === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t("admin.analytics.noCompletions")}
                  </p>
                )}
                <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
                  <span>
                    {t("adminOverview.includedUsers")}: {data.totalUsers}
                  </span>
                  <span>
                    {t("adminOverview.includedFlows")}: {data.totalWorkflows}
                  </span>
                  <span>
                    {t("admin.analytics.table.avgDuration")}:{" "}
                    {Math.round(data.avgDurationMs / 1000)} {t("adminOverview.seconds")}
                  </span>
                </div>
                {data.overTime.length > 0 && (
                  <div>
                    <div
                      className="flex h-24 items-end gap-1"
                      role="img"
                      aria-label={t("admin.analytics.executionsOverTime")}
                      data-testid="executions-chart"
                    >
                      {data.overTime.map((point) => (
                        <div
                          key={point.date}
                          className="min-w-0 flex-1 rounded-t bg-chart-1"
                          style={{
                            height: `${Math.max(3, (point.count / chartMaximum) * 100)}%`,
                          }}
                          data-hint={`${point.date} (UTC): ${point.count}`}
                        />
                      ))}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {data.overTime[0].date} — {data.overTime[data.overTime.length - 1].date} (UTC)
                    </p>
                    <AnalyticsSeriesNotice
                      window={data.overTimeWindow}
                      shown={data.overTime.length}
                    />
                  </div>
                )}
              </>
            );
          }}
        </AnalyticsCard>
      </div>
    </ExecutionStopProvider>
  );
}
