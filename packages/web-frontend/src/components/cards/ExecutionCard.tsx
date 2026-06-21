/**
 * Execution Card Component
 * Displays execution info in list (compact) or grid mode using CardShell
 * Handles 3 data interfaces via normalizeExecution()
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Play, AlertTriangle, Clock, StickyNote, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge, type ExecutionStatus } from "@/components/status-badge";
import { type NormalizedExecution } from "./normalize-execution";
import { formatRelativeTime } from "./format-utils";
import { CardShell } from "./CardShell";

interface ExecutionCardProps {
  execution: NormalizedExecution;
  onClick?: (execution: NormalizedExecution) => void;
  compact?: boolean;
}

const validStatuses: ExecutionStatus[] = ["running", "waiting", "completed", "failed", "locked"];

export const ExecutionCard: React.FC<ExecutionCardProps> = ({
  execution,
  onClick,
  compact = false,
}) => {
  const { t } = useTranslation();
  const isValidStatus = validStatuses.includes(execution.status as ExecutionStatus);

  if (compact) {
    return (
      <CardShell compact onClick={() => onClick?.(execution)} testId="execution-card">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <Play className="w-4 h-4 text-primary flex-shrink-0" />
            <span className="font-medium text-sm text-foreground truncate">
              {execution.workflowName || execution.workflowId}
            </span>
          </div>
          {isValidStatus && <StatusBadge status={execution.status as ExecutionStatus} />}
          {execution.hasActiveLock && (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 h-4 border-yellow-500/50 text-yellow-600 dark:text-yellow-400"
            >
              <Lock className="w-3 h-3 mr-0.5" />
              Locked
            </Badge>
          )}
        </div>

        {execution.note && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            <StickyNote className="w-3 h-3 inline mr-1" />
            {execution.note}
          </p>
        )}

        <div className="flex items-center gap-2 mt-auto flex-wrap">
          {execution.errorCount != null && execution.errorCount > 0 && (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 h-4 border-destructive/30 text-destructive"
            >
              <AlertTriangle className="w-3 h-3 mr-0.5" />
              {execution.errorCount} {t("common.errorsLabel", { defaultValue: "errors" })}
            </Badge>
          )}
          {execution.userDisplay && (
            <span className="text-[10px] text-muted-foreground font-mono">
              {execution.userDisplay}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto">
            <Clock className="w-3 h-3 inline mr-0.5" />
            {formatRelativeTime(execution.createdAt)}
          </span>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell onClick={() => onClick?.(execution)} testId="execution-card">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <Play className="w-4 h-4 text-primary flex-shrink-0" />
        <span className="font-medium text-sm text-foreground truncate">
          {execution.workflowName || execution.workflowId}
        </span>
        {execution.note && (
          <span className="text-xs text-muted-foreground truncate hidden sm:inline">
            {execution.note}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-[10px] text-muted-foreground font-mono hidden md:inline">
          {execution.id.slice(0, 8)}
        </span>
        {execution.userDisplay && (
          <span className="text-[11px] text-muted-foreground font-mono hidden sm:block">
            {execution.userDisplay}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 flex-shrink-0">
        {execution.hasActiveLock && (
          <Badge
            variant="outline"
            className="text-[10px] px-1 py-0 h-4 border-yellow-500/50 text-yellow-600 dark:text-yellow-400"
          >
            <Lock className="w-3 h-3 mr-0.5" />
          </Badge>
        )}
        {execution.errorCount != null && execution.errorCount > 0 && (
          <Badge
            variant="outline"
            className="text-[10px] px-1 py-0 h-4 border-destructive/30 text-destructive"
          >
            <AlertTriangle className="w-3 h-3 mr-0.5" />
            {execution.errorCount}
          </Badge>
        )}
        {isValidStatus && <StatusBadge status={execution.status as ExecutionStatus} />}
        <span className="text-[10px] text-muted-foreground">
          {formatRelativeTime(execution.createdAt)}
        </span>
      </div>
    </CardShell>
  );
};
