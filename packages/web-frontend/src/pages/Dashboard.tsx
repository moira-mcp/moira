/* eslint-disable no-console */
/**
 * Dashboard Page — the home page.
 * Leads with how Moira is meant to be used: connect your agent, describe the task in plain words,
 * and let the agent pick a ready flow or build one — learning flows is optional. Then the agent
 * connection (per-client setup), a prompt to try, the recommended flows, and the overview: stat
 * cards, recent workflows and recent executions.
 *
 * Note: console.error used for browser debugging of API errors
 */

import React, { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Workflow, Play, StickyNote, Plug, MessageSquareText, Route } from "lucide-react";
import apiClient from "../services/api-client";
import { ROUTES } from "../constants/routes";
import { HidePanelButton } from "../components/onboarding/HidePanelButton";
import { usePanelVisible } from "../components/onboarding/beginnerPanels";
import { QuickStartCard } from "../components/QuickStartCard";
import { RecommendedFlows } from "../components/onboarding/RecommendedFlows";
import { PageShell } from "../components/PageShell";
import { StatCard } from "../components/stat-card";
import { EmptyState } from "../components/empty-state";
import { formatRelativeTime } from "../components/cards/format-utils";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { ExecutionCard } from "../components/cards/ExecutionCard";
import { normalizeExecution } from "../components/cards/normalize-execution";

const HOW_IT_WORKS = [
  { key: "connect", icon: Plug },
  { key: "describe", icon: MessageSquareText },
  { key: "agent", icon: Route },
] as const;

/**
 * The three steps of using Moira, agent first, and the note that the rest is optional. A beginner
 * panel: its reader can hide it for good.
 */
function HowItWorks(): React.JSX.Element | null {
  const { t } = useTranslation();
  if (!usePanelVisible("home-intro")) return null;
  return (
    <section
      className="mb-8 rounded-2xl border bg-gradient-to-br from-primary/10 via-card to-card p-6 md:p-8"
      aria-labelledby="home-how-title"
      data-testid="home-how-it-works"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id="home-how-title" className="text-2xl font-semibold tracking-tight">
          {t("pages.dashboard.how.title")}
        </h2>
        <HidePanelButton panel="home-intro" />
      </div>
      <p className="mt-2 max-w-3xl text-muted-foreground">{t("pages.dashboard.how.subtitle")}</p>
      <ol className="mt-6 grid gap-4 md:grid-cols-3" data-testid="home-steps">
        {HOW_IT_WORKS.map(({ key, icon: Icon }, index) => (
          <li
            key={key}
            className="flex flex-col gap-2 rounded-xl border bg-card/80 p-4"
            data-step={key}
          >
            <span className="inline-flex items-center gap-2 text-sm font-semibold">
              <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                {index + 1}
              </span>
              <Icon className="size-4 text-primary" aria-hidden="true" />
              {t(`pages.dashboard.how.steps.${key}.title`)}
            </span>
            <span className="text-sm text-muted-foreground">
              {t(`pages.dashboard.how.steps.${key}.body`)}
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-5 rounded-xl border border-dashed bg-card/60 p-4" data-testid="home-try">
        <p className="text-sm font-medium">{t("pages.dashboard.how.tryTitle")}</p>
        <p className="mt-1 font-mono text-sm text-primary">{t("pages.dashboard.how.tryPrompt")}</p>
      </div>
      <p className="mt-4 text-sm text-muted-foreground" data-testid="home-optional">
        {t("pages.dashboard.how.optional")}
      </p>
    </section>
  );
}

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
      <HowItWorks />

      {/* Step 1 — connect the agent: per-client MCP configuration */}
      <QuickStartCard />

      <RecommendedFlows variant="compact" />

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
          <CardContent data-testid="dashboard-recent-workflows">
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
          <CardContent data-testid="dashboard-recent-executions">
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
