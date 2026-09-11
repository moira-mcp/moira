/**
 * Lanes — the process as progression, the default mode.
 *
 * The task header (title, goal, facts) sits above one rail of blocks in process order. The
 * current block is pinned as "you are here", repeats carry their count, skipped blocks are struck
 * through and dashed so they cannot be confused with blocks not yet reached, and returns are
 * drawn as labelled arcs beneath the rail from lane to lane. Beneath the rail the selected block's
 * run content (summary, details, outcome, next) is written out. On a phone the rail becomes a
 * vertical stepper and returns become chips, which is what a phone can show.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapPin, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { GuidanceCallout } from "./Guidance";
import { StatusChip, StatusIcon, STATUS_STYLE } from "./status";
import { arcGeometry, arcsHeight, buildArcs } from "./arcs";
import { currentBlockId, type RunBlock, type RunViewProps } from "./model";

const LANE_MIN_WIDTH = 132;
const LANE_GAP = 10;

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

function LaneButton({
  block,
  selected,
  isCurrent,
  onClick,
  vertical,
}: {
  block: RunBlock;
  selected: boolean;
  isCurrent: boolean;
  onClick: () => void;
  vertical: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const style = STATUS_STYLE[block.status];
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
        block.status === "skipped" && "opacity-75",
        selected && "ring-2 ring-ring",
        vertical ? "w-full" : "flex-1",
      )}
      data-lane-index={block.index}
      data-block-id={block.id}
      data-status={block.status}
      data-testid={`progress-node-${block.id}`}
    >
      {isCurrent && (
        <span className="absolute -top-3 left-3 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground shadow">
          <MapPin className="size-3" aria-hidden="true" />
          {t("pages.runPage.lanes.youAreHere")}
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <StatusIcon status={block.status} className="size-3.5" />
        {t("pages.runPage.lanes.phase", { index: block.index + 1 })}
        {block.iterations > 1 ? (
          <span
            className="ml-auto rounded-full bg-success/15 px-1.5 text-[10px] tabular-nums text-success"
            data-testid="lane-iterations"
          >
            ×{block.iterations}
          </span>
        ) : null}
      </span>
      <span
        className={cn(
          "text-sm font-semibold leading-5",
          block.status === "skipped" && "line-through decoration-muted-foreground/60",
        )}
      >
        {block.name}
      </span>
      <span className="sr-only">{t(`pages.runPage.status.${block.status}`)}</span>
      {block.content.summary && (
        <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
          {block.content.summary}
        </span>
      )}
    </button>
  );
}

function BlockContent({ block }: { block: RunBlock }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { content } = block;
  const hasContent =
    content.summary || content.details.length > 0 || content.outcome || content.next;
  return (
    <section
      className="rounded-xl border bg-card px-4 py-3"
      data-testid="lanes-content"
      data-block-id={block.id}
      aria-label={block.name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold">
          <span className="mr-2 tabular-nums text-muted-foreground">{block.index + 1}.</span>
          {block.name}
        </h3>
        <StatusChip status={block.status} iterations={block.iterations} />
      </div>
      <p className="mt-1 text-sm leading-6 text-foreground/85">{block.description}</p>
      {hasContent ? (
        <dl className="mt-2 space-y-1 text-sm">
          {content.summary && <dd className="font-medium">{content.summary}</dd>}
          {content.details.map((detail, index) => (
            <dd key={index} className="text-muted-foreground">
              • {detail}
            </dd>
          ))}
          {content.outcome && <dd className="text-success">✓ {content.outcome}</dd>}
          {content.next && <dd className="font-medium text-primary">→ {content.next}</dd>}
        </dl>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {t(`pages.runPage.lanes.noContent.${block.status}`)}
        </p>
      )}
    </section>
  );
}

export function LanesView({
  progress,
  blocks,
  selectedBlockId,
  onSelectBlock,
}: RunViewProps): React.JSX.Element {
  const { t } = useTranslation();
  const [containerRef, width] = useContainerWidth();
  // A phone gets the vertical stepper; on any wider screen the rail keeps process order left to
  // right and scrolls inside its own container when the blocks do not fit.
  const vertical = useIsMobile();
  const current = useMemo(() => currentBlockId(blocks), [blocks]);
  const shown = selectedBlockId ?? current ?? blocks[0]?.id ?? null;
  const shownBlock = blocks.find((b) => b.id === shown) ?? null;
  const arcs = useMemo(() => buildArcs(blocks), [blocks]);
  const n = blocks.length;

  // Equal-width lanes; when they cannot fit, the rail scrolls horizontally and the current lane is
  // brought into view rather than everything shrinking below legibility.
  const laneWidth = Math.max(LANE_MIN_WIDTH, (width - LANE_GAP * (n - 1)) / n);
  const railWidth = laneWidth * n + LANE_GAP * (n - 1);
  const centerOf = (i: number) => i * (laneWidth + LANE_GAP) + laneWidth / 2;
  const svgHeight = arcsHeight(arcs);

  const railRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    const target = rail?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!rail || !target) return;
    rail.scrollLeft = Math.max(0, target.offsetLeft - (rail.clientWidth - target.offsetWidth) / 2);
  }, [blocks, laneWidth]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4" data-testid="lanes-view">
      <header className="space-y-1">
        <h2 className="text-xl font-bold leading-7" data-testid="execution-progress-task-title">
          {progress.taskTitle}
        </h2>
        {progress.title && progress.title !== progress.taskTitle && (
          <p className="text-xs font-semibold text-muted-foreground">{progress.title}</p>
        )}
        {progress.goal && (
          <p className="text-sm leading-5" data-testid="execution-progress-goal">
            {progress.goal}
          </p>
        )}
        {progress.facts.length > 0 && (
          <dl className="flex flex-wrap gap-2 pt-1">
            {progress.facts.map((fact) => (
              <div
                key={`${fact.label}-${fact.value}`}
                className={cn(
                  "rounded-lg border-2 bg-card px-2.5 py-1",
                  fact.tone === "critical"
                    ? "border-destructive"
                    : fact.tone === "warning"
                      ? "border-warning"
                      : fact.tone === "positive"
                        ? "border-success"
                        : "border-border",
                )}
              >
                <dt className="text-[10px] font-semibold text-muted-foreground">{fact.label}</dt>
                <dd className="text-xs font-semibold">{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </header>
      <GuidanceCallout title={t("pages.runPage.modeGuide.lanes.title")} testId="guidance-lanes">
        {t("pages.runPage.modeGuide.lanes.body")}
      </GuidanceCallout>
      <div
        ref={containerRef}
        className="space-y-4"
        data-lanes-orientation={vertical ? "vertical" : "horizontal"}
      >
        {vertical ? (
          <ol className="space-y-2" aria-label={t("pages.runPage.lanes.rail")}>
            {blocks.map((block) => {
              const returns = block.transitions.filter((tr) => tr.cycle);
              return (
                <li key={block.id} className="space-y-1">
                  <LaneButton
                    block={block}
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
                          data-arc="chip"
                        >
                          <RotateCcw className="size-3" aria-hidden="true" />
                          {tr.label}
                          <span className="text-muted-foreground">
                            → {blocks.find((b) => b.id === tr.to)?.name}
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
                aria-label={t("pages.runPage.lanes.rail")}
              >
                {blocks.map((block) => (
                  <li key={block.id} className="flex" style={{ width: laneWidth }}>
                    <LaneButton
                      block={block}
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
                  height={svgHeight}
                  className="block overflow-visible"
                  aria-label={t("pages.runPage.lanes.returns")}
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
                  {arcs.map((arc) => {
                    const { x1, x2, y, d } = arcGeometry(arc, centerOf);
                    return (
                      <g key={`path-${arc.from}-${arc.to}-${arc.label}`}>
                        <title>{`${arc.cause} — ${t("pages.runPage.lanes.endsWhen")} ${arc.exit}`}</title>
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
        {shownBlock && <BlockContent block={shownBlock} />}
      </div>
    </div>
  );
}
