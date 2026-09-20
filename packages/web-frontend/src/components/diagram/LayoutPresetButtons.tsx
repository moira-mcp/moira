/**
 * Quick layout buttons for the zoom/fit cluster of a diagram: one per preset, the active one
 * marked. Both the map and the graph mount them, and both follow the same stored choice — but a
 * preset means something different on each surface (the map moves block rows, the graph moves
 * whole block groups), so each names its own copy under
 * `components.diagram.presets.<surface>.<id>`.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { ControlButton } from "@xyflow/react";
import { AlignHorizontalJustifyCenter, ArrowDownUp, Rows3, Shrink } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  LAYOUT_PRESETS,
  useLayoutPreset,
  type LayoutPreset,
  type PresetSurface,
} from "./layoutPreset";
import { ToolbarButton } from "./DiagramToolbar";

const ICONS: Record<LayoutPreset, React.ComponentType<{ className?: string }>> = {
  default: Rows3,
  compact: Shrink,
  flow: AlignHorizontalJustifyCenter,
  vertical: ArrowDownUp,
};

export function LayoutPresetButtons({
  variant = "controls",
  surface = "map",
}: {
  /** `controls`: React Flow control buttons; `toolbar`: plain toolbar buttons. */
  variant?: "controls" | "toolbar";
  /** Which diagram is naming the presets; picks the wording. */
  surface?: PresetSurface;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [preset, setPreset] = useLayoutPreset();
  const label = (id: LayoutPreset): string =>
    t(`components.diagram.presets.${surface}.${id}.label`);
  const hint = (id: LayoutPreset): string =>
    `${label(id)} — ${t(`components.diagram.presets.${surface}.${id}.hint`)}`;
  if (variant === "toolbar") {
    return (
      <div className="flex items-center gap-0.5" data-testid="layout-preset-buttons">
        {LAYOUT_PRESETS.map((id) => {
          const Icon = ICONS[id];
          const active = id === preset;
          return (
            <ToolbarButton
              key={id}
              onClick={() => setPreset(id)}
              title={hint(id)}
              label={label(id)}
              active={active}
              dataAttributes={{
                "data-layout-preset": id,
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
      {LAYOUT_PRESETS.map((id) => {
        const Icon = ICONS[id];
        const active = id === preset;
        return (
          <ControlButton
            key={id}
            onClick={() => setPreset(id)}
            data-hint={hint(id)}
            aria-label={label(id)}
            aria-pressed={active}
            data-layout-preset={id}
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
