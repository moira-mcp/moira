/**
 * Mode registry of the run page. The URL parameter `view` selects a mode by id; an unknown or
 * missing value resolves to the default (lanes) rather than an error.
 */

import type React from "react";
import { AlignLeft, Columns3, Footprints, GitFork } from "lucide-react";

export type RunViewMode = "lanes" | "canvas" | "outline" | "route";

export interface ModeDefinition {
  id: RunViewMode;
  icon: React.ComponentType<{ className?: string }>;
}

export const MODES: readonly ModeDefinition[] = [
  { id: "lanes", icon: Columns3 },
  { id: "canvas", icon: GitFork },
  { id: "outline", icon: AlignLeft },
  { id: "route", icon: Footprints },
];

export const DEFAULT_MODE: RunViewMode = "lanes";

export function resolveMode(value: string | null | undefined): RunViewMode {
  return MODES.some((mode) => mode.id === value) ? (value as RunViewMode) : DEFAULT_MODE;
}
