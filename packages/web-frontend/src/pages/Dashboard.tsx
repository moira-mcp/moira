/* eslint-disable no-console */
/**
 * Dashboard Page — the home page.
 * Leads with how Moira is meant to be used: connect your agent, describe the task in plain words,
 * and let the agent pick a ready flow or build one — learning flows is optional. Then the agent
 * connection (per-client setup), a prompt to try, the recommended flows, and the work area: the
 * runs in progress with their step, the latest runs and the flows the user runs most.
 *
 * Note: console.error used for browser debugging of API errors
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Plug, MessageSquareText, Route } from "lucide-react";
import apiClient, { type WorkSummary } from "../services/api-client";
import { HidePanelButton } from "../components/onboarding/HidePanelButton";
import { usePanelVisible } from "../components/onboarding/beginnerPanels";
import { QuickStartCard } from "../components/QuickStartCard";
import { RecommendedFlows } from "../components/onboarding/RecommendedFlows";
import { PageShell } from "../components/PageShell";
import { WorkArea } from "../components/home/WorkArea";

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

export const Dashboard: React.FC = () => {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<WorkSummary | null>(null);

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

      <WorkArea summary={data} />
    </PageShell>
  );
};
