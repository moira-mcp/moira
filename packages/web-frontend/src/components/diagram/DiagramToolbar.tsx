/**
 * One toolbar for a process diagram, the same on the map and on the graph: what the surface puts
 * first (the map's sidebar toggle), the step finder, the layout presets and the zoom and fit
 * actions — instead of React Flow's floating control cluster plus controls scattered around.
 */

import React from "react";
import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { LayoutPresetButtons } from "./LayoutPresetButtons";

export function ToolbarButton({
  onClick,
  title,
  label,
  active = false,
  children,
  dataAttributes,
}: {
  onClick: () => void;
  title: string;
  label: string;
  active?: boolean;
  children: React.ReactNode;
  dataAttributes?: Record<string, string | undefined>;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      aria-pressed={active || undefined}
      className={cn(
        "inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground transition hover:border-border hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "border-primary/50 bg-primary/10 text-primary",
      )}
      {...dataAttributes}
    >
      {children}
    </button>
  );
}

function Divider(): React.JSX.Element {
  return <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />;
}

export function DiagramToolbar({
  leading,
  finder,
  onZoomIn,
  onZoomOut,
  onFit,
  trailing,
  testId = "diagram-toolbar",
}: {
  leading?: React.ReactNode;
  finder?: React.ReactNode;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  trailing?: React.ReactNode;
  testId?: string;
}): React.JSX.Element {
  return (
    <div
      className="flex shrink-0 items-center gap-1 border-b bg-card px-2 py-1"
      data-testid={testId}
      role="toolbar"
    >
      {leading}
      {finder && <div className="mx-1 min-w-0 flex-1 basis-[240px] max-w-[360px]">{finder}</div>}
      <div className="ml-auto flex items-center gap-0.5">
        <LayoutPresetButtons variant="toolbar" />
        <Divider />
        <ToolbarButton
          onClick={onZoomOut}
          title="Отдалить"
          label="Отдалить"
          dataAttributes={{ "data-testid": "toolbar-zoom-out" }}
        >
          <ZoomOut className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={onZoomIn}
          title="Приблизить"
          label="Приблизить"
          dataAttributes={{ "data-testid": "toolbar-zoom-in" }}
        >
          <ZoomIn className="size-4" />
        </ToolbarButton>
        <ToolbarButton
          onClick={onFit}
          title="Показать всё"
          label="Показать всё"
          dataAttributes={{ "data-testid": "toolbar-fit" }}
        >
          <Maximize className="size-4" />
        </ToolbarButton>
        {trailing}
      </div>
    </div>
  );
}
