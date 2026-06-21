/**
 * Node Detail Sheet Component
 *
 * Clean side panel with node information:
 * - Node name and type
 * - Full directive
 * - Completion condition
 * - Connections
 * - Validation status
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
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface NodeDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  node: Node | null;
  incomingNodes?: Array<{ id: string; label: string }>;
  outgoingNodes?: Array<{ id: string; label: string; connectionType: string }>;
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

/**
 * Section component for consistent styling
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
 * Node Detail Sheet Component
 */
export const NodeDetailSheet: React.FC<NodeDetailSheetProps> = ({
  open,
  onOpenChange,
  node,
  incomingNodes = [],
  outgoingNodes = [],
}) => {
  const { t } = useTranslation();

  if (!node) return null;

  const data = node.data as Record<string, unknown>;
  const nodeType = (node.type || "unknown") as string;
  const Icon = NODE_ICONS[nodeType] || Bot;

  // Extract data fields
  const directive = data.directive as string | undefined;
  const completionCondition = data.completionCondition as string | undefined;
  const inputSchema = data.inputSchema as Record<string, unknown> | undefined;
  const condition = data.condition as Record<string, unknown> | undefined;
  const message = data.message as string | undefined;
  const expressions = data.expressions as string[] | undefined;
  const graphId = data.graphId as string | undefined;
  const validationErrors = data.validationErrors as string[] | undefined;
  const validationWarnings = data.validationWarnings as string[] | undefined;

  // Type colors for badge
  const typeColors: Record<string, string> = {
    start: "bg-chart-2/10 text-chart-2",
    "agent-directive": "bg-chart-1/10 text-chart-1",
    condition: "bg-chart-4/10 text-chart-4",
    "telegram-notification": "bg-chart-3/10 text-chart-3",
    subgraph: "bg-chart-3/10 text-chart-3",
    end: "bg-destructive/10 text-destructive",
    expression: "bg-chart-3/10 text-chart-3",
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[380px] sm:w-[440px] p-0 flex flex-col">
        {/* Header */}
        <SheetHeader className="px-6 py-4 border-b bg-muted/30">
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "w-9 h-9 rounded-md flex items-center justify-center shrink-0",
                typeColors[nodeType] || "bg-muted text-muted-foreground",
              )}
            >
              <Icon className="w-4.5 h-4.5" />
            </div>
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-left text-base font-semibold truncate">
                {(data.label as string) || node.id}
              </SheetTitle>
              <div className="flex items-center gap-2 mt-1">
                <span
                  className={cn("text-xs px-1.5 py-0.5 rounded font-medium", typeColors[nodeType])}
                >
                  {nodeType.replace("-", " ")}
                </span>
              </div>
            </div>
          </div>
        </SheetHeader>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-6 divide-y divide-border">
            {/* Validation errors/warnings */}
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

            {/* Directive - for agent-directive nodes */}
            {directive && (
              <Section title={t("components.workflowGraph.nodeDetails.directive", "Directive")}>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">{directive}</p>
              </Section>
            )}

            {/* Completion Condition */}
            {completionCondition && (
              <Section
                title={t(
                  "components.workflowGraph.nodeDetails.completionCondition",
                  "Success Criteria",
                )}
              >
                <p className="text-sm leading-relaxed text-muted-foreground">
                  {completionCondition}
                </p>
              </Section>
            )}

            {/* Message - for telegram nodes */}
            {message && (
              <Section title={t("components.workflowGraph.nodeDetails.message", "Message")}>
                <p className="text-sm whitespace-pre-wrap">{message}</p>
              </Section>
            )}

            {/* Condition - for condition nodes */}
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

            {/* Expressions - for expression nodes */}
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
            <Section title="Node ID">
              <code className="text-xs font-mono bg-muted px-2 py-1 rounded block overflow-x-auto">
                {node.id}
              </code>
            </Section>

            {/* Connections */}
            {(incomingNodes.length > 0 || outgoingNodes.length > 0) && (
              <Section title={t("components.workflowGraph.nodeDetails.connections", "Connections")}>
                <div className="space-y-3">
                  {/* Incoming */}
                  {incomingNodes.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                        <ArrowLeft className="w-3 h-3" />
                        <span>From</span>
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

                  {/* Outgoing */}
                  {outgoingNodes.length > 0 && (
                    <div>
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                        <ArrowRight className="w-3 h-3" />
                        <span>To</span>
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
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default NodeDetailSheet;
