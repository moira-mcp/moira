/**
 * One toolbar for a process diagram, the same on the map and on the graph, and the only place
 * the page keeps its functions: the view modes (map / graph), what the surface puts first (the
 * map's sidebar toggle, the run's route cursor), the step finder folded into a button, the
 * layout presets, the zoom and fit actions, the minimap switch, and the page's trailing controls
 * (legend, guide, edit). Text about the page lives in `PageHeader`, never here.
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Map as MapIcon, Maximize, Search, X, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { LayoutPresetButtons } from "./LayoutPresetButtons";
import type { PresetSurface } from "./layoutPreset";

export function ToolbarButton({
  onClick,
  title,
  label,
  active = false,
  children,
  dataAttributes,
  className,
}: {
  onClick: () => void;
  title: string;
  label: string;
  active?: boolean;
  children: React.ReactNode;
  dataAttributes?: Record<string, string | undefined>;
  className?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      data-hint={title}
      aria-label={label}
      aria-pressed={active || undefined}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground transition hover:border-border hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "border-primary/50 bg-primary/10 text-primary",
        className,
      )}
      {...dataAttributes}
    >
      {children}
    </button>
  );
}

export function ToolbarDivider(): React.JSX.Element {
  return <span className="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true" />;
}

export function DiagramToolbar({
  modes,
  leading,
  finder,
  onZoomIn,
  onZoomOut,
  onFit,
  minimap,
  trailing,
  surface = "map",
  presets = true,
  testId = "diagram-toolbar",
}: {
  /** The page's view-mode switch (map / graph), first in the row. */
  modes?: React.ReactNode;
  leading?: React.ReactNode;
  /** The step finder; shown when the search button is pressed. Receives `onClose` via context-free prop. */
  finder?: (close: () => void) => React.ReactNode;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** The minimap switch, when the diagram has one. */
  minimap?: { on: boolean; toggle: () => void };
  trailing?: React.ReactNode;
  /** Which diagram this toolbar belongs to; picks the presets' wording. */
  surface?: PresetSurface;
  /** Show the layout presets; a diagram with one fixed layout turns them off. */
  presets?: boolean;
  testId?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [finderOpen, setFinderOpen] = useState(false);
  const finderText = t("components.diagram.toolbar.finder");
  return (
    <div
      // Wraps when the diagram's column is narrow (both sidebars open): a second short row beats
      // buttons cut off at the edge.
      className="flex shrink-0 flex-wrap items-center gap-x-1 gap-y-1 border-b bg-card px-2 py-1"
      data-testid={testId}
      role="toolbar"
    >
      {modes && <div className="flex shrink-0 items-center">{modes}</div>}
      {modes && (leading || finder) && <ToolbarDivider />}
      {leading && <div className="flex min-w-0 shrink-0 items-center gap-2">{leading}</div>}
      {finder && (
        <div className={cn("flex min-w-0 items-center gap-1", finderOpen && "flex-1")}>
          <ToolbarButton
            onClick={() => setFinderOpen((open) => !open)}
            title={finderText}
            label={finderText}
            active={finderOpen}
            dataAttributes={{ "data-testid": "toolbar-finder" }}
          >
            {finderOpen ? <X className="size-4" /> : <Search className="size-4" />}
          </ToolbarButton>
          {finderOpen && (
            <div className="min-w-[160px] max-w-[360px] flex-1" data-testid="toolbar-finder-field">
              {finder(() => setFinderOpen(false))}
            </div>
          )}
        </div>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {presets && (
          <>
            <LayoutPresetButtons variant="toolbar" surface={surface} />
            <ToolbarDivider />
          </>
        )}
        <ToolbarButton
          onClick={onZoomOut}
          title={t("components.diagram.toolbar.zoomOut")}
          label={t("components.diagram.toolbar.zoomOut")}
          dataAttributes={{ "data-testid": "toolbar-zoom-out" }}
        >
          <ZoomOut className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={onZoomIn}
          title={t("components.diagram.toolbar.zoomIn")}
          label={t("components.diagram.toolbar.zoomIn")}
          dataAttributes={{ "data-testid": "toolbar-zoom-in" }}
        >
          <ZoomIn className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={onFit}
          title={t("components.diagram.toolbar.fit")}
          label={t("components.diagram.toolbar.fit")}
          dataAttributes={{ "data-testid": "toolbar-fit" }}
        >
          <Maximize className="size-4" />
        </ToolbarButton>
        {minimap && (
          <ToolbarButton
            onClick={minimap.toggle}
            title={t("components.diagram.toolbar.minimapHint")}
            label={t("components.diagram.toolbar.minimap")}
            active={minimap.on}
            dataAttributes={{ "data-testid": "toolbar-minimap" }}
          >
            <MapIcon className="size-4" />
          </ToolbarButton>
        )}
        {trailing && (
          <>
            <ToolbarDivider />
            {trailing}
          </>
        )}
      </div>
    </div>
  );
}
