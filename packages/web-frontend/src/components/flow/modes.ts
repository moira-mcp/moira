/**
 * Mode registry of the flow page. The URL parameter `view` selects a mode by id; an unknown or
 * missing value resolves to the default (outline). `graph` is the technical node graph with its
 * controls and node details; it is the only mode of a workflow without a process view.
 */

import type React from "react";
import { AlignLeft, Columns3, GitFork, PanelsLeftRight, Workflow } from "lucide-react";

export type FlowViewMode = "outline" | "canvas" | "lanes" | "split" | "graph";

export interface FlowModeDefinition {
  id: FlowViewMode;
  icon: React.ComponentType<{ className?: string }>;
}

export const FLOW_MODES: readonly FlowModeDefinition[] = [
  { id: "outline", icon: AlignLeft },
  { id: "canvas", icon: GitFork },
  { id: "lanes", icon: Columns3 },
  { id: "split", icon: PanelsLeftRight },
  { id: "graph", icon: Workflow },
];

export const DEFAULT_FLOW_MODE: FlowViewMode = "outline";

export function resolveFlowMode(value: string | null | undefined): FlowViewMode {
  return FLOW_MODES.some((mode) => mode.id === value) ? (value as FlowViewMode) : DEFAULT_FLOW_MODE;
}
