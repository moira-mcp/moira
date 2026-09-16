/**
 * Block detail — the selected block (the current one by default), and the only place either page
 * tells a block's whole story.
 *
 * Always: status, name, description, the run content, the transitions in words and the steps that
 * implement the block with the evidence each demands back. On a run (`progress` given) it adds the
 * block's passes with their durations, the list it is bound to, what its steps wrote up to the
 * cursor and the facts of its visits. On a definition it adds the block's typical durations and,
 * while edit mode is on, the authoring controls: the name and the description, each transition's
 * label, and the step list with the move-to-block select and every step's authored text. A step
 * focuses the technical node graph so the block ↔ steps drill-down is always one click away.
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { GuidanceCallout } from "./Guidance";
import { PanelSection } from "../diagram/PanelSection";
import { IndexBadge } from "../diagram/IndexBadge";
import { BLOCK_TONE } from "./CanvasView";
import type { HighlightRequest } from "../diagram/useHighlightTarget";
import { formatDuration } from "./duration";
import { StatusChip } from "./status";
import { StepList } from "./StepList";
import { StepCard, StepCardList } from "./StepCard";
import { BlockTimings } from "./BlockTimings";
import { BlockListCard } from "./BlockListCard";
import { BlockRouteFacts } from "./BlockRouteFacts";
import { TypicalDurations } from "./TypicalDurations";
import { useEditing } from "../flow/editing";
import {
  BlockNameEditor,
  BlockSummaryEditor,
  DiagnosticBadge,
  NodeTextEditor,
  OwnerSelect,
  TransitionEditor,
} from "../flow/EditControls";
import { orderedNodeIds } from "../flow/model";
import type { WorkflowGraph } from "../../types/workflow-types";
import type {
  ExecutionRouteEntry,
  WorkflowVersionStatistics,
} from "@mcp-moira/workflow-engine/progress-visual";
import {
  blockById,
  blockWrites,
  formatValue,
  stepConnections,
  orderNodeIds,
  stepsOf,
  type ExecutionProgress,
  type RunBlock,
} from "./model";
import type { WaitingFor } from "./waiting";

/** What the block's visits wrote up to the cursor: the latest value per name, with its visit. */
function BlockWrites({
  progress,
  block,
  cursor,
}: {
  progress: ExecutionProgress;
  block: RunBlock;
  cursor: number | null;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const writes = useMemo(
    () => blockWrites(progress, block.id, cursor),
    [progress, block.id, cursor],
  );
  if (writes.length === 0) return null;
  return (
    <section aria-label={t("pages.runPage.variables.wrote")}>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("pages.runPage.variables.wrote")}
      </p>
      <div
        className="flex flex-wrap items-center gap-1 text-[11px]"
        data-testid={`block-writes-${block.id}`}
      >
        {writes.map((w) => (
          <span
            key={w.name}
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded-md border bg-background px-1.5 font-mono leading-5",
              w.adjusted && "border-warning bg-warning/10",
            )}
            data-hint={`${w.name} = ${formatValue(w.value)} (#${w.seq})`}
            data-block-write={w.name}
          >
            <span className="shrink-0 text-muted-foreground">{w.name}</span>
            <span className="min-w-0 max-w-[220px] truncate">= {formatValue(w.value)}</span>
            <span className="shrink-0 text-muted-foreground">#{w.seq}</span>
          </span>
        ))}
      </div>
    </section>
  );
}

/** The block's steps while a definition is edited: move-to-block and the authored text in place. */
function EditableSteps({
  block,
  blocks,
  workflow,
  onSelectBlock,
}: {
  block: RunBlock;
  blocks: RunBlock[];
  workflow?: WorkflowGraph;
  onSelectBlock: (blockId: string | null) => void;
}): React.JSX.Element {
  const nodeIds = useMemo(() => orderedNodeIds(workflow, block), [workflow, block]);
  const steps = useMemo(() => stepsOf(workflow, nodeIds), [workflow, nodeIds]);
  const nodes = useMemo(() => new Map((workflow?.nodes ?? []).map((n) => [n.id, n])), [workflow]);
  return (
    <StepCardList testId="block-detail-steps">
      {steps.map((step, position) => {
        const node = nodes.get(step.id);
        return (
          <StepCard
            key={step.id}
            step={step}
            position={position + 1}
            connections={stepConnections(node, block, blocks)}
            onConnection={(connection) =>
              connection.targetBlockId && onSelectBlock(connection.targetBlockId)
            }
            afterTitle={<OwnerSelect nodeId={step.id} currentBlockId={block.id} blocks={blocks} />}
            beforeSummary={<DiagnosticBadge nodeId={step.id} className="mt-1" />}
            footer={
              node ? (
                <NodeTextEditor step={step} node={node as unknown as Record<string, unknown>} />
              ) : undefined
            }
          />
        );
      })}
    </StepCardList>
  );
}

export function BlockDetailPanel({
  block,
  blocks,
  workflow,
  waitingFor = null,
  progress,
  route,
  statistics,
  statisticsPending = false,
  statisticsError = null,
  cursor = null,
  onSelectBlock,
  onSetCursor,
  onFocusNode,
  listHighlight = null,
}: {
  block: RunBlock | null;
  blocks: RunBlock[];
  workflow?: WorkflowGraph;
  /** Who the run waits for (`progress.waitingFor`); words the header's waiting status. */
  waitingFor?: WaitingFor;
  /** The run's projection; absent on a definition, which has no run state to show. */
  progress?: ExecutionProgress;
  /** The whole recorded route: the block's own visits are read from it. */
  route?: readonly ExecutionRouteEntry[];
  /** Typical durations of the version, shown on a definition. */
  statistics?: WorkflowVersionStatistics | null;
  /** On a definition: the statistics are still being fetched / their fetch failed. */
  statisticsPending?: boolean;
  statisticsError?: string | null;
  /** Route cursor (visit sequence number); null means the whole run. */
  cursor?: number | null;
  onSelectBlock: (blockId: string | null) => void;
  /** Move the route cursor to a visit of this block; absent where there is no cursor. */
  onSetCursor?: (at: number | null) => void;
  onFocusNode: (nodeId: string) => void;
  /** A list item to open the list section at and mark (from a click on the card). */
  listHighlight?: HighlightRequest | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { definition, enabled: editing } = useEditing();
  const steps = useMemo(
    () => (block ? stepsOf(workflow, orderNodeIds(workflow, block.nodeIds)) : []),
    [workflow, block],
  );
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
          <h3 className="flex min-w-0 flex-1 items-center gap-2 text-base font-semibold leading-6">
            <IndexBadge index={block.index + 1} tone={BLOCK_TONE[block.status]} />
            <span className="min-w-0">
              {editing ? <BlockNameEditor block={block} /> : block.name}
            </span>
          </h3>
          <StatusChip status={block.status} waitingFor={waitingFor} />
        </div>
        <DiagnosticBadge blockId={block.id} />
        {editing ? (
          <BlockSummaryEditor block={block} className="block text-sm leading-6" />
        ) : (
          <p className="text-sm leading-6 text-foreground/85">{block.description}</p>
        )}
        {!definition && (
          <p className="text-[11px] text-muted-foreground" data-testid="block-detail-facts">
            {t("pages.runPage.stepCount", { count: steps.length })}
            {block.iterations > 1 && ` · ${t("pages.runPage.ran", { count: block.iterations })}`}
            {block.visits > 0 && ` · ${t("pages.runPage.visited", { count: block.visits })}`}
          </p>
        )}
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

      {progress && (
        <PanelSection
          id="timings"
          title={t("pages.runPage.blockDetail.time", { defaultValue: "Время" })}
          summary={
            block.timing.totalMs !== null
              ? `${formatDuration(block.timing.totalMs, t)}${block.iterations > 1 ? ` · ×${block.iterations}` : ""}`
              : undefined
          }
        >
          <BlockTimings block={block} statistics={statistics} cursor={cursor} />
        </PanelSection>
      )}
      {progress && block.list && (block.list.done !== null || block.list.total !== null) && (
        <PanelSection
          id="list"
          title={t("pages.runPage.blockDetail.list", { defaultValue: "Список" })}
          summary={`${block.list.done ?? "?"}/${block.list.total ?? "?"}${block.list.currentTitle ? ` · ${block.list.currentTitle}` : ""}`}
          openToken={listHighlight?.token}
        >
          <BlockListCard block={block} highlight={listHighlight} />
        </PanelSection>
      )}
      {progress && (
        <PanelSection
          id="writes"
          title={t("pages.runPage.variables.wrote")}
          defaultOpen={false}
          summary={String(blockWrites(progress, block.id, cursor).length)}
        >
          <BlockWrites progress={progress} block={block} cursor={cursor} />
        </PanelSection>
      )}
      {definition && (
        <TypicalDurations
          blockId={block.id}
          statistics={statistics}
          pending={statisticsPending}
          error={statisticsError}
        />
      )}

      {block.transitions.length > 0 && (
        <PanelSection
          id="transitions"
          title={t("pages.runPage.blockDetail.transitions")}
          summary={String(block.transitions.length)}
        >
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
                    <TransitionEditor transition={transition} className="ml-1 align-text-bottom" />
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
                        {t("pages.runPage.map.endsWhen")} {transition.cycle.exit}
                      </span>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </PanelSection>
      )}

      {progress && route && onSetCursor && (
        <PanelSection
          id="route"
          title={t("pages.runPage.blockDetail.routeFacts", {
            defaultValue: "Что здесь происходило",
          })}
          defaultOpen={false}
          summary={String(block.visits)}
        >
          <BlockRouteFacts block={block} route={route} cursor={cursor} onSetCursor={onSetCursor} />
        </PanelSection>
      )}

      <PanelSection
        id="steps"
        title={t("pages.runPage.blockDetail.steps")}
        summary={String(block.nodeIds.length)}
        defaultOpen={false}
      >
        {editing ? (
          <EditableSteps
            block={block}
            blocks={blocks}
            workflow={workflow}
            onSelectBlock={onSelectBlock}
          />
        ) : (
          <>
            <StepList steps={steps} currentNodeId={block.currentNodeId} onFocusNode={onFocusNode} />
            <p className="mt-1 text-[11px] text-muted-foreground">
              {t("pages.runPage.blockDetail.stepsHint")}
            </p>
          </>
        )}
      </PanelSection>
    </div>
  );
}
