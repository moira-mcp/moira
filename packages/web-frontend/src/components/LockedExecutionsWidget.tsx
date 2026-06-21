/**
 * Widget showing currently locked executions as a banner above the execution list.
 * Users see their own locks, admins see all locks.
 */
import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Lock, Clock, ChevronDown, ChevronUp } from "lucide-react";
import { Alert, AlertTitle, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { apiClient } from "../services/api-client";
import { ROUTES } from "../constants/routes";

interface LockedExecution {
  executionId: string;
  workflowId: string;
  workflowName?: string | null;
  status: string;
  note?: string;
  createdAt?: number;
  updatedAt?: number;
  hasActiveLock?: boolean;
  // Admin-only fields
  userEmail?: string;
  userName?: string | null;
}

interface LockedExecutionsWidgetProps {
  admin?: boolean;
  /** Refresh trigger — increment to refetch */
  refreshKey?: number;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export const LockedExecutionsWidget: React.FC<LockedExecutionsWidgetProps> = ({
  admin = false,
  refreshKey = 0,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [locked, setLocked] = useState<LockedExecution[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLocked = async () => {
      try {
        setLoading(true);
        if (admin) {
          const result = await apiClient.getAdminExecutions({
            status: "locked",
            limit: 20,
          });
          setLocked(result.executions || []);
        } else {
          const result = await apiClient.getExecutions({
            status: ["locked"],
            limit: 20,
          });
          setLocked(result.executions || []);
        }
      } catch {
        setLocked([]);
      } finally {
        setLoading(false);
      }
    };
    fetchLocked();
  }, [admin, refreshKey]);

  if (loading || locked.length === 0) return null;

  const displayItems = expanded ? locked : locked.slice(0, 3);
  const hasMore = locked.length > 3;

  const handleClick = (executionId: string) => {
    const path = admin
      ? `${ROUTES.ADMIN_EXECUTIONS}/${executionId}`
      : `${ROUTES.EXECUTIONS}/${executionId}`;
    navigate(path);
  };

  return (
    <Alert
      className="border-yellow-500/50 bg-yellow-50/50 dark:bg-yellow-950/20 mb-4"
      data-testid="locked-executions-widget"
    >
      <Lock className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
      <AlertTitle className="text-yellow-800 dark:text-yellow-300">
        {t("lockedWidget.title", { count: locked.length })}
      </AlertTitle>
      <AlertDescription>
        <div className="space-y-2 mt-1">
          {displayItems.map((exec) => (
            <div
              key={exec.executionId}
              className="flex items-center justify-between gap-2 py-1 px-2 rounded hover:bg-yellow-100/50 dark:hover:bg-yellow-900/30 cursor-pointer"
              onClick={() => handleClick(exec.executionId)}
              data-testid="locked-execution-item"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Badge
                  variant="outline"
                  className="text-[10px] px-1 py-0 h-4 border-yellow-500/50 text-yellow-600 dark:text-yellow-400 shrink-0"
                >
                  <Lock className="w-3 h-3" />
                </Badge>
                <span className="text-sm truncate">
                  {exec.workflowName || exec.note || exec.executionId.slice(0, 8)}
                </span>
                {admin && exec.userEmail && (
                  <span className="text-xs text-muted-foreground truncate">({exec.userEmail})</span>
                )}
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground shrink-0">
                <Clock className="w-3 h-3" />
                {exec.updatedAt ? formatDuration(Date.now() - exec.updatedAt) : "—"}
              </div>
            </div>
          ))}
          {hasMore && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full text-xs h-6 text-yellow-700 dark:text-yellow-400"
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? (
                <>
                  <ChevronUp className="w-3 h-3 mr-1" />
                  {t("lockedWidget.showLess", "Show less")}
                </>
              ) : (
                <>
                  <ChevronDown className="w-3 h-3 mr-1" />
                  {t("lockedWidget.showMore", {
                    count: locked.length - 3,
                    defaultValue: `Show ${locked.length - 3} more`,
                  })}
                </>
              )}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
};
