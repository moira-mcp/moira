/**
 * Route — follow the recorded run.
 *
 * The run is shown as the route it actually took: consecutive visits inside one block form a
 * stretch, stretches follow each other in the order they happened, and a return to an earlier
 * block is marked where it happened. On the left, a "visits per block" summary gives the counts
 * at a glance. A cursor (the `at` URL parameter) marks how far along the route the reader is;
 * visits after it are dimmed, and the same cursor drives the block states in every other mode.
 */

import React, { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, CornerLeftUp, Hourglass, MapPin, RotateCcw, UserRound } from "lucide-react";
import type { ExecutionRouteEntry } from "@mcp-moira/workflow-engine/progress-visual";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StatusChip, StatusIcon } from "./status";
import { NodeTypeTag } from "./nodeTypeStyle";
import { GuidanceCallout } from "./Guidance";
import { ROUTING_NODE_TYPES, type RunBlock, type RunViewProps } from "./model";
import { blockRouteStats, changesText, exitLabel, segmentsOf, type RouteSegment } from "./route";

function VisitRow({
  visit,
  blocks,
  nodeType,
  cursor,
  onSetCursor,
  nextBlockName,
}: {
  visit: ExecutionRouteEntry;
  blocks: RunBlock[];
  nodeType: string;
  cursor: number | null;
  onSetCursor: (at: number) => void;
  nextBlockName?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const routing = ROUTING_NODE_TYPES.has(nodeType);
  const beyond = cursor !== null && visit.seq > cursor;
  const isCursor = cursor === visit.seq;
  const exit = exitLabel(visit, blocks);
  const changes = changesText(visit.changed);
  const teleport = visit.exitKey === "teleport";
  return (
    <li
      id={`route-visit-${visit.seq}`}
      data-visit-seq={visit.seq}
      data-node-id={visit.nodeId}
      data-beyond={beyond ? "true" : undefined}
      data-adjusted={visit.adjusted ? "true" : undefined}
      data-loop={visit.loop ? "true" : undefined}
      aria-current={isCursor ? "step" : undefined}
      className={cn(
        "group flex cursor-pointer items-start gap-2 rounded-md px-2 transition",
        routing || visit.adjusted ? "py-0.5 text-[11px] text-muted-foreground" : "py-1.5 text-sm",
        beyond && "opacity-40",
        isCursor && "bg-primary/10 ring-1 ring-primary/40",
        visit.adjusted && "border-l-2 border-warning",
      )}
      onClick={() => onSetCursor(visit.seq)}
    >
      <span className="w-8 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
        {visit.seq}
      </span>
      {visit.adjusted ? (
        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-md border border-warning bg-warning/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-warning-foreground">
          <UserRound className="size-3" aria-hidden="true" />
          {t(`pages.runPage.route.actor.${visit.actor?.role ?? "user"}`)}
        </span>
      ) : (
        <NodeTypeTag type={nodeType} className={cn("mt-0.5", routing && "scale-90")} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={cn("font-mono", routing ? "text-[11px]" : "text-xs font-medium")}>
            {visit.nodeId}
          </span>
          {visit.adjusted && (
            <span className="rounded-full bg-warning/20 px-1.5 text-[10px] font-medium leading-4 text-warning-foreground">
              {t("pages.runPage.route.adjusted")}
            </span>
          )}
          {visit.exitKey && (
            <span className="inline-flex items-center gap-1 rounded border px-1 text-[10px] leading-4 text-muted-foreground">
              {teleport ? (
                <>
                  <CornerLeftUp className="size-3" aria-hidden="true" />
                  {t("pages.runPage.route.teleport")}
                </>
              ) : (
                <>
                  {visit.exitKey}
                  {exit ? <span className="text-foreground/80">· {exit.label}</span> : null}
                  {nextBlockName ? <span className="text-primary">→ {nextBlockName}</span> : null}
                </>
              )}
            </span>
          )}
          {visit.waited && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 text-[10px] font-medium leading-4 text-warning-foreground">
              <Hourglass className="size-3" aria-hidden="true" />
              {t("pages.runPage.route.waited")}
            </span>
          )}
          {visit.loop && (
            <span className="inline-flex items-center gap-1 text-[10px] font-medium text-primary">
              <RotateCcw className="size-3" aria-hidden="true" />
              {t("pages.runPage.route.loopVisit")}
            </span>
          )}
          {isCursor && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground">
              <MapPin className="size-3" aria-hidden="true" />
              {t("pages.runPage.route.cursor")}
            </span>
          )}
        </div>
        {changes && (
          <p
            className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
            title={changes}
          >
            {t("pages.runPage.route.changed")} {changes}
          </p>
        )}
      </div>
    </li>
  );
}

function SegmentCard({
  segment,
  blocks,
  nodeTypes,
  cursor,
  onSetCursor,
  selected,
  onSelectBlock,
  nextSegment,
}: {
  segment: RouteSegment;
  blocks: RunBlock[];
  nodeTypes: Map<string, string>;
  cursor: number | null;
  onSetCursor: (at: number) => void;
  selected: boolean;
  onSelectBlock: (id: string | null) => void;
  nextSegment?: RouteSegment;
}): React.JSX.Element {
  const { t } = useTranslation();
  const block = blocks.find((b) => b.id === segment.blockId);
  const nextBlock = nextSegment ? blocks.find((b) => b.id === nextSegment.blockId) : undefined;
  const containsCursor = cursor !== null && segment.visits.some((v) => v.seq === cursor);
  const wholeBeyond = cursor !== null && segment.visits[0].seq > cursor;
  const [open, setOpen] = React.useState(true);
  useEffect(() => {
    if (containsCursor) setOpen(true);
  }, [containsCursor]);
  const working = segment.visits.filter(
    (v) => !v.adjusted && !ROUTING_NODE_TYPES.has(nodeTypes.get(v.nodeId) ?? ""),
  ).length;

  return (
    <li
      className="relative pl-6"
      data-segment-index={segment.index}
      data-segment-block={segment.blockId ?? ""}
      data-loop={segment.loopsBackTo ? "true" : undefined}
    >
      <span
        className={cn(
          "absolute left-[7px] top-3 size-3 rounded-full border-2 bg-background",
          containsCursor ? "border-primary" : "border-border",
        )}
        aria-hidden="true"
      />
      <Collapsible open={open} onOpenChange={setOpen}>
        <div
          className={cn(
            "rounded-lg border bg-card transition",
            selected && "ring-2 ring-ring",
            wholeBeyond && "opacity-50",
          )}
        >
          <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <button
              type="button"
              className="text-left text-sm font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelectBlock(selected ? null : segment.blockId)}
              aria-pressed={selected}
            >
              {block?.name ?? segment.blockId ?? t("pages.runPage.route.noBlock")}
            </button>
            {segment.entry > 1 && (
              <span
                className="rounded-full bg-success/15 px-1.5 text-[10px] font-semibold leading-4 text-success"
                data-testid="segment-entry"
              >
                {t("pages.runPage.route.entry", { n: segment.entry })}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {t("pages.runPage.route.segmentSize", { visits: segment.visits.length, working })}
            </span>
            <CollapsibleTrigger
              className="ml-auto inline-flex items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("pages.runPage.route.toggleSegment")}
            >
              <ChevronDown
                className={cn("size-4 transition-transform", open && "rotate-180")}
                aria-hidden="true"
              />
            </CollapsibleTrigger>
          </header>
          <CollapsibleContent>
            <ol className="border-t px-1 py-1">
              {segment.visits.map((visit, i) => (
                <VisitRow
                  key={visit.seq}
                  visit={visit}
                  blocks={blocks}
                  nodeType={nodeTypes.get(visit.nodeId) ?? "unknown"}
                  cursor={cursor}
                  onSetCursor={onSetCursor}
                  nextBlockName={
                    i === segment.visits.length - 1 && nextBlock ? nextBlock.name : undefined
                  }
                />
              ))}
            </ol>
          </CollapsibleContent>
        </div>
      </Collapsible>
      {segment.loopsBackTo && (
        <p
          className="mt-1 flex items-center gap-1.5 pl-1 text-xs font-medium text-primary"
          data-loop-marker={segment.loopsBackTo}
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {t("pages.runPage.route.loopMarker", {
            block: blocks.find((b) => b.id === segment.loopsBackTo)?.name ?? segment.loopsBackTo,
          })}
        </p>
      )}
    </li>
  );
}

export function RouteView({
  progress,
  blocks,
  route,
  workflow,
  selectedBlockId,
  onSelectBlock,
  cursor,
  onSetCursor,
}: RunViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const segments = useMemo(() => segmentsOf(route, blocks), [route, blocks]);
  const stats = useMemo(() => blockRouteStats(route, blocks, cursor), [route, blocks, cursor]);
  const nodeTypes = useMemo(
    () => new Map((workflow?.nodes ?? []).map((node) => [node.id, node.type])),
    [workflow],
  );
  useEffect(() => {
    if (cursor === null) return;
    document
      .getElementById(`route-visit-${cursor}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [cursor]);

  if (!progress.routeRecorded) {
    return (
      <div className="p-4">
        <GuidanceCallout
          title={t("pages.runPage.route.noRouteTitle")}
          testId="guidance-route-empty"
        >
          {t("pages.runPage.route.noRouteBody")}
        </GuidanceCallout>
      </div>
    );
  }

  const loops = segments.filter((s) => s.loopsBackTo).length;
  const adjustments = route.filter((v) => v.adjusted).length;
  const runStatus =
    progress.executionStatus === "completed"
      ? "completed"
      : blocks.some((b) => b.status === "waiting")
        ? "waiting"
        : "running";

  return (
    <div className="scrollbar-thin h-full space-y-4 overflow-auto p-4" data-testid="route-view">
      <GuidanceCallout title={t("pages.runPage.modeGuide.route.title")} testId="guidance-route">
        {t("pages.runPage.modeGuide.route.body")}
      </GuidanceCallout>

      <div className="grid gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
          <dl className="grid grid-cols-4 gap-2 rounded-lg border bg-card p-3 text-center text-sm">
            {(
              [
                ["visits", route.length],
                ["segments", segments.length],
                ["loops", loops],
                ["adjustments", adjustments],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="rounded-md bg-muted/50 py-1.5">
                <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t(`pages.runPage.route.stat.${k}`)}
                </dt>
                <dd className="text-lg font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="rounded-lg border bg-card" data-testid="route-block-summary">
            <p className="border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("pages.runPage.route.perBlock")}
            </p>
            <ol className="divide-y">
              {blocks.map((block) => {
                const s = stats.get(block.id);
                const max = Math.max(1, ...[...stats.values()].map((x) => x.visits));
                const first = s?.firstSeq;
                return (
                  <li key={block.id}>
                    <button
                      type="button"
                      data-summary-block={block.id}
                      data-entries={s?.entries ?? 0}
                      data-node-visits={s?.visits ?? 0}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selectedBlockId === block.id && "bg-accent",
                      )}
                      onClick={() => {
                        onSelectBlock(block.id);
                        if (first !== undefined) onSetCursor(first);
                      }}
                    >
                      <StatusIcon status={block.status} className="size-3.5" />
                      <span className="w-28 truncate">{block.name}</span>
                      <span className="relative h-2 flex-1 overflow-hidden rounded bg-muted">
                        <span
                          className="absolute inset-y-0 left-0 rounded bg-primary/60"
                          style={{ width: `${((s?.visits ?? 0) / max) * 100}%` }}
                        />
                      </span>
                      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                        {s?.entries ? `${s.entries}× · ${s.visits}` : "—"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="px-3 py-1.5 text-[10px] text-muted-foreground">
              {t("pages.runPage.route.perBlockLegend")}
            </p>
          </div>
        </aside>

        <ol
          className="relative space-y-2 border-l-2 border-border/70 pl-2"
          data-testid="route-list"
        >
          {segments.map((segment, i) => (
            <SegmentCard
              key={segment.index}
              segment={segment}
              blocks={blocks}
              nodeTypes={nodeTypes}
              cursor={cursor}
              onSetCursor={onSetCursor}
              selected={selectedBlockId === segment.blockId}
              onSelectBlock={onSelectBlock}
              nextSegment={segments[i + 1]}
            />
          ))}
          <li className="flex items-center gap-2 pl-6 text-xs text-muted-foreground">
            <StatusChip
              status={
                runStatus === "completed" ? "done" : runStatus === "waiting" ? "waiting" : "active"
              }
            />
            {t(`pages.runPage.route.runStatus.${runStatus}`)}
          </li>
        </ol>
      </div>
    </div>
  );
}
