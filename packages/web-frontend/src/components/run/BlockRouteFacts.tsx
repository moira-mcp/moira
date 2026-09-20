/**
 * What the run actually did in one block: its visits as the route recorded them — the exit each
 * visit left through in the transition's own words, whether the visit waited for input, the names
 * it set, who made a runtime adjustment, and the visits that re-entered the block. A visit is a
 * link: clicking it moves the route cursor there, so the rest of the page shows the run as it
 * stood at that moment.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { CornerUpLeft, Hourglass, RotateCcw } from "lucide-react";
import type { ExecutionRouteEntry } from "@mcp-moira/workflow-engine/progress-visual";
import { cn } from "@/lib/utils";
import { changesText, exitLabel } from "./route";
import type { RunBlock } from "./model";

export function BlockRouteFacts({
  block,
  route,
  cursor,
  onSetCursor,
  className,
}: {
  block: RunBlock;
  /** The whole recorded route; the block's own visits are taken from it. */
  route: readonly ExecutionRouteEntry[];
  /** Route cursor (visit sequence number); null means the whole run. */
  cursor: number | null;
  onSetCursor: (at: number | null) => void;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const visits = route.filter((visit) => visit.blockId === block.id);
  return (
    <section
      className={cn("space-y-1", className)}
      data-testid="block-route-facts"
      data-block-id={block.id}
      aria-label={t("pages.runPage.routeFacts.title")}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("pages.runPage.routeFacts.title")}
      </p>
      {visits.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="block-route-facts-empty">
          {t("pages.runPage.routeFacts.empty")}
        </p>
      ) : (
        <ol className="space-y-0.5 text-sm">
          {visits.map((visit) => {
            const exit = exitLabel(visit, [block]);
            const changed = changesText(visit.changed);
            return (
              <li
                key={visit.seq}
                className={cn(
                  "flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md px-1.5 py-0.5",
                  cursor === visit.seq && "bg-primary/5",
                  cursor !== null && visit.seq > cursor && "opacity-50",
                )}
                data-testid="block-route-visit"
                data-seq={visit.seq}
              >
                <button
                  type="button"
                  className="tabular-nums text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => onSetCursor(visit.seq)}
                  data-hint={t("pages.runPage.routeFacts.goTo")}
                >
                  {t("pages.runPage.routeFacts.visit", { seq: visit.seq })}
                </button>
                <span className="font-medium">{visit.nodeId}</span>
                {visit.loop && (
                  <span
                    className="inline-flex items-center gap-1 text-primary"
                    data-testid="block-route-loop"
                  >
                    <RotateCcw className="size-3" aria-hidden="true" />
                    {t("pages.runPage.routeFacts.loopVisit")}
                  </span>
                )}
                {visit.waited && (
                  <span className="inline-flex items-center gap-1 text-warning-foreground">
                    <Hourglass className="size-3" aria-hidden="true" />
                    {t("pages.runPage.routeFacts.waited")}
                  </span>
                )}
                {exit && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-1",
                      exit.cycle ? "text-primary" : "text-muted-foreground",
                    )}
                    data-testid="block-route-exit"
                  >
                    {exit.cycle && <CornerUpLeft className="size-3" aria-hidden="true" />}→{" "}
                    {exit.label}
                  </span>
                )}
                {changed && (
                  <span className="text-muted-foreground" data-testid="block-route-changed">
                    {t("pages.runPage.routeFacts.changed")} {changed}
                  </span>
                )}
                {visit.adjusted && (
                  <span className="text-warning-foreground" data-testid="block-route-adjusted">
                    {t("pages.runPage.routeFacts.adjusted")}
                    {visit.actor
                      ? ` · ${t(`pages.runPage.routeFacts.actor.${visit.actor.role}`)}`
                      : ""}
                  </span>
                )}
                {cursor === visit.seq && (
                  <span className="text-[11px] font-semibold text-primary">
                    {t("pages.runPage.routeFacts.cursor")}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
