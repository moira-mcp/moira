/**
 * Mode registry of the flow page: the same two views as the run page. `map` is the derived process
 * as a diagram with its contents sidebar; `graph` is the technical node graph with its controls and
 * node details, and the only mode of a workflow without a process view. The URL parameter `view`
 * selects one by id; an unknown value — including a link written for one of the views this page
 * used to have (`outline`, `canvas`, `lanes`, `split`) — resolves to the map.
 */

import type React from "react";
import { Map, Workflow } from "lucide-react";

export type FlowViewMode = "map" | "graph";

export interface FlowModeDefinition {
  id: FlowViewMode;
  icon: React.ComponentType<{ className?: string }>;
}

export const FLOW_MODES: readonly FlowModeDefinition[] = [
  { id: "map", icon: Map },
  { id: "graph", icon: Workflow },
];

export const DEFAULT_FLOW_MODE: FlowViewMode = "map";

export function resolveFlowMode(value: string | null | undefined): FlowViewMode {
  return FLOW_MODES.some((mode) => mode.id === value) ? (value as FlowViewMode) : DEFAULT_FLOW_MODE;
}
