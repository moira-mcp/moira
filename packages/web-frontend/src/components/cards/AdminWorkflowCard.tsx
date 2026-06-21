/**
 * Admin Workflow Card Component
 * Displays workflow info for admin list: owner, name, visibility, version, node count, dates
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Clock, Eye, EyeOff, CheckCircle2, XCircle, HelpCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "./format-utils";
import { CardShell } from "./CardShell";

export interface AdminWorkflowCardData {
  id: string;
  slug: string;
  userId: string;
  ownerHandle: string;
  name: string;
  description: string | null;
  version: string;
  visibility: "public" | "private";
  nodeCount: number;
  validation: {
    status: "valid" | "invalid" | "unknown";
    errors: string[];
    validatedAt: number | null;
  };
  createdAt: number;
  updatedAt: number;
}

interface AdminWorkflowCardProps {
  workflow: AdminWorkflowCardData;
  compact?: boolean;
}

const ValidationIcon: React.FC<{ status: string }> = ({ status }) => {
  if (status === "valid") return <CheckCircle2 className="w-3.5 h-3.5 text-success" />;
  if (status === "invalid") return <XCircle className="w-3.5 h-3.5 text-destructive" />;
  return <HelpCircle className="w-3.5 h-3.5 text-muted-foreground" />;
};

export const AdminWorkflowCard: React.FC<AdminWorkflowCardProps> = ({
  workflow,
  compact = false,
}) => {
  const { t } = useTranslation();

  if (compact) {
    return (
      <CardShell compact testId="admin-workflow-card">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <GitBranch className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <span className="font-medium text-sm truncate">{workflow.name}</span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {workflow.visibility === "public" ? (
              <Eye className="w-3 h-3 text-muted-foreground" />
            ) : (
              <EyeOff className="w-3 h-3 text-muted-foreground" />
            )}
            <ValidationIcon status={workflow.validation.status} />
          </div>
        </div>

        <div className="text-xs text-muted-foreground truncate">
          @{workflow.ownerHandle} · v{workflow.version} · {workflow.nodeCount}{" "}
          {t("admin.workflows.nodes")}
        </div>

        <div className="flex items-center gap-1 mt-auto">
          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
            <Clock className="w-3 h-3" />
            {formatRelativeTime(workflow.updatedAt)}
          </span>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell testId="admin-workflow-card">
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <GitBranch className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        <span className="font-medium text-sm truncate">{workflow.name}</span>
        <Badge
          variant="outline"
          className={`text-[10px] px-1 py-0 h-4 flex-shrink-0 ${
            workflow.visibility === "public"
              ? "border-success/30 text-success"
              : "border-muted-foreground/30 text-muted-foreground"
          }`}
        >
          {workflow.visibility === "public"
            ? t("admin.workflows.public")
            : t("admin.workflows.private")}
        </Badge>
        <ValidationIcon status={workflow.validation.status} />
      </div>

      <span className="text-[11px] text-muted-foreground flex-shrink-0 hidden sm:block">
        @{workflow.ownerHandle}
      </span>

      <span className="text-[11px] text-muted-foreground flex-shrink-0 hidden md:block">
        v{workflow.version} · {workflow.nodeCount} {t("admin.workflows.nodes")}
      </span>

      <div className="flex items-center gap-1 flex-shrink-0">
        <span className="text-[10px] text-muted-foreground">
          {formatRelativeTime(workflow.updatedAt)}
        </span>
      </div>
    </CardShell>
  );
};
