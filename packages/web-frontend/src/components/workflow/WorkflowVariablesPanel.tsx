/**
 * Workflow Variables Panel Component
 *
 * Collapsible sidebar showing workflow variables:
 * - Variable name, description, default value
 * - Expand/collapse for long values
 * - Type indicators
 */

import React, { useState } from "react";
import { ChevronRight, ChevronDown, Variable } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface WorkflowVariable {
  name: string;
  description?: string;
  type?: string;
  default?: unknown;
  required?: boolean;
}

interface WorkflowVariablesPanelProps {
  variables?: Record<string, WorkflowVariable> | WorkflowVariable[];
  className?: string;
  defaultOpen?: boolean;
}

/**
 * Format value for display
 */
function formatValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "—";
  }
  if (typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

/**
 * Get variable type badge color
 */
function getTypeBadgeVariant(type?: string): "default" | "secondary" | "outline" {
  switch (type) {
    case "string":
      return "default";
    case "number":
      return "secondary";
    case "boolean":
      return "outline";
    default:
      return "outline";
  }
}

/**
 * Individual variable item
 */
const VariableItem: React.FC<{ variable: WorkflowVariable }> = ({ variable }) => {
  const [expanded, setExpanded] = useState(false);
  const formattedValue = formatValue(variable.default);
  const isLongValue = formattedValue.length > 50;

  return (
    <div className="border-b border-border last:border-0 py-2 px-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-sm font-medium truncate">{variable.name}</span>
            {variable.required && <span className="text-destructive text-xs">*</span>}
            {variable.type && (
              <Badge variant={getTypeBadgeVariant(variable.type)} className="text-[10px] px-1 py-0">
                {variable.type}
              </Badge>
            )}
          </div>
          {variable.description && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
              {variable.description}
            </p>
          )}
        </div>
      </div>

      {/* Value display */}
      {variable.default !== undefined && (
        <div className="mt-1.5">
          {isLongValue ? (
            <Collapsible open={expanded} onOpenChange={setExpanded}>
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs w-full justify-start">
                  {expanded ? (
                    <ChevronDown className="w-3 h-3 mr-1" />
                  ) : (
                    <ChevronRight className="w-3 h-3 mr-1" />
                  )}
                  {expanded ? "Hide value" : "Show value"}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="text-xs bg-muted p-2 rounded mt-1 overflow-auto max-h-32">
                  {formattedValue}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <div className="text-xs font-mono bg-muted px-2 py-1 rounded truncate">
              {formattedValue}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Variables Panel Component
 */
export const WorkflowVariablesPanel: React.FC<WorkflowVariablesPanelProps> = ({
  variables,
  className = "",
  defaultOpen = true,
}) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(defaultOpen);

  // Normalize variables to array
  const variableList: WorkflowVariable[] = React.useMemo(() => {
    if (!variables) return [];
    if (Array.isArray(variables)) return variables;
    return Object.entries(variables).map(([name, value]) => ({
      name,
      ...value,
    }));
  }, [variables]);

  if (variableList.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "border-r border-border bg-card h-full overflow-hidden flex flex-col",
        isOpen ? "w-64" : "w-10",
        "transition-all duration-200",
        className,
      )}
    >
      {/* Header */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 p-2 border-b border-border hover:bg-muted/50 transition-colors w-full"
      >
        {isOpen ? (
          <ChevronDown className="w-4 h-4 shrink-0" />
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0" />
        )}
        <Variable className="w-4 h-4 shrink-0" />
        {isOpen && (
          <>
            <span className="text-sm font-medium flex-1 text-left">
              {t("components.workflowGraph.variables", "Variables")}
            </span>
            <Badge variant="secondary" className="text-xs">
              {variableList.length}
            </Badge>
          </>
        )}
      </button>

      {/* Variables list */}
      {isOpen && (
        <div className="flex-1 overflow-y-auto">
          {variableList.map((variable, index) => (
            <VariableItem key={variable.name || index} variable={variable} />
          ))}
        </div>
      )}

      {/* Collapsed state indicator */}
      {!isOpen && (
        <div className="flex-1 flex flex-col items-center pt-2 gap-1">
          <Badge
            variant="secondary"
            className="text-[10px] w-6 h-6 p-0 flex items-center justify-center"
          >
            {variableList.length}
          </Badge>
        </div>
      )}
    </div>
  );
};

export default WorkflowVariablesPanel;
