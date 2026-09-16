/**
 * Mode registry of the run page: two views of the same run. `map` is the process as a diagram with
 * its contents sidebar; `graph` is the technical node graph. The URL parameter `view` selects one
 * by id; an unknown value — including a link written for one of the views this page used to have
 * (`lanes`, `canvas`, `outline`, `route`) — resolves to the map rather than an error.
 */

import type React from "react";
import { Map, Workflow } from "lucide-react";

export type RunViewMode = "map" | "graph";

export interface ModeDefinition {
  id: RunViewMode;
  icon: React.ComponentType<{ className?: string }>;
}

export const MODES: readonly ModeDefinition[] = [
  { id: "map", icon: Map },
  { id: "graph", icon: Workflow },
];

export const DEFAULT_MODE: RunViewMode = "map";

export function resolveMode(value: string | null | undefined): RunViewMode {
  return MODES.some((mode) => mode.id === value) ? (value as RunViewMode) : DEFAULT_MODE;
}
