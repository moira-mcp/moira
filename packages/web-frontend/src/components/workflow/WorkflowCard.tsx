/**
 * A workflow in the flow list, drawn through the shared CardShell slots so it reads like every
 * other list item:
 *
 * - the name, with the version quiet beside it;
 * - what the flow does, in up to two lines (the whole description on hover);
 * - for a recommended universal flow, when to pick it;
 * - owner, visibility and tags as the quiet meta line;
 * - a badge only for what needs attention: not valid, not yet validated, shared with you.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Clock, GitBranch, Globe, Lock, Trash2, Users } from "lucide-react";
import { WorkflowFileInfo } from "types";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CardShell, type CardAction } from "../cards/CardShell";
import { whenToPickKey } from "../onboarding/recommended";

interface WorkflowCardProps {
  workflow: WorkflowFileInfo;
  isSelected?: boolean;
  onClick?: (workflow: WorkflowFileInfo) => void;
  onDelete?: (workflowId: string, workflowName: string) => void;
  currentUserHandle?: string;
  isAdmin?: boolean;
  compact?: boolean;
}

/** At most this many tags are shown; the rest are counted. */
const MAX_TAGS = 3;

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
  const name = workflow.metadata?.name || workflow.id;
  const description = workflow.metadata?.description;
  const tags = (workflow.metadata?.tags ?? []).filter((tag): tag is string => !!tag);
  const whenKey = whenToPickKey(workflow.ownerHandle, workflow.slug);
  const status =
    workflow.validation?.status ?? (workflow.validation?.isValid ? "valid" : "invalid");

  // Only the owner or an administrator may delete.
  const canDelete =
    onDelete && (isAdmin || (currentUserHandle && workflow.ownerHandle === currentUserHandle));
  const actions: CardAction[] = canDelete
    ? [
        {
          icon: <Trash2 className="h-3.5 w-3.5" />,
          label: t("components.workflowCard.deleteWorkflow"),
          onClick: () => onDelete(workflow.id, name),
          variant: "destructive",
          testId: "workflow-card-delete",
        },
      ]
    : [];

  const badges = (
    <>
      {status === "invalid" && (
        <Badge
          variant="outline"
          className="h-5 gap-1 border-destructive/30 bg-destructive/10 px-1.5 text-[11px] text-destructive"
          data-testid="workflow-card-invalid"
        >
          <AlertCircle className="size-3" aria-hidden="true" />
          {t("components.workflowCard.invalid")}
        </Badge>
      )}
      {status === "unknown" && (
        <Badge
          variant="outline"
          className="h-5 gap-1 px-1.5 text-[11px] text-muted-foreground"
          data-testid="workflow-card-unknown"
        >
          <Clock className="size-3" aria-hidden="true" />
          {t("components.workflowCard.unknown")}
        </Badge>
      )}
      {workflow.accessType === "shared" && (
        <Badge
          variant="outline"
          className="h-5 gap-1 border-chart-4/30 bg-chart-4/10 px-1.5 text-[11px] text-chart-4"
          data-testid="shared-with-you-badge"
        >
          <Users className="size-3" aria-hidden="true" />
          {t("components.workflowCard.sharedWithYou")}
        </Badge>
      )}
    </>
  );

  const meta = (
    <>
      <span className="font-mono" data-testid="workflow-card-owner">
        @{workflow.ownerHandle}
      </span>
      {workflow.visibility === "public" ? (
        <span className="inline-flex items-center gap-1">
          <Globe className="size-3" aria-hidden="true" />
          {t("components.workflowCard.public")}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-warning">
          <Lock className="size-3" aria-hidden="true" />
          {t("components.workflowCard.private")}
        </span>
      )}
      {tags.length > 0 && (
        <span className="inline-flex flex-wrap items-center gap-1" data-testid="workflow-card-tags">
          {tags.slice(0, MAX_TAGS).map((tag) => (
            <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-[11px] leading-none">
              {tag}
            </span>
          ))}
          {tags.length > MAX_TAGS && <span className="text-[11px]">+{tags.length - MAX_TAGS}</span>}
        </span>
      )}
    </>
  );

  const descriptionText = description ? (
    <TooltipProvider>
      <Tooltip delayDuration={400}>
        <TooltipTrigger asChild>
          <span
            className={compact ? "line-clamp-3" : "line-clamp-2"}
            data-testid="workflow-card-description"
          >
            {description}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="start" className="max-w-md">
          <p className="text-xs leading-5">{description}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : undefined;

  return (
    <CardShell
      compact={compact}
      onClick={() => onClick?.(workflow)}
      actions={actions}
      testId="workflow-card"
      className={cn(isSelected && "border-primary bg-primary/5")}
      icon={<GitBranch aria-hidden="true" />}
      title={name}
      titleAside={workflow.metadata?.version ? `v${workflow.metadata.version}` : undefined}
      description={descriptionText}
      note={
        whenKey ? (
          <span data-testid="workflow-card-when">
            <span className="font-medium">{t("onboarding.whenLabel")}</span> {t(whenKey)}
          </span>
        ) : undefined
      }
      meta={meta}
      badges={badges}
    />
  );
};
