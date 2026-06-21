/**
 * Workflow Group Component
 * Collapsible folder sections with workflow cards
 */

import React from "react";
import { WorkflowFileInfo } from "types";
import { WorkflowCard } from "./WorkflowCard";

interface WorkflowGroupProps {
  workflows: WorkflowFileInfo[];
  selectedWorkflowId?: string;
  onWorkflowSelect: (workflow: WorkflowFileInfo) => void;
  onDelete?: (workflowId: string, workflowName: string) => void;
  defaultExpanded?: boolean;
  currentUserHandle?: string;
  isAdmin?: boolean;
  viewMode?: "list" | "grid";
}

export const WorkflowGroup: React.FC<WorkflowGroupProps> = ({
  workflows,
  selectedWorkflowId,
  onWorkflowSelect,
  onDelete,
  currentUserHandle,
  isAdmin,
  viewMode = "list",
}) => {
  if (!workflows || workflows.length === 0) {
    return null;
  }

  return (
    <>
      {workflows.map((workflow) => (
        <WorkflowCard
          key={workflow.id}
          workflow={workflow}
          isSelected={selectedWorkflowId === workflow.id}
          onClick={onWorkflowSelect}
          onDelete={onDelete}
          currentUserHandle={currentUserHandle}
          isAdmin={isAdmin}
          compact={viewMode === "grid"}
        />
      ))}
    </>
  );
};
