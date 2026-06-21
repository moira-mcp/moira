/**
 * Compact Node Component - Unified visualization for all node types
 *
 * Features:
 * - Small footprint (~120x40px)
 * - Icon + node name
 * - Color-coded border by type
 * - Validation status via border color
 * - Hover tooltip with description
 * - Multiple handles on all 4 sides for optimal edge routing
 */

import React from "react";
import { Handle, Position } from "@xyflow/react";
import {
  Play,
  Bot,
  GitBranch,
  Send,
  Workflow,
  Square,
  Code,
  AlertCircle,
  FileText,
  FileEdit,
  FilePlus,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MoiraNodeDataUnion } from "../../types";

interface CompactNodeProps {
  data: MoiraNodeDataUnion & {
    isCurrent?: boolean;
    isError?: boolean; // Runtime error in this node
    onWorkflowNavigate?: (workflowId: string) => void;
    layoutDirection?: "TB" | "LR"; // TB = Top-Bottom, LR = Left-Right
  };
  selected?: boolean;
}

// Node type configuration
const NODE_CONFIG: Record<
  string,
  {
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    borderColor: string;
    bgColor: string;
    textColor: string;
  }
> = {
  start: {
    icon: Play,
    label: "START",
    borderColor: "border-chart-2",
    bgColor: "bg-chart-2/10",
    textColor: "text-chart-2",
  },
  "agent-directive": {
    icon: Bot,
    label: "AGENT",
    borderColor: "border-chart-1",
    bgColor: "bg-chart-1/10",
    textColor: "text-chart-1",
  },
  condition: {
    icon: GitBranch,
    label: "IF",
    borderColor: "border-chart-4",
    bgColor: "bg-chart-4/10",
    textColor: "text-chart-4",
  },
  "telegram-notification": {
    icon: Send,
    label: "NOTIFY",
    borderColor: "border-chart-3",
    bgColor: "bg-chart-3/10",
    textColor: "text-chart-3",
  },
  subgraph: {
    icon: Workflow,
    label: "SUBGRAPH",
    borderColor: "border-chart-3",
    bgColor: "bg-chart-3/10",
    textColor: "text-chart-3",
  },
  end: {
    icon: Square,
    label: "END",
    borderColor: "border-destructive",
    bgColor: "bg-destructive/10",
    textColor: "text-destructive",
  },
  expression: {
    icon: Code,
    label: "EXPR",
    borderColor: "border-chart-3",
    bgColor: "bg-chart-3/10",
    textColor: "text-chart-3",
  },
  "read-note": {
    icon: FileText,
    label: "READ",
    borderColor: "border-chart-5",
    bgColor: "bg-chart-5/10",
    textColor: "text-chart-5",
  },
  "write-note": {
    icon: FileEdit,
    label: "WRITE",
    borderColor: "border-chart-5",
    bgColor: "bg-chart-5/10",
    textColor: "text-chart-5",
  },
  "upsert-note": {
    icon: FilePlus,
    label: "UPSERT",
    borderColor: "border-chart-5",
    bgColor: "bg-chart-5/10",
    textColor: "text-chart-5",
  },
  fallback: {
    icon: HelpCircle,
    label: "UNKNOWN",
    borderColor: "border-border",
    bgColor: "bg-muted/50",
    textColor: "text-muted-foreground",
  },
};

/**
 * Get display label for node - prioritize actual name over type
 */
function getDisplayLabel(data: MoiraNodeDataUnion): string {
  // Priority: label (from metadata.displayName) > nodeId
  const displayName = data.label || data.nodeId;
  // Truncate to 16 chars for compact display
  if (displayName.length > 16) {
    return displayName.substring(0, 14) + "..";
  }
  return displayName;
}

/**
 * Get tooltip description for node
 */
function getTooltipDescription(data: MoiraNodeDataUnion): string {
  if (data.nodeType === "agent-directive" && "directive" in data) {
    return data.directive?.substring(0, 100) || data.label;
  }
  if (data.nodeType === "condition" && "conditionSummary" in data) {
    return data.conditionSummary || "Condition";
  }
  if (data.nodeType === "telegram-notification" && "message" in data) {
    return data.message?.substring(0, 100) || "Telegram notification";
  }
  if (data.nodeType === "subgraph" && "graphId" in data) {
    return `Subgraph: ${data.graphId}`;
  }
  if (data.nodeType === "expression" && "expressions" in data) {
    return data.expressions?.join("; ").substring(0, 100) || "Expression";
  }
  if (data.nodeType === "read-note" && "outputVariable" in data) {
    return `Read notes → ${data.outputVariable}`;
  }
  if (data.nodeType === "write-note" && "source" in data) {
    return `Write ${data.source}`;
  }
  if (data.nodeType === "upsert-note" && "keyTemplate" in data) {
    return `Upsert → ${data.keyTemplate}`;
  }
  if (data.nodeType === "fallback" && "originalType" in data) {
    return `Unknown node type: ${data.originalType}`;
  }
  return data.description || data.label;
}

/**
 * Props comparison for React.memo optimization
 * Only re-render if relevant props changed
 */
function arePropsEqual(prevProps: CompactNodeProps, nextProps: CompactNodeProps): boolean {
  // Quick reference check
  if (prevProps === nextProps) return true;

  // Check selected state
  if (prevProps.selected !== nextProps.selected) return false;

  // Check data fields that affect rendering
  const prevData = prevProps.data;
  const nextData = nextProps.data;

  return (
    prevData.nodeId === nextData.nodeId &&
    prevData.nodeType === nextData.nodeType &&
    prevData.label === nextData.label &&
    prevData.validationStatus === nextData.validationStatus &&
    prevData.isCurrent === nextData.isCurrent &&
    prevData.isError === nextData.isError &&
    prevData.layoutDirection === nextData.layoutDirection
  );
}

/**
 * Compact Node Component
 */
const CompactNodeInner: React.FC<CompactNodeProps> = ({ data, selected }) => {
  const config = NODE_CONFIG[data.nodeType] || NODE_CONFIG["agent-directive"];
  const Icon = config.icon;
  const isCurrent = data.isCurrent;
  const isError = data.isError;
  const isHighlighted = selected || isCurrent;
  const hasValidationError = data.validationStatus === "invalid";

  // Handle double-click for subgraph navigation
  const handleDoubleClick = () => {
    if (data.nodeType === "subgraph" && "graphId" in data && data.onWorkflowNavigate) {
      data.onWorkflowNavigate(data.graphId);
    }
  };

  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <div
            onDoubleClick={handleDoubleClick}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-lg border-2 transition-all cursor-pointer",
              "min-w-[100px] max-w-[120px]",
              config.bgColor,
              hasValidationError || isError ? "border-destructive" : config.borderColor,
              isHighlighted && "ring-2 ring-offset-2 ring-primary shadow-lg",
              isError && "ring-2 ring-offset-2 ring-destructive shadow-lg bg-destructive/20",
              isCurrent && "animate-pulse",
            )}
          >
            <Icon className={cn("w-4 h-4 shrink-0", config.textColor)} />
            <span className={cn("text-xs font-medium truncate", config.textColor)}>
              {getDisplayLabel(data)}
            </span>
            {(hasValidationError || isError) && (
              <AlertCircle className="w-3 h-3 text-destructive shrink-0" />
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[300px]">
          <div className="space-y-1">
            <div className="font-medium">{data.nodeId}</div>
            <div className="text-xs text-muted-foreground">{getTooltipDescription(data)}</div>
            {data.validationErrors && data.validationErrors.length > 0 && (
              <div className="text-xs text-destructive">{data.validationErrors[0]}</div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>

      {/* Input handle - position depends on layout direction */}
      {data.nodeType !== "start" && (
        <Handle
          type="target"
          position={data.layoutDirection === "TB" ? Position.Top : Position.Left}
          id="input"
          className="!bg-muted-foreground !border-2 !border-background !w-2.5 !h-2.5"
        />
      )}

      {/* Output handles - position depends on layout direction */}
      {data.nodeType !== "end" && (
        <>
          {data.nodeType === "condition" ? (
            <>
              {/* Condition: two outputs - true and false */}
              <Handle
                type="source"
                position={data.layoutDirection === "TB" ? Position.Bottom : Position.Right}
                id="true"
                className="!bg-chart-2 !border-2 !border-background !w-2.5 !h-2.5"
                style={data.layoutDirection === "TB" ? { left: "30%" } : { top: "30%" }}
              />
              <Handle
                type="source"
                position={data.layoutDirection === "TB" ? Position.Bottom : Position.Right}
                id="false"
                className="!bg-destructive !border-2 !border-background !w-2.5 !h-2.5"
                style={data.layoutDirection === "TB" ? { left: "70%" } : { top: "70%" }}
              />
            </>
          ) : (
            <Handle
              type="source"
              position={data.layoutDirection === "TB" ? Position.Bottom : Position.Right}
              id="output"
              className="!bg-muted-foreground !border-2 !border-background !w-2.5 !h-2.5"
            />
          )}
        </>
      )}
    </TooltipProvider>
  );
};

/**
 * Memoized Compact Node Component
 * Only re-renders when relevant props change (see arePropsEqual)
 */
const CompactNode = React.memo(CompactNodeInner, arePropsEqual);

export default CompactNode;
