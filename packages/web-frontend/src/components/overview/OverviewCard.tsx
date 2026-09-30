/**
 * One run on the overview, on a card of constant height: whatever the number of plan items or the
 * length of the text, the rows are the same — status and age, a two-line title, the flow (or the
 * parent a child run belongs to), the stage strip or what the person is waited for, the plan window
 * around the current item, and the footer with its flags. Everything a card shortens is in the
 * hints and, in full, in the side panel its title opens.
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

/** The dot and label colour of each status; the label always says the status in words. */
export const STATUS_DOT: Record<OverviewStatus, string> = {
  "waiting-user": "bg-your-move",
  "waiting-agent": "bg-info",
  locked: "bg-warning",
  completed: "bg-success",
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
        "inline-flex items-center gap-1.5 whitespace-nowrap font-semibold",
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
      {t(`pages.overview.runStatus.${status}`)}
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
          "min-w-0",
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
  if (!run.stages || run.stages.labels.length === 0) return null;
  const total = run.stages.labels.length;
  const finished = run.status === "completed";
  const active = run.stages.activeIndex;
  const position = finished ? total : (active ?? run.stages.doneCount);
  const hint = run.stages.labels
    .map(
      (label, index) =>
        `${index < position ? "✓" : index === position && !finished ? "▸" : "·"} ${label}`,
    )
    .join("\n");
  return (
    <Hint content={hint} className="whitespace-pre-line" width="md">
      <div className="grid content-start gap-[5px]" data-testid="overview-stages" tabIndex={0}>
        <div className="flex justify-between gap-2 whitespace-nowrap text-xs text-muted-foreground">
          <span>
            {t("pages.overview.card.stage", { number: Math.min(position + 1, total), total })}
          </span>
          <b className="truncate font-semibold text-foreground">
            {finished || position >= total
              ? t("pages.overview.card.stagesDone")
              : run.stages.labels[position]}
          </b>
        </div>
        <div className="flex gap-[3px]" aria-hidden="true">
          {run.stages.labels.map((label, index) => (
            <i
              key={`${index}-${label}`}
              className={cn(
                "h-[5px] flex-1 rounded-[2px] bg-secondary",
                index < position && (finished ? "bg-success" : "bg-primary"),
                index === position && !finished && "bg-primary/40",
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
      <div className="grid min-h-0 grid-rows-[18px_1fr] border-t border-border pt-2">
        <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("pages.overview.card.plan")}
        </div>
        <div
          className="grid content-center gap-1.5 text-[13px] text-muted-foreground"
          data-testid="overview-no-plan"
        >
          {run.status !== "completed" && run.current?.stepName ? (
            <span>
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
      className="grid min-h-0 grid-rows-[18px_1fr] border-t border-border pt-2"
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
  } else if (run.status === "completed") {
    text = t("pages.overview.card.completed", {
      ago: agoText(now - (run.completedAt ?? activityOf(run)), t),
    });
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
        {run.children.total > 0 ? (
          <Hint
            content={t("pages.overview.card.childrenFlag", {
              total: run.children.total,
              unfinished: run.children.unfinished,
            })}
          >
            <span
              className="inline-flex h-[18px] items-center gap-0.5 rounded-md bg-primary/10 px-1.5 text-[11px] font-bold text-primary"
              data-testid="overview-flag-children"
              tabIndex={0}
            >
              <GitBranch className="h-3 w-3" aria-hidden="true" />
              {run.children.unfinished}/{run.children.total}
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
        {/* The note is usually the task's title already; only a note that differs is flagged. */}
        {run.note && run.note !== run.title ? (
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
    stale ? t("pages.overview.ageHint.stale", { days: daysIn(now - since) }) : null,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <article
      className={cn(
        "relative grid h-[340px] w-full min-w-0 cursor-pointer gap-y-2 rounded-xl border border-border bg-card px-4 pb-3 pt-3.5 text-card-foreground shadow-sm transition-colors hover:border-ring/50",
        strip
          ? "grid-rows-[20px_40px_18px_26px_minmax(0,1fr)_22px]"
          : "grid-rows-[20px_40px_18px_minmax(0,1fr)_22px]",
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
            {ageText(now - since, t)}
          </span>
        </Hint>
      </div>
      <Button
        type="button"
        variant="ghost"
        className="h-auto justify-start whitespace-normal rounded-sm p-0 text-left text-[15px] font-semibold leading-5 hover:bg-transparent"
        aria-haspopup="dialog"
        data-testid="overview-card-open"
        onClick={() => onOpen(run.executionId)}
      >
        <span className="line-clamp-2">{run.title}</span>
      </Button>
      <div className="truncate text-xs text-muted-foreground" data-testid="overview-subtitle">
        {continuing ? (
          <Hint content={t("pages.overview.card.flowHint", { name: run.workflowName ?? "—" })}>
            <span tabIndex={0}>
              <span className="font-semibold text-primary">
                {t("pages.overview.card.childOf", { title: continuing })}
              </span>
            </span>
          </Hint>
        ) : (
          (run.workflowName ?? "—")
        )}
      </div>
      {strip ? <StripRow run={run} /> : null}
      <PlanArea run={run} />
      <Footer run={run} now={now} />
      {run.matches ? null : <span className="sr-only">{t("pages.overview.card.muted")}</span>}
    </article>
  );
}
