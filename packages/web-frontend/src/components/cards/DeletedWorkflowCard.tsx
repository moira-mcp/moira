/**
 * A deleted workflow as a CardShell item: its name struck through as the title with a Deleted
 * badge, its id as the description, and who deleted it and when as the meta line; restore and
 * delete-for-good are the actions.
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

  return (
    <CardShell
      compact={compact}
      onClick={onClick ? () => onClick(workflow) : undefined}
      actions={actions}
      className="opacity-75"
      testId="deleted-workflow-card"
      icon={<GitBranch aria-hidden="true" />}
      title={<span className="text-muted-foreground line-through">{workflow.name}</span>}
      description={<span className="font-mono text-xs">{workflow.id}</span>}
      badges={
        <Badge
          variant="outline"
          className="h-5 border-destructive/30 px-1.5 text-[11px] text-destructive"
        >
          {t("common.deleted", { defaultValue: "Deleted" })}
        </Badge>
      }
      meta={
        <>
          <span className="font-mono">{workflow.deletedBy || workflow.userId}</span>
          {workflow.deletedAt && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" aria-hidden="true" />
              {formatRelativeTime(workflow.deletedAt)}
            </span>
          )}
        </>
      }
    />
  );
};
