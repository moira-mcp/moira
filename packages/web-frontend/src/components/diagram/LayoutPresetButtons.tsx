/**
 * Quick layout buttons for the zoom/fit cluster of a diagram: one per preset, the active one
 * marked. Both the map and the graph mount them, and both follow the same stored choice.
 */

import React from "react";
import { ControlButton } from "@xyflow/react";
import { AlignHorizontalJustifyCenter, ArrowDownUp, Rows3, Shrink } from "lucide-react";
import { cn } from "@/lib/utils";
import { LAYOUT_PRESETS, useLayoutPreset, type LayoutPreset } from "./layoutPreset";

const ICONS: Record<LayoutPreset, React.ComponentType<{ className?: string }>> = {
  default: Rows3,
  compact: Shrink,
  flow: AlignHorizontalJustifyCenter,
  vertical: ArrowDownUp,
};

export function LayoutPresetButtons(): React.JSX.Element {
  const [preset, setPreset] = useLayoutPreset();
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
