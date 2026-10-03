/**
 * One run on the overview, on a card of constant height: whatever the number of plan items or the
 * length of the text, the rows are the same — status and age, a two-line title, its own flow and
 * parent or context relationship, the stage strip or what the person is waited for, the plan window
 * around the current item, and the footer with its flags. Everything a card shortens is in the
 * hints and, in full, in the modal dialog its title opens.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Check,
  CircleAlert,
  GitBranch,
  Hourglass,
  MessageCircleQuestion,
  OctagonPause,
  StickyNote,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Hint } from "../diagram/Hint";
import { formatDuration } from "../run/duration";
import type {
  OverviewNotificationMark,
  OverviewRun,
  OverviewStatus,
} from "../../services/api-client";
import {
  activityOf,
  cardPlan,
  hasStripRow,
  isStale,
  planRows,
  planSlots,
  type PlanRow,
} from "./model";
import { agoText, ageText, dateText, daysIn } from "./format";
import { useExecutionStopAction } from "../execution/ExecutionStop";

/** The dot and label colour of each status; the label always says the status in words. */
export const STATUS_DOT: Record<OverviewStatus, string> = {
  "waiting-user": "bg-your-move",
  "waiting-agent": "bg-info",
  locked: "bg-warning",
  completed: "bg-success",
  stopped: "bg-muted-foreground",
};

export function StatusLabel({
  status,
  withHint = true,
  muted = false,
}: {
  status: OverviewStatus;
  withHint?: boolean;
  /** The run is shown only because its tree matches the filters. */
  muted?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const label = (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 font-semibold",
        status === "waiting-user" ? "text-your-move" : "text-foreground",
      )}
      data-testid="overview-status"
      data-status={status}
      {...(withHint ? { tabIndex: 0 } : {})}
    >
      <span
        className={cn(
          "h-2 w-2 flex-none rounded-full",
          STATUS_DOT[status],
          status === "waiting-user" && "animate-pulse",
        )}
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{t(`pages.overview.runStatus.${status}`)}</span>
    </span>
  );
  return withHint ? (
    <Hint
      content={
        muted
          ? `${t(`pages.overview.runStatusHint.${status}`)}\n${t("pages.overview.card.muted")}`
          : t(`pages.overview.runStatusHint.${status}`)
      }
      className="whitespace-pre-line"
      side="bottom"
      align="start"
    >
      {label}
    </Hint>
  ) : (
    label
  );
}

function notificationShort(
  mark: OverviewNotificationMark | null,
  now: number,
  t: TFunction,
): { text: string; ok: boolean } {
  const key = "pages.overview.card.notification";
  if (!mark) return { text: t(`${key}.none`), ok: false };
  if (mark.state === "pending" || mark.sentAt === null)
    return { text: t(`${key}.pending`), ok: true };
  if (mark.deliveryStatus === "delivered" || mark.deliveryStatus === "partial") {
    const values = {
      channels: mark.deliveredChannels.join(", "),
      ago: agoText(now - mark.sentAt, t),
    };
    return {
      text: t(mark.kind === "remind" ? `${key}.reminded` : `${key}.sent`, values),
      ok: true,
    };
  }
  if (mark.deliveryStatus === "no_configured_channels")
    return { text: t(`${key}.noChannels`), ok: false };
  return { text: t(`${key}.failed`), ok: false };
}

function PlanRowView({ row, t }: { row: PlanRow; t: TFunction }): React.JSX.Element {
  if (row.kind !== "item") {
    return (
      <li
        className="h-6 flex-none truncate pl-[23px] text-[12.5px] leading-6 text-muted-foreground"
        data-testid={`overview-plan-${row.kind}`}
      >
        {t(row.kind === "above" ? "pages.overview.card.above" : "pages.overview.card.below", {
          count: row.count,
        })}
      </li>
    );
  }
  const { item } = row;
  return (
    <li
      className={cn(
        "flex min-w-0 flex-none gap-2 text-[13px]",
        row.twoLines ? "h-[42px] items-start pt-[3px]" : "h-6 items-center",
        item.current && "font-semibold",
      )}
      data-testid="overview-plan-item"
      data-index={item.index}
      data-current={item.current || undefined}
      data-done={item.done || undefined}
    >
      <span
        className={cn(
          "grid h-[15px] w-[15px] flex-none place-items-center rounded-[4px] border-[1.5px] border-border",
          item.done && "border-primary bg-primary text-primary-foreground",
          item.current && "border-primary ring-[3px] ring-inset ring-card bg-primary",
          row.twoLines && "mt-px",
        )}
        aria-hidden="true"
      >
        {item.done ? <Check className="h-2.5 w-2.5" /> : null}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 [overflow-wrap:anywhere]",
          row.twoLines ? "line-clamp-2 leading-[18px]" : "truncate",
          item.done && "text-muted-foreground",
        )}
      >
        {item.title}
      </span>
      {item.current ? <span className="sr-only">{t("pages.overview.card.current")}</span> : null}
      {item.durationMs !== null && item.done ? (
        <span className="ml-auto flex-none text-[11.5px] font-normal text-muted-foreground">
          {formatDuration(item.durationMs, t)}
        </span>
      ) : null}
    </li>
  );
}

function StripRow({ run }: { run: OverviewRun }): React.JSX.Element | null {
  const { t } = useTranslation();
  if (run.status === "stopped") {
    return (
      <Hint
        content={run.stopReason ?? t("pages.overview.runStatusHint.stopped")}
        width="md"
        className="whitespace-pre-line"
      >
        <div
          className="flex h-[26px] min-w-0 items-center gap-1.5 rounded-lg bg-secondary px-2 text-[12.5px] text-muted-foreground"
          data-testid="overview-stop-reason"
          tabIndex={0}
        >
          <OctagonPause className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          <span className="truncate">
            {run.stopReason ?? t("pages.overview.runStatus.stopped")}
          </span>
        </div>
      </Hint>
    );
  }
  const waiting = run.status === "waiting-user" ? run.waitingForUser : null;
  if (waiting) {
    const agent = waiting.source === "agent";
    const text = agent
      ? t("pages.overview.card.agentAsks", { question: waiting.question })
      : waiting.label;
    return (
      <Hint
        content={
          agent
            ? `${t("pages.overview.card.agentHint")}\n${waiting.question}`
            : t("pages.overview.card.gateHint")
        }
        width="md"
        className="whitespace-pre-line"
      >
        <div
          className="flex h-[26px] min-w-0 items-center gap-1.5 rounded-lg bg-your-move/10 px-2 text-[12.5px] font-semibold text-your-move"
          data-testid="overview-waiting"
          data-source={waiting.source}
          tabIndex={0}
        >
          {agent ? (
            <MessageCircleQuestion className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          ) : (
            <Hourglass className="h-3.5 w-3.5 flex-none" aria-hidden="true" />
          )}
          <span className="truncate">{text}</span>
        </div>
      </Hint>
    );
  }
  if (!run.stages || run.stages.entries.length === 0) return null;
  const entries = run.stages.entries;
  const total = entries.length;
  const done = entries.filter(
    (stage) => stage.status === "done" || stage.status === "repeated",
  ).length;
  const position =
    run.status === "completed"
      ? -1
      : entries.findIndex((stage) => stage.status === "active" || stage.status === "waiting");
  const hint = entries
    .map((stage) => `${stage.label} — ${t(`pages.runPage.status.${stage.status}`)}`)
    .join("\n");
  return (
    <Hint content={hint} className="whitespace-pre-line" width="md">
      <div className="grid content-start gap-[5px]" data-testid="overview-stages" tabIndex={0}>
        <div className="flex min-w-0 justify-between gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">
            {position >= 0
              ? t("pages.overview.card.stage", { number: position + 1, total })
              : t("pages.overview.card.stagesProgress", { done, total })}
          </span>
          <b className="truncate font-semibold text-foreground">
            {done === total
              ? t("pages.overview.card.stagesDone")
              : position >= 0
                ? entries[position].label
                : ""}
          </b>
        </div>
        <div className="flex gap-[3px]" aria-hidden="true">
          {entries.map((stage, index) => (
            <i
              key={stage.id}
              data-stage-status={stage.status}
              className={cn(
                "h-[5px] min-w-0 flex-1 rounded-[2px] bg-secondary",
                (stage.status === "done" || stage.status === "repeated") && "bg-primary",
                stage.status === "skipped" && "bg-muted-foreground/25",
                index === position && "bg-primary/40",
              )}
            />
          ))}
        </div>
      </div>
    </Hint>
  );
}

function PlanArea({ run }: { run: OverviewRun }): React.JSX.Element {
  const { t } = useTranslation();
  const plan = cardPlan(run);
  if (plan.kind === "none") {
    return (
      <div className="grid min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[18px_1fr] border-t border-border pt-2">
        <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("pages.overview.card.plan")}
        </div>
        <div
          className="grid min-w-0 content-center gap-1.5 text-[13px] text-muted-foreground"
          data-testid="overview-no-plan"
        >
          {run.status !== "completed" && run.status !== "stopped" && run.current?.stepName ? (
            <span className="line-clamp-4 [overflow-wrap:anywhere]">
              {t("pages.overview.card.now")}{" "}
              <b className="font-medium text-foreground">{run.current.stepName}</b>
            </span>
          ) : null}
          <span>{t("pages.overview.card.noPlan")}</span>
        </div>
      </div>
    );
  }
  const total = plan.kind === "list" ? (plan.total ?? plan.items.length) : plan.total;
  const rows = planRows(plan.items, total, planSlots(run), run.status === "completed");
  const title = plan.kind === "list" ? plan.title : t("pages.overview.card.stages");
  const count =
    plan.kind === "list"
      ? plan.done !== null && plan.total !== null
        ? t("pages.overview.card.doneOf", { done: plan.done, total: plan.total })
        : ""
      : t("pages.overview.card.doneOf", { done: plan.done, total: plan.total });
  return (
    <div
      className="grid min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[18px_1fr] border-t border-border pt-2"
      data-testid="overview-plan"
      data-plan={plan.kind}
    >
      <div className="flex justify-between gap-2 text-[11.5px] text-muted-foreground">
        <span className="truncate font-semibold uppercase tracking-wide">{title}</span>
        <span className="flex-none">{count}</span>
      </div>
      <ol className="flex min-h-0 flex-col overflow-hidden">
        {rows.map((row) => (
          <PlanRowView
            key={row.kind === "item" ? `i${row.item.index}` : row.kind}
            row={row}
            t={t}
          />
        ))}
      </ol>
    </div>
  );
}

function Footer({ run, now }: { run: OverviewRun; now: number }): React.JSX.Element {
  const { t } = useTranslation();
  const waiting = run.status === "waiting-user" ? run.waitingForUser : null;
  let text: string;
  let hint: string;
  let notified: boolean | null = null;
  if (waiting) {
    const note = notificationShort(waiting.notification, now, t);
    text = note.text;
    notified = note.ok;
    hint = "";
  } else if (run.status === "completed" || run.status === "stopped") {
    const at = run.completedAt ?? activityOf(run);
    text =
      at === null
        ? t(`pages.overview.card.${run.status}Unknown`)
        : t(`pages.overview.card.${run.status}`, { ago: agoText(now - at, t) });
    hint = "";
  } else {
    text =
      run.current?.directiveShownAt != null
        ? t("pages.overview.card.shown", { ago: agoText(now - run.current.directiveShownAt, t) })
        : t("pages.overview.card.shownUnknown");
    hint = run.current?.stepName
      ? t("pages.overview.card.stepHint", { step: run.current.stepName })
      : "";
  }
  const textView = (
    <span
      className={cn("truncate", notified === false && "text-destructive")}
      {...(hint ? { tabIndex: 0 } : {})}
    >
      {text}
    </span>
  );
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 whitespace-nowrap border-t border-border pt-1.5 text-xs text-muted-foreground"
      data-testid="overview-footer"
    >
      {hint ? <Hint content={hint}>{textView}</Hint> : textView}
      <span className="ml-auto inline-flex flex-none gap-1">
        {run.childrenTotal.total > 0 ? (
          <Hint
            content={t("pages.overview.card.childrenFlag", {
              total: run.childrenTotal.total,
              shown: run.children.total,
              unfinished: run.childrenTotal.unfinished,
            })}
          >
            <span
              className="inline-flex h-[18px] items-center gap-0.5 rounded-md bg-primary/10 px-1.5 text-[11px] font-bold text-primary"
              data-testid="overview-flag-children"
              tabIndex={0}
            >
              <GitBranch className="h-3 w-3" aria-hidden="true" />
              {run.children.total}/{run.childrenTotal.total}
            </span>
          </Hint>
        ) : null}
        {run.refusalCount > 0 ? (
          <Hint
            content={t("pages.overview.card.refusalsFlag", { count: run.refusalCount })}
            side="top"
            align="end"
          >
            <span
              className="inline-flex h-[18px] items-center gap-0.5 rounded-md bg-destructive/10 px-1.5 text-[11px] font-bold text-destructive"
              data-testid="overview-flag-refusals"
              tabIndex={0}
            >
              <CircleAlert className="h-3 w-3" aria-hidden="true" />
              {run.refusalCount}
            </span>
          </Hint>
        ) : null}
        {/* Notes remain independently inspectable even when their text matches the task title. */}
        {run.note ? (
          <Hint
            content={t("pages.overview.card.noteFlag", { note: run.note })}
            side="top"
            align="end"
          >
            <span
              className="inline-flex h-[18px] items-center rounded-md bg-secondary px-1.5 text-muted-foreground"
              data-testid="overview-flag-note"
              tabIndex={0}
            >
              <StickyNote className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">{t("pages.overview.panel.note")}</span>
            </span>
          </Hint>
        ) : null}
      </span>
    </div>
  );
}

export interface OverviewCardProps {
  run: OverviewRun;
  /** Drawn inside a parent's group: the subtitle names the parent. */
  parentTitle: string | null;
  now: number;
  onOpen: (executionId: string) => void;
  className?: string;
}

export function OverviewCard({
  run,
  parentTitle,
  now,
  onOpen,
  className,
}: OverviewCardProps): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const stop = useExecutionStopAction(run);
  const strip = hasStripRow(run);
  const since = activityOf(run);
  const stale = isStale(run, now);
  const continuing = parentTitle ?? run.parent?.title ?? null;
  const ageHint = [
    run.lastActivityAt !== null
      ? t("pages.overview.ageHint.last", { at: dateText(run.lastActivityAt, i18n.language) })
      : t("pages.overview.ageHint.none"),
    run.subtreeActivityAt !== null &&
    run.lastActivityAt !== null &&
    run.subtreeActivityAt > run.lastActivityAt
      ? t("pages.overview.ageHint.subtree", { at: dateText(run.subtreeActivityAt, i18n.language) })
      : null,
    stale && since !== null
      ? t("pages.overview.ageHint.stale", { days: daysIn(now - since) })
      : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <article
      className={cn(
        "relative grid h-[360px] w-full min-w-0 grid-cols-[minmax(0,1fr)] cursor-pointer gap-y-2 rounded-xl border border-border bg-card px-4 pb-3 pt-3.5 text-card-foreground shadow-sm transition-colors hover:border-ring/50",
        strip
          ? "grid-rows-[20px_40px_34px_26px_minmax(0,1fr)_22px]"
          : "grid-rows-[20px_40px_34px_minmax(0,1fr)_22px]",
        run.status === "waiting-user" && "border-your-move/50 ring-1 ring-your-move/30",
        !run.matches && "[&>*]:opacity-50",
        className,
      )}
      aria-label={run.title}
      data-testid="overview-card"
      data-run-id={run.executionId}
      data-status={run.status}
      data-matches={run.matches ? "true" : "false"}
      onClick={(event) => {
        // A click on the card opens the panel, unless it was on a control of its own.
        if ((event.target as HTMLElement).closest("button,a,[tabindex]")) return;
        onOpen(run.executionId);
      }}
    >
      <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
        <StatusLabel status={run.status} muted={!run.matches} />
        <Hint content={ageHint} className="whitespace-pre-line" side="bottom" align="end">
          <span
            className={cn(
              "ml-auto whitespace-nowrap text-muted-foreground",
              stale && "font-semibold text-foreground",
            )}
            data-testid="overview-age"
            data-stale={stale || undefined}
            tabIndex={0}
          >
            {since === null ? "—" : ageText(now - since, t)}
          </span>
        </Hint>
        {stop ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 shrink-0 text-destructive"
            aria-label={stop.label}
            data-hint={stop.label}
            disabled={stop.disabled}
            data-testid={stop.testId}
            onClick={(event) => {
              event.stopPropagation();
              stop.onClick();
            }}
          >
            {stop.icon}
          </Button>
        ) : null}
      </div>
      <Button
        type="button"
        variant="ghost"
        className="h-auto min-w-0 justify-start whitespace-normal rounded-sm p-0 text-left text-[15px] font-semibold leading-5 hover:bg-transparent"
        aria-haspopup="dialog"
        data-testid="overview-card-open"
        onClick={() => onOpen(run.executionId)}
      >
        <span className="min-w-0 flex-1 line-clamp-2 [overflow-wrap:anywhere]">{run.title}</span>
      </Button>
      <div
        className="grid min-w-0 content-start gap-0.5 text-xs text-muted-foreground"
        data-testid="overview-subtitle"
      >
        <span className="min-w-0 truncate" data-testid="overview-own-flow">
          {run.workflowName ?? "—"}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          {!run.matches ? (
            <span className="shrink-0 font-medium" data-testid="overview-parent-context">
              {t("pages.overview.card.context")}
            </span>
          ) : null}
          {continuing ? (
            <Hint
              content={`${t("pages.overview.card.childOf", { title: continuing })}\n${t("pages.overview.card.flowHint", { name: run.workflowName ?? "—" })}`}
              className="whitespace-pre-line"
            >
              <span
                tabIndex={0}
                className="block min-w-0 flex-1 truncate font-semibold text-primary"
              >
                {t("pages.overview.card.childOf", { title: continuing })}
              </span>
            </Hint>
          ) : null}
        </span>
      </div>
      {strip ? <StripRow run={run} /> : null}
      <PlanArea run={run} />
      <Footer run={run} now={now} />
      {run.matches ? null : <span className="sr-only">{t("pages.overview.card.muted")}</span>}
    </article>
  );
}
