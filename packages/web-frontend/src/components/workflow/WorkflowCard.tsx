/**
 * Workflow Card Component
 * Compact single-row card display for workflow selection
 * - Horizontal layout: icon + name/version left, owner center, badges right
 * - Description as tooltip on hover
 * - Consistent card height
 */

import React from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle,
  AlertCircle,
  Clock,
  GitBranch,
  Lock,
  Globe,
  Users,
  Trash2,
} from "lucide-react";
import { WorkflowFileInfo } from "types";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface WorkflowCardProps {
  workflow: WorkflowFileInfo;
  isSelected?: boolean;
  onClick?: (workflow: WorkflowFileInfo) => void;
  onDelete?: (workflowId: string, workflowName: string) => void;
  currentUserHandle?: string;
  isAdmin?: boolean;
  compact?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getValidationStatusConfig = (validation: any) => {
  if (validation?.isValid === true) {
    return {
      icon: <CheckCircle className="w-3 h-3" />,
      className: "bg-success/10 text-success border-success/30",
    };
  }
  if (validation?.isValid === false) {
    return {
      icon: <AlertCircle className="w-3 h-3" />,
      className: "bg-destructive/10 text-destructive border-destructive/30",
    };
  }
  return {
    icon: <Clock className="w-3 h-3" />,
    className: "bg-muted text-muted-foreground border-border",
  };
};

export const WorkflowCard: React.FC<WorkflowCardProps> = ({
  workflow,
  isSelected = false,
  onClick,
  onDelete,
  currentUserHandle,
  isAdmin = false,
  compact = false,
}) => {
  const { t } = useTranslation();
  const validationConfig = getValidationStatusConfig(workflow.validation);

  // Only show delete button if user owns the workflow or is admin
  const canDelete =
    onDelete && (isAdmin || (currentUserHandle && workflow.ownerHandle === currentUserHandle));

  const cardContent = compact ? (
    // Grid view: vertical card with description
    <Card
      className={cn(
        "cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 group h-full",
        isSelected
          ? "border-2 border-primary bg-primary/5"
          : "border border-border bg-card hover:border-primary/50",
      )}
      onClick={() => onClick?.(workflow)}
      data-testid="workflow-card"
    >
      <div className="p-3 flex flex-col gap-2 h-full">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <GitBranch className="w-4 h-4 text-primary flex-shrink-0" />
            <span className="font-medium text-sm text-foreground truncate">
              {workflow.metadata?.name || workflow.id}
            </span>
          </div>
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(workflow.id, workflow.metadata?.name || workflow.id);
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10 flex-shrink-0"
              aria-label={t("components.workflowCard.deleteWorkflow")}
              title={t("components.workflowCard.deleteWorkflow")}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>

        {workflow.metadata?.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {workflow.metadata.description}
          </p>
        )}

        <div className="flex items-center gap-1 mt-auto flex-wrap">
          {workflow.metadata?.version && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
              v{workflow.metadata.version}
            </Badge>
          )}
          <Badge
            className={cn(
              "text-[10px] px-1 py-0 h-5 flex items-center",
              validationConfig.className,
            )}
          >
            {validationConfig.icon}
          </Badge>
          {workflow.visibility === "public" ? (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 h-5 flex items-center gap-0.5 border-info/30 text-info bg-info/10"
            >
              <Globe className="w-3 h-3" />
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 h-5 flex items-center gap-0.5 border-warning/30 text-warning bg-warning/10"
            >
              <Lock className="w-3 h-3" />
            </Badge>
          )}
          {workflow.accessType === "shared" && (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 h-5 flex items-center gap-0.5 border-chart-4/30 text-chart-4 bg-chart-4/10"
              data-testid="shared-with-you-badge"
            >
              <Users className="w-3 h-3" />
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground font-mono ml-auto">
            @{workflow.ownerHandle}
          </span>
        </div>
      </div>
    </Card>
  ) : (
    <Card
      className={cn(
        "mb-1.5 cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 group",
        isSelected
          ? "border-2 border-primary bg-primary/5"
          : "border border-border bg-card hover:border-primary/50",
      )}
      onClick={() => onClick?.(workflow)}
      data-testid="workflow-card"
    >
      {/* Single-row compact layout */}
      <div className="flex items-center h-10 px-3 gap-3">
        {/* Left: Icon + Name + Version */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <GitBranch className="w-4 h-4 text-primary flex-shrink-0" />
          <span className="font-medium text-sm text-foreground truncate">
            {workflow.metadata?.name || workflow.id}
          </span>
          {workflow.metadata?.version && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 flex-shrink-0">
              v{workflow.metadata.version}
            </Badge>
          )}
        </div>

        {/* Center: Owner handle */}
        <div className="text-[11px] text-muted-foreground font-mono flex-shrink-0 hidden sm:block">
          @{workflow.ownerHandle}
        </div>

        {/* Right: Badges */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {/* Validation badge - icon only */}
          <Badge
            className={cn(
              "text-[10px] px-1 py-0 h-5 flex items-center",
              validationConfig.className,
            )}
          >
            {validationConfig.icon}
          </Badge>

          {/* Visibility badge - icon only on narrow, with text on wider */}
          {workflow.visibility === "public" ? (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 h-5 flex items-center gap-0.5 border-info/30 text-info bg-info/10"
            >
              <Globe className="w-3 h-3" />
              <span className="hidden md:inline">{t("components.workflowCard.public")}</span>
            </Badge>
          ) : (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 h-5 flex items-center gap-0.5 border-warning/30 text-warning bg-warning/10"
            >
              <Lock className="w-3 h-3" />
              <span className="hidden md:inline">{t("components.workflowCard.private")}</span>
            </Badge>
          )}

          {/* Shared badge */}
          {workflow.accessType === "shared" && (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 h-5 flex items-center gap-0.5 border-chart-4/30 text-chart-4 bg-chart-4/10"
              data-testid="shared-with-you-badge"
            >
              <Users className="w-3 h-3" />
              <span className="hidden md:inline">{t("components.workflowCard.sharedWithYou")}</span>
            </Badge>
          )}

          {/* Delete button - hidden until hover */}
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(workflow.id, workflow.metadata?.name || workflow.id);
              }}
              className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10"
              aria-label={t("components.workflowCard.deleteWorkflow")}
              title={t("components.workflowCard.deleteWorkflow")}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>
    </Card>
  );

  // Wrap in tooltip if description exists (list mode only — grid shows description inline)
  if (!compact && workflow.metadata?.description) {
    return (
      <TooltipProvider>
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>{cardContent}</TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs">
            <p className="text-xs">{workflow.metadata.description}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return cardContent;
};
