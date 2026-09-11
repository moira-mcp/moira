/**
 * Block detail — the selected block (the current one by default): its status, description, run
 * content, transitions in words, and its steps with the evidence each demands back. A step
 * focuses the technical node graph so the block ↔ steps drill-down is always one click away.
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { GuidanceCallout } from "./Guidance";
import { StatusChip } from "./status";
import { StepList } from "./StepList";
import type { WorkflowGraph } from "../../types/workflow-types";
import { blockById, stepsOf, type RunBlock } from "./model";

export function BlockDetailPanel({
  block,
  blocks,
  workflow,
  onSelectBlock,
  onFocusNode,
}: {
  block: RunBlock | null;
  blocks: RunBlock[];
  workflow?: WorkflowGraph;
  onSelectBlock: (blockId: string | null) => void;
  onFocusNode: (nodeId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const steps = useMemo(() => (block ? stepsOf(workflow, block.nodeIds) : []), [workflow, block]);
  if (!block) {
    return (
      <div className="p-3">
        <GuidanceCallout
          title={t("pages.runPage.blockDetail.emptyTitle")}
          testId="block-detail-empty"
        >
          {t("pages.runPage.blockDetail.emptyBody")}
        </GuidanceCallout>
      </div>
    );
  }
  const byId = blockById(blocks);
  const { content } = block;
  return (
    <div className="space-y-3 p-3" data-testid="block-detail" data-block-id={block.id}>
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold leading-6">
            <span className="mr-2 tabular-nums text-muted-foreground">{block.index + 1}.</span>
            {block.name}
          </h3>
          <StatusChip status={block.status} iterations={block.iterations} />
        </div>
        <p className="text-sm leading-6 text-foreground/85">{block.description}</p>
        {(content.summary || content.details.length > 0 || content.outcome || content.next) && (
          <dl className="space-y-0.5 pt-1 text-sm" data-testid="block-detail-content">
            {content.summary && <dd className="font-medium">{content.summary}</dd>}
            {content.details.map((detail, index) => (
              <dd key={index} className="text-muted-foreground">
                • {detail}
              </dd>
            ))}
            {content.outcome && <dd className="text-success">✓ {content.outcome}</dd>}
            {content.next && <dd className="font-medium text-primary">→ {content.next}</dd>}
          </dl>
        )}
      </header>

      {block.transitions.length > 0 && (
        <section aria-label={t("pages.runPage.blockDetail.transitions")}>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pages.runPage.blockDetail.transitions")}
          </p>
          <ul className="space-y-1.5 text-sm">
            {block.transitions.map((transition) => (
              <li
                key={`${transition.to}-${transition.label}`}
                className={cn(
                  "flex items-start gap-2 rounded-lg border px-2.5 py-1.5",
                  transition.cycle ? "border-primary/40 bg-primary/5" : "border-border bg-muted/30",
                )}
                data-transition-kind={transition.cycle ? "cycle" : "forward"}
              >
                {transition.cycle ? (
                  <RotateCcw className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
                ) : (
                  <ArrowRight
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                )}
                <div className="min-w-0">
                  <p className="font-medium">
                    {transition.label}
                    <button
                      type="button"
                      className="ml-1 font-normal text-muted-foreground underline-offset-2 hover:underline"
                      onClick={() => onSelectBlock(transition.to)}
                    >
                      → {byId.get(transition.to)?.name ?? transition.to}
                    </button>
                  </p>
                  {transition.cycle && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {transition.cycle.cause}{" "}
                      <span className="text-foreground/70">
                        {t("pages.runPage.lanes.endsWhen")} {transition.cycle.exit}
                      </span>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-label={t("pages.runPage.blockDetail.steps")}>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("pages.runPage.blockDetail.steps")} ·{" "}
          {t("pages.runPage.stepCount", { count: steps.length })}
        </p>
        <StepList steps={steps} currentNodeId={block.currentNodeId} onFocusNode={onFocusNode} />
        <p className="mt-1 text-[11px] text-muted-foreground">
          {t("pages.runPage.blockDetail.stepsHint")}
        </p>
      </section>
    </div>
  );
}
