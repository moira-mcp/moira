/**
 * Trace variant — follow a recorded run.
 *
 * The run is shown as the route it actually took: consecutive visits inside one block form a
 * segment, segments follow each other in the order they happened, and a return to an earlier block
 * is marked where it happened. Above the route, a compact "visits per block" summary gives the
 * counts at a glance. A cursor (the `at` URL parameter) marks how far along the route the reader
 * is; visits after it are dimmed, and the same cursor drives the block states in every other mode.
 */

import React, { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, CornerLeftUp, Hourglass, MapPin, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { StatusChip, StatusIcon } from "../shared/status";
import { NodeTypeTag } from "../shared/nodeTypeStyle";
import { GuidanceCallout } from "../shared/Guidance";
import type { VariantProps } from "../shared/BlockCards";
import { nodeById, runStateOf, type ProcessProjection } from "../model";
import { blockStats, type RunTrace, type TraceVisit } from "../trace";

interface Segment {
  index: number;
  blockId: string;
  /** Which entry into this block this segment is (1-based). */
  entry: number;
  visits: TraceVisit[];
  /** The segment ends with a return to an earlier block (by process order). */
  loopsBackTo?: string;
}

function segmentsOf(projection: ProcessProjection, trace: RunTrace): Segment[] {
  const owner = new Map<string, string>();
  for (const b of projection.blocks) for (const id of b.nodeIds) owner.set(id, b.id);
  const order = new Map(projection.blocks.map((b, i) => [b.id, i]));
  const entries = new Map<string, number>();
  const segments: Segment[] = [];
  for (const visit of trace.visits) {
    const blockId = owner.get(visit.nodeId) ?? "?";
    const last = segments[segments.length - 1];
    if (last && last.blockId === blockId) {
      last.visits.push(visit);
      continue;
    }
    const entry = (entries.get(blockId) ?? 0) + 1;
    entries.set(blockId, entry);
    segments.push({ index: segments.length, blockId, entry, visits: [visit] });
  }
  for (let i = 0; i < segments.length - 1; i++) {
    const from = order.get(segments[i].blockId) ?? -1;
    const to = order.get(segments[i + 1].blockId) ?? -1;
    if (to < from) segments[i].loopsBackTo = segments[i + 1].blockId;
  }
  return segments;
}

function changesText(changes: Record<string, unknown>): string {
  const entries = Object.entries(changes);
  if (entries.length === 0) return "";
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k} = ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" · ")
    .concat(entries.length > 3 ? ` · +${entries.length - 3}` : "");
}

const ROUTING = new Set(["start", "condition", "expression"]);

function VisitRow({
  visit,
  projection,
  cursor,
  onSetCursor,
  nextBlockName,
}: {
  visit: TraceVisit;
  projection: ProcessProjection;
  cursor: number | null;
  onSetCursor: (at: number) => void;
  nextBlockName?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const nodes = nodeById(projection);
  const node = nodes.get(visit.nodeId);
  const routing = ROUTING.has(node?.type ?? "");
  const beyond = cursor !== null && visit.seq > cursor;
  const isCursor = cursor === visit.seq;
  const label =
    node?.connectionLabels && visit.exitKey && node.connectionLabels[visit.exitKey]
      ? typeof node.connectionLabels[visit.exitKey] === "string"
        ? (node.connectionLabels[visit.exitKey] as string)
        : (node.connectionLabels[visit.exitKey] as { label: string }).label
      : null;
  const changes = changesText(visit.changes);
  return (
    <li
      id={`trace-visit-${visit.seq}`}
      data-visit-seq={visit.seq}
      data-node-id={visit.nodeId}
      data-beyond={beyond ? "true" : undefined}
      aria-current={isCursor ? "step" : undefined}
      className={cn(
        "group flex cursor-pointer items-start gap-2 rounded-md px-2 transition",
        routing ? "py-0.5 text-[11px] text-muted-foreground" : "py-1.5 text-sm",
        beyond && "opacity-40",
        isCursor && "bg-primary/10 ring-1 ring-primary/40",
        visit.adjusted && "border-l-2 border-warning",
      )}
      data-adjusted={visit.adjusted ? "true" : undefined}
      onClick={() => onSetCursor(visit.seq)}
    >
      <span className="w-8 shrink-0 pt-0.5 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
        {visit.seq}
      </span>
      <NodeTypeTag type={node?.type ?? "unknown"} className={cn("mt-0.5", routing && "scale-90")} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={cn("font-mono", routing ? "text-[11px]" : "text-xs font-medium")}>
            {visit.nodeId}
          </span>
          {visit.exitKey && (
            <span className="inline-flex items-center gap-1 rounded border px-1 text-[10px] leading-4 text-muted-foreground">
              {visit.exitKey.startsWith("teleport:") ? (
                <>
                  <CornerLeftUp className="size-3" aria-hidden="true" />
                  {t("pages.processViewPrototype.traceView.teleport")} {visit.exitKey.slice(9)}
                </>
              ) : (
                <>
                  {visit.exitKey}
                  {label ? <span className="text-foreground/80">· {label}</span> : null}
                  {nextBlockName ? <span className="text-primary">→ {nextBlockName}</span> : null}
                </>
              )}
            </span>
          )}
          {visit.waited && (
            <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 text-[10px] font-medium leading-4 text-warning-foreground">
              <Hourglass className="size-3" aria-hidden="true" />
              {t("pages.processViewPrototype.traceView.waited")}
            </span>
          )}
          {visit.adjusted && (
            <span className="rounded-full bg-warning/20 px-1.5 text-[10px] font-medium leading-4 text-warning-foreground">
              {t("pages.processViewPrototype.variables.adjustedVisit")}
            </span>
          )}
          {visit.note && <span className="text-xs text-muted-foreground">{visit.note}</span>}
          {isCursor && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-4 text-primary-foreground">
              <MapPin className="size-3" aria-hidden="true" />
              {t("pages.processViewPrototype.traceView.cursor")}
            </span>
          )}
        </div>
        {!routing && node?.summary && (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{node.summary}</p>
        )}
        {changes && (
          <p
            className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground"
            title={changes}
          >
            {changes}
          </p>
        )}
      </div>
    </li>
  );
}

function SegmentCard({
  segment,
  projection,
  cursor,
  onSetCursor,
  selected,
  onSelectBlock,
  nextSegment,
}: {
  segment: Segment;
  projection: ProcessProjection;
  cursor: number | null;
  onSetCursor: (at: number) => void;
  selected: boolean;
  onSelectBlock: (id: string | null) => void;
  nextSegment?: Segment;
}): React.JSX.Element {
  const { t } = useTranslation();
  const block = projection.blocks.find((b) => b.id === segment.blockId);
  const nextBlock = nextSegment
    ? projection.blocks.find((b) => b.id === nextSegment.blockId)
    : undefined;
  const containsCursor = cursor !== null && segment.visits.some((v) => v.seq === cursor);
  const wholeBeyond = cursor !== null && segment.visits[0].seq > cursor;
  const [open, setOpen] = React.useState(true);
  useEffect(() => {
    if (containsCursor) setOpen(true);
  }, [containsCursor]);
  const working = segment.visits.filter(
    (v) => !ROUTING.has(nodeById(projection).get(v.nodeId)?.type ?? ""),
  ).length;

  return (
    <li
      className="relative pl-6"
      data-segment-index={segment.index}
      data-segment-block={segment.blockId}
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
              {block?.name ?? segment.blockId}
            </button>
            {segment.entry > 1 && (
              <span className="rounded-full bg-success/15 px-1.5 text-[10px] font-semibold leading-4 text-success">
                {t("pages.processViewPrototype.traceView.entry", { n: segment.entry })}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {t("pages.processViewPrototype.traceView.segmentSize", {
                visits: segment.visits.length,
                working,
              })}
            </span>
            <CollapsibleTrigger
              className="ml-auto inline-flex items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("pages.processViewPrototype.traceView.toggleSegment")}
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
                  projection={projection}
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
          {t("pages.processViewPrototype.traceView.loopMarker", {
            block:
              projection.blocks.find((b) => b.id === segment.loopsBackTo)?.name ??
              segment.loopsBackTo,
          })}
        </p>
      )}
    </li>
  );
}

export function TraceView({
  projection,
  selectedBlockId,
  onSelectBlock,
  trace,
  cursor = null,
  onSetCursor,
}: VariantProps): React.JSX.Element {
  const { t } = useTranslation();
  const segments = useMemo(() => (trace ? segmentsOf(projection, trace) : []), [projection, trace]);
  const stats = useMemo(
    () => (trace ? blockStats(projection, trace, cursor ?? undefined) : new Map()),
    [projection, trace, cursor],
  );
  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (cursor === null) return;
    document
      .getElementById(`trace-visit-${cursor}`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [cursor]);

  if (!trace) {
    return (
      <GuidanceCallout
        title={t("pages.processViewPrototype.traceView.noTraceTitle")}
        testId="guidance-trace-empty"
      >
        {t("pages.processViewPrototype.traceView.noTraceBody")}
      </GuidanceCallout>
    );
  }

  const loops = segments.filter((s) => s.loopsBackTo).length;
  const setCursor = (at: number): void => onSetCursor?.(at);

  return (
    <div className="space-y-4" data-testid="trace-view">
      <GuidanceCallout
        title={t("pages.processViewPrototype.traceView.guideTitle")}
        testId="guidance-trace"
      >
        {t("pages.processViewPrototype.traceView.guideBody")}
      </GuidanceCallout>

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-lg border bg-card p-3 text-sm">
            <p className="font-semibold">{trace.title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{trace.description}</p>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[
                ["visits", trace.visits.length],
                ["segments", segments.length],
                ["loops", loops],
              ].map(([k, v]) => (
                <div key={k} className="rounded-md bg-muted/50 py-1.5">
                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t(`pages.processViewPrototype.traceView.stat.${k}`)}
                  </dt>
                  <dd className="text-lg font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-lg border bg-card" data-testid="trace-block-summary">
            <p className="border-b px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("pages.processViewPrototype.traceView.perBlock")}
            </p>
            <ol className="divide-y">
              {projection.blocks.map((block) => {
                const s = stats.get(block.id);
                const state = runStateOf(projection, block.id);
                const max = Math.max(1, ...[...stats.values()].map((x) => x.nodeVisits));
                const first = s?.firstSeq;
                return (
                  <li key={block.id}>
                    <button
                      type="button"
                      data-summary-block={block.id}
                      data-entries={s?.entries ?? 0}
                      data-node-visits={s?.nodeVisits ?? 0}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        selectedBlockId === block.id && "bg-accent",
                      )}
                      onClick={() => {
                        onSelectBlock(block.id);
                        if (first !== undefined) setCursor(first);
                      }}
                    >
                      <StatusIcon status={state.status} className="size-3.5" />
                      <span className="w-32 truncate">{block.name}</span>
                      <span className="relative h-2 flex-1 overflow-hidden rounded bg-muted">
                        <span
                          className="absolute inset-y-0 left-0 rounded bg-primary/60"
                          style={{ width: `${((s?.nodeVisits ?? 0) / max) * 100}%` }}
                        />
                      </span>
                      <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
                        {s?.entries ? `${s.entries}× · ${s.nodeVisits}` : "—"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="px-3 py-1.5 text-[10px] text-muted-foreground">
              {t("pages.processViewPrototype.traceView.perBlockLegend")}
            </p>
          </div>
        </aside>

        <ol
          ref={listRef}
          className="relative space-y-2 border-l-2 border-border/70 pl-2"
          data-testid="trace-route"
        >
          {segments.map((segment, i) => (
            <SegmentCard
              key={segment.index}
              segment={segment}
              projection={projection}
              cursor={cursor}
              onSetCursor={setCursor}
              selected={selectedBlockId === segment.blockId}
              onSelectBlock={onSelectBlock}
              nextSegment={segments[i + 1]}
            />
          ))}
          <li className="pl-6 text-xs text-muted-foreground">
            <StatusChip
              state={{
                status:
                  trace.status === "completed"
                    ? "done"
                    : trace.status === "waiting"
                      ? "waiting"
                      : trace.status === "stopped"
                        ? "skipped"
                        : "active",
              }}
            />{" "}
            {t(`pages.processViewPrototype.trace.status.${trace.status}`)}
          </li>
        </ol>
      </div>
    </div>
  );
}
