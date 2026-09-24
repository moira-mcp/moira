/**
 * A workflow in the administrator's list, as a CardShell item: its name and version as the title,
 * its description, a badge only when it is invalid or not yet checked, and owner, visibility, size
 * in nodes and last change as the meta line.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { GitBranch, Clock, Globe, Lock, XCircle, HelpCircle } from "lucide-react";
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

export const AdminWorkflowCard: React.FC<AdminWorkflowCardProps> = ({
  workflow,
  compact = false,
}) => {
  const { t } = useTranslation();
  const status = workflow.validation.status;

  return (
    <CardShell
      compact={compact}
      testId="admin-workflow-card"
      icon={<GitBranch aria-hidden="true" />}
      title={workflow.name}
      titleAside={`v${workflow.version}`}
      description={workflow.description || undefined}
      badges={
        status !== "valid" && (
          <Badge
            variant="outline"
            className={
              status === "invalid"
                ? "h-5 gap-1 border-destructive/30 px-1.5 text-[11px] text-destructive"
                : "h-5 gap-1 px-1.5 text-[11px] text-muted-foreground"
            }
          >
            {status === "invalid" ? (
              <XCircle className="size-3" aria-hidden="true" />
            ) : (
              <HelpCircle className="size-3" aria-hidden="true" />
            )}
            {t(`components.workflowCard.${status}`)}
          </Badge>
        )
      }
      meta={
        <>
          <span className="font-mono">@{workflow.ownerHandle}</span>
          <span className="inline-flex items-center gap-1">
            {workflow.visibility === "public" ? (
              <Globe className="size-3" aria-hidden="true" />
            ) : (
              <Lock className="size-3" aria-hidden="true" />
            )}
            {workflow.visibility === "public"
              ? t("admin.workflows.public")
              : t("admin.workflows.private")}
          </span>
          <span>
            {workflow.nodeCount} {t("admin.workflows.nodes")}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" aria-hidden="true" />
            {formatRelativeTime(workflow.updatedAt)}
          </span>
        </>
      }
    />
  );
};
