/**
 * Lanes variant — the process as progression.
 *
 * Optimised for "where is this run now": the phases sit on one rail in process order, the current
 * phase is marked as the position, repeats carry their count, skipped phases are dimmed and dashed
 * so they cannot be confused with phases not yet reached, and returns are drawn as arcs beneath the
 * rail from column to column — no graph layout, just column indices. Below the rail, a detail card
 * describes the selected phase (the current one by default). At narrow widths the rail becomes a
 * vertical stepper and returns become chips, which is what a phone can actually show.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, MapPin, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { GuidanceCallout } from "../shared/Guidance";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusChip, StatusIcon, STATUS_STYLE } from "../shared/status";
import type { VariantProps } from "../shared/BlockCards";
import { blockById, runStateOf, type BlockRunState, type ProcessProjection } from "../model";

const LANE_MIN_WIDTH = 132;
const LANE_GAP = 10;
const ARC_BASE = 22;
/** Each nesting depth adds a line plus the label pill that sits beneath it. */
const ARC_STEP = 28;
const NARROW_BREAKPOINT = 720;

function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function currentBlockId(projection: ProcessProjection): string | null {
  const hit = projection.blocks.find((b) => {
    const s = runStateOf(projection, b.id).status;
    return s === "active" || s === "waiting";
  });
  return hit?.id ?? null;
}

interface Arc {
  from: number;
  to: number;
  label: string;
  depth: number;
  cause: string;
  exit: string;
}

function buildArcs(projection: ProcessProjection): Arc[] {
  const index = new Map(projection.blocks.map((b, i) => [b.id, i]));
  const raw = projection.blocks.flatMap((b) =>
    b.transitions
      .filter((t) => t.cycle)
      .map((t) => ({
        from: index.get(b.id)!,
        to: index.get(t.to)!,
        label: t.label,
        cause: t.cycle!.cause,
        exit: t.cycle!.exit,
      })),
  );
  // Shorter spans nest inside longer ones: assign depth by span so arcs never cross each other.
  const sorted = [...raw].sort((a, b) => a.from - a.to - (b.from - b.to));
  const lanesUsed: Array<Array<[number, number]>> = [];
  return sorted.map((arc) => {
    const lo = Math.min(arc.from, arc.to);
    const hi = Math.max(arc.from, arc.to);
    let depth = 0;
    while (lanesUsed[depth]?.some(([a, b]) => lo <= b && a <= hi)) depth += 1;
    (lanesUsed[depth] ??= []).push([lo, hi]);
    return { ...arc, depth };
  });
}

/** A self-loop is a short hook; a wider one keeps its label clear of the arrows. */
function arcGeometry(
  arc: Arc,
  centerOf: (index: number) => number,
): { x1: number; x2: number; y: number; d: string } {
  const self = arc.from === arc.to;
  const x1 = centerOf(arc.from) + (self ? 30 : 0);
  const x2 = centerOf(arc.to) - (self ? 30 : 0);
  const y = ARC_BASE + arc.depth * ARC_STEP;
  return { x1, x2, y, d: `M ${x1} 2 L ${x1} ${y} L ${x2} ${y} L ${x2} 2` };
}

function DetailCard({
  projection,
  blockId,
}: {
  projection: ProcessProjection;
  blockId: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const blocks = blockById(projection);
  const block = blocks.get(blockId);
  if (!block) return null;
  const state = runStateOf(projection, block.id);
  const index = projection.blocks.findIndex((b) => b.id === block.id);
  return (
    <Card data-testid="lanes-detail" data-block-id={block.id}>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <CardTitle className="text-lg leading-6">
            <span className="mr-2 tabular-nums text-muted-foreground">{index + 1}.</span>
            {block.name}
          </CardTitle>
          <StatusChip state={state} />
        </div>
        <p className="text-sm leading-6 text-foreground/85">{block.description}</p>
        {state.note && <p className="text-sm text-muted-foreground">{state.note}</p>}
      </CardHeader>
      <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
        {block.transitions.map((transition) => (
          <div
            key={`${transition.to}-${transition.label}`}
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2",
              transition.cycle ? "border-primary/40 bg-primary/5" : "border-border bg-muted/30",
            )}
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
                <span className="font-normal text-muted-foreground">
                  {" "}
                  → {blocks.get(transition.to)?.name ?? transition.to}
                </span>
              </p>
              {transition.cycle && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {transition.cycle.cause}{" "}
                  <span className="text-foreground/70">
                    {t("pages.processViewPrototype.lanes.endsWhen")} {transition.cycle.exit}
                  </span>
                </p>
              )}
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground sm:col-span-2">
          {t("pages.processViewPrototype.nodeCount", { count: block.nodeIds.length })}
        </p>
      </CardContent>
    </Card>
  );
}

function LaneButton({
  index,
  name,
  state,
  selected,
  isCurrent,
  onClick,
  vertical,
}: {
  index: number;
  name: string;
  state: BlockRunState;
  selected: boolean;
  isCurrent: boolean;
  onClick: () => void;
  vertical: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const style = STATUS_STYLE[state.status];
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      aria-current={isCurrent ? "step" : undefined}
      className={cn(
        "relative flex min-w-0 flex-col gap-1.5 rounded-xl border-2 px-3 py-2.5 text-left transition",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        style.surface,
        state.status === "skipped" && "opacity-75",
        selected && "ring-2 ring-ring",
        vertical ? "w-full" : "flex-1",
      )}
      data-lane-index={index}
      data-status={state.status}
    >
      {isCurrent && (
        <span className="absolute -top-3 left-3 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground shadow">
          <MapPin className="size-3" aria-hidden="true" />
          {t("pages.processViewPrototype.lanes.youAreHere")}
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <StatusIcon status={state.status} className="size-3.5" />
        {t("pages.processViewPrototype.lanes.phase", { index: index + 1 })}
        {state.status === "repeated" && state.iterations ? (
          <span className="ml-auto rounded-full bg-success/15 px-1.5 text-[10px] tabular-nums text-success">
            ×{state.iterations}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "text-sm font-semibold leading-5",
          state.status === "skipped" && "line-through decoration-muted-foreground/60",
        )}
      >
        {name}
      </span>
      {state.note && (
        <span className="truncate text-[11px] text-muted-foreground">{state.note}</span>
      )}
    </button>
  );
}

export function LanesView({
  projection,
  selectedBlockId,
  onSelectBlock,
}: VariantProps): React.JSX.Element {
  const { t } = useTranslation();
  const [containerRef, width] = useContainerWidth();
  const vertical = width > 0 && width < NARROW_BREAKPOINT;
  const current = useMemo(() => currentBlockId(projection), [projection]);
  const shown = selectedBlockId ?? current ?? projection.blocks[0]?.id ?? null;
  const arcs = useMemo(() => buildArcs(projection), [projection]);
  const n = projection.blocks.length;

  // Equal-width lanes; when they cannot fit, the rail scrolls horizontally and the current lane is
  // brought into view rather than everything shrinking below legibility.
  const laneWidth = Math.max(LANE_MIN_WIDTH, (width - LANE_GAP * (n - 1)) / n);
  const railWidth = laneWidth * n + LANE_GAP * (n - 1);
  const centerOf = (i: number) => i * (laneWidth + LANE_GAP) + laneWidth / 2;
  const arcsHeight = arcs.length
    ? ARC_BASE + Math.max(...arcs.map((a) => a.depth)) * ARC_STEP + 34
    : 0;

  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    const target = rail?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!rail || !target) return;
    rail.scrollLeft = Math.max(0, target.offsetLeft - (rail.clientWidth - target.offsetWidth) / 2);
  }, [projection, laneWidth]);

  return (
    <div className="space-y-4">
      <GuidanceCallout
        title={t("pages.processViewPrototype.modeGuide.lanes.title")}
        testId="guidance-lanes"
      >
        {t("pages.processViewPrototype.modeGuide.lanes.body")}
      </GuidanceCallout>
      <div
        ref={containerRef}
        className="space-y-4"
        data-lanes-orientation={vertical ? "vertical" : "horizontal"}
      >
        {vertical ? (
          <ol className="space-y-2" aria-label={projection.title}>
            {projection.blocks.map((block, index) => {
              const state = runStateOf(projection, block.id);
              const returns = block.transitions.filter((tr) => tr.cycle);
              return (
                <li key={block.id} className="space-y-1">
                  <LaneButton
                    index={index}
                    name={block.name}
                    state={state}
                    selected={shown === block.id}
                    isCurrent={current === block.id}
                    onClick={() => onSelectBlock(block.id)}
                    vertical
                  />
                  {returns.length > 0 && (
                    <div className="flex flex-wrap gap-1 pl-3">
                      {returns.map((tr) => (
                        <span
                          key={`${tr.to}-${tr.label}`}
                          className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-background px-2 py-0.5 text-[11px] text-primary"
                        >
                          <RotateCcw className="size-3" aria-hidden="true" />
                          {tr.label}
                          <span className="text-muted-foreground">
                            → {projection.blocks.find((b) => b.id === tr.to)?.name}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <div ref={railRef} className="overflow-x-auto pb-1 pt-3" data-testid="lanes-rail">
            <div style={{ width: railWidth }}>
              <ol
                className="flex items-stretch"
                style={{ gap: LANE_GAP }}
                aria-label={projection.title}
              >
                {projection.blocks.map((block, index) => (
                  <li key={block.id} className="flex" style={{ width: laneWidth }}>
                    <LaneButton
                      index={index}
                      name={block.name}
                      state={runStateOf(projection, block.id)}
                      selected={shown === block.id}
                      isCurrent={current === block.id}
                      onClick={() => onSelectBlock(block.id)}
                      vertical={false}
                    />
                  </li>
                ))}
              </ol>
              {arcs.length > 0 && (
                <svg
                  width={railWidth}
                  height={arcsHeight}
                  className="block overflow-visible"
                  aria-label={t("pages.processViewPrototype.lanes.returns")}
                  role="img"
                >
                  <defs>
                    <marker
                      id="lane-arrow"
                      viewBox="0 0 10 10"
                      refX="8"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" />
                    </marker>
                  </defs>
                  {/* Paths first, labels after, so a deeper arc's leg never runs through a label. */}
                  {arcs.map((arc) => {
                    const { x1, x2, y, d } = arcGeometry(arc, centerOf);
                    return (
                      <g key={`path-${arc.from}-${arc.to}-${arc.label}`}>
                        <title>{`${arc.cause} — ${t("pages.processViewPrototype.lanes.endsWhen")} ${arc.exit}`}</title>
                        <path
                          d={d}
                          fill="none"
                          stroke="var(--primary)"
                          strokeWidth={2}
                          strokeDasharray="6 5"
                          strokeLinejoin="round"
                          markerEnd="url(#lane-arrow)"
                          data-arc={`${x1}-${x2}-${y}`}
                        />
                      </g>
                    );
                  })}
                  {arcs.map((arc) => {
                    const { x1, x2, y } = arcGeometry(arc, centerOf);
                    return (
                      <foreignObject
                        key={`label-${arc.from}-${arc.to}-${arc.label}`}
                        x={(x1 + x2) / 2 - 130}
                        y={y + 3}
                        width={260}
                        height={18}
                      >
                        <div className="flex justify-center">
                          <span className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-primary/40 bg-background px-2 text-[11px] leading-[16px] text-primary">
                            <RotateCcw className="size-3 shrink-0" aria-hidden="true" />
                            {arc.label}
                          </span>
                        </div>
                      </foreignObject>
                    );
                  })}
                </svg>
              )}
            </div>
          </div>
        )}

        {shown && <DetailCard projection={projection} blockId={shown} />}
      </div>
    </div>
  );
}
