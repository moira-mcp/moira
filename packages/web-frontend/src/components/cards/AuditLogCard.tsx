/**
 * Audit Log Card Component
 * Supports grid (compact) and list modes for audit log entries using CardShell
 */

import React from "react";
import { Shield, Globe, Monitor, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
  create: "border-success/30 text-success bg-success/10",
  update: "border-info/30 text-info bg-info/10",
  delete: "border-destructive/30 text-destructive bg-destructive/10",
  login: "border-warning/30 text-warning bg-warning/10",
  logout: "border-muted text-muted-foreground bg-muted",
};

function getActionColor(action: string): string {
  const key = Object.keys(actionColors).find((k) => action.toLowerCase().includes(k));
  return key ? actionColors[key] : "border-border text-muted-foreground bg-muted";
}

export const AuditLogCard: React.FC<AuditLogCardProps> = ({ entry, compact = false, onClick }) => {
  if (!compact) {
    return (
      <CardShell
        onClick={() => onClick?.(entry)}
        className="hover:translate-y-0"
        testId="audit-log-card"
      >
        <Shield className="w-3.5 h-3.5 text-primary flex-shrink-0" />
        <Badge
          className={cn("text-[10px] px-1.5 py-0 h-4 flex-shrink-0", getActionColor(entry.action))}
        >
          {entry.action}
        </Badge>
        {entry.resource && (
          <span className="text-xs text-muted-foreground truncate hidden sm:inline">
            {entry.resource}
            {entry.resourceId && (
              <span className="font-mono ml-1 text-foreground">{entry.resourceId}</span>
            )}
          </span>
        )}
        <div className="flex-1" />
        {(entry.userName || entry.userEmail) && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground flex-shrink-0 hidden md:flex">
            <User className="w-3 h-3" />
            {entry.userName || entry.userEmail}
          </span>
        )}
        {entry.source && (
          <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground flex-shrink-0 hidden lg:flex">
            <Monitor className="w-3 h-3" />
            {entry.source}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground flex-shrink-0">
          {formatRelativeTime(entry.createdAt)}
        </span>
      </CardShell>
    );
  }

  return (
    <CardShell compact onClick={() => onClick?.(entry)} testId="audit-log-card">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Shield className="w-4 h-4 text-primary flex-shrink-0" />
          <Badge className={cn("text-[10px] px-1.5 py-0 h-4", getActionColor(entry.action))}>
            {entry.action}
          </Badge>
        </div>
        <span className="text-[10px] text-muted-foreground flex-shrink-0">
          {formatRelativeTime(entry.createdAt)}
        </span>
      </div>

      {entry.resource && (
        <div className="text-xs text-muted-foreground truncate">
          {entry.resource}
          {entry.resourceId && (
            <span className="font-mono ml-1 text-foreground">{entry.resourceId}</span>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 mt-auto flex-wrap text-[10px] text-muted-foreground">
        {(entry.userName || entry.userEmail) && (
          <span className="flex items-center gap-0.5">
            <User className="w-3 h-3" />
            {entry.userName || entry.userEmail}
          </span>
        )}
        {entry.source && (
          <span className="flex items-center gap-0.5">
            <Monitor className="w-3 h-3" />
            {entry.source}
          </span>
        )}
        {entry.ip && (
          <span className="flex items-center gap-0.5">
            <Globe className="w-3 h-3" />
            {entry.ip}
            {entry.country && ` (${entry.country})`}
          </span>
        )}
      </div>
    </CardShell>
  );
};
