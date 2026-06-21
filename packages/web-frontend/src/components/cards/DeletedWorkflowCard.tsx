/**
 * Deleted Workflow Card Component
 * Displays deleted workflow with strikethrough, restore/delete actions using CardShell
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Trash2, RotateCcw, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "./format-utils";
import { CardShell, type CardAction } from "./CardShell";

export interface DeletedWorkflowCardData {
  id: string;
  name: string;
  userId: string;
  deleted: boolean;
  deletedAt: number | null;
  deletedBy: string | null;
  createdAt?: number;
}

interface DeletedWorkflowCardProps {
  workflow: DeletedWorkflowCardData;
  onClick?: (workflow: DeletedWorkflowCardData) => void;
  onRestore?: (workflow: DeletedWorkflowCardData) => void;
  onPermanentDelete?: (workflow: DeletedWorkflowCardData) => void;
  compact?: boolean;
}

export const DeletedWorkflowCard: React.FC<DeletedWorkflowCardProps> = ({
  workflow,
  onClick,
  onRestore,
  onPermanentDelete,
  compact = false,
}) => {
  const { t } = useTranslation();

  const actions = useMemo(() => {
    const list: CardAction[] = [];
    if (onRestore)
      list.push({
        icon: <RotateCcw className="w-3.5 h-3.5" />,
        label: t("common.restore", { defaultValue: "Restore" }),
        onClick: () => onRestore(workflow),
        variant: "success",
      });
    if (onPermanentDelete)
      list.push({
        icon: <Trash2 className="w-3.5 h-3.5" />,
        label: t("common.permanentDelete", { defaultValue: "Permanently Delete" }),
        onClick: () => onPermanentDelete(workflow),
        variant: "destructive",
      });
    return list;
  }, [onRestore, onPermanentDelete, workflow, t]);

  if (compact) {
    return (
      <CardShell
        compact
        onClick={() => onClick?.(workflow)}
        actions={actions}
        className="opacity-75"
        testId="deleted-workflow-card"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <GitBranch className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <span className="font-medium text-sm text-muted-foreground truncate line-through">
              {workflow.name}
            </span>
          </div>
          <Badge
            variant="outline"
            className="text-[10px] px-1 py-0 h-4 border-destructive/30 text-destructive flex-shrink-0"
          >
            {t("common.deleted", { defaultValue: "Deleted" })}
          </Badge>
        </div>

        <div className="text-xs text-muted-foreground font-mono truncate">{workflow.id}</div>

        <div className="flex items-center gap-1 mt-auto">
          {workflow.deletedAt && (
            <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
              <Clock className="w-3 h-3" />
              {formatRelativeTime(workflow.deletedAt)}
            </span>
          )}
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      onClick={() => onClick?.(workflow)}
      actions={actions}
      className="opacity-75"
      testId="deleted-workflow-card"
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <GitBranch className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <span className="font-medium text-sm text-muted-foreground truncate line-through">
          {workflow.name}
        </span>
        <Badge
          variant="outline"
          className="text-[10px] px-1 py-0 h-4 border-destructive/30 text-destructive flex-shrink-0"
        >
          {t("common.deleted", { defaultValue: "Deleted" })}
        </Badge>
      </div>

      <span className="text-[11px] text-muted-foreground font-mono flex-shrink-0 hidden sm:block">
        {workflow.deletedBy || workflow.userId}
      </span>

      <div className="flex items-center gap-1 flex-shrink-0">
        {workflow.deletedAt && (
          <span className="text-[10px] text-muted-foreground">
            {formatRelativeTime(workflow.deletedAt)}
          </span>
        )}
      </div>
    </CardShell>
  );
};
