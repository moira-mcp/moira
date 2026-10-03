/**
 * An execution as a CardShell item: its task as the title, its note as the
 * description, the status and anything wrong (a lock, errors) as badges, and who started it, when
 * and its short id as the meta line. Handles 3 data interfaces via normalizeExecution().
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Play, AlertTriangle, Clock, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge, isExecutionStatus } from "@/components/status-badge";
import { type NormalizedExecution } from "./normalize-execution";
import { formatRelativeTime } from "./format-utils";
import { CardShell } from "./CardShell";
import { useExecutionStopAction } from "../execution/ExecutionStop";

interface ExecutionCardProps {
  execution: NormalizedExecution;
  onClick?: (execution: NormalizedExecution) => void;
  compact?: boolean;
}

export const ExecutionCard: React.FC<ExecutionCardProps> = ({
  execution,
  onClick,
  compact = false,
}) => {
  const { t } = useTranslation();
  const stop = useExecutionStopAction({
    executionId: execution.id,
    title: execution.taskTitle ?? execution.workflowName ?? execution.workflowId,
    stopCapability: execution.stopCapability,
  });

  return (
    <CardShell
      compact={compact}
      onClick={onClick ? () => onClick(execution) : undefined}
      testId="execution-card"
      icon={<Play aria-hidden="true" />}
      title={execution.taskTitle ?? execution.workflowName ?? execution.workflowId}
      description={execution.note || undefined}
      note={
        execution.stopReason != null ? (
          <span className="line-clamp-2 [overflow-wrap:anywhere]">
            {t("pages.overview.panel.stopReason")}: {execution.stopReason}
          </span>
        ) : undefined
      }
      actions={stop ? [stop] : undefined}
      badges={
        <>
          {execution.hasActiveLock && (
            <Badge
              variant="outline"
              className="h-5 gap-1 border-yellow-500/50 px-1.5 text-[11px] text-yellow-600 dark:text-yellow-400"
            >
              <Lock className="size-3" aria-hidden="true" />
              {t("common.locked", { defaultValue: "Locked" })}
            </Badge>
          )}
          {execution.errorCount != null && execution.errorCount > 0 && (
            <Badge
              variant="outline"
              className="h-5 gap-1 border-destructive/30 px-1.5 text-[11px] text-destructive"
            >
              <AlertTriangle className="size-3" aria-hidden="true" />
              {execution.errorCount} {t("common.errorsLabel", { defaultValue: "errors" })}
            </Badge>
          )}
          {isExecutionStatus(execution.status) && (
            <StatusBadge status={execution.status} className="h-5 px-1.5 text-[11px]" />
          )}
        </>
      }
      meta={
        <>
          {execution.taskTitle !== (execution.workflowName ?? execution.workflowId) ? (
            <span>{execution.workflowName ?? execution.workflowId}</span>
          ) : null}
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" aria-hidden="true" />
            {formatRelativeTime(execution.createdAt)}
          </span>
          {execution.userDisplay !== undefined && (
            <span className="font-mono">{execution.userDisplay ?? t("common.unknownUser")}</span>
          )}
          <span className="font-mono">{execution.id.slice(0, 8)}</span>
        </>
      }
    />
  );
};
