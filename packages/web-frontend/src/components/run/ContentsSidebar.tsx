/**
 * The table of contents of a process: one row per block (status, number, name, list progress,
 * pass count), shown beside the map and beside the graph alike, since both know the blocks.
 * Picking a row selects the block and takes the camera there. The sidebar folds away and the
 * choice is kept per browser. `ContentsLayout` places it beside a diagram and hands the diagram
 * the fold button for its toolbar.
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { PassCount, StatusIcon } from "./status";
import { BLOCK_TONE } from "./CanvasView";
import { IndexBadge } from "../diagram/IndexBadge";
import { INTERACTIVE } from "../diagram/interactive";
import { formatDuration } from "./duration";
import type { RunBlock } from "./model";

const SIDEBAR_KEY = "moira.map.sidebarCollapsed";

/** One row of the contents: status, position, name, and the block's counts on the right. */
export function ContentsRow({
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
          "flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1 text-left text-sm hover:bg-accent",
          INTERACTIVE.clickable,
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected && "bg-accent font-medium",
          block.status === "skipped" && "text-muted-foreground line-through",
          block.status === "pending" && "text-muted-foreground",
        )}
      >
        <StatusIcon status={block.status} className="size-3.5" />
        <IndexBadge index={block.index + 1} tone={BLOCK_TONE[block.status]} size="sm" />
        <span className="min-w-0 flex-1 truncate">{block.name}</span>
        <PassCount iterations={block.iterations} />
        {bound && (
          <span
            className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
            data-hint={t("pages.runPage.map.listProgress")}
            data-contents-list={bound}
          >
            {bound}
          </span>
        )}
        {typical !== null && (
          <span
            className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
            data-hint={t("pages.runPage.map.typical")}
            data-contents-typical={typical}
          >
            {formatDuration(typical, t)}
          </span>
        )}
      </button>
    </li>
  );
}

export function ContentsSidebar({
  blocks,
  selectedBlockId,
  onSelect,
  collapsed,
  children,
  testId = "map-contents",
}: {
  blocks: RunBlock[];
  selectedBlockId: string | null;
  onSelect: (id: string) => void;
  collapsed: boolean;
  /** What the page puts above the list (a run's facts). */
  children?: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <aside
      className={cn(
        "scrollbar-thin order-2 shrink-0 space-y-3 border-t p-3 lg:order-1 lg:w-[260px] lg:overflow-auto lg:border-r lg:border-t-0 xl:w-[300px]",
        collapsed && "lg:hidden",
      )}
      aria-label={t("pages.runPage.map.contents")}
      data-testid={testId}
      data-collapsed={collapsed ? "true" : undefined}
    >
      {children}
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("pages.runPage.map.contents")}
      </p>
      <ol className="space-y-0.5" data-testid="map-contents-list">
        {blocks.map((block) => (
          <ContentsRow
            key={block.id}
            block={block}
            selected={selectedBlockId === block.id}
            onSelect={onSelect}
          />
        ))}
      </ol>
    </aside>
  );
}

/** The fold state of the contents sidebar, kept per browser. */
export function useContentsSidebar(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SIDEBAR_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = (): void =>
    setCollapsed((value) => {
      try {
        window.localStorage.setItem(SIDEBAR_KEY, value ? "0" : "1");
      } catch {
        // storage unavailable: the choice lives for this page only
      }
      return !value;
    });
  return [collapsed, toggle];
}

/** The toolbar button that folds the contents sidebar. */
export function ContentsToggle({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={t("pages.runPage.map.contents")}
      data-hint={t("pages.runPage.map.contents")}
      data-testid="map-sidebar-toggle"
      className="hidden h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground lg:inline-flex"
    >
      {collapsed ? (
        <PanelLeftOpen className="size-4" aria-hidden="true" />
      ) : (
        <PanelLeftClose className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}

/**
 * A diagram beside the contents: on a phone one scrolling column (the diagram at a readable fixed
 * height, the contents beneath), from `lg` a row that fills the page's box.
 */
export function ContentsLayout({
  blocks,
  selectedBlockId,
  onSelect,
  sidebar,
  children,
  testId,
}: {
  blocks: RunBlock[];
  selectedBlockId: string | null;
  onSelect: (id: string) => void;
  sidebar?: React.ReactNode;
  /** The diagram, given the fold button for its toolbar. */
  children: (toggle: React.ReactNode) => React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  const [collapsed, toggle] = useContentsSidebar();
  return (
    <div
      className="flex flex-col lg:h-full lg:min-h-0 lg:flex-row lg:overflow-hidden"
      data-testid={testId}
    >
      <div className="order-1 flex h-[55vh] flex-col overflow-hidden lg:order-2 lg:h-full lg:min-h-0 lg:flex-1">
        <div className="min-h-0 flex-1 overflow-hidden">
          {children(<ContentsToggle collapsed={collapsed} onToggle={toggle} />)}
        </div>
      </div>
      <ContentsSidebar
        blocks={blocks}
        selectedBlockId={selectedBlockId}
        onSelect={onSelect}
        collapsed={collapsed}
      >
        {sidebar}
      </ContentsSidebar>
    </div>
  );
}
