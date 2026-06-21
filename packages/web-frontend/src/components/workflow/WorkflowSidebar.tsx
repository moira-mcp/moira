/**
 * Workflow Sidebar — Persistent side panel for workflow viewer
 *
 * Shows workflow-level info when no node selected,
 * node details when a node is selected.
 * Always visible (not an overlay).
 */

import React, { useState } from "react";
import { Node } from "@xyflow/react";
import {
  Play,
  Bot,
  GitBranch,
  Send,
  Workflow,
  Square,
  Code,
  ChevronDown,
  ChevronRight,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ArrowLeft,
  FileJson,
  Info,
  Tag,
  Hash,
  BookOpen,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import type { WorkflowGraph as WorkflowGraphType } from "../../types";

interface WorkflowSidebarProps {
  /** The workflow data for workflow-level info */
  workflow: WorkflowGraphType;
  /** Currently selected node (null = show workflow info) */
  selectedNode: Node | null;
  /** Incoming connections for selected node */
  incomingNodes?: Array<{ id: string; label: string }>;
  /** Outgoing connections for selected node */
  outgoingNodes?: Array<{ id: string; label: string; connectionType: string }>;
  /** Callback to clear selection */
  onClearSelection?: () => void;
  className?: string;
}

// Node type icons
const NODE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  start: Play,
  "agent-directive": Bot,
  condition: GitBranch,
  "telegram-notification": Send,
  subgraph: Workflow,
  end: Square,
  expression: Code,
};

// Type badge colors
const TYPE_COLORS: Record<string, string> = {
  start: "bg-chart-2/10 text-chart-2",
  "agent-directive": "bg-chart-1/10 text-chart-1",
  condition: "bg-chart-4/10 text-chart-4",
  "telegram-notification": "bg-chart-3/10 text-chart-3",
  subgraph: "bg-chart-3/10 text-chart-3",
  end: "bg-destructive/10 text-destructive",
  expression: "bg-chart-3/10 text-chart-3",
};

/**
 * Collapsible section
 */
const Section: React.FC<{
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
  defaultOpen?: boolean;
  collapsible?: boolean;
}> = ({ title, icon: Icon, children, defaultOpen = true, collapsible = false }) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  if (!collapsible) {
    return (
      <div className="py-3">
        <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
          {Icon && <Icon className="w-3.5 h-3.5" />}
          {title}
        </h4>
        {children}
      </div>
    );
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className="py-3">
        <CollapsibleTrigger asChild>
          <button className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors w-full">
            {isOpen ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )}
            {Icon && <Icon className="w-3.5 h-3.5" />}
            {title}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2">{children}</CollapsibleContent>
      </div>
    </Collapsible>
  );
};

/**
 * Workflow-level information panel
 */
const WorkflowInfo: React.FC<{ workflow: WorkflowGraphType }> = ({ workflow }) => {
  const { t } = useTranslation();
  const { metadata, nodes } = workflow;

  // Count node types
  const nodeTypeCounts = nodes.reduce(
    (acc, node) => {
      const type = node.type || "unknown";
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <div className="divide-y divide-border">
      {/* Header */}
      <div className="pb-3">
        <div className="flex items-center gap-2 mb-2">
          <Workflow className="w-5 h-5 text-primary" />
          <h3 className="font-semibold text-base truncate">{metadata.name}</h3>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">
            v{metadata.version}
          </Badge>
          {metadata.author && (
            <span className="text-xs text-muted-foreground">{metadata.author}</span>
          )}
        </div>
      </div>

      {/* Description */}
      {metadata.description && (
        <Section title={t("components.workflowSidebar.description", "Description")} icon={Info}>
          <p className="text-sm leading-relaxed text-muted-foreground">{metadata.description}</p>
        </Section>
      )}

      {/* Tags */}
      {metadata.tags && metadata.tags.length > 0 && (
        <Section title={t("components.workflowSidebar.tags", "Tags")} icon={Tag}>
          <div className="flex flex-wrap gap-1.5">
            {metadata.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        </Section>
      )}

      {/* Node Statistics */}
      <Section title={t("components.workflowSidebar.nodes", "Nodes")} icon={Hash}>
        <div className="space-y-1.5">
          <div className="text-sm font-medium">
            {nodes.length} {t("components.workflowSidebar.totalNodes", "total nodes")}
          </div>
          <div className="grid grid-cols-2 gap-1">
            {Object.entries(nodeTypeCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => {
                const Icon = NODE_ICONS[type] || Bot;
                return (
                  <div
                    key={type}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <Icon className="w-3 h-3" />
                    <span className="truncate">{type.replace("-", " ")}</span>
                    <span className="ml-auto font-medium">{count}</span>
                  </div>
                );
              })}
          </div>
        </div>
      </Section>

      {/* Philosophy */}
      {metadata.philosophy && (
        <Section
          title={t("components.workflowSidebar.philosophy", "Philosophy")}
          icon={BookOpen}
          collapsible
          defaultOpen={false}
        >
          <p className="text-sm leading-relaxed text-muted-foreground italic">
            {metadata.philosophy}
          </p>
        </Section>
      )}
    </div>
  );
};

/**
 * Node detail panel (same content as old NodeDetailSheet, without Sheet wrapper)
 */
const NodeDetail: React.FC<{
  node: Node;
  incomingNodes: Array<{ id: string; label: string }>;
  outgoingNodes: Array<{ id: string; label: string; connectionType: string }>;
}> = ({ node, incomingNodes, outgoingNodes }) => {
  const { t } = useTranslation();

  const data = node.data as Record<string, unknown>;
  const nodeType = (node.type || "unknown") as string;
  const Icon = NODE_ICONS[nodeType] || Bot;

  const directive = data.directive as string | undefined;
  const completionCondition = data.completionCondition as string | undefined;
  const inputSchema = data.inputSchema as Record<string, unknown> | undefined;
  const condition = data.condition as Record<string, unknown> | undefined;
  const message = data.message as string | undefined;
  const expressions = data.expressions as string[] | undefined;
  const graphId = data.graphId as string | undefined;
  const validationErrors = data.validationErrors as string[] | undefined;
  const validationWarnings = data.validationWarnings as string[] | undefined;

  return (
    <div className="divide-y divide-border">
      {/* Header */}
      <div className="pb-3">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "w-9 h-9 rounded-md flex items-center justify-center shrink-0",
              TYPE_COLORS[nodeType] || "bg-muted text-muted-foreground",
            )}
          >
            <Icon className="w-4.5 h-4.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold truncate">
              {(data.label as string) || node.id}
            </h3>
            <span
              className={cn("text-xs px-1.5 py-0.5 rounded font-medium", TYPE_COLORS[nodeType])}
            >
              {nodeType.replace("-", " ")}
            </span>
          </div>
        </div>
      </div>

      {/* Validation */}
      {((validationErrors && validationErrors.length > 0) ||
        (validationWarnings && validationWarnings.length > 0)) && (
        <Section title={t("components.workflowGraph.nodeDetails.validation", "Validation")}>
          {validationErrors?.map((error, i) => (
            <div key={i} className="flex items-start gap-2 text-sm text-destructive mb-1">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          ))}
          {validationWarnings?.map((warning, i) => (
            <div key={i} className="flex items-start gap-2 text-sm text-chart-4 mb-1">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{warning}</span>
            </div>
          ))}
        </Section>
      )}

      {/* Directive */}
      {directive && (
        <Section title={t("components.workflowGraph.nodeDetails.directive", "Directive")}>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">{directive}</p>
        </Section>
      )}

      {/* Completion Condition */}
      {completionCondition && (
        <Section
          title={t("components.workflowGraph.nodeDetails.completionCondition", "Success Criteria")}
        >
          <p className="text-sm leading-relaxed text-muted-foreground">{completionCondition}</p>
        </Section>
      )}

      {/* Message */}
      {message && (
        <Section title={t("components.workflowGraph.nodeDetails.message", "Message")}>
          <p className="text-sm whitespace-pre-wrap">{message}</p>
        </Section>
      )}

      {/* Condition */}
      {condition && (
        <Section
          title={t("components.workflowGraph.nodeDetails.condition", "Condition")}
          collapsible
          defaultOpen={false}
        >
          <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-48">
            {JSON.stringify(condition, null, 2)}
          </pre>
        </Section>
      )}

      {/* Expressions */}
      {expressions && expressions.length > 0 && (
        <Section title={t("components.workflowGraph.nodeDetails.expressions", "Expressions")}>
          {expressions.map((expr, i) => (
            <div key={i} className="text-sm font-mono bg-muted p-2 rounded mb-1">
              {expr}
            </div>
          ))}
        </Section>
      )}

      {/* Subgraph ID */}
      {graphId && (
        <Section title={t("components.workflowGraph.nodeDetails.subgraphId", "Subgraph ID")}>
          <code className="text-sm font-mono bg-muted px-2 py-1 rounded">{graphId}</code>
        </Section>
      )}

      {/* Input Schema */}
      {inputSchema && Object.keys(inputSchema).length > 0 && (
        <Section
          title={t("components.workflowGraph.nodeDetails.inputSchema", "Input Schema")}
          icon={FileJson}
          collapsible
          defaultOpen={false}
        >
          <pre className="text-xs bg-muted p-3 rounded-md overflow-auto max-h-64">
            {JSON.stringify(inputSchema, null, 2)}
          </pre>
        </Section>
      )}

      {/* Node ID */}
      <Section title={t("components.workflowSidebar.nodeId", "Node ID")}>
        <code className="text-xs font-mono bg-muted px-2 py-1 rounded block overflow-x-auto">
          {node.id}
        </code>
      </Section>

      {/* Connections */}
      {(incomingNodes.length > 0 || outgoingNodes.length > 0) && (
        <Section title={t("components.workflowGraph.nodeDetails.connections", "Connections")}>
          <div className="space-y-3">
            {incomingNodes.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  <ArrowLeft className="w-3 h-3" />
                  <span>{t("components.workflowSidebar.from", "From")}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {incomingNodes.map((n) => (
                    <Badge key={n.id} variant="secondary" className="text-xs font-normal">
                      {n.label || n.id}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
            {outgoingNodes.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  <ArrowRight className="w-3 h-3" />
                  <span>{t("components.workflowSidebar.to", "To")}</span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {outgoingNodes.map((n) => (
                    <Badge
                      key={`${n.id}-${n.connectionType}`}
                      variant="secondary"
                      className="text-xs font-normal"
                    >
                      {n.label || n.id}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
};

/**
 * Persistent workflow sidebar
 */
export const WorkflowSidebar: React.FC<WorkflowSidebarProps> = ({
  workflow,
  selectedNode,
  incomingNodes = [],
  outgoingNodes = [],
  onClearSelection,
  className,
}) => {
  const { t } = useTranslation();

  return (
    <div
      className={cn("border-l border-border bg-card flex flex-col h-full", className)}
      data-testid="workflow-sidebar"
    >
      {/* Sidebar header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between shrink-0">
        <h3 className="text-sm font-semibold text-muted-foreground">
          {selectedNode
            ? t("components.workflowSidebar.nodeDetails", "Node Details")
            : t("components.workflowSidebar.workflowInfo", "Workflow Info")}
        </h3>
        {selectedNode && onClearSelection && (
          <button
            onClick={onClearSelection}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {t("components.workflowSidebar.showWorkflowInfo", "← Workflow")}
          </button>
        )}
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="px-4 py-2">
          {selectedNode ? (
            <NodeDetail
              node={selectedNode}
              incomingNodes={incomingNodes}
              outgoingNodes={outgoingNodes}
            />
          ) : (
            <WorkflowInfo workflow={workflow} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
};

export default WorkflowSidebar;
