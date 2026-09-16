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

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Compass, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModeGuideKey } from "../flow/editing";
import { PassCount, StatusIcon } from "./status";
import { CanvasDiagram } from "./CanvasView";
import { formatDuration } from "./duration";
import { type RunBlock, type RunViewProps } from "./model";

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
  className,
  compact = false,
}: {
  className?: string;
  /** One line: title and description truncated, for the toolbar. */
  compact?: boolean;
  progress: RunViewProps["progress"];
}): React.JSX.Element | null {
  const { taskTitle, goal, facts } = progress;
  // The projection falls back to the workflow title when the run has no task title; printing the
  // same text twice tells the reader nothing, so the title line appears only when it differs.
  const title = progress.title !== taskTitle ? progress.title : undefined;
  if (!taskTitle && !title && !goal && facts.length === 0) return null;
  return (
    <div
      className={cn(
        compact
          ? "flex min-w-0 items-baseline gap-x-2 overflow-hidden whitespace-nowrap"
          : "flex flex-wrap items-baseline gap-x-2 gap-y-1 border-b bg-card px-3 py-1.5",
        className,
      )}
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
          className={cn("min-w-0 truncate text-xs text-muted-foreground", !compact && "basis-full")}
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
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" data-testid="guidance-map">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        title={t(`${guideKey}.map.title`)}
        aria-label={t(`${guideKey}.map.title`)}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
          open && "border-primary/50 bg-primary/10 text-primary",
        )}
        data-testid="guidance-map-toggle"
      >
        <Compass className="size-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-[360px] rounded-lg border bg-popover p-3 text-xs leading-5 text-popover-foreground shadow-md"
          data-testid="guidance-map-body"
        >
          <p className="mb-1 font-medium text-primary">{t(`${guideKey}.map.title`)}</p>
          {t(`${guideKey}.map.body`)}
        </div>
      )}
    </div>
  );
}

const SIDEBAR_KEY = "moira.map.sidebarCollapsed";

export function MapView({
  sidebar,
  ...props
}: RunViewProps & {
  /** Extra content the page puts above the contents list. */
  sidebar?: React.ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const guideKey = useModeGuideKey();
  const { blocks, selectedBlockId, onSelectBlock } = props;
  // The contents sidebar folds away to give the diagram the whole width; the choice is kept per
  // browser so a reader who folded it finds it folded on the next run.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggleSidebar = (): void => {
    setCollapsed((value) => {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, value ? "0" : "1");
      } catch {
        // storage unavailable: the choice lives for this page only
      }
      return !value;
    });
  };

  // On a phone the map is one scrolling column (the diagram at a readable fixed height, the
  // contents beneath it); from `lg` it is a row that fills the page's box and scrolls nowhere but
  // inside the sidebar.
  return (
    <div
      className="flex flex-col lg:h-full lg:min-h-0 lg:flex-row lg:overflow-hidden"
      data-testid="map-view"
    >
      <div className="order-1 flex h-[55vh] flex-col overflow-hidden lg:order-2 lg:h-full lg:min-h-0 lg:flex-1">
        <div className="min-h-0 flex-1 overflow-hidden">
          <CanvasDiagram
            {...props}
            toolbarTitle={<HeaderFacts progress={props.progress} compact />}
            toolbarTrailing={<MapGuide guideKey={guideKey} />}
            toolbarLeading={
              <button
                type="button"
                onClick={toggleSidebar}
                aria-expanded={!collapsed}
                aria-label={t("pages.runPage.map.contents")}
                title={t("pages.runPage.map.contents")}
                data-testid="map-sidebar-toggle"
                className="hidden h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground lg:inline-flex"
              >
                {collapsed ? (
                  <PanelLeftOpen className="size-4" aria-hidden="true" />
                ) : (
                  <PanelLeftClose className="size-4" aria-hidden="true" />
                )}
              </button>
            }
          />
        </div>
      </div>

      <aside
        className={cn(
          "scrollbar-thin order-2 shrink-0 space-y-3 border-t p-3 lg:order-1 lg:w-[260px] lg:overflow-auto lg:border-r lg:border-t-0 xl:w-[300px]",
          collapsed && "lg:hidden",
        )}
        aria-label={t("pages.runPage.map.contents")}
        data-testid="map-contents"
        data-collapsed={collapsed ? "true" : undefined}
      >
        {sidebar}
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
