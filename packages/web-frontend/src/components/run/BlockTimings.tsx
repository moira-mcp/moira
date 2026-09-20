/**
 * How long the run spent in a block: one row per pass through its working step with the times it
 * was entered and left, the pass duration, the open pass measured to the moment the projection
 * was made, and the block's total. A run recorded before timestamps existed has no measurements:
 * every value reads "—", never "0 s". When the version's statistics are given, the typical pass
 * and run duration stand beside the measured ones so a pass reads as fast or slow at a glance.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowVersionStatistics } from "@mcp-moira/workflow-engine/progress-visual";
import { cn } from "@/lib/utils";
import { formatClock, formatDuration } from "./duration";
import type { RunBlock } from "./model";

export function BlockTimings({
  block,
  statistics,
  cursor,
  className,
}: {
  block: RunBlock;
  /** The version's typical durations; the block's entry is used when the sample holds one. */
  statistics?: WorkflowVersionStatistics | null;
  /** Route cursor: passes after it are marked as later than the position shown. */
  cursor: number | null;
  className?: string;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const timing = block.timing ?? null;
  const passes = timing?.passes ?? [];
  // The statistics carry an entry for every block of the version, sampled or not; only a sampled
  // one has a typical duration to show.
  const entry = statistics?.blocks.find((candidate) => candidate.blockId === block.id) ?? null;
  const typical =
    entry && Math.max(entry.pass.sampleCount, entry.run.sampleCount) > 0 ? entry : null;
  return (
    <section
      className={cn("space-y-1", className)}
      data-testid="block-timings"
      data-block-id={block.id}
      data-recorded={timing?.recorded ? "true" : "false"}
      aria-label={t("pages.runPage.timing.title")}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("pages.runPage.timing.title")}
      </p>
      {passes.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="block-timings-empty">
          {t("pages.runPage.timing.noPasses")}
        </p>
      ) : (
        <ol className="space-y-0.5 text-sm">
          {passes.map((pass, index) => (
            <li
              key={`${pass.seq}-${pass.nodeId}`}
              className={cn(
                "flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md px-1.5 py-0.5",
                pass.open && "bg-primary/5",
                cursor !== null && pass.seq > cursor && "opacity-50",
              )}
              data-testid="block-timing-pass"
              data-seq={pass.seq}
              data-open={pass.open ? "true" : "false"}
            >
              <span className="tabular-nums text-muted-foreground">
                {t("pages.runPage.timing.pass", { n: index + 1 })}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {formatClock(pass.enteredAt, i18n.language)} →{" "}
                {pass.open ? "…" : formatClock(pass.leftAt, i18n.language)}
              </span>
              <span
                className={cn("font-medium tabular-nums", pass.open && "text-primary")}
                data-testid="block-timing-pass-duration"
              >
                {formatDuration(pass.durationMs, t)}
              </span>
              {pass.open && (
                <span className="text-[11px] text-primary">
                  {t("pages.runPage.timing.running")}
                </span>
              )}
            </li>
          ))}
        </ol>
      )}
      <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-1.5 text-sm">
        <div className="flex items-baseline gap-1">
          <dt className="text-muted-foreground">{t("pages.runPage.timing.total")}</dt>
          <dd className="font-semibold tabular-nums" data-testid="block-timing-total">
            {formatDuration(timing?.totalMs ?? null, t)}
          </dd>
        </div>
        {timing?.currentMs !== null && timing?.currentMs !== undefined && (
          <div className="flex items-baseline gap-1">
            <dt className="text-muted-foreground">{t("pages.runPage.timing.current")}</dt>
            <dd
              className="font-medium tabular-nums text-primary"
              data-testid="block-timing-current"
            >
              {formatDuration(timing.currentMs, t)}
            </dd>
          </div>
        )}
        {typical && (
          <div
            className="flex items-baseline gap-1 text-muted-foreground"
            data-testid="block-timing-typical"
          >
            <dt>{t("pages.runPage.timing.typical")}</dt>
            <dd className="tabular-nums">
              {t("pages.runPage.timing.typicalValues", {
                pass: formatDuration(typical.pass.medianMs, t),
                run: formatDuration(typical.run.medianMs, t),
              })}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
