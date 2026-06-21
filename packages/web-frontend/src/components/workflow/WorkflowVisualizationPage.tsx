/**
 * Workflow Visualization Page Container
 *
 * Full-page workflow visualization with:
 * - Header with metadata (name, version, description, author, tags)
 * - Variables panel (collapsible sidebar)
 * - Graph canvas with compact nodes
 * - Node detail sheet on click
 */

import React from "react";
import { WorkflowGraph as WorkflowGraphComponent } from "./WorkflowGraph";
import { WorkflowHeader } from "./WorkflowHeader";
import { WorkflowVariablesPanel } from "./WorkflowVariablesPanel";
import { WorkflowGraph, WorkflowFileInfo, WorkflowValidationStatus } from "../../types";
import { Node } from "@xyflow/react";

interface WorkflowVisualizationPageProps {
  /** Workflow data */
  workflow: WorkflowGraph;
  /** File info (visibility, author, etc.) */
  fileInfo?: WorkflowFileInfo;
  /** Validation status */
  validation?: WorkflowValidationStatus;
  /** Current node ID for execution highlighting */
  currentNodeId?: string | null;
  /** Handler for navigating to another workflow (subgraph) */
  onWorkflowNavigate?: (workflowId: string) => void;
  /** Handler for node click */
  onNodeClick?: (event: React.MouseEvent, node: Node) => void;
  /** Additional CSS class */
  className?: string;
  /** Show variables panel */
  showVariables?: boolean;
  /** Show header */
  showHeader?: boolean;
  /** Show controls */
  showControls?: boolean;
  /** Show minimap */
  showMinimap?: boolean;
}

/**
 * Workflow Visualization Page
 */
export const WorkflowVisualizationPage: React.FC<WorkflowVisualizationPageProps> = ({
  workflow,
  fileInfo,
  validation,
  currentNodeId,
  onWorkflowNavigate,
  onNodeClick,
  className = "",
  showVariables = true,
  showHeader = true,
  showControls = true,
  showMinimap = true,
}) => {
  // Count nodes and edges for header
  const nodeCount = workflow.nodes?.length || 0;
  const edgeCount =
    workflow.nodes?.reduce((count, node) => {
      if (!node.connections) return count;
      return count + Object.keys(node.connections).length;
    }, 0) || 0;

  return (
    <div className={`flex flex-col h-full ${className}`}>
      {/* Header */}
      {showHeader && (
        <WorkflowHeader
          workflow={workflow}
          fileInfo={fileInfo}
          nodeCount={nodeCount}
          edgeCount={edgeCount}
        />
      )}

      {/* Main content: Variables panel + Graph canvas */}
      <div className="flex flex-1 overflow-hidden">
        {/* Variables Panel */}
        {showVariables && workflow.variables && (
          <WorkflowVariablesPanel variables={workflow.variables} defaultOpen={true} />
        )}

        {/* Graph Canvas */}
        <div className="flex-1 relative">
          <WorkflowGraphComponent
            workflow={workflow}
            validation={validation}
            currentNodeId={currentNodeId}
            onWorkflowNavigate={onWorkflowNavigate}
            onNodeClick={onNodeClick}
            showControls={showControls}
            showMinimap={showMinimap}
            showNodeDetails={true}
          />
        </div>
      </div>
    </div>
  );
};

export default WorkflowVisualizationPage;
