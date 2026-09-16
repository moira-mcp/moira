/**
 * Quick layout buttons for the zoom/fit cluster of a diagram: one per preset, the active one
 * marked. Both the map and the graph mount them, and both follow the same stored choice.
 */

import React from "react";
import { ControlButton } from "@xyflow/react";
import { AlignHorizontalJustifyCenter, Rows3, Shrink } from "lucide-react";
import { cn } from "@/lib/utils";
import { LAYOUT_PRESETS, useLayoutPreset, type LayoutPreset } from "./layoutPreset";
import { ToolbarButton } from "./DiagramToolbar";

const ICONS: Record<LayoutPreset, React.ComponentType<{ className?: string }>> = {
  default: Rows3,
  compact: Shrink,
  flow: AlignHorizontalJustifyCenter,
};

export function LayoutPresetButtons({
  variant = "controls",
}: {
  /** `controls`: React Flow control buttons; `toolbar`: plain toolbar buttons. */
  variant?: "controls" | "toolbar";
}): React.JSX.Element {
  const [preset, setPreset] = useLayoutPreset();
  if (variant === "toolbar") {
    return (
      <div className="flex items-center gap-0.5" data-testid="layout-preset-buttons">
        {LAYOUT_PRESETS.map((entry) => {
          const Icon = ICONS[entry.id];
          const active = entry.id === preset;
          return (
            <ToolbarButton
              key={entry.id}
              onClick={() => setPreset(entry.id)}
              title={`${entry.label} — ${entry.hint}`}
              label={entry.label}
              active={active}
              dataAttributes={{
                "data-layout-preset": entry.id,
                "data-active": active ? "true" : undefined,
              }}
            >
              <Icon className="size-4" />
            </ToolbarButton>
          );
        })}
      </div>
    );
  }
  return (
    <div className="contents" data-testid="layout-preset-buttons">
      {LAYOUT_PRESETS.map((entry) => {
        const Icon = ICONS[entry.id];
        const active = entry.id === preset;
        return (
          <ControlButton
            key={entry.id}
            onClick={() => setPreset(entry.id)}
            title={`${entry.label} — ${entry.hint}`}
            aria-label={entry.label}
            aria-pressed={active}
            data-layout-preset={entry.id}
            data-active={active ? "true" : undefined}
            className={cn(active && "!bg-primary/20 !text-primary")}
          >
            <Icon className="size-4" />
          </ControlButton>
        );
      })}
    </div>
  );
}
