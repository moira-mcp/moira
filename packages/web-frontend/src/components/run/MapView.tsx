/**
 * Map — the process as a diagram with its table of contents.
 *
 * A compact header names what is being looked at — the run's task, its rendered title, its goal
 * and the projection's facts (on a definition, the workflow's name and description) — above the
 * layered diagram (`CanvasDiagram`): blocks left to right in process order, labelled forward
 * transitions, loops below, hub bundles, a chip per exit, and on a run the block the run is at in
 * view. The left sidebar is the contents: every block in order with its status, how many times it
 * ran, the progress of the list it is bound to and, on the flow page, how long the block typically
 * takes — plus the node finder, which answers "which block is this step in" and selects that block.
 *
 * The diagram owns the column: the explanation of the view is one line with a disclosure, closed
 * until the reader opens it and remembered per page in `localStorage`, so it costs one row instead
 * of a third of the height. On a phone the map is one scrolling column — the diagram at a readable
 * fixed height, the contents beneath it — and the page's panel follows underneath as before.
 *
 * The map holds no block narrative: the page's right panel carries it, on the run page with the
 * run's timings, list and route facts and on the flow page with authoring.
 */

import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, CornerDownLeft, Compass, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { useModeGuideKey } from "../flow/editing";
import { NodeTypeTag } from "./nodeTypeStyle";
import { PassCount, StatusIcon } from "./status";
import { CanvasDiagram } from "./CanvasView";
import { formatDuration } from "./duration";
import {
  blockById,
  nodeOwners,
  stepsOf,
  type RunBlock,
  type RunViewProps,
  type StepInfo,
} from "./model";

/** Search over every step of the process: picking a match selects the block that owns it. */
function NodeFinder({
  blocks,
  steps,
  onPick,
}: {
  blocks: RunBlock[];
  steps: StepInfo[];
  onPick: (blockId: string) => void;
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
        placeholder={t("pages.runPage.map.findNode")}
        aria-label={t("pages.runPage.map.findNode")}
        className="h-9 pl-8 text-sm"
        data-testid="map-node-finder"
      />
      {query.trim() && (
        <ul
          className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md"
          role="listbox"
        >
          {matches.length === 0 && (
            <li className="px-3 py-2 text-xs text-muted-foreground">
              {t("pages.runPage.map.noMatch")}
            </li>
          )}
          {matches.map(({ step, owner }) => (
            <li key={step.id} role="option" aria-selected={false}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent"
                onClick={() => {
                  if (owner) onPick(owner.id);
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

/** One row of the contents: status, position, name, and the block's counts on the right. */
function ContentsRow({
  block,
  selected,
  onSelect,
}: {
  block: RunBlock;
  selected: boolean;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const bound =
    block.list && (block.list.done !== null || block.list.total !== null)
      ? `${block.list.done ?? "?"}/${block.list.total ?? "?"}`
      : null;
  const typical = block.stats?.run.medianMs ?? null;
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(block.id)}
        aria-pressed={selected}
        aria-current={block.status === "active" || block.status === "waiting" ? "step" : undefined}
        data-block-id={block.id}
        data-status={block.status}
        data-testid={`map-contents-${block.id}`}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-accent",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected && "bg-accent font-medium",
          block.status === "skipped" && "text-muted-foreground line-through",
          block.status === "pending" && "text-muted-foreground",
        )}
      >
        <StatusIcon status={block.status} className="size-3.5" />
        <span className="tabular-nums text-muted-foreground">{block.index + 1}.</span>
        <span className="min-w-0 flex-1 truncate">{block.name}</span>
        <PassCount iterations={block.iterations} />
        {bound && (
          <span
            className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
            title={t("pages.runPage.map.listProgress")}
            data-contents-list={bound}
          >
            {bound}
          </span>
        )}
        {typical !== null && (
          <span
            className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
            title={t("pages.runPage.map.typical")}
            data-contents-typical={typical}
          >
            {formatDuration(typical, t)}
          </span>
        )}
      </button>
    </li>
  );
}

/** Colour of a projection fact by its tone; a neutral fact is plain text on the card. */
const FACT_TONE: Record<string, string> = {
  neutral: "border-border bg-muted/40 text-muted-foreground",
  positive: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/50 bg-warning/10 text-warning-foreground",
  critical: "border-destructive/50 bg-destructive/10 text-destructive",
};

/**
 * What is being looked at, in one compact band: the run's task title, the title the run rendered
 * for itself, its goal and the projection's facts. A definition carries the workflow's name and
 * description in the same fields, so the flow page shows those without a branch here.
 */
function HeaderFacts({
  progress,
}: {
  progress: RunViewProps["progress"];
}): React.JSX.Element | null {
  const { taskTitle, goal, facts } = progress;
  // The projection falls back to the workflow title when the run has no task title; printing the
  // same text twice tells the reader nothing, so the title line appears only when it differs.
  const title = progress.title !== taskTitle ? progress.title : undefined;
  if (!taskTitle && !title && !goal && facts.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b bg-card px-3 py-1.5"
      data-testid="run-header-facts"
    >
      {taskTitle && (
        <span className="min-w-0 truncate text-sm font-semibold leading-5" data-fact="taskTitle">
          {taskTitle}
        </span>
      )}
      {title && (
        <span className="min-w-0 truncate text-sm text-foreground/80" data-fact="title">
          {title}
        </span>
      )}
      {goal && (
        <span
          className="min-w-0 basis-full truncate text-xs text-muted-foreground"
          title={goal}
          data-fact="goal"
        >
          {goal}
        </span>
      )}
      {facts.length > 0 && (
        <span className="flex flex-wrap items-center gap-1" data-testid="run-header-fact-chips">
          {facts.map((fact) => (
            <span
              key={`${fact.label}:${fact.value}`}
              className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4",
                FACT_TONE[fact.tone] ?? FACT_TONE.neutral,
              )}
              data-fact-tone={fact.tone}
              title={`${fact.label}: ${fact.value}`}
            >
              <span className="shrink-0 font-medium">{fact.label}</span>
              <span className="min-w-0 truncate">{fact.value}</span>
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * The explanation of the view as one line: a title with a disclosure that opens the body. It is
 * closed by default so the diagram keeps the column, and the reader's choice is remembered per
 * page in `localStorage` — a browser that refuses storage simply keeps the default.
 */
function MapGuide({ guideKey }: { guideKey: string }): React.JSX.Element {
  const { t } = useTranslation();
  const storageKey = `moira.map.guide:${guideKey}`;
  const [open, setOpen] = useState(() => {
    try {
      return window.localStorage.getItem(storageKey) === "open";
    } catch {
      return false;
    }
  });
  const toggle = (): void => {
    setOpen((was) => {
      const next = !was;
      try {
        window.localStorage.setItem(storageKey, next ? "open" : "closed");
      } catch {
        // A browser that blocks site data keeps the choice for this view only.
      }
      return next;
    });
  };
  return (
    <div className="border-b bg-primary/5 px-3 py-1" data-testid="guidance-map">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="guidance-map-toggle"
      >
        <Compass className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{t(`${guideKey}.map.title`)}</span>
        <ChevronDown
          className={cn("ml-auto size-3.5 shrink-0 transition-transform", open && "rotate-180")}
          aria-hidden="true"
        />
      </button>
      {open && (
        <p
          className="pb-1 pt-1 text-xs leading-5 text-foreground/80"
          data-testid="guidance-map-body"
        >
          {t(`${guideKey}.map.body`)}
        </p>
      )}
    </div>
  );
}

export function MapView({
  sidebar,
  ...props
}: RunViewProps & {
  /** Extra content the page puts above the contents list. */
  sidebar?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const guideKey = useModeGuideKey();
  const { blocks, workflow, selectedBlockId, onSelectBlock } = props;
  const allSteps = useMemo(
    () =>
      stepsOf(
        workflow,
        blocks.flatMap((b) => b.nodeIds),
      ),
    [workflow, blocks],
  );

  // On a phone the map is one scrolling column (the diagram at a readable fixed height, the
  // contents beneath it); from `lg` it is a row that fills the page's box and scrolls nowhere but
  // inside the sidebar.
  return (
    <div
      className="flex flex-col lg:h-full lg:min-h-0 lg:flex-row lg:overflow-hidden"
      data-testid="map-view"
    >
      <div className="order-1 flex h-[55vh] flex-col overflow-hidden lg:order-2 lg:h-full lg:min-h-0 lg:flex-1">
        <HeaderFacts progress={props.progress} />
        <MapGuide guideKey={guideKey} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <CanvasDiagram {...props} />
        </div>
      </div>

      <aside
        className="scrollbar-thin order-2 shrink-0 space-y-3 border-t p-3 lg:order-1 lg:w-[260px] lg:overflow-auto lg:border-r lg:border-t-0 xl:w-[300px]"
        aria-label={t("pages.runPage.map.contents")}
        data-testid="map-contents"
      >
        {sidebar}
        <NodeFinder blocks={blocks} steps={allSteps} onPick={onSelectBlock} />
        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("pages.runPage.map.contents")}
        </p>
        <ol className="space-y-0.5" data-testid="map-contents-list">
          {blocks.map((block) => (
            <ContentsRow
              key={block.id}
              block={block}
              selected={selectedBlockId === block.id}
              onSelect={onSelectBlock}
            />
          ))}
        </ol>
      </aside>
    </div>
  );
}
