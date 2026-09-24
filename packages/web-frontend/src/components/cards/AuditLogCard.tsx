/**
 * An audit log entry as a CardShell item: the action as the title, what it touched as the
 * description, and who, from where (source, address) and when as the meta line.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Shield, Globe, Monitor, User, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "./format-utils";
import { CardShell } from "./CardShell";

export interface AuditLogCardData {
  id: string;
  userId?: string;
  userEmail: string | null;
  userName: string | null;
  action: string;
  resource?: string;
  resourceId?: string;
  source?: string;
  ip?: string;
  country?: string;
  userAgent?: string;
  metadata?: string;
  changes?: string;
  createdAt: number;
}

interface AuditLogCardProps {
  entry: AuditLogCardData;
  compact?: boolean;
  onClick?: (entry: AuditLogCardData) => void;
}

const actionColors: Record<string, string> = {
  create: "text-success",
  update: "text-info",
  delete: "text-destructive",
  login: "text-warning",
  logout: "text-muted-foreground",
};

function getActionColor(action: string): string {
  const key = Object.keys(actionColors).find((k) => action.toLowerCase().includes(k));
  return key ? actionColors[key] : "text-foreground";
}

export const AuditLogCard: React.FC<AuditLogCardProps> = ({ entry, compact = false, onClick }) => {
  const { t } = useTranslation();
  // A system entry has no user; an entry whose user can no longer be found still says so.
  const who = entry.userName || entry.userEmail || (entry.userId ? t("common.unknownUser") : null);

  return (
    <CardShell
      compact={compact}
      onClick={onClick ? () => onClick(entry) : undefined}
      testId="audit-log-card"
      icon={<Shield aria-hidden="true" />}
      title={<span className={cn("font-mono", getActionColor(entry.action))}>{entry.action}</span>}
      description={
        entry.resource ? (
          <span>
            {entry.resource}
            {entry.resourceId && (
              <span className="ml-1 font-mono text-foreground">{entry.resourceId}</span>
            )}
          </span>
        ) : undefined
      }
      meta={
        <>
          {who && (
            <span className="inline-flex items-center gap-1">
              <User className="size-3" aria-hidden="true" />
              {who}
            </span>
          )}
          {entry.source && (
            <span className="inline-flex items-center gap-1">
              <Monitor className="size-3" aria-hidden="true" />
              {entry.source}
            </span>
          )}
          {entry.ip && (
            <span className="inline-flex items-center gap-1">
              <Globe className="size-3" aria-hidden="true" />
              {entry.ip}
              {entry.country && ` (${entry.country})`}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" aria-hidden="true" />
            {formatRelativeTime(entry.createdAt)}
          </span>
        </>
      }
    />
  );
};
