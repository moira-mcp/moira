/**
 * Mode registry of the flow page. `steps` is the simplest picture — what the agent is told, as
 * numbered instruction cards joined by arrows — and exists for every workflow; `map` is the derived
 * process as a diagram with its contents sidebar; `graph` is the technical node graph with its
 * controls and node details. A workflow without a process view has no map. The URL parameter
 * `view` selects one by id; an unknown value — including a link written for one of the views this
 * page used to have (`outline`, `canvas`, `lanes`, `split`) — resolves to the page's default view.
 */

import type React from "react";
import { ListOrdered, Map, Workflow } from "lucide-react";

export type FlowViewMode = "steps" | "map" | "graph";

export interface FlowModeDefinition {
  id: FlowViewMode;
  icon: React.ComponentType<{ className?: string }>;
}

export const FLOW_MODES: readonly FlowModeDefinition[] = [
  { id: "steps", icon: ListOrdered },
  { id: "map", icon: Map },
  { id: "graph", icon: Workflow },
];

export const DEFAULT_FLOW_MODE: FlowViewMode = "map";

export function resolveFlowMode(
  value: string | null | undefined,
  fallback: FlowViewMode = DEFAULT_FLOW_MODE,
): FlowViewMode {
  return FLOW_MODES.some((mode) => mode.id === value) ? (value as FlowViewMode) : fallback;
}
