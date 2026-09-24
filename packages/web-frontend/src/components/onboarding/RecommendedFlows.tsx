/**
 * "Recommended for getting started": the learning examples and the universal flows, with what
 * each one does and when to pick it, under the message that matters most to a newcomer — they do
 * not have to choose or build a flow at all: their agent does that from a plain description of the
 * task. The flow list shows the full section (foldable, the fold remembered); the home page shows
 * the compact one. An entry is shown once the catalog confirms its flow exists on this instance.
 */

import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, ChevronDown, GraduationCap, Sparkles, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiClient } from "../../services/api-client";
import { ROUTES } from "../../constants/routes";
import { useStoredFlag } from "../diagram/useStoredFlag";
import { recommendedFlows, SYSTEM_HANDLE, type RecommendedFlow } from "./recommended";

/**
 * One lookup per set of slugs for the life of the page. The section can mount more than once in a
 * visit — the home page and the flow list both show it, and a route re-renders when the session is
 * re-checked — and each mount would otherwise ask the catalog again. A failed lookup is forgotten,
 * so the next mount asks afresh.
 */
const lookups = new Map<string, Promise<Set<string>>>();

function lookUp(slugs: string): Promise<Set<string>> {
  let lookup = lookups.get(slugs);
  if (!lookup) {
    lookup = apiClient
      .getWorkflows({ slugs: slugs.split(","), visibility: "public", limit: 50 })
      .then(
        (response) =>
          new Set(
            response.workflows
              .filter((info) => info.ownerHandle === SYSTEM_HANDLE)
              .map((info) => info.slug),
          ),
      );
    lookup.catch(() => lookups.delete(slugs));
    lookups.set(slugs, lookup);
  }
  return lookup;
}

/** Forget every lookup; for tests that stand up a different catalog. */
export function resetRecommendedLookups(): void {
  lookups.clear();
}

/**
 * The recommended flows of this language that exist here: one list request names their slugs, and
 * only a system-owned match counts.
 */
export function useRecommendedFlows(): { flows: RecommendedFlow[]; loaded: boolean } {
  const { i18n } = useTranslation();
  const wanted = useMemo(() => recommendedFlows(i18n.language), [i18n.language]);
  // The lookup follows the set of slugs, not the language object: a language that settles on a
  // variant of the same language asks nothing again.
  const slugs = wanted.map((flow) => flow.slug).join(",");
  const [present, setPresent] = useState<Set<string> | null>(null);
  useEffect(() => {
    let live = true;
    setPresent(null);
    lookUp(slugs)
      .catch(() => new Set<string>())
      .then((found) => {
        if (live) setPresent(found);
      });
    return () => {
      live = false;
    };
  }, [slugs]);
  return {
    flows: present ? wanted.filter((flow) => present.has(flow.slug)) : [],
    loaded: present !== null,
  };
}

function FlowCard({
  flow,
  compact,
}: {
  flow: RecommendedFlow;
  compact: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const base = `onboarding.${flow.kind === "example" ? "examples" : "universal"}.${flow.key}`;
  return (
    <button
      type="button"
      onClick={() => navigate(`${ROUTES.WORKFLOWS}/${SYSTEM_HANDLE}/${flow.slug}`)}
      className="group flex h-full flex-col gap-2 rounded-xl border bg-card p-4 text-left transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="recommended-flow"
      data-slug={flow.slug}
      data-kind={flow.kind}
    >
      <span className="flex items-center gap-2">
        {flow.level !== null && (
          <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
            {flow.level}
          </span>
        )}
        <span className="font-medium text-foreground">{t(`${base}.title`)}</span>
      </span>
      <span className="text-sm text-muted-foreground">{t(`${base}.description`)}</span>
      {!compact && flow.kind === "universal" && (
        <span className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t("onboarding.whenLabel")}</span>{" "}
          {t(`${base}.when`)}
        </span>
      )}
      <span className="mt-auto inline-flex items-center gap-1 pt-1 text-xs font-medium text-primary">
        {t("onboarding.open")}
        <ArrowRight
          className="size-3.5 transition group-hover:translate-x-0.5"
          aria-hidden="true"
        />
      </span>
    </button>
  );
}

function Group({
  icon: Icon,
  title,
  subtitle,
  flows,
  compact,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  flows: RecommendedFlow[];
  compact: boolean;
  testId: string;
}): React.JSX.Element | null {
  if (flows.length === 0) return null;
  return (
    <div className="space-y-3" data-testid={testId}>
      <div>
        <h3 className="inline-flex items-center gap-2 text-sm font-semibold">
          <Icon className="size-4 text-primary" aria-hidden="true" />
          {title}
        </h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {flows.map((flow) => (
          <FlowCard key={flow.slug} flow={flow} compact={compact} />
        ))}
      </div>
    </div>
  );
}

export function RecommendedFlows({
  variant = "full",
}: {
  /** `full` on the flow list (foldable, with when-to-pick); `compact` on the home page. */
  variant?: "full" | "compact";
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const { flows, loaded } = useRecommendedFlows();
  const [collapsed, toggleCollapsed] = useStoredFlag("moira.workflows.recommendedCollapsed");
  const compact = variant === "compact";
  if (loaded && flows.length === 0) return null;
  const open = compact || !collapsed;
  return (
    <section
      className={cn("rounded-xl border bg-muted/30 p-4 sm:p-5", compact ? "mb-8" : "mb-6")}
      aria-labelledby="recommended-flows-title"
      data-testid="recommended-flows"
      data-state={open ? "open" : "closed"}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="recommended-flows-title" className="inline-flex items-center gap-2 font-semibold">
            <Sparkles className="size-4 text-primary" aria-hidden="true" />
            {t("onboarding.title")}
          </h2>
          {open && (
            <p className="max-w-3xl text-sm text-muted-foreground" data-testid="agent-first-note">
              {t("onboarding.agentFirst")}
            </p>
          )}
        </div>
        {!compact && (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={open}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="recommended-toggle"
          >
            {open ? t("onboarding.hide") : t("onboarding.show")}
            <ChevronDown
              className={cn("size-3.5 transition", open ? "rotate-180" : "rotate-0")}
              aria-hidden="true"
            />
          </button>
        )}
      </div>
      {open && (
        <div className="mt-4 space-y-5">
          <Group
            icon={GraduationCap}
            title={t("onboarding.examplesTitle")}
            subtitle={t("onboarding.examplesSubtitle")}
            flows={flows.filter((flow) => flow.kind === "example")}
            compact={compact}
            testId="recommended-examples"
          />
          <Group
            icon={Wrench}
            title={t("onboarding.universalTitle")}
            subtitle={t("onboarding.universalSubtitle")}
            flows={flows.filter((flow) => flow.kind === "universal")}
            compact={compact}
            testId="recommended-universal"
          />
        </div>
      )}
    </section>
  );
}
