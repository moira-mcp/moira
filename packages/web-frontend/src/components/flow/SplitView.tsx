/**
 * Split — blocks against their implementation.
 *
 * Left: the blocks as a compact list in process order. Right: the steps the selected block owns,
 * in traversal order from the block's entry nodes, each with its type, summary, expected
 * evidence and outgoing connections. Connections that stay inside the block point at rows; those
 * that leave it are chips naming the target block, and clicking one selects that block. A node
 * finder above the block list answers the reverse question — which block owns this step. In edit
 * mode a step can be moved to another block and its authored text edited in place; the block's
 * name and description are editable in the header. Nothing is laid out by a graph engine.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { GuidanceCallout } from "../run/Guidance";
import { NodeTypeTag } from "../run/nodeTypeStyle";
import {
  blockById,
  nodeOwners,
  stepConnections,
  stepsOf,
  type RunBlock,
  type RunViewProps,
} from "../run/model";
import { StepCard, StepCardList } from "../run/StepCard";
import type { StepInfo } from "../run/model";
import type { WorkflowGraph, WorkflowNode } from "../../types/workflow-types";
import {
  BlockNameEditor,
  BlockSummaryEditor,
  DiagnosticBadge,
  NodeTextEditor,
  OwnerSelect,
} from "./EditControls";
import { useEditing } from "./editing";

/** Nodes of a block in traversal order: entry nodes first, then breadth-first along in-block edges. */
export function orderedNodeIds(workflow: WorkflowGraph | undefined, block: RunBlock): string[] {
  const nodes = new Map((workflow?.nodes ?? []).map((n) => [n.id, n]));
  const inBlock = new Set(block.nodeIds);
  const targetedFromInside = new Set<string>();
  for (const id of block.nodeIds) {
    for (const target of Object.values(nodes.get(id)?.connections ?? {})) {
      if (inBlock.has(target) && target !== id) targetedFromInside.add(target);
    }
  }
  const entries = block.nodeIds.filter((id) => !targetedFromInside.has(id));
  const queue = entries.length > 0 ? [...entries] : block.nodeIds.slice(0, 1);
  const seen = new Set<string>();
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id) || !inBlock.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const target of Object.values(nodes.get(id)?.connections ?? {})) {
      if (inBlock.has(target) && !seen.has(target)) queue.push(target);
    }
  }
  for (const id of block.nodeIds) if (!seen.has(id)) order.push(id);
  return order;
}

function BlockRow({
  block,
  selected,
  onSelect,
}: {
  block: RunBlock;
  selected: boolean;
  onSelect: (id: string | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(block.id)}
        aria-pressed={selected}
        data-block-id={block.id}
        data-testid={`split-block-${block.id}`}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-lg border-l-[3px] border-border px-3 py-2 text-left transition",
          "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "bg-accent" : "bg-transparent",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium leading-5">
            <span className="mr-1.5 tabular-nums text-muted-foreground">{block.index + 1}.</span>
            {block.name}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {t("pages.runPage.stepCount", { count: block.nodeIds.length })}
          </span>
        </span>
      </button>
    </li>
  );
}

function NodeFinder({
  blocks,
  steps,
  onPick,
}: {
  blocks: RunBlock[];
  steps: StepInfo[];
  onPick: (blockId: string, nodeId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const owners = useMemo(() => nodeOwners(blocks), [blocks]);
  const byId = blockById(blocks);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return steps
      .filter((n) => n.id.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q))
      .slice(0, 8)
      .map((n) => ({ step: n, owner: byId.get(owners.get(n.id) ?? "") }));
  }, [steps, query, owners, byId]);

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("pages.flowPage.split.findNode")}
        aria-label={t("pages.flowPage.split.findNode")}
        className="h-9 pl-8 text-sm"
        data-testid="split-node-finder"
      />
      {query.trim() && (
        <ul
          className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md"
          role="listbox"
        >
          {matches.length === 0 && (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {t("pages.flowPage.split.noMatch")}
            </li>
          )}
          {matches.map(({ step, owner }) => (
            <li key={step.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => {
                  if (owner) onPick(owner.id, step.id);
                  setQuery("");
                }}
                data-node-match={step.id}
              >
                <NodeTypeTag type={step.type} />
                <span className="truncate font-mono">{step.id}</span>
                {owner && (
                  <span className="ml-auto shrink-0 text-muted-foreground">
                    <CornerDownLeft className="mr-1 inline size-3" aria-hidden="true" />
                    {owner.name}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NodeRow({
  step,
  node,
  position,
  block,
  blocks,
  highlighted,
  onSelectBlock,
  onJumpToNode,
}: {
  step: StepInfo;
  node: WorkflowNode | undefined;
  position: number;
  block: RunBlock;
  blocks: RunBlock[];
  highlighted: boolean;
  onSelectBlock: (id: string) => void;
  onJumpToNode: (id: string) => void;
}): React.JSX.Element {
  const connections = stepConnections(node, block, blocks);
  return (
    <StepCard
      id={`split-node-${step.id}`}
      step={step}
      position={position + 1}
      highlighted={highlighted}
      connections={connections}
      onConnection={(connection) =>
        connection.internal
          ? onJumpToNode(connection.target)
          : connection.targetBlockId && onSelectBlock(connection.targetBlockId)
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
}

export function SplitView({
  blocks,
  workflow,
  selectedBlockId,
  onSelectBlock,
}: RunViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const { enabled } = useEditing();
  const byId = blockById(blocks);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const pendingNodeId = useRef<string | null>(null);

  const effectiveId = selectedBlockId ?? blocks[0]?.id ?? null;
  const block = effectiveId ? byId.get(effectiveId) : undefined;
  const nodeIds = useMemo(() => (block ? orderedNodeIds(workflow, block) : []), [workflow, block]);
  const steps = useMemo(() => stepsOf(workflow, nodeIds), [workflow, nodeIds]);
  const allSteps = useMemo(
    () =>
      stepsOf(
        workflow,
        blocks.flatMap((b) => b.nodeIds),
      ),
    [workflow, blocks],
  );
  const nodes = useMemo(() => new Map((workflow?.nodes ?? []).map((n) => [n.id, n])), [workflow]);

  const jumpToNode = (nodeId: string): void => {
    setHighlightedNodeId(nodeId);
    document
      .getElementById(`split-node-${nodeId}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  useEffect(() => {
    const pending = pendingNodeId.current;
    pendingNodeId.current = null;
    if (pending) {
      setHighlightedNodeId(pending);
      listRef.current
        ?.querySelector(`[data-node-id="${CSS.escape(pending)}"]`)
        ?.scrollIntoView({ block: "center" });
      return;
    }
    setHighlightedNodeId(null);
  }, [block?.id]);

  return (
    <div className="scrollbar-thin h-full space-y-4 overflow-auto p-4" data-testid="split-view">
      <GuidanceCallout title={t("pages.flowPage.modeGuide.split.title")} testId="guidance-split">
        {t("pages.flowPage.modeGuide.split.body")}
      </GuidanceCallout>
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="space-y-3">
          <NodeFinder
            blocks={blocks}
            steps={allSteps}
            onPick={(blockId, nodeId) => {
              if (blockId === block?.id) {
                jumpToNode(nodeId);
                return;
              }
              pendingNodeId.current = nodeId;
              onSelectBlock(blockId);
            }}
          />
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pages.flowPage.split.blocks")}
          </p>
          <ol className="space-y-1" data-testid="split-blocks">
            {blocks.map((b) => (
              <BlockRow
                key={b.id}
                block={b}
                selected={b.id === effectiveId}
                onSelect={onSelectBlock}
              />
            ))}
          </ol>
        </aside>

        <section
          className="flex min-h-[420px] flex-col overflow-hidden rounded-xl border bg-card"
          aria-label={t("pages.flowPage.split.implementation")}
          data-testid="split-implementation"
          data-block-id={block?.id}
        >
          {block ? (
            <>
              <header className="space-y-2 border-b px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="min-w-0 flex-1 text-base font-semibold leading-6">
                    {enabled ? <BlockNameEditor block={block} /> : block.name}
                  </h3>
                  <span className="text-xs text-muted-foreground">
                    {t("pages.runPage.stepCount", { count: block.nodeIds.length })}
                  </span>
                </div>
                <DiagnosticBadge blockId={block.id} />
                {enabled ? (
                  <BlockSummaryEditor block={block} className="block text-sm leading-6" />
                ) : (
                  <p className="text-sm leading-6 text-foreground/85">{block.description}</p>
                )}
              </header>
              <StepCardList listRef={listRef} className="flex-1 p-3" testId="split-nodes">
                {steps.map((step, position) => (
                  <NodeRow
                    key={step.id}
                    step={step}
                    node={nodes.get(step.id)}
                    position={position}
                    block={block}
                    blocks={blocks}
                    highlighted={highlightedNodeId === step.id}
                    onSelectBlock={onSelectBlock}
                    onJumpToNode={jumpToNode}
                  />
                ))}
              </StepCardList>
            </>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              {t("pages.flowPage.split.pickBlock")}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
