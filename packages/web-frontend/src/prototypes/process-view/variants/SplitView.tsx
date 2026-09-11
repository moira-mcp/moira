/**
 * Split variant — blocks against their implementation.
 *
 * Left: the aggregated blocks as a compact list in process order. Right: the authored nodes the
 * selected block claims, in traversal order from the block's entry nodes, each with its type,
 * summary and outgoing connections. Connections that stay inside the block point at rows; those
 * that leave it are chips naming the target block, and clicking one selects that block. A node
 * finder above the block list answers the reverse question — which block owns this node — and
 * selects it. Nothing is laid out by a graph engine, so a 27-node block stays a scrollable list.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownRight, ArrowUpRight, CornerDownLeft, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { StatusChip, StatusIcon, STATUS_STYLE } from "../shared/status";
import { NodeTypeTag } from "../shared/nodeTypeStyle";
import { OwnerSelect } from "../shared/EditControls";
import { BlockVariables } from "../shared/VariablesPanel";
import { GuidanceCallout } from "../shared/Guidance";
import type { VariantProps } from "../shared/BlockCards";
import {
  blockById,
  nodeById,
  ownerOf,
  runStateOf,
  type AuthoredNode,
  type ProcessBlock,
  type ProcessProjection,
} from "../model";

/** Nodes of a block in traversal order: entry nodes first, then breadth-first along in-block edges. */
function orderedNodes(projection: ProcessProjection, block: ProcessBlock): AuthoredNode[] {
  const nodes = nodeById(projection);
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
  const order: AuthoredNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id) || !inBlock.has(id)) continue;
    seen.add(id);
    const node = nodes.get(id);
    if (!node) continue;
    order.push(node);
    for (const target of Object.values(node.connections)) {
      if (inBlock.has(target) && !seen.has(target)) queue.push(target);
    }
  }
  for (const id of block.nodeIds) {
    const node = nodes.get(id);
    if (node && !seen.has(id)) order.push(node);
  }
  return order;
}

/** Incoming edges from nodes owned by other blocks. */
function entriesFromOutside(
  projection: ProcessProjection,
  block: ProcessBlock,
): Array<{ from: ProcessBlock; via: string; toNodeId: string }> {
  const inBlock = new Set(block.nodeIds);
  const result: Array<{ from: ProcessBlock; via: string; toNodeId: string }> = [];
  for (const node of projection.authored) {
    if (inBlock.has(node.id)) continue;
    const owner = ownerOf(projection, node.id);
    if (!owner) continue;
    for (const [label, target] of Object.entries(node.connections)) {
      if (inBlock.has(target)) result.push({ from: owner, via: label, toNodeId: target });
    }
  }
  return result;
}

function BlockRow({
  block,
  index,
  projection,
  selected,
  onSelect,
}: {
  block: ProcessBlock;
  index: number;
  projection: ProcessProjection;
  selected: boolean;
  onSelect: (id: string | null) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const state = runStateOf(projection, block.id);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(block.id)}
        aria-pressed={selected}
        aria-current={state.status === "active" ? "step" : undefined}
        data-block-id={block.id}
        data-status={state.status}
        className={cn(
          "flex w-full items-start gap-2.5 rounded-lg border-l-[3px] px-3 py-2 text-left transition",
          "hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          STATUS_STYLE[state.status].surface
            .split(" ")
            .find((c) => c.startsWith("border-") && !c.startsWith("border-dashed")) ??
            "border-border",
          selected ? "bg-accent shadow-sm" : "bg-transparent",
          state.status === "skipped" && "opacity-70",
        )}
      >
        <StatusIcon status={state.status} className="mt-1" />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-sm font-medium leading-5",
              state.status === "skipped" && "line-through",
              state.status === "pending" && "text-muted-foreground",
            )}
          >
            <span className="mr-1.5 tabular-nums text-muted-foreground">{index + 1}.</span>
            {block.name}
          </span>
          <span className="block text-[11px] text-muted-foreground">
            {[
              t("pages.processViewPrototype.nodeCount", { count: block.nodeIds.length }),
              state.status === "repeated" && state.iterations ? `×${state.iterations}` : null,
              state.note ?? null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
      </button>
    </li>
  );
}

function NodeFinder({
  projection,
  onPick,
}: {
  projection: ProcessProjection;
  onPick: (blockId: string, nodeId: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return projection.authored
      .filter((n) => n.id.toLowerCase().includes(q) || n.summary.toLowerCase().includes(q))
      .slice(0, 8)
      .map((n) => ({ node: n, owner: ownerOf(projection, n.id) }));
  }, [projection, query]);

  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("pages.processViewPrototype.split.findNode")}
        aria-label={t("pages.processViewPrototype.split.findNode")}
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
              {t("pages.processViewPrototype.split.noMatch")}
            </li>
          )}
          {matches.map(({ node, owner }) => (
            <li key={node.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => {
                  if (owner) onPick(owner.id, node.id);
                  setQuery("");
                }}
                data-node-match={node.id}
              >
                <NodeTypeTag type={node.type} />
                <span className="truncate font-mono">{node.id}</span>
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
  node,
  position,
  block,
  projection,
  highlighted,
  isCurrent,
  onSelectBlock,
  onJumpToNode,
}: {
  node: AuthoredNode;
  position: number;
  block: ProcessBlock;
  projection: ProcessProjection;
  highlighted: boolean;
  isCurrent: boolean;
  onSelectBlock: (id: string) => void;
  onJumpToNode: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const blocks = blockById(projection);
  const inBlock = new Set(block.nodeIds);
  const connections = Object.entries(node.connections);

  return (
    <li
      id={`split-node-${node.id}`}
      data-node-id={node.id}
      aria-current={isCurrent ? "step" : undefined}
      className={cn(
        "relative flex gap-3 px-4 py-2.5 transition-colors",
        isCurrent && "bg-primary/5",
        highlighted && "bg-accent",
      )}
    >
      <span className="w-6 shrink-0 pt-0.5 text-right text-[11px] tabular-nums text-muted-foreground">
        {position + 1}
      </span>
      <NodeTypeTag type={node.type} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-mono text-xs font-medium">{node.id}</span>
          <OwnerSelect nodeId={node.id} currentBlockId={block.id} blocks={projection.blocks} />
          {isCurrent && (
            <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground">
              {t("pages.processViewPrototype.outline.current")}
            </span>
          )}
        </div>
        {node.summary && (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{node.summary}</p>
        )}
        {node.inputs?.length ? (
          <p
            className="mt-1 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground"
            data-node-inputs={node.inputs.join(",")}
          >
            <span>{t("pages.processViewPrototype.outline.returns")}</span>
            {node.inputs.map((field) => (
              <span key={field} className="rounded border bg-background px-1 font-mono leading-4">
                {field}
              </span>
            ))}
          </p>
        ) : null}
        {connections.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {connections.map(([label, target]) => {
              const internal = inBlock.has(target);
              const targetBlock = internal ? undefined : ownerOf(projection, target);
              return (
                <button
                  key={`${label}-${target}`}
                  type="button"
                  onClick={() =>
                    internal ? onJumpToNode(target) : targetBlock && onSelectBlock(targetBlock.id)
                  }
                  data-edge-kind={internal ? "internal" : "external"}
                  title={internal ? target : (blocks.get(targetBlock?.id ?? "")?.name ?? target)}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] leading-4 transition",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    internal
                      ? "border-border bg-background text-muted-foreground hover:bg-accent"
                      : "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10",
                  )}
                >
                  {internal ? (
                    <ArrowDownRight className="size-3 shrink-0" aria-hidden="true" />
                  ) : (
                    <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
                  )}
                  <span className="font-medium">{label}</span>
                  <span className="truncate opacity-80">
                    {internal ? target : (targetBlock?.name ?? target)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </li>
  );
}

export function SplitView({
  projection,
  selectedBlockId,
  onSelectBlock,
  trace,
  cursor,
}: VariantProps): React.JSX.Element {
  const { t } = useTranslation();
  const blocks = blockById(projection);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const pendingNodeId = useRef<string | null>(null);

  // With nothing selected, open on the block the run is at so the pane is never empty.
  const effectiveId =
    selectedBlockId ??
    projection.blocks.find((b) =>
      ["active", "waiting"].includes(runStateOf(projection, b.id).status),
    )?.id ??
    projection.blocks[0]?.id ??
    null;
  const block = effectiveId ? blocks.get(effectiveId) : undefined;
  const state = block ? runStateOf(projection, block.id) : undefined;
  const nodes = useMemo(() => (block ? orderedNodes(projection, block) : []), [projection, block]);
  const entries = useMemo(
    () => (block ? entriesFromOutside(projection, block) : []),
    [projection, block],
  );

  const jumpToNode = (nodeId: string): void => {
    setHighlightedNodeId(nodeId);
    document
      .getElementById(`split-node-${nodeId}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  // When the pane changes: apply a highlight requested before the change (node finder), otherwise
  // drop a stale one and scroll the current node into view.
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
    const currentId = state?.currentNodeId;
    if (!currentId || !listRef.current) return;
    listRef.current
      .querySelector(`[data-node-id="${CSS.escape(currentId)}"]`)
      ?.scrollIntoView({ block: "center" });
  }, [block?.id, state?.currentNodeId]);

  return (
    <div className="space-y-4">
      <GuidanceCallout
        title={t("pages.processViewPrototype.modeGuide.split.title")}
        testId="guidance-split"
      >
        {t("pages.processViewPrototype.modeGuide.split.body")}
      </GuidanceCallout>
      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-3">
          <NodeFinder
            projection={projection}
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
            {t("pages.processViewPrototype.split.blocks")}
          </p>
          <ol className="space-y-1" data-testid="split-blocks">
            {projection.blocks.map((b, index) => (
              <BlockRow
                key={b.id}
                block={b}
                index={index}
                projection={projection}
                selected={b.id === effectiveId}
                onSelect={onSelectBlock}
              />
            ))}
          </ol>
        </aside>

        <section
          className="flex min-h-[560px] flex-col overflow-hidden rounded-xl border bg-card"
          aria-label={t("pages.processViewPrototype.split.implementation")}
          data-testid="split-implementation"
          data-block-id={block?.id}
        >
          {block && state ? (
            <>
              <header className="space-y-2 border-b px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="text-base font-semibold leading-6">{block.name}</h3>
                  <StatusChip state={state} />
                  {state.note && (
                    <span className="text-sm text-muted-foreground">{state.note}</span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {t("pages.processViewPrototype.nodeCount", { count: block.nodeIds.length })}
                  </span>
                </div>
                <p className="text-sm leading-6 text-foreground/85">{block.description}</p>
                <BlockVariables
                  projection={projection}
                  trace={trace}
                  cursor={cursor}
                  blockId={block.id}
                />
                {entries.length > 0 && (
                  <p className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                    <span className="mr-1">{t("pages.processViewPrototype.split.entersFrom")}</span>
                    {entries.map((e) => (
                      <button
                        key={`${e.from.id}-${e.via}-${e.toNodeId}`}
                        type="button"
                        onClick={() => onSelectBlock(e.from.id)}
                        className="inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        title={`${e.via} → ${e.toNodeId}`}
                      >
                        <CornerDownLeft className="size-3" aria-hidden="true" />
                        {e.from.name}
                        <span className="opacity-70">· {e.via}</span>
                      </button>
                    ))}
                  </p>
                )}
              </header>
              <ol
                ref={listRef}
                className="max-h-[640px] flex-1 divide-y overflow-y-auto"
                data-testid="split-nodes"
              >
                {nodes.map((node, position) => (
                  <NodeRow
                    key={node.id}
                    node={node}
                    position={position}
                    block={block}
                    projection={projection}
                    highlighted={highlightedNodeId === node.id}
                    isCurrent={state.currentNodeId === node.id}
                    onSelectBlock={onSelectBlock}
                    onJumpToNode={jumpToNode}
                  />
                ))}
              </ol>
            </>
          ) : (
            <p className="p-6 text-sm text-muted-foreground">
              {t("pages.processViewPrototype.split.pickBlock")}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
