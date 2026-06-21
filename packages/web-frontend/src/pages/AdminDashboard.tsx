/**
 * Admin Dashboard
 * Unified overview page at /admin with system stats, analytics, and quick links
 */

import React, { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { apiClient } from "../services/api-client";
import { PageShell } from "../components/PageShell";
import { ROUTES } from "../constants/routes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TopWorkflowsTable } from "../components/TopWorkflowsTable";
import type { TopWorkflow } from "../components/TopWorkflowsTable";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LogOut } from "lucide-react";
import { StatCard } from "../components/stat-card";

type TimeRange = "today" | "week" | "month" | "year" | "all";

interface ActivityItem {
  id: string;
  workflowId: string;
  status: string;
  timestamp: number;
  action: string;
}

interface SystemStats {
  totalWorkflows: number;
  totalExecutions: number;
  totalDefinitions: number;
  activeExecutions: number;
  systemHealth?: {
    backendStatus: string;
    databaseSize: number;
  };
  recentActivity?: ActivityItem[];
}

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

const formatPercentage = (value: number): string => `${value.toFixed(1)}%`;

const statusBadgeClass = (status: string): string => {
  if (status === "completed") return "border-transparent bg-success text-success-foreground";
  if (status === "failed") return "border-transparent bg-destructive text-destructive-foreground";
  return "border-transparent bg-info text-info-foreground";
};

export const AdminDashboard: React.FC = () => {
  const { t } = useTranslation();
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [logoutAllDialogOpen, setLogoutAllDialogOpen] = useState(false);
  const [logoutAllResult, setLogoutAllResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);

  const [timeRange, setTimeRange] = useState<TimeRange>("month");
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [topWorkflows, setTopWorkflows] = useState<TopWorkflow[]>([]);
  const [executionsData, setExecutionsData] = useState<ExecutionsData | null>(null);
  const [usersData, setUsersData] = useState<UsersData | null>(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(true);

  const loadStats = useCallback(async () => {
    setLoading(true);
    try {
      const statsData = await apiClient.getAdminStats();
      setStats(statsData);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
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
    } catch {
      // Analytics failure is non-blocking; system stats still shown
    } finally {
      setAnalyticsLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const handleLogoutAll = async () => {
    setLogoutAllResult(null);
    try {
      const result = await apiClient.logoutAllUsers();
      setLogoutAllResult({ success: true, message: result.message });
    } catch (err) {
      const message = err instanceof Error ? err.message : t("common.errors.actionFailed");
      setLogoutAllResult({ success: false, message });
    }
  };

  if (loading) {
    return <PageShell title={t("admin.dashboard.title")} loading />;
  }

  if (error || !stats) {
    return (
      <PageShell
        title={t("admin.dashboard.title")}
        error={error || t("admin.dashboard.failedToLoad")}
        onRetry={loadStats}
      />
    );
  }

  return (
    <PageShell title={t("admin.dashboard.title")}>
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

      {/* System Statistics Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
        <StatCard value={stats.totalWorkflows} label={t("admin.dashboard.stats.totalWorkflows")} />
        <StatCard
          value={stats.totalExecutions}
          label={t("admin.dashboard.stats.totalExecutions")}
        />
        <StatCard
          value={stats.activeExecutions}
          label={t("admin.dashboard.stats.activeExecutions")}
        />
        <StatCard
          value={stats.totalDefinitions}
          label={t("admin.dashboard.stats.settingDefinitions")}
        />
      </div>

      {/* Analytics Overview Cards */}
      {!analyticsLoading && overview && (
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
      {!analyticsLoading && overview && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <StatCard
            value={overview.completedExecutions}
            label={t("admin.analytics.status.completed")}
          />
          <StatCard value={overview.activeExecutions} label={t("admin.analytics.status.active")} />
          <StatCard value={overview.failedExecutions} label={t("admin.analytics.status.failed")} />
        </div>
      )}

      {/* System Health */}
      {stats.systemHealth && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">
                {t("admin.dashboard.systemHealth.backendStatus")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-full bg-success"></span>
                <span className="text-muted-foreground capitalize">
                  {stats.systemHealth.backendStatus}
                </span>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">
                {t("admin.dashboard.systemHealth.databaseSize")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-foreground">
                {(stats.systemHealth.databaseSize / 1024 / 1024).toFixed(2)} {t("common.units.mb")}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">{t("admin.dashboard.logoutAll.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <Button variant="destructive" size="sm" onClick={() => setLogoutAllDialogOpen(true)}>
                <LogOut className="h-4 w-4 mr-2" />
                {t("admin.dashboard.logoutAll.button")}
              </Button>
              <ConfirmDialog
                open={logoutAllDialogOpen}
                onOpenChange={setLogoutAllDialogOpen}
                title={t("admin.dashboard.logoutAll.confirmTitle")}
                description={t("admin.dashboard.logoutAll.confirmDescription")}
                confirmLabel={t("admin.dashboard.logoutAll.confirm")}
                cancelLabel={t("auth.CANCEL")}
                variant="destructive"
                onConfirm={handleLogoutAll}
              />
              {logoutAllResult && (
                <p
                  className={`mt-2 text-sm ${logoutAllResult.success ? "text-success" : "text-destructive"}`}
                >
                  {logoutAllResult.message}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Executions Over Time Chart */}
      {!analyticsLoading && executionsData && executionsData.overTime.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>{t("admin.analytics.executionsOverTime")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-1 h-32" data-testid="executions-chart">
              {(() => {
                const maxCount = Math.max(...executionsData.overTime.map((d) => d.count), 1);
                return executionsData.overTime.slice(-14).map((item, index) => (
                  <div
                    key={index}
                    className="flex-1 bg-chart-1 rounded-t hover:bg-chart-1/80 transition-colors cursor-pointer relative group"
                    style={{ height: `${(item.count / maxCount) * 100}%`, minHeight: "4px" }}
                    title={`${item.date}: ${item.count}`}
                  >
                    <div className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 bg-popover text-popover-foreground text-xs px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none shadow">
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
          </CardContent>
        </Card>
      )}

      {/* User Activity Section */}
      {!analyticsLoading && usersData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
          <Card>
            <CardHeader>
              <CardTitle>{t("admin.analytics.userActivity.title")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-4">
                <div data-testid="card-active-users-detailed">
                  <div className="text-2xl font-bold text-info">{usersData.activeUsers}</div>
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
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("admin.analytics.userActivity.topUsers")}</CardTitle>
            </CardHeader>
            <CardContent>
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
                          <div className="text-sm font-medium text-foreground">
                            {user.name || user.email}
                          </div>
                          {user.name && (
                            <div className="text-xs text-muted-foreground">{user.email}</div>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-foreground">
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
            </CardContent>
          </Card>
        </div>
      )}

      {/* Top 10 Workflows Table */}
      {!analyticsLoading && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>{t("admin.analytics.topWorkflows")}</CardTitle>
          </CardHeader>
          <CardContent>
            <TopWorkflowsTable workflows={topWorkflows} />
          </CardContent>
        </Card>
      )}

      {/* Recent Activity */}
      {stats.recentActivity && stats.recentActivity.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>{t("admin.dashboard.recentActivity.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {stats.recentActivity.map((activity) => (
                <div
                  key={activity.id}
                  className="flex items-start gap-3 p-3 border-b border-border last:border-0"
                >
                  <div className="flex-1">
                    <div className="text-sm text-foreground">{activity.action}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {t("admin.dashboard.recentActivity.workflow")}: {activity.workflowId} •{" "}
                      {new Date(activity.timestamp).toLocaleString()}
                    </div>
                  </div>
                  <Badge className={statusBadgeClass(activity.status)}>
                    {t(`common.status.${activity.status}`)}
                  </Badge>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Links */}
      <Card>
        <CardHeader>
          <CardTitle>{t("admin.dashboard.quickLinks.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(
              [
                { to: ROUTES.ADMIN_USERS, icon: "👥", key: "userManagement" },
                { to: ROUTES.ADMIN_DELETED_WORKFLOWS, icon: "🗑️", key: "deletedWorkflows" },
                { to: ROUTES.ADMIN_SETTINGS, icon: "⚙️", key: "systemSettings" },
                { to: ROUTES.ADMIN_EXECUTIONS, icon: "🔄", key: "allExecutions" },
              ] as const
            ).map(({ to, icon, key }) => (
              <Link
                key={key}
                to={to}
                className="flex items-center gap-3 p-4 border border-border rounded-lg hover:bg-muted transition-colors"
              >
                <div className="text-2xl">{icon}</div>
                <div>
                  <div className="font-medium text-foreground">
                    {t(`admin.dashboard.quickLinks.${key}`)}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {t(`admin.dashboard.quickLinks.${key}Desc`)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </PageShell>
  );
};
