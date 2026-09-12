/**
 * Lanes — the process as progression, the default mode.
 *
 * The task header (title, goal, facts) sits above one rail of blocks in process order. The
 * current block is pinned as "you are here", repeats carry their count, skipped blocks are struck
 * through and dashed so they cannot be confused with blocks not yet reached, returns are thin
 * muted arcs beneath the rail from lane to lane, and forward transitions that skip a lane are
 * thin muted links above it. Neither carries a label at rest: each source lane names its returns
 * and skips in chips, and hovering a chip (or a connector) lights that connector and shows its
 * label; a lane selected by the reader lights all of its connectors. Beneath the rail the shown block's run
 * content (summary, details, outcome, next) is written out. On a phone the rail becomes a
 * vertical stepper with the same chips, which is what a phone can show.
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
import { MapPin, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTheme } from "@/hooks/useTheme";
import { DiagramViewport } from "../diagram/DiagramViewport";
import { useOpeningPlacement } from "../diagram/placement";
import { GuidanceCallout } from "./Guidance";
import { useEditing, useModeGuideKey } from "../flow/editing";
import { PassCount, StatusChip, StatusIcon, STATUS_STYLE } from "./status";
import {
  arcGeometry,
  buildArcs,
  buildLinks,
  linkGeometry,
  pillRows,
  type LaneArc,
  type LaneLink,
} from "./arcs";
import {
  LANE_WIDTH,
  laneCardHeight,
  laneCenter,
  laneRailLayout,
  laneViewportHeight,
  LANE_GAP,
} from "./laneLayout";
import { currentBlockId, type RunBlock, type RunViewProps } from "./model";
import { chipTitle, laneChipsOf, transitionKey, type TransitionChip } from "./chips";
import { TransitionChipView, TransitionFocusProvider, isLit, useTransitionFocus } from "./focus";

function LaneButton({
  block,
  selected,
  isCurrent,
  onClick,
  vertical,
  chips = [],
}: {
  block: RunBlock;
  selected: boolean;
  isCurrent: boolean;
  onClick: () => void;
  vertical: boolean;
  /** The block's returns and skips: each names its target and lights its connector on hover. */
  chips?: TransitionChip[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const { definition } = useEditing();
  const style = STATUS_STYLE[block.status];
  const endsWhen = t("pages.runPage.lanes.endsWhen");
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
        <PassCount iterations={block.iterations} className="ml-auto" testId="lane-iterations" />
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
      {(block.content.summary ?? block.description) && (
        <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">
          {block.content.summary ?? block.description}
        </span>
      )}
      {chips.length > 0 && (
        <span className="flex flex-col items-start gap-1" data-testid="lane-chips">
          {chips.map((chip) => (
            <TransitionChipView key={chip.key} chip={chip} title={chipTitle(chip, endsWhen)} />
          ))}
        </span>
      )}
    </button>
  );
}

type LaneNodeData = {
  block: RunBlock;
  selected: boolean;
  isCurrent: boolean;
  chips: TransitionChip[];
  cardHeight: number;
  onSelect: (id: string) => void;
};
type LaneNode = Node<LaneNodeData, "lane">;
/** Geometry precomputed in flow coordinates; `y` and `d` are relative to the edge's own band. */
/** Every connector of the same source lane, so lit pills can take one row each. */
type Sibling = { key: string; y: number };
type ArcEdgeData = {
  arc: LaneArc;
  key: string;
  from: string;
  x1: number;
  x2: number;
  y: number;
  d: string;
  rowBottom: number;
  siblings: Sibling[];
};
type LinkEdgeData = {
  link: LaneLink;
  key: string;
  from: string;
  x1: number;
  x2: number;
  y: number;
  d: string;
  siblings: Sibling[];
};
type LaneEdge = Edge<ArcEdgeData, "arc"> | Edge<LinkEdgeData, "link">;

/** A lane card as a node: hidden handles so edges can attach, the button fills the fixed box. */
function LaneNodeView({ data }: NodeProps<LaneNode>): React.JSX.Element {
  const { block, selected, isCurrent, chips, cardHeight, onSelect } = data;
  return (
    <div className="flex" style={{ width: LANE_WIDTH, height: cardHeight }}>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
      <LaneButton
        block={block}
        selected={selected}
        isCurrent={isCurrent}
        onClick={() => onSelect(block.id)}
        vertical={false}
        chips={chips}
      />
    </div>
  );
}

/**
 * A return: a thin dashed arc beneath the row, muted at rest; lit (full primary, on top) with its
 * label pill under the line while its chip or the arc itself is hovered or its lane is selected.
 */
function ArcEdgeView({ data }: EdgeProps<Edge<ArcEdgeData, "arc">>): React.JSX.Element | null {
  const { t } = useTranslation();
  const focus = useTransitionFocus();
  if (!data) return null;
  const { arc, key, from, x1, x2, y, d, rowBottom, siblings } = data;
  const lit = isLit(focus, key, from);
  // Pills of the connectors lit together take one row each beneath the deepest of them.
  const pillY = lit
    ? pillRows(
        siblings.filter((s) => isLit(focus, s.key, from)),
        1,
      ).get(key)
    : undefined;
  return (
    <>
      <g
        transform={`translate(0 ${rowBottom})`}
        onMouseEnter={() => focus.setHovered([key])}
        onMouseLeave={() => focus.setHovered(null)}
        style={{ cursor: "default" }}
      >
        <title>{`${arc.label} — ${arc.cause} — ${t("pages.runPage.lanes.endsWhen")} ${arc.exit}`}</title>
        <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
        <path
          d={d}
          fill="none"
          stroke="var(--primary)"
          strokeWidth={lit ? 2 : 1.25}
          strokeOpacity={lit ? 1 : 0.35}
          strokeDasharray="6 5"
          strokeLinejoin="round"
          markerEnd={lit ? "url(#lane-arrow)" : "url(#lane-arrow-muted)"}
          data-arc={`${x1}-${x2}-${y}`}
          data-transition={key}
          data-focused={lit ? "true" : undefined}
        />
      </g>
      {lit && (
        <EdgeLabelRenderer>
          <span
            className="nodrag nopan absolute z-10 inline-flex max-w-[280px] items-center gap-1 truncate rounded-full border border-primary/40 bg-background px-2 text-[11px] leading-[16px] text-primary shadow-sm"
            style={{
              transform: `translate(-50%, 0) translate(${(x1 + x2) / 2}px, ${rowBottom + (pillY ?? y + 3)}px)`,
            }}
            data-arc-label={key}
          >
            <RotateCcw className="size-3 shrink-0" aria-hidden="true" />
            {arc.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** A forward link above the row: thin and muted at rest, lit with its label while hovered. */
function LinkEdgeView({ data }: EdgeProps<Edge<LinkEdgeData, "link">>): React.JSX.Element | null {
  const focus = useTransitionFocus();
  if (!data) return null;
  const { link, key, from, x1, x2, y, d, siblings } = data;
  const lit = isLit(focus, key, from);
  const pillY = lit
    ? pillRows(
        siblings.filter((s) => isLit(focus, s.key, from)),
        -1,
      ).get(key)
    : undefined;
  return (
    <>
      <g
        opacity={lit ? 1 : 0.5}
        onMouseEnter={() => focus.setHovered([key])}
        onMouseLeave={() => focus.setHovered(null)}
        style={{ cursor: "default" }}
      >
        <title>{link.label}</title>
        <path d={d} fill="none" stroke="transparent" strokeWidth={14} />
        <path
          d={d}
          fill="none"
          stroke={lit ? "var(--foreground)" : "var(--muted-foreground)"}
          strokeWidth={lit ? 2 : 1.25}
          strokeLinejoin="round"
          markerEnd="url(#lane-arrow-link)"
          data-link={`${link.from}-${link.to}`}
          data-transition={key}
          data-focused={lit ? "true" : undefined}
        />
      </g>
      {lit && (
        <EdgeLabelRenderer>
          <span
            className="nodrag nopan absolute z-10 inline-flex max-w-[280px] items-center truncate rounded-full border border-border bg-background px-2 text-[11px] leading-[16px] text-foreground shadow-sm"
            style={{
              transform: `translate(-50%, -100%) translate(${(x1 + x2) / 2}px, ${pillY ?? y - 3}px)`,
            }}
            data-link-label={key}
          >
            {link.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
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
  chipsOf: (block: RunBlock) => TransitionChip[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const { actualTheme } = useTheme();
  const chipsByBlock = useMemo(
    () => new Map(blocks.map((b) => [b.id, chipsOf(b)])),
    [blocks, chipsOf],
  );
  const cardHeight = useMemo(
    () => laneCardHeight(Math.max(0, ...[...chipsByBlock.values()].map((c) => c.length))),
    [chipsByBlock],
  );
  const layout = useMemo(
    () => laneRailLayout(blocks.length, arcs, links, cardHeight),
    [blocks, arcs, links, cardHeight],
  );

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
      void rf.setCenter(laneCenter(index), rowTop + cardHeight / 2, { zoom: 1, duration: 0 });
    },
    [rowTop, cardHeight],
  );
  const { onInit, onReady } = useOpeningPlacement(placeViewport, currentIndex);

  const nodes = useMemo<LaneNode[]>(
    () =>
      blocks.map((block, i) => ({
        id: block.id,
        type: "lane",
        position: layout.positions[i],
        width: LANE_WIDTH,
        height: cardHeight,
        draggable: false,
        selectable: false,
        data: {
          block,
          selected: shown === block.id,
          isCurrent: current === block.id,
          chips: chipsByBlock.get(block.id) ?? [],
          cardHeight,
          onSelect: onSelectBlock,
        },
      })),
    [blocks, layout, shown, current, chipsByBlock, cardHeight, onSelectBlock],
  );

  const edges = useMemo<LaneEdge[]>(() => {
    const idOf = (index: number) => blocks[index].id;
    const arcSiblings = new Map<string, Sibling[]>();
    for (const arc of arcs) {
      const from = idOf(arc.from);
      const list = arcSiblings.get(from) ?? [];
      list.push({
        key: transitionKey(from, { to: idOf(arc.to), label: arc.label }),
        y: arcGeometry(arc, laneCenter).y,
      });
      arcSiblings.set(from, list);
    }
    const linkSiblings = new Map<string, Sibling[]>();
    for (const { link, y } of drawnLinks) {
      const from = idOf(link.from);
      const list = linkSiblings.get(from) ?? [];
      list.push({ key: transitionKey(from, { to: idOf(link.to), label: link.label }), y });
      linkSiblings.set(from, list);
    }
    const arcEdges: LaneEdge[] = arcs.map((arc) => ({
      id: `arc-${arc.from}-${arc.to}-${arc.label}`,
      source: idOf(arc.from),
      target: idOf(arc.to),
      type: "arc",
      selectable: false,
      focusable: false,
      data: {
        arc,
        key: transitionKey(idOf(arc.from), { to: idOf(arc.to), label: arc.label }),
        from: idOf(arc.from),
        ...arcGeometry(arc, laneCenter),
        rowBottom: layout.rowBottom,
        siblings: arcSiblings.get(idOf(arc.from)) ?? [],
      },
    }));
    const linkEdges: LaneEdge[] = drawnLinks.map(({ link, ...geometry }) => ({
      id: `link-${link.from}-${link.to}-${link.label}`,
      source: idOf(link.from),
      target: idOf(link.to),
      type: "link",
      selectable: false,
      focusable: false,
      data: {
        link,
        key: transitionKey(idOf(link.from), { to: idOf(link.to), label: link.label }),
        from: idOf(link.from),
        ...geometry,
        siblings: linkSiblings.get(idOf(link.from)) ?? [],
      },
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
              id="lane-arrow-muted"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" fillOpacity={0.35} />
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
        <StatusChip status={block.status} />
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
  // Every lane names its returns and its skips in chips; the connectors carry no label at rest.
  const chipsOf = useCallback((block: RunBlock) => laneChipsOf(block, blocks), [blocks]);
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
      <TransitionFocusProvider pinnedBlock={selectedBlockId}>
        <div className="space-y-4" data-lanes-orientation={vertical ? "vertical" : "horizontal"}>
          {vertical ? (
            <ol className="space-y-2" aria-label={t("pages.runPage.lanes.rail")}>
              {blocks.map((block) => (
                <li key={block.id}>
                  <LaneButton
                    block={block}
                    selected={shown === block.id}
                    isCurrent={current === block.id}
                    onClick={() => onSelectBlock(block.id)}
                    vertical
                    chips={chipsOf(block)}
                  />
                </li>
              ))}
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
      </TransitionFocusProvider>
    </div>
  );
}
