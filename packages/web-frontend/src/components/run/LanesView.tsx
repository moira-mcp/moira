/**
 * Lanes — the process as progression, the default mode.
 *
 * The task header (title, goal, facts) sits above one rail of blocks in process order. The
 * current block is pinned as "you are here", repeats carry their count, skipped blocks are struck
 * through and dashed so they cannot be confused with blocks not yet reached, returns are drawn
 * as labelled arcs beneath the rail from lane to lane, and forward transitions that skip a lane
 * are thin muted links above it (a link's label sits on the line when it fits, else as a chip in
 * the source lane). Beneath the rail the selected block's run content (summary, details, outcome,
 * next) is written out. On a phone the rail becomes a vertical stepper and returns and skips
 * become chips, which is what a phone can show.
 *
 * The horizontal rail is a React Flow instance on the shared `DiagramViewport`: lane cards are
 * fixed nodes in one row placed by `laneLayout`, returns and links are custom edges drawing the
 * `arcs` geometry in flow coordinates, so the rail pans and zooms like the canvas and never
 * scrolls the page. The phone stepper is plain DOM and keeps its native scroll.
 */

import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  EdgeLabelRenderer,
  Handle,
  Position,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import { ArrowUpRight, MapPin, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTheme } from "@/hooks/useTheme";
import { DiagramViewport } from "../diagram/DiagramViewport";
import { useOpeningPlacement } from "../diagram/placement";
import { GuidanceCallout } from "./Guidance";
import { useEditing, useModeGuideKey } from "../flow/editing";
import { StatusChip, StatusIcon, STATUS_STYLE } from "./status";
import {
  arcGeometry,
  buildArcs,
  buildLinks,
  linkGeometry,
  type LaneArc,
  type LaneLink,
} from "./arcs";
import {
  LANE_HEIGHT,
  LANE_WIDTH,
  laneCenter,
  laneRailLayout,
  laneViewportHeight,
  LANE_GAP,
} from "./laneLayout";
import { currentBlockId, type RunBlock, type RunTransition, type RunViewProps } from "./model";

type Skip = { transition: RunTransition; targetName: string };

function LaneButton({
  block,
  selected,
  isCurrent,
  onClick,
  vertical,
  skips = [],
}: {
  block: RunBlock;
  selected: boolean;
  isCurrent: boolean;
  onClick: () => void;
  vertical: boolean;
  /** Forward transitions whose label the rail could not fit on the link: shown as chips here. */
  skips?: Skip[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const { definition } = useEditing();
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
      {!definition && <span className="sr-only">{t(`pages.runPage.status.${block.status}`)}</span>}
      {block.content.summary && (
        <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
          {block.content.summary}
        </span>
      )}
      {skips.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {skips.map(({ transition, targetName }) => (
            <ForwardChip
              key={`${transition.to}-${transition.label}`}
              label={transition.label}
              targetName={targetName}
            />
          ))}
        </span>
      )}
    </button>
  );
}

/** A forward transition as a chip: the return chips' shape with a forward icon and muted tone. */
function ForwardChip({
  label,
  targetName,
}: {
  label: string;
  targetName: string;
}): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
      data-arc="chip"
      data-link="chip"
    >
      <ArrowUpRight className="size-3" aria-hidden="true" />
      {label}
      <span>→ {targetName}</span>
    </span>
  );
}

type LaneNodeData = {
  block: RunBlock;
  selected: boolean;
  isCurrent: boolean;
  skips: Skip[];
  onSelect: (id: string) => void;
};
type LaneNode = Node<LaneNodeData, "lane">;
/** Geometry precomputed in flow coordinates; `y` and `d` are relative to the edge's own band. */
type ArcEdgeData = {
  arc: LaneArc;
  x1: number;
  x2: number;
  y: number;
  d: string;
  rowBottom: number;
};
type LinkEdgeData = {
  link: LaneLink;
  x1: number;
  x2: number;
  y: number;
  d: string;
  labelFits: boolean;
};
type LaneEdge = Edge<ArcEdgeData, "arc"> | Edge<LinkEdgeData, "link">;

/** A lane card as a node: hidden handles so edges can attach, the button fills the fixed box. */
function LaneNodeView({ data }: NodeProps<LaneNode>): React.JSX.Element {
  const { block, selected, isCurrent, skips, onSelect } = data;
  return (
    <div className="flex" style={{ width: LANE_WIDTH, height: LANE_HEIGHT }}>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      <LaneButton
        block={block}
        selected={selected}
        isCurrent={isCurrent}
        onClick={() => onSelect(block.id)}
        vertical={false}
        skips={skips}
      />
    </div>
  );
}

/** A return: a dashed primary path beneath the row and its label pill under the line. */
function ArcEdgeView({ data }: EdgeProps<Edge<ArcEdgeData, "arc">>): React.JSX.Element | null {
  const { t } = useTranslation();
  if (!data) return null;
  const { arc, x1, x2, y, d, rowBottom } = data;
  return (
    <>
      <g transform={`translate(0 ${rowBottom})`}>
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
      <EdgeLabelRenderer>
        <span
          className="nodrag nopan absolute inline-flex max-w-[260px] items-center gap-1 truncate rounded-full border border-primary/40 bg-background px-2 text-[11px] leading-[16px] text-primary"
          style={{
            transform: `translate(-50%, 0) translate(${(x1 + x2) / 2}px, ${rowBottom + y + 3}px)`,
          }}
        >
          <RotateCcw className="size-3 shrink-0" aria-hidden="true" />
          {arc.label}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

/** A forward link above the row, its label on the line when it fits (else the source's chip). */
function LinkEdgeView({ data }: EdgeProps<Edge<LinkEdgeData, "link">>): React.JSX.Element | null {
  if (!data) return null;
  const { link, x1, x2, y, d, labelFits } = data;
  return (
    <g opacity={0.6}>
      <title>{link.label}</title>
      <path
        d={d}
        fill="none"
        stroke="var(--muted-foreground)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        markerEnd="url(#lane-arrow-link)"
        data-link={`${link.from}-${link.to}`}
      />
      {labelFits && (
        <text
          x={(x1 + x2) / 2}
          y={y - 3}
          textAnchor="middle"
          fontSize={11}
          fill="var(--muted-foreground)"
          data-link-label={`${link.from}-${link.to}`}
        >
          {link.label}
        </text>
      )}
    </g>
  );
}

const nodeTypes = { lane: LaneNodeView };
const edgeTypes = { arc: ArcEdgeView, link: LinkEdgeView };

/**
 * The horizontal rail: a fixed-height React Flow viewport whose height follows the geometry so
 * the page does not jump; it opens fitted to the whole rail and, on a run, centred on the current
 * lane at full size.
 */
function LanesRail({
  blocks,
  arcs,
  links,
  drawnLinks,
  shown,
  current,
  onSelectBlock,
  chipsOf,
}: {
  blocks: RunBlock[];
  arcs: LaneArc[];
  links: LaneLink[];
  drawnLinks: Array<{ link: LaneLink } & ReturnType<typeof linkGeometry>>;
  shown: string | null;
  current: string | null;
  onSelectBlock: (id: string) => void;
  chipsOf: (block: RunBlock) => Skip[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const { actualTheme } = useTheme();
  const layout = useMemo(() => laneRailLayout(blocks.length, arcs, links), [blocks, arcs, links]);

  // Centre on the current lane at full size once it is known and again only when it moves: a
  // refetch that changes nothing must not undo the reader's own panning.
  const currentIndex = blocks.find((b) => b.id === current)?.index ?? null;
  const rowTop = layout.rowTop;
  const placeViewport = useCallback(
    (rf: ReactFlowInstance<LaneNode, LaneEdge>, index: number | null) => {
      if (index === null) {
        // A definition has no current lane: open at full size on the first lane; the reader pans.
        void rf.setViewport({ x: LANE_GAP, y: 0, zoom: 1 });
        return;
      }
      void rf.setCenter(laneCenter(index), rowTop + LANE_HEIGHT / 2, { zoom: 1, duration: 0 });
    },
    [rowTop],
  );
  const { onInit, onReady } = useOpeningPlacement(placeViewport, currentIndex);

  const nodes = useMemo<LaneNode[]>(
    () =>
      blocks.map((block, i) => ({
        id: block.id,
        type: "lane",
        position: layout.positions[i],
        width: LANE_WIDTH,
        height: LANE_HEIGHT,
        draggable: false,
        selectable: false,
        data: {
          block,
          selected: shown === block.id,
          isCurrent: current === block.id,
          skips: chipsOf(block),
          onSelect: onSelectBlock,
        },
      })),
    [blocks, layout, shown, current, chipsOf, onSelectBlock],
  );

  const edges = useMemo<LaneEdge[]>(() => {
    const idOf = (index: number) => blocks[index].id;
    const arcEdges: LaneEdge[] = arcs.map((arc) => ({
      id: `arc-${arc.from}-${arc.to}-${arc.label}`,
      source: idOf(arc.from),
      target: idOf(arc.to),
      type: "arc",
      selectable: false,
      focusable: false,
      data: { arc, ...arcGeometry(arc, laneCenter), rowBottom: layout.rowBottom },
    }));
    const linkEdges: LaneEdge[] = drawnLinks.map(({ link, ...geometry }) => ({
      id: `link-${link.from}-${link.to}-${link.label}`,
      source: idOf(link.from),
      target: idOf(link.to),
      type: "link",
      selectable: false,
      focusable: false,
      data: { link, ...geometry },
    }));
    return [...arcEdges, ...linkEdges];
  }, [blocks, arcs, drawnLinks, layout]);

  return (
    <div
      className="overflow-hidden rounded-xl border bg-muted/20"
      style={{ height: laneViewportHeight(layout) }}
      role="region"
      aria-label={t("pages.runPage.lanes.rail")}
      data-testid="lanes-rail"
    >
      <DiagramViewport<LaneNode, LaneEdge>
        kind="lanes"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        colorMode={actualTheme}
        onInit={onInit}
        onReady={onReady}
      >
        <svg aria-hidden="true">
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
            <marker
              id="lane-arrow-link"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted-foreground)" />
            </marker>
          </defs>
        </svg>
      </DiagramViewport>
    </div>
  );
}

function BlockContent({ block }: { block: RunBlock }): React.JSX.Element | null {
  const { t } = useTranslation();
  const { definition } = useEditing();
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
      ) : definition ? null : (
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
  const guideKey = useModeGuideKey();
  // A phone gets the vertical stepper; on any wider screen the rail keeps process order left to
  // right inside a pannable, zoomable viewport.
  const vertical = useIsMobile();
  const current = useMemo(() => currentBlockId(blocks), [blocks]);
  const shown = selectedBlockId ?? current ?? blocks[0]?.id ?? null;
  const shownBlock = blocks.find((b) => b.id === shown) ?? null;
  const arcs = useMemo(() => buildArcs(blocks), [blocks]);
  const links = useMemo(() => buildLinks(blocks), [blocks]);

  const linksBand = useMemo(
    () => laneRailLayout(blocks.length, arcs, links).rowTop,
    [blocks, arcs, links],
  );
  const drawnLinks = useMemo(
    () => links.map((link) => ({ link, ...linkGeometry(link, laneCenter, linksBand) })),
    [links, linksBand],
  );
  // A link whose label does not fit on the line is labelled by a chip in its source lane instead;
  // the stepper has no links, so there every skipping transition is a chip.
  const chipsOf = useCallback(
    (block: RunBlock): Skip[] =>
      block.transitions
        .filter((tr) => {
          const target = blocks.find((b) => b.id === tr.to);
          if (tr.cycle || !target || target.index <= block.index + 1) return false;
          if (vertical) return true;
          const drawn = drawnLinks.find(
            (d) =>
              d.link.from === block.index &&
              d.link.to === target.index &&
              d.link.label === tr.label,
          );
          return drawn ? !drawn.labelFits : false;
        })
        .map((transition) => ({
          transition,
          targetName: blocks.find((b) => b.id === transition.to)?.name ?? transition.to,
        })),
    [blocks, vertical, drawnLinks],
  );

  return (
    <div
      className="scrollbar-thin flex h-full flex-col gap-4 overflow-auto p-4"
      data-testid="lanes-view"
    >
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
      <GuidanceCallout title={t(`${guideKey}.lanes.title`)} testId="guidance-lanes">
        {t(`${guideKey}.lanes.body`)}
      </GuidanceCallout>
      <div className="space-y-4" data-lanes-orientation={vertical ? "vertical" : "horizontal"}>
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
                    skips={chipsOf(block)}
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
          <LanesRail
            blocks={blocks}
            arcs={arcs}
            links={links}
            drawnLinks={drawnLinks}
            shown={shown}
            current={current}
            onSelectBlock={onSelectBlock}
            chipsOf={chipsOf}
          />
        )}
        {shownBlock && <BlockContent block={shownBlock} />}
      </div>
    </div>
  );
}
