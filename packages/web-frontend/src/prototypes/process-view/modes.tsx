/**
 * Mode registry for the process-view prototypes. The URL parameter `view` selects a mode by id;
 * an unknown or missing value resolves to the default rather than an error.
 */

import type React from "react";
import { AlignLeft, Columns3, Footprints, GitFork, Rows3 } from "lucide-react";
import type { VariantProps } from "./shared/BlockCards";
import { CanvasView } from "./variants/CanvasView";
import { LanesView } from "./variants/LanesView";
import { OutlineView } from "./variants/OutlineView";
import { SplitView } from "./variants/SplitView";
import { TraceView } from "./variants/TraceView";

export type ViewMode = "canvas" | "lanes" | "outline" | "split" | "trace";

export interface ModeDefinition {
  id: ViewMode;
  /** i18n key suffix under pages.processViewPrototype.modes. */
  labelKey: ViewMode;
  icon: React.ComponentType<{ className?: string }>;
  component: React.ComponentType<VariantProps>;
}

export const MODES: readonly ModeDefinition[] = [
  { id: "canvas", labelKey: "canvas", icon: GitFork, component: CanvasView },
  { id: "lanes", labelKey: "lanes", icon: Columns3, component: LanesView },
  { id: "outline", labelKey: "outline", icon: AlignLeft, component: OutlineView },
  { id: "split", labelKey: "split", icon: Rows3, component: SplitView },
  { id: "trace", labelKey: "trace", icon: Footprints, component: TraceView },
];

export const DEFAULT_MODE: ViewMode = "canvas";

export function resolveMode(value: string | null | undefined): ViewMode {
  return MODES.some((mode) => mode.id === value) ? (value as ViewMode) : DEFAULT_MODE;
}
