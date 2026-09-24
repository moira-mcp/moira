import React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type ExecutionStatus = "running" | "waiting" | "completed" | "failed" | "locked";

const statusStyles: Record<ExecutionStatus, string> = {
  running: "border-transparent bg-info text-info-foreground",
  waiting: "border-transparent bg-warning text-warning-foreground",
  completed: "border-transparent bg-success text-success-foreground",
  failed: "border-transparent bg-destructive-fill text-destructive-foreground",
  locked:
    "border-transparent bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
};

interface StatusBadgeProps {
  status: ExecutionStatus;
  className?: string;
}

/** An execution's status in the reader's language, coloured by the state. */
export function StatusBadge({ status, className }: StatusBadgeProps) {
  const { t } = useTranslation();
  return (
    <Badge className={cn(statusStyles[status], className)} data-status={status}>
      {t(`common.status.${status}`)}
    </Badge>
  );
}

export type { ExecutionStatus };
