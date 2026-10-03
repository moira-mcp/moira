/**
 * Everything about one run of the overview, in a spacious modal: the chain of parent runs, what
 * the person is waited for (the question and its choices, "answer the agent in the chat", whether
 * they were notified), the current step, refusals, the whole plan and every stage (from the run's
 * progress), the child runs, the dates and the note, and a link to the run page. Whatever a card
 * shows only in a hint is here in full. Esc closes the panel and focus returns to where it was.
 */

import React, { useCallback, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getReadIdentity, subscribeReadScope } from "../../services/read-scope";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Check, Circle, CircleDot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { ExecutionStopButton } from "../execution/ExecutionStop";

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
            <span
              className={cn(
                "min-w-0 flex-1 [overflow-wrap:anywhere]",
                done && "text-muted-foreground",
              )}
            >
              {block.name}{" "}
              <span className="text-xs text-muted-foreground">
                {t(
                  stopped && (block.status === "active" || block.status === "waiting")
                    ? "pages.runPage.stoppedHere"
                    : `pages.runPage.status.${block.status}`,
                )}
              </span>
            </span>
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
  const lifetime = useMemo(() => ({ executionId: run.executionId }), [run.executionId]);
  const progress = useResource(
    `${run.executionId}@${run.lastActivityAt ?? 0}`,
    useCallback(
      async () => ({
        lifetime,
        executionId: run.executionId,
        value: await apiClient.getExecutionProgress(run.executionId),
      }),
      [lifetime, run.executionId],
    ),
  );
  const held =
    progress.data?.lifetime === lifetime && progress.data.executionId === run.executionId
      ? progress.data.value
      : undefined;
  const stopped = run.status === "stopped" || held?.stopReason != null;
  const blocks = held?.source === "trace" ? runBlocks(held, undefined, stopped) : [];
  const currentId = currentBlockId(blocks);
  // An intentionally stopped frontier can still own the partial list, without being current work.
  const current =
    blocks.find((block) => block.id === currentId) ??
    (stopped
      ? blocks.find((block) => block.status === "active" || block.status === "waiting")
      : null) ??
    null;
  const listBlock = current?.list ? current : (blocks.find((block) => block.list) ?? null);
  const waiting = run.status === "waiting-user" ? run.waitingForUser : null;
  const unfinished = run.status !== "completed" && run.status !== "stopped";
  const since = activityOf(run);
  return (
    <div className="grid min-w-0 gap-5 px-5 pb-5 [overflow-wrap:anywhere]">
      {run.status === "stopped" ? (
        <Section title={t("pages.overview.panel.stopReason")} testId="overview-panel-stop-reason">
          <p className="whitespace-pre-wrap break-words rounded-lg bg-secondary p-3 text-sm">
            {run.stopReason ?? t("pages.overview.runStatusHint.stopped")}
          </p>
        </Section>
      ) : null}
      {run.note ? (
        <div
          className="whitespace-pre-wrap rounded-md bg-secondary px-2.5 py-2 text-sm"
          data-testid="overview-panel-note"
        >
          <span className="sr-only">{t("pages.overview.panel.note")}: </span>
          {run.note}
        </div>
      ) : null}
      {since !== null && isStale(run, now) ? (
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
      {progress.pending && held === undefined ? (
        <p className="text-xs text-muted-foreground" role="status">
          {t("pages.overview.panel.progressLoading")}
        </p>
      ) : progress.error && held === undefined ? (
        <p className="text-xs text-destructive" role="status">
          {t("pages.overview.panel.progressError")}
        </p>
      ) : null}
      {listBlock ? (
        <Section
          title={`${t("pages.overview.panel.list")} · ${listBlock.name}`}
          testId="overview-panel-list"
        >
          <BlockListCard block={listBlock} stopped={stopped} />
        </Section>
      ) : null}
      {blocks.length > 0 ? (
        <Section title={t("pages.overview.panel.stages")}>
          <StageList blocks={blocks} stopped={stopped} />
        </Section>
      ) : null}
      {run.childrenTotal.total > 0 || run.childRuns.length > 0 ? (
        <Section
          title={t("pages.overview.panel.children", { count: run.childRuns.length })}
          testId="overview-panel-children"
        >
          <p className="text-xs text-muted-foreground">
            {t("pages.overview.card.childrenFlag", {
              shown: run.childRuns.length,
              total: run.childrenTotal.total,
              unfinished: run.childrenTotal.unfinished,
            })}
          </p>
          <ul className="grid gap-1">
            {run.childRuns.map((child) => (
              <li key={child.executionId} className="flex min-w-0 items-start gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  className="grid h-auto min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] justify-start gap-1 whitespace-normal px-1 py-1 text-left text-sm font-normal"
                  onClick={() => onOpen(child.executionId)}
                >
                  <span
                    className={cn("mt-1 h-2 w-2 self-start rounded-full", STATUS_DOT[child.status])}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    {child.title}
                    <span className="block text-xs text-muted-foreground">
                      {child.workflowName}
                    </span>
                  </span>
                  <span className="col-start-2 text-xs text-muted-foreground">
                    {t(`pages.overview.runStatus.${child.status}`)}
                  </span>
                </Button>
                <ExecutionStopButton target={child} />
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
          className="h-auto min-w-0 max-w-full justify-start whitespace-normal p-0 text-left text-sm [overflow-wrap:anywhere]"
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
  const lifetime = useMemo(() => ({ runId, identity }), [runId, identity]);
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
  const lastLifetime = useRef(lifetime);
  if (lastLifetime.current !== lifetime) {
    lastLifetime.current = lifetime;
    lastRow.current = null;
  }
  const currentRun = isOpen && run?.executionId === runId ? run : null;
  if (currentRun) lastRow.current = currentRun;
  else if (lastRow.current?.executionId !== runId) lastRow.current = null;
  const fetched = useResource(
    isOpen && currentRun === null ? `${runId}#${refreshKey ?? 0}` : null,
    useCallback(
      async (key: string) => ({
        lifetime,
        row: (await apiClient.getOverviewRows([key.slice(0, key.lastIndexOf("#"))]))[0] ?? null,
      }),
      [lifetime],
    ),
  );
  const fetchedRow =
    fetched.data?.lifetime === lifetime && fetched.data.row?.executionId === runId
      ? fetched.data.row
      : null;
  const shown = isOpen ? (currentRun ?? fetchedRow ?? lastRow.current) : null;
  return (
    <Dialog open={isOpen} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] min-w-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        data-testid="overview-panel"
        aria-describedby={undefined}
        closeLabel={t("pages.overview.panel.close")}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus.current?.isConnected) returnFocus.current.focus();
          else {
            const fallback = document.querySelector<HTMLElement>(
              '[data-testid="overview-card"] button, [data-testid="overview-status-active"], main h1',
            );
            if (fallback) {
              if (!fallback.hasAttribute("tabindex")) fallback.tabIndex = -1;
              fallback.focus();
            }
          }
          returnFocus.current = null;
        }}
      >
        <DialogHeader className="max-h-[35dvh] min-w-0 shrink-0 gap-2 overflow-y-auto border-b border-border px-5 py-4 pr-12 text-left [overflow-wrap:anywhere]">
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
                    className="h-auto min-w-0 max-w-full whitespace-normal p-0 text-left text-[12.5px] [overflow-wrap:anywhere]"
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
          <DialogTitle
            className="min-w-0 text-xl leading-snug [overflow-wrap:anywhere]"
            data-testid="overview-panel-title"
          >
            {shown?.title ?? (fetched.pending ? "…" : t("pages.overview.panel.notFound"))}
          </DialogTitle>
          {shown ? (
            <DialogDescription asChild>
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-[12.5px]">
                <StatusLabel status={shown.status} withHint={false} />
                {!shown.matches ? (
                  <span className="text-xs font-medium" data-testid="overview-panel-context">
                    {t("pages.overview.card.context")}
                  </span>
                ) : null}
                <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                  {shown.workflowName ?? ""}
                </span>
              </div>
            </DialogDescription>
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
        </DialogHeader>
        <ScrollArea className="min-h-0 min-w-0 flex-1" data-testid="overview-panel-scroll">
          <div className="pt-4">
            {shown ? (
              <PanelBody run={shown} ancestors={ancestors} now={now} onOpen={onOpen} />
            ) : fetched.error && !fetched.pending ? (
              <p role="alert" className="px-5 pb-5 text-sm text-destructive">
                {t("pages.overview.error")}{" "}
                <Button variant="link" onClick={() => void fetched.refresh()}>
                  {t("pages.overview.retry")}
                </Button>
              </p>
            ) : null}
          </div>
        </ScrollArea>
        {shown ? (
          <DialogFooter className="shrink-0 flex-row flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            <ExecutionStopButton target={shown} />
            <Button asChild>
              <Link
                to={`${ROUTES.EXECUTIONS}/${encodeURIComponent(shown.executionId)}`}
                data-testid="overview-panel-open-run"
              >
                {t("pages.overview.panel.open")}
              </Link>
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
