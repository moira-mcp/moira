/**
 * Admin Analytics Dashboard
 * Analytics page with visualizations at /admin/analytics
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { apiClient } from "../services/api-client";
import { PageShell } from "../components/PageShell";
import { StatCard } from "../components/stat-card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TopWorkflowsTable } from "../components/TopWorkflowsTable";
import type { TopWorkflow } from "../components/TopWorkflowsTable";

type TimeRange = "today" | "week" | "month" | "year" | "all";

interface OverviewData {
  totalUsers: number;
  totalWorkflows: number;
  totalExecutions: number;
  activeExecutions: number;
  completedExecutions: number;
  failedExecutions: number;
  timeRange: string;
}

interface ExecutionsData {
  total: number;
  completed: number;
  failed: number;
  active: number;
  successRate: number;
  avgDurationMs: number | null;
  overTime: Array<{ date: string; count: number }>;
}

interface UsersData {
  activeUsers: number;
  newUsers: number;
  topUsers: Array<{
    userId: string;
    email: string;
    name: string | null;
    executionCount: number;
    workflowCount: number;
  }>;
}

export const AdminAnalytics: React.FC = () => {
  const { t } = useTranslation();
  const [timeRange, setTimeRange] = useState<TimeRange>("month");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [topWorkflows, setTopWorkflows] = useState<TopWorkflow[]>([]);
  const [executionsData, setExecutionsData] = useState<ExecutionsData | null>(null);
  const [usersData, setUsersData] = useState<UsersData | null>(null);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overviewRes, topWorkflowsRes, executionsRes, usersRes] = await Promise.all([
        apiClient.getAnalyticsOverview(timeRange),
        apiClient.getAnalyticsTopWorkflows(timeRange, 10),
        apiClient.getAnalyticsExecutions(timeRange),
        apiClient.getAnalyticsUsers(timeRange),
      ]);

      setOverview(overviewRes);
      setTopWorkflows(topWorkflowsRes.workflows);
      setExecutionsData(executionsRes);
      setUsersData({
        activeUsers: usersRes.activeUsers,
        newUsers: usersRes.newUsers,
        topUsers: usersRes.topUsers.map((u) => ({
          userId: u.userId,
          email: u.userEmail,
          name: u.userName,
          executionCount: u.executionCount,
          workflowCount: u.workflowCount,
        })),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [timeRange, t]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const formatPercentage = (value: number): string => {
    return `${value.toFixed(1)}%`;
  };

  if (loading) {
    return <PageShell title={t("admin.analytics.title")} loading />;
  }

  if (error) {
    return <PageShell title={t("admin.analytics.title")} error={error} onRetry={loadAnalytics} />;
  }

  return (
    <PageShell title={t("admin.analytics.title")}>
      {/* Header actions */}
      <div className="flex justify-end items-center mb-6">
        <Select value={timeRange} onValueChange={(v) => setTimeRange(v as TimeRange)}>
          <SelectTrigger className="w-[180px]" data-testid="time-range-selector">
            <SelectValue placeholder={t("admin.analytics.selectTimeRange")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">{t("admin.analytics.timeRanges.today")}</SelectItem>
            <SelectItem value="week">{t("admin.analytics.timeRanges.week")}</SelectItem>
            <SelectItem value="month">{t("admin.analytics.timeRanges.month")}</SelectItem>
            <SelectItem value="year">{t("admin.analytics.timeRanges.year")}</SelectItem>
            <SelectItem value="all">{t("admin.analytics.timeRanges.all")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Overview Cards */}
      {overview && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <StatCard
            value={overview.totalExecutions}
            label={t("admin.analytics.cards.totalExecutions")}
          />
          <StatCard
            value={executionsData ? formatPercentage(executionsData.successRate) : "-"}
            label={t("admin.analytics.cards.successRate")}
          />
          <StatCard value={overview.totalUsers} label={t("admin.analytics.cards.activeUsers")} />
          <StatCard
            value={overview.totalWorkflows}
            label={t("admin.analytics.cards.activeWorkflows")}
          />
        </div>
      )}

      {/* Execution Status Breakdown */}
      {overview && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <StatCard
            value={overview.completedExecutions}
            label={t("admin.analytics.status.completed")}
          />
          <StatCard value={overview.activeExecutions} label={t("admin.analytics.status.active")} />
          <StatCard value={overview.failedExecutions} label={t("admin.analytics.status.failed")} />
        </div>
      )}

      {/* Executions Over Time Chart (Simple Bar Visualization) */}
      {executionsData && executionsData.overTime.length > 0 && (
        <div className="bg-card border border-border rounded-lg p-6 shadow-sm mb-8">
          <h2 className="text-xl font-semibold mb-4 text-card-foreground">
            {t("admin.analytics.executionsOverTime")}
          </h2>
          <div className="flex items-end gap-1 h-32" data-testid="executions-chart">
            {(() => {
              const maxCount = Math.max(...executionsData.overTime.map((d) => d.count), 1);
              return executionsData.overTime.slice(-14).map((item, index) => (
                <div
                  key={index}
                  className="flex-1 bg-chart-1 rounded-t hover:bg-primary transition-colors cursor-pointer relative group"
                  style={{ height: `${(item.count / maxCount) * 100}%`, minHeight: "4px" }}
                  title={`${item.date}: ${item.count}`}
                >
                  <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-popover text-popover-foreground text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                    {item.date}: {item.count}
                  </div>
                </div>
              ));
            })()}
          </div>
          <div className="flex justify-between mt-2 text-xs text-muted-foreground">
            <span>
              {executionsData.overTime.length > 0
                ? executionsData.overTime[Math.max(0, executionsData.overTime.length - 14)]?.date
                : ""}
            </span>
            <span>
              {executionsData.overTime.length > 0
                ? executionsData.overTime[executionsData.overTime.length - 1]?.date
                : ""}
            </span>
          </div>
        </div>
      )}

      {/* User Activity Section */}
      {usersData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          {/* User Stats Cards */}
          <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold mb-4 text-card-foreground">
              {t("admin.analytics.userActivity.title")}
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <div data-testid="card-active-users-detailed">
                <div className="text-2xl font-bold text-primary">{usersData.activeUsers}</div>
                <div className="text-sm text-muted-foreground">
                  {t("admin.analytics.userActivity.activeUsers")}
                </div>
              </div>
              <div data-testid="card-new-users">
                <div className="text-2xl font-bold text-success">{usersData.newUsers}</div>
                <div className="text-sm text-muted-foreground">
                  {t("admin.analytics.userActivity.newUsers")}
                </div>
              </div>
            </div>
          </div>

          {/* Top Active Users */}
          <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
            <h2 className="text-xl font-semibold mb-4 text-card-foreground">
              {t("admin.analytics.userActivity.topUsers")}
            </h2>
            {usersData.topUsers.length > 0 ? (
              <div className="space-y-3" data-testid="top-users-list">
                {usersData.topUsers.slice(0, 5).map((user, index) => (
                  <div
                    key={user.userId}
                    className="flex items-center justify-between py-2 border-b border-border last:border-0"
                  >
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-muted-foreground w-6">
                        #{index + 1}
                      </span>
                      <div>
                        <div className="text-sm font-medium text-card-foreground">
                          {user.name || user.email}
                        </div>
                        {user.name && (
                          <div className="text-xs text-muted-foreground">{user.email}</div>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-card-foreground">
                        {user.executionCount}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {t("admin.analytics.userActivity.executions")}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-center py-4">
                {t("admin.analytics.userActivity.noData")}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Top 10 Workflows Table */}
      <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
        <h2 className="text-xl font-semibold mb-4 text-card-foreground">
          {t("admin.analytics.topWorkflows")}
        </h2>
        <TopWorkflowsTable workflows={topWorkflows} />
      </div>
    </PageShell>
  );
};
