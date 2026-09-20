/**
 * What a block typically costs on this version: the median duration of one pass, the median time a
 * whole run spends in the block and the median number of passes, over the completed runs sampled
 * for the version. A version nobody has finished yet has no sample, and the block says so instead
 * of showing a zero.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowVersionStatistics } from "@mcp-moira/workflow-engine/progress-visual";
import { cn } from "@/lib/utils";
import { formatDuration } from "./duration";

export function TypicalDurations({
  blockId,
  statistics,
  pending = false,
  error = null,
  className,
}: {
  blockId: string;
  /** The version's statistics; null when the version has none or they are not loaded. */
  statistics: WorkflowVersionStatistics | null | undefined;
  /** True while the statistics are being fetched and none are at hand yet. */
  pending?: boolean;
  /** The fetch's failure, when it failed: the block then says so instead of claiming no runs. */
  error?: string | null;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const block = statistics?.blocks.find((entry) => entry.blockId === blockId) ?? null;
  const sampled = block ? Math.max(block.pass.sampleCount, block.run.sampleCount) : 0;
  return (
    <section
      className={cn("space-y-1", className)}
      data-testid="typical-durations"
      data-block-id={blockId}
      data-sampled={sampled}
      aria-label={t("pages.runPage.typical.title")}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("pages.runPage.typical.title")}
      </p>
      {error ? (
        <p
          className="text-sm text-muted-foreground"
          data-hint={error}
          data-testid="typical-durations-error"
        >
          {t("pages.runPage.typical.unavailable")}
        </p>
      ) : pending && !statistics ? (
        <p className="text-sm text-muted-foreground" data-testid="typical-durations-pending">
          {t("pages.runPage.typical.loading")}
        </p>
      ) : !block || sampled === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="typical-durations-empty">
          {t("pages.runPage.typical.noRuns")}
        </p>
      ) : (
        <>
          <dl className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
            <div className="flex items-baseline gap-1">
              <dt className="text-muted-foreground">{t("pages.runPage.typical.pass")}</dt>
              <dd className="font-medium tabular-nums" data-testid="typical-pass">
                {formatDuration(block.pass.medianMs, t)}
              </dd>
            </div>
            <div className="flex items-baseline gap-1">
              <dt className="text-muted-foreground">{t("pages.runPage.typical.run")}</dt>
              <dd className="font-medium tabular-nums" data-testid="typical-run">
                {formatDuration(block.run.medianMs, t)}
              </dd>
            </div>
            <div className="flex items-baseline gap-1">
              <dt className="text-muted-foreground">{t("pages.runPage.typical.passes")}</dt>
              <dd className="font-medium tabular-nums" data-testid="typical-passes">
                {block.typicalPasses === null ? "—" : `×${block.typicalPasses}`}
              </dd>
            </div>
          </dl>
          <p className="text-[11px] text-muted-foreground" data-testid="typical-sample">
            {t("pages.runPage.typical.sample", { runs: sampled })}
          </p>
        </>
      )}
    </section>
  );
}
