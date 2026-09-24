/**
 * The home page's work area: what a returning user comes back for.
 *
 * - In progress: the runs not finished yet, each with the step it is on, a link to the run and a
 *   ready-to-say prompt that asks the agent to continue it (the agent continues runs, not people).
 * - Recently finished: the runs that ended last.
 * - Your flows: the flows the user runs most, each with a ready-to-say prompt.
 *
 * Every item is the shared list item. A user with no runs gets one empty state that says what will
 * appear here and gives the prompt to start with, instead of three empty sections.
 */

import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Clock, Copy, ExternalLink, GitBranch, MessageSquareText, Play } from "lucide-react";
import type { ActiveWorkRun, TopFlow, WorkSummary } from "../../services/api-client";
import { ROUTES } from "../../constants/routes";
import { CardShell } from "../cards/CardShell";
import { ExecutionCard } from "../cards/ExecutionCard";
import { normalizeExecution } from "../cards/normalize-execution";
import { formatRelativeTime } from "../cards/format-utils";
import { StatusBadge, type ExecutionStatus } from "../status-badge";
import { Badge } from "../ui/badge";
import { promptKey } from "../onboarding/recommended";
import { usePanelVisible } from "../onboarding/beginnerPanels";
import { humanizeVariable } from "../diagram/VariableText";

async function copy(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    // Clipboard access denied; the prompt stays readable on the item
  }
}

function Section({
  title,
  testId,
  empty,
  children,
}: {
  title: string;
  testId: string;
  empty: string;
  children: React.ReactNode[];
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2" data-testid={testId} aria-label={title}>
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {children.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <div>{children}</div>
      )}
    </section>
  );
}

function ActiveRunItem({ run }: { run: ActiveWorkRun }): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // A step with no name to show reads as words made from its id, not as the raw id
  const step =
    run.stepName ??
    (run.stepId
      ? humanizeVariable(run.stepId).replace(/^./, (first) => first.toUpperCase())
      : null);
  const resume = t("pages.dashboard.work.inProgress.resumePrompt", { id: run.executionId });
  const open = () => navigate(`${ROUTES.EXECUTIONS}/${run.executionId}`);
  const needsAttention = run.status === "locked" || run.errorCount > 0;
  return (
    <CardShell
      testId={`work-active-${run.executionId}`}
      onClick={open}
      icon={<Play aria-hidden="true" />}
      title={run.workflowName ?? run.workflowId}
      description={
        step ? (
          <span data-testid="work-active-step">
            {t("pages.dashboard.work.inProgress.atStep", { step })}
          </span>
        ) : undefined
      }
      note={run.note ?? undefined}
      meta={
        <>
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" aria-hidden="true" />
            {formatRelativeTime(run.updatedAt)}
          </span>
          <span className="font-mono">{run.executionId.slice(0, 8)}</span>
        </>
      }
      badges={
        needsAttention ? (
          <>
            {run.errorCount > 0 && (
              <Badge
                variant="outline"
                className="h-5 px-1.5 text-[11px] border-destructive/30 text-destructive"
              >
                {run.errorCount} {t("common.errorsLabel", { defaultValue: "errors" })}
              </Badge>
            )}
            {run.status === "locked" && (
              <StatusBadge
                status={run.status as ExecutionStatus}
                className="h-5 px-1.5 text-[11px]"
              />
            )}
          </>
        ) : undefined
      }
      actions={[
        {
          icon: <Copy className="h-3.5 w-3.5" />,
          label: t("pages.dashboard.work.inProgress.copyResume"),
          onClick: () => void copy(resume, t("pages.dashboard.work.copied")),
          testId: `work-resume-${run.executionId}`,
        },
        {
          icon: <ExternalLink className="h-3.5 w-3.5" />,
          label: t("pages.dashboard.work.inProgress.open"),
          onClick: open,
          testId: `work-open-${run.executionId}`,
        },
      ]}
    />
  );
}

function TopFlowItem({ flow }: { flow: TopFlow }): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const authored = promptKey(flow.ownerHandle, flow.slug);
  const prompt = authored
    ? t(authored)
    : t("pages.dashboard.work.flows.prompt", { name: flow.name });
  const open = () =>
    navigate(
      flow.ownerHandle
        ? `${ROUTES.WORKFLOWS}/${flow.ownerHandle}/${flow.slug}`
        : `${ROUTES.WORKFLOWS}/${flow.id}`,
    );
  return (
    <CardShell
      testId={`work-flow-${flow.id}`}
      onClick={open}
      icon={<GitBranch aria-hidden="true" />}
      title={flow.name}
      description={flow.description ?? undefined}
      note={
        <span className="inline-flex items-start gap-1.5" data-testid="work-flow-prompt">
          <MessageSquareText className="mt-0.5 size-3 shrink-0 text-primary" aria-hidden="true" />
          <span className="font-mono text-primary">{prompt}</span>
        </span>
      }
      meta={
        <>
          <span>{t("pages.dashboard.work.flows.runs", { count: flow.runs })}</span>
          <span>
            {t("pages.dashboard.work.flows.lastRun", { when: formatRelativeTime(flow.lastRunAt) })}
          </span>
        </>
      }
      actions={[
        {
          icon: <Copy className="h-3.5 w-3.5" />,
          label: t("pages.dashboard.work.flows.copyPrompt"),
          onClick: () => void copy(prompt, t("pages.dashboard.work.copied")),
          testId: `work-flow-copy-${flow.id}`,
        },
      ]}
    />
  );
}

/**
 * The first-time state: what will appear here and the prompt to start with. It points to the
 * recommended flows above while that panel is shown, and to the flow list once the reader hid it.
 */
function WorkEmpty(): React.JSX.Element {
  const { t } = useTranslation();
  const recommendedShown = usePanelVisible("home-recommended");
  return (
    <div className="rounded-xl border border-dashed p-6" data-testid="work-empty">
      <p className="font-medium">{t("pages.dashboard.work.empty.title")}</p>
      <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
        {t("pages.dashboard.work.empty.body")}
      </p>
      <p className="mt-3 font-mono text-sm text-primary">{t("pages.dashboard.how.tryPrompt")}</p>
      <p className="mt-3 text-sm text-muted-foreground" data-testid="work-empty-next">
        {recommendedShown ? (
          t("pages.dashboard.work.empty.recommended")
        ) : (
          <Link to={ROUTES.WORKFLOWS} className="text-primary underline-offset-4 hover:underline">
            {t("pages.dashboard.work.empty.browse")}
          </Link>
        )}
      </p>
    </div>
  );
}

export function WorkArea({ summary }: { summary: WorkSummary }): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const hasRuns =
    summary.activeRuns.length > 0 || summary.recentRuns.length > 0 || summary.topFlows.length > 0;
  return (
    <section className="mt-2" aria-labelledby="work-title" data-testid="work-area">
      <h2 id="work-title" className="mb-4 text-lg font-semibold tracking-tight">
        {t("pages.dashboard.work.title")}
      </h2>
      {!hasRuns ? (
        <WorkEmpty />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-6">
            <Section
              title={t("pages.dashboard.work.inProgress.title")}
              testId="work-in-progress"
              empty={t("pages.dashboard.work.inProgress.empty")}
            >
              {summary.activeRuns.map((run) => (
                <ActiveRunItem key={run.executionId} run={run} />
              ))}
            </Section>
            <Section
              title={t("pages.dashboard.work.recent.title")}
              testId="work-recent"
              empty={t("pages.dashboard.work.recent.empty")}
            >
              {summary.recentRuns.map((run) => (
                <ExecutionCard
                  key={run.executionId}
                  execution={normalizeExecution({ ...run, note: run.note ?? undefined })}
                  onClick={() => navigate(`${ROUTES.EXECUTIONS}/${run.executionId}`)}
                />
              ))}
            </Section>
          </div>
          <Section
            title={t("pages.dashboard.work.flows.title")}
            testId="work-flows"
            empty={t("pages.dashboard.work.flows.empty")}
          >
            {summary.topFlows.map((flow) => (
              <TopFlowItem key={flow.id} flow={flow} />
            ))}
          </Section>
        </div>
      )}
    </section>
  );
}
