/**
 * Everything about one run of the overview, in a modal side panel: the chain of parent runs, what
 * the person is waited for (the question and its choices, "answer the agent in the chat", whether
 * they were notified), the current step, refusals, the whole plan and every stage (from the run's
 * progress), the child runs, the dates and the note, and a link to the run page. Whatever a card
 * shows only in a hint is here in full. Esc closes the panel and focus returns to where it was.
 */

import React, { useCallback, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { getReadIdentity, subscribeReadScope } from "../../services/read-scope";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, Circle, CircleDot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { ROUTES } from "../../constants/routes";
import { useResource } from "../../hooks/useResource";
import { apiClient, type OverviewRun } from "../../services/api-client";
import { BlockListCard } from "../run/BlockListCard";
import { currentBlockId, runBlocks, type RunBlock } from "../run/model";
import { waitingNotificationText } from "../execution/waitingNotification";
import { STATUS_DOT, StatusLabel } from "./OverviewCard";
import { activityOf, isStale } from "./model";
import { agoText, dateText, daysIn } from "./format";

export interface OverviewPanelProps {
  /** The run shown, or null when the panel is closed. */
  runId: string | null;
  /** The run's row when it is on the page; fetched by id otherwise. */
  run: OverviewRun | null;
  /** Its parent runs on the page, root first. */
  ancestors: OverviewRun[];
  now: number;
  /** Changes whenever the live connection reports a change; a row fetched by id is fetched again. */
  refreshKey?: number | null;
  onOpen: (executionId: string) => void;
  onClose: () => void;
}

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <section className="grid gap-2" data-testid={testId}>
      <h3 className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function StageList({
  blocks,
  stopped,
}: {
  blocks: RunBlock[];
  stopped: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <ol className="grid gap-1 text-sm" data-testid="overview-panel-stages">
      {blocks.map((block) => {
        const done = block.status === "done" || block.status === "repeated";
        const active = !stopped && (block.status === "active" || block.status === "waiting");
        return (
          <li
            key={block.id}
            className={cn("flex items-start gap-2", active && "font-semibold")}
            data-status={block.status}
          >
            {done ? (
              <Check className="mt-0.5 h-3.5 w-3.5 flex-none text-primary" aria-hidden="true" />
            ) : active ? (
              <CircleDot className="mt-0.5 h-3.5 w-3.5 flex-none text-primary" aria-hidden="true" />
            ) : (
              <Circle
                className="mt-0.5 h-3.5 w-3.5 flex-none text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <span className={cn(done && "text-muted-foreground")}>{block.name}</span>
            {active ? <span className="sr-only">{t("pages.overview.card.current")}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function PanelBody({
  run,
  ancestors,
  now,
  onOpen,
}: {
  run: OverviewRun;
  ancestors: OverviewRun[];
  now: number;
  onOpen: (id: string) => void;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const progress = useResource(
    `${run.executionId}@${run.lastActivityAt ?? 0}`,
    useCallback(() => apiClient.getExecutionProgress(run.executionId), [run.executionId]),
  );
  const blocks = progress.data ? runBlocks(progress.data) : [];
  const currentId = currentBlockId(blocks);
  const current = blocks.find((block) => block.id === currentId) ?? null;
  const listBlock = current?.list ? current : (blocks.find((block) => block.list) ?? null);
  const waiting = run.status === "waiting-user" ? run.waitingForUser : null;
  const unfinished = run.status !== "completed" && run.status !== "stopped";
  const since = activityOf(run);
  return (
    <div className="grid gap-5 px-4 pb-4">
      {run.status === "stopped" ? (
        <Section title={t("pages.overview.panel.stopReason")} testId="overview-panel-stop-reason">
          <p className="whitespace-pre-wrap break-words rounded-lg bg-secondary p-3 text-sm">
            {run.stopReason ?? t("pages.overview.runStatusHint.stopped")}
          </p>
        </Section>
      ) : null}
      {run.note && run.note !== run.title ? (
        <div
          className="rounded-md bg-secondary px-2.5 py-2 text-sm"
          data-testid="overview-panel-note"
        >
          <span className="sr-only">{t("pages.overview.panel.note")}: </span>
          {run.note}
        </div>
      ) : null}
      {isStale(run, now) ? (
        <div className="rounded-md bg-warning/15 px-2.5 py-2 text-sm text-foreground" role="note">
          {t("pages.overview.panel.stale", { days: daysIn(now - since) })}
        </div>
      ) : null}
      {waiting ? (
        <div
          className="grid gap-2.5 rounded-lg border border-your-move/40 bg-your-move/5 p-3"
          role="group"
          aria-label={
            waiting.source === "agent"
              ? t("pages.overview.panel.agentTitle")
              : t("pages.overview.panel.gateTitle", { label: waiting.label })
          }
          data-testid="overview-panel-waiting"
          data-source={waiting.source}
        >
          <div className="font-semibold text-your-move">
            {waiting.source === "agent"
              ? t("pages.overview.panel.agentTitle")
              : t("pages.overview.panel.gateTitle", { label: waiting.label })}
          </div>
          {waiting.source === "agent" ? (
            <>
              <p className="text-sm">{waiting.question}</p>
              {waiting.options.length > 0 ? (
                <ul
                  className="list-disc pl-5 text-sm"
                  aria-label={t("pages.overview.panel.options")}
                  data-testid="overview-panel-options"
                >
                  {waiting.options.map((option) => (
                    <li key={option}>{option}</li>
                  ))}
                </ul>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {t("pages.overview.panel.agentSince", { ago: agoText(now - waiting.since, t) })}
              </p>
            </>
          ) : run.current?.directiveShownAt != null ? (
            <p className="text-xs text-muted-foreground">
              {t("pages.overview.panel.gateSince", {
                ago: agoText(now - run.current.directiveShownAt, t),
              })}
            </p>
          ) : null}
          <p className="text-sm font-semibold">{t("pages.overview.panel.answerInChat")}</p>
          <p className="text-xs text-muted-foreground">{t("pages.overview.panel.clearsItself")}</p>
          {waiting.notification ? (
            <p className="text-xs text-muted-foreground" data-testid="overview-panel-notification">
              {waitingNotificationText(waiting.notification, t, now)}
            </p>
          ) : null}
        </div>
      ) : null}
      {unfinished ? (
        <Section title={t("pages.overview.panel.now")}>
          <div className="text-sm" data-testid="overview-panel-step">
            {run.current?.stepName ?? t("pages.overview.panel.noStep")}
          </div>
          <div className="text-xs text-muted-foreground">
            {run.current?.directiveShownAt != null
              ? t("pages.overview.card.shown", {
                  ago: agoText(now - run.current.directiveShownAt, t),
                })
              : t("pages.overview.card.shownUnknown")}
          </div>
        </Section>
      ) : null}
      {run.refusalCount > 0 ? (
        <Section title={t("pages.overview.panel.refusals", { count: run.refusalCount })}>
          <p className="text-xs text-muted-foreground">
            {t("pages.overview.panel.refusalsText", { count: run.refusalCount })}
          </p>
        </Section>
      ) : null}
      {progress.pending && !progress.data ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t("pages.overview.panel.progressLoading")}
        </p>
      ) : progress.error && !progress.data ? (
        <p className="text-xs text-destructive" role="status">
          {t("pages.overview.panel.progressError")}
        </p>
      ) : null}
      {listBlock ? (
        <Section
          title={`${t("pages.overview.panel.list")} · ${listBlock.name}`}
          testId="overview-panel-list"
        >
          <BlockListCard block={listBlock} />
        </Section>
      ) : null}
      {blocks.length > 0 ? (
        <Section title={t("pages.overview.panel.stages")}>
          <StageList blocks={blocks} stopped={run.status === "stopped"} />
        </Section>
      ) : null}
      {run.childRuns.length > 0 ? (
        <Section
          title={t("pages.overview.panel.children", { count: run.childRuns.length })}
          testId="overview-panel-children"
        >
          <ul className="grid gap-1">
            {run.childRuns.map((child) => (
              <li key={child.executionId}>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start gap-2 px-1 py-1 text-left text-sm font-normal"
                  onClick={() => onOpen(child.executionId)}
                >
                  <span
                    className={cn("h-2 w-2 flex-none rounded-full", STATUS_DOT[child.status])}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{child.title}</span>
                  <span className="flex-none text-xs text-muted-foreground">
                    {t(`pages.overview.runStatus.${child.status}`)}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title={t("pages.overview.panel.facts")}>
        <dl
          className="grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1 text-sm"
          data-testid="overview-panel-facts"
        >
          <dt className="text-muted-foreground">{t("pages.overview.panel.flow")}</dt>
          <dd className="min-w-0 break-words">
            {run.workflowName ?? "—"}
            {run.workflowVersion ? ` ${run.workflowVersion}` : ""}
          </dd>
          <dt className="text-muted-foreground">{t("pages.overview.panel.started")}</dt>
          <dd>{dateText(run.createdAt, i18n.language)}</dd>
          <dt className="text-muted-foreground">{t("pages.overview.panel.lastStep")}</dt>
          <dd>{dateText(run.lastActivityAt, i18n.language)}</dd>
          {run.subtreeActivityAt !== null &&
          run.lastActivityAt !== null &&
          run.subtreeActivityAt > run.lastActivityAt ? (
            <>
              <dt className="text-muted-foreground">{t("pages.overview.panel.inChildren")}</dt>
              <dd>{dateText(run.subtreeActivityAt, i18n.language)}</dd>
            </>
          ) : null}
          {run.completedAt !== null ? (
            <>
              <dt className="text-muted-foreground">
                {t(
                  run.status === "stopped"
                    ? "pages.overview.panel.stoppedAt"
                    : "pages.overview.panel.completedAt",
                )}
              </dt>
              <dd>{dateText(run.completedAt, i18n.language)}</dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{t("pages.overview.panel.id")}</dt>
          <dd className="min-w-0 break-all font-mono text-xs">{run.executionId}</dd>
        </dl>
      </Section>
      {ancestors.length === 0 && run.parent ? (
        <Button
          type="button"
          variant="link"
          className="h-auto justify-start p-0 text-sm"
          onClick={() => onOpen(run.parent!.executionId)}
        >
          {t("pages.overview.card.childOf", { title: run.parent.title })}
        </Button>
      ) : null}
    </div>
  );
}

export function OverviewPanel({
  runId,
  run,
  ancestors,
  now,
  refreshKey = null,
  onOpen,
  onClose,
}: OverviewPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const identity = useSyncExternalStore(subscribeReadScope, getReadIdentity, getReadIdentity);
  // The panel opens from a card's title without a dialog trigger, so it remembers what had focus
  // when it opened and gives focus back there when it closes.
  const returnFocus = useRef<HTMLElement | null>(null);
  const isOpen = runId !== null && identity !== null;
  useLayoutEffect(() => {
    if (isOpen && document.activeElement instanceof HTMLElement) {
      returnFocus.current = document.activeElement;
    }
  }, [isOpen]);
  // A run opened by a link, or one a live refetch took off the page, is fetched by id — again
  // whenever the live connection reports a change — and until then the panel keeps the row it had.
  const lastRow = useRef<OverviewRun | null>(null);
  if (run) lastRow.current = run;
  else if (lastRow.current?.executionId !== runId) lastRow.current = null;
  const fetched = useResource(
    runId !== null && run === null ? `${runId}#${refreshKey ?? 0}` : null,
    useCallback(
      async (key: string) =>
        (await apiClient.getOverviewRows([key.slice(0, key.lastIndexOf("#"))]))[0] ?? null,
      [],
    ),
  );
  const fetchedRow = fetched.data?.executionId === runId ? fetched.data : null;
  const shown = run ?? fetchedRow ?? lastRow.current;
  return (
    <Sheet open={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
      <SheetContent
        side="right"
        className="w-full gap-0 p-0 sm:max-w-[460px]"
        data-testid="overview-panel"
        aria-describedby={undefined}
        closeLabel={t("pages.overview.panel.close")}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus.current?.isConnected) returnFocus.current.focus();
          returnFocus.current = null;
        }}
      >
        <SheetHeader className="gap-2 border-b border-border pr-12">
          {ancestors.length > 0 ? (
            <nav
              className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground"
              aria-label={t("pages.overview.panel.parents")}
              data-testid="overview-panel-parents"
            >
              {ancestors.map((ancestor) => (
                <React.Fragment key={ancestor.executionId}>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto max-w-[220px] truncate p-0 text-[12.5px]"
                    onClick={() => onOpen(ancestor.executionId)}
                  >
                    {ancestor.title}
                  </Button>
                  <span aria-hidden="true">›</span>
                </React.Fragment>
              ))}
              <span>{t("pages.overview.panel.thisRun")}</span>
            </nav>
          ) : null}
          <SheetTitle className="text-lg leading-snug" data-testid="overview-panel-title">
            {shown?.title ?? (fetched.pending ? "…" : t("pages.overview.panel.notFound"))}
          </SheetTitle>
          {shown ? (
            <SheetDescription asChild>
              <div className="flex items-center gap-2 text-[12.5px]">
                <StatusLabel status={shown.status} withHint={false} />
                <span className="truncate text-muted-foreground">{shown.workflowName ?? ""}</span>
              </div>
            </SheetDescription>
          ) : null}
          {shown ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="overview-panel-status-meaning"
            >
              {t(`pages.overview.runStatusHint.${shown.status}`)}
              {shown.matches ? null : ` ${t("pages.overview.card.muted")}.`}
            </p>
          ) : null}
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="pt-4">
            {shown ? (
              <PanelBody run={shown} ancestors={ancestors} now={now} onOpen={onOpen} />
            ) : null}
          </div>
        </ScrollArea>
        {shown ? (
          <SheetFooter className="flex-row justify-end border-t border-border">
            <Button asChild>
              <Link
                to={`${ROUTES.EXECUTIONS}/${encodeURIComponent(shown.executionId)}`}
                data-testid="overview-panel-open-run"
              >
                {t("pages.overview.panel.open")}
              </Link>
            </Button>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
