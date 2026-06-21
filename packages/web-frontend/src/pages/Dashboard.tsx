/* eslint-disable no-console */
/**
 * Dashboard Page
 * Overview with stat cards, recent workflows, and recent executions
 *
 * Note: console.error used for browser debugging of API errors
 */

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Workflow, Play, StickyNote } from "lucide-react";
import apiClient from "../services/api-client";
import { ROUTES } from "../constants/routes";
import { QuickStartCard } from "../components/QuickStartCard";
import { PageShell } from "../components/PageShell";
import { StatCard } from "../components/stat-card";
import { EmptyState } from "../components/empty-state";
import { formatRelativeTime } from "../components/cards/format-utils";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { ExecutionCard } from "../components/cards/ExecutionCard";
import { normalizeExecution } from "../components/cards/normalize-execution";

interface DashboardStats {
  workflowsCount: number;
  executionsCount: number;
  notesCount: number;
}

interface RecentWorkflow {
  id: string;
  name: string;
  description?: string;
  visibility: string;
  createdAt?: string;
}

interface RecentExecution {
  id: string;
  workflowId: string;
  workflowName?: string | null;
  note?: string | null;
  status: string;
  startTime: string;
  endTime?: string;
  duration: number | null;
}

interface StatsData {
  stats: DashboardStats;
  recentWorkflows: RecentWorkflow[];
  recentExecutions: RecentExecution[];
}

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<StatsData | null>(null);

  const loadDashboardData = useCallback(async () => {
    try {
      setLoading(true);
      const statsData = await apiClient.getStatsSummary();
      setData(statsData);
      setError(null);
    } catch (err) {
      console.error("Failed to load dashboard data:", err);
      setError(t("pages.dashboard.error"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  if (loading) {
    return <PageShell title={t("pages.dashboard.title")} loading />;
  }

  if (error || !data) {
    return (
      <PageShell
        title={t("pages.dashboard.title")}
        error={error || t("pages.dashboard.failedToLoad")}
        onRetry={loadDashboardData}
        retryLabel={t("pages.dashboard.retry")}
      />
    );
  }

  return (
    <PageShell title={t("pages.dashboard.title")}>
      {/* Quick Start - MCP Configuration */}
      <QuickStartCard />

      {/* Stat Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <StatCard
          label={t("pages.dashboard.stats.totalWorkflows")}
          value={data.stats.workflowsCount}
          icon={Workflow}
          className="cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={() => navigate(ROUTES.WORKFLOWS)}
        />
        <StatCard
          label={t("pages.dashboard.stats.executions")}
          value={data.stats.executionsCount}
          icon={Play}
          className="cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={() => navigate(ROUTES.EXECUTIONS)}
        />
        <StatCard
          label={t("pages.dashboard.stats.notes")}
          value={data.stats.notesCount}
          icon={StickyNote}
          className="cursor-pointer hover:bg-muted/50 transition-colors"
          onClick={() => navigate(ROUTES.NOTES)}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recent Workflows */}
        <Card>
          <CardHeader>
            <CardTitle>{t("pages.dashboard.recentWorkflows.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentWorkflows.length === 0 ? (
              <EmptyState icon={Workflow} title={t("pages.dashboard.recentWorkflows.empty")} />
            ) : (
              <div className="space-y-3">
                {data.recentWorkflows.map((workflow) => (
                  <div
                    key={workflow.id}
                    className="p-3 border border-border rounded-lg hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => navigate(`${ROUTES.WORKFLOWS}/${workflow.id}`)}
                  >
                    <div className="font-medium truncate">{workflow.name}</div>
                    {workflow.description && (
                      <div className="text-sm text-muted-foreground mt-1 line-clamp-2">
                        {workflow.description}
                      </div>
                    )}
                    <div className="flex items-center gap-2 mt-2">
                      <Badge variant="secondary">{workflow.visibility}</Badge>
                      {workflow.createdAt && (
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(workflow.createdAt)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent Executions */}
        <Card>
          <CardHeader>
            <CardTitle>{t("pages.dashboard.recentExecutions.title")}</CardTitle>
          </CardHeader>
          <CardContent>
            {data.recentExecutions.length === 0 ? (
              <EmptyState icon={Play} title={t("pages.dashboard.recentExecutions.empty")} />
            ) : (
              <div className="space-y-2">
                {data.recentExecutions.map((execution) => (
                  <ExecutionCard
                    key={execution.id}
                    execution={normalizeExecution(execution)}
                    compact
                    onClick={() => navigate(`${ROUTES.EXECUTIONS}/${execution.id}`)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  );
};
