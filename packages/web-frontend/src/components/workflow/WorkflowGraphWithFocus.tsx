/**
 * The technical node graph with an imperative focus: a `focusRequest` (node id + token) brings
 * that node into view once the graph is mounted. The React Flow instance is stored once
 * (`onInit` is stable), because storing it on every init re-renders the wrapper without end and
 * a deferred focus never gets to run.
 */

import React, { useCallback, useEffect, useState } from "react";
import { WorkflowGraph } from "./WorkflowGraph";
import type { WorkflowGraph as WorkflowGraphType } from "../../types";

export interface WorkflowGraphWithFocusProps {
  workflow: WorkflowGraphType;
  validation?: {
    isValid: boolean;
    globalErrors: string[];
    globalWarnings: string[];
    nodeValidation: Record<string, { isValid: boolean; errors: string[]; warnings: string[] }>;
  };
  currentNodeId?: string | null;
  errorNodeIds?: string[];
  onNodeClick?: (event: React.MouseEvent, node: { id: string }) => void;
  showControls?: boolean;
  showMinimap?: boolean;
  showNodeDetails?: boolean;
  onWorkflowNavigate?: (workflowId: string) => void;
  onNodeSelect?: (
    node: import("@xyflow/react").Node | null,
    connections: {
      incoming: Array<{ id: string; label: string }>;
      outgoing: Array<{ id: string; label: string; connectionType: string }>;
    },
  ) => void;
  focusRequest: { nodeId: string; token: number } | null;
}

export function WorkflowGraphWithFocus({ focusRequest, ...props }: WorkflowGraphWithFocusProps) {
  const [reactFlowInstance, setReactFlowInstance] = useState<{
    fitView: (options?: { nodes?: { id: string }[]; padding?: number; duration?: number }) => void;
  } | null>(null);

  const handleInit = useCallback(
    (instance: NonNullable<typeof reactFlowInstance>) =>
      setReactFlowInstance((previous) => previous ?? instance),
    [],
  );

  useEffect(() => {
    if (!reactFlowInstance || !focusRequest) return;
    // The graph lays itself out after init and fits the whole graph shortly after; the focus
    // waits past that fit so the node, not the overview, ends up in view.
    const timer = window.setTimeout(() => {
      reactFlowInstance.fitView({
        nodes: [{ id: focusRequest.nodeId }],
        padding: 0.5,
        duration: 300,
      });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [reactFlowInstance, focusRequest]);

  return <WorkflowGraph {...props} onInit={handleInit} />;
}
