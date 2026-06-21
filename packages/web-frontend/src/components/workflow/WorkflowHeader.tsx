/**
 * Workflow Header Component
 *
 * Displays workflow metadata in a compact header:
 * - Name, version, description
 * - Author and tags
 * - Visibility badge (public/private)
 * - Node/edge counts
 */

import React from "react";
import { Globe, Lock, User, Tag, Box, GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { WorkflowGraph, WorkflowFileInfo } from "../../types";
import { useTranslation } from "react-i18next";

interface WorkflowHeaderProps {
  workflow: WorkflowGraph;
  fileInfo?: WorkflowFileInfo;
  nodeCount?: number;
  edgeCount?: number;
  className?: string;
}

export const WorkflowHeader: React.FC<WorkflowHeaderProps> = ({
  workflow,
  fileInfo,
  nodeCount,
  edgeCount,
  className = "",
}) => {
  const { t } = useTranslation();
  const metadata = workflow.metadata;

  return (
    <div className={`border-b border-border bg-card px-4 py-3 ${className}`}>
      <div className="flex items-start justify-between gap-4">
        {/* Left side: Name and description */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h1 className="text-lg font-semibold truncate">{metadata.name}</h1>
            {metadata.version && (
              <Badge variant="outline" className="text-xs shrink-0">
                v{metadata.version}
              </Badge>
            )}
            {/* Visibility badge */}
            {fileInfo && (
              <Badge
                variant={fileInfo.visibility === "public" ? "default" : "secondary"}
                className="text-xs shrink-0 gap-1"
              >
                {fileInfo.visibility === "public" ? (
                  <>
                    <Globe className="w-3 h-3" />
                    {t("components.workflowCard.public")}
                  </>
                ) : (
                  <>
                    <Lock className="w-3 h-3" />
                    {t("components.workflowCard.private")}
                  </>
                )}
              </Badge>
            )}
          </div>

          {metadata.description && (
            <p className="text-sm text-muted-foreground line-clamp-2">{metadata.description}</p>
          )}
        </div>

        {/* Right side: Stats and meta */}
        <div className="flex flex-col items-end gap-1 shrink-0">
          {/* Author */}
          {fileInfo?.ownerName && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <User className="w-3 h-3" />
              <span>{fileInfo.ownerName}</span>
            </div>
          )}

          {/* Node/Edge counts */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {nodeCount !== undefined && (
              <div className="flex items-center gap-1">
                <Box className="w-3 h-3" />
                <span>{nodeCount} nodes</span>
              </div>
            )}
            {edgeCount !== undefined && (
              <div className="flex items-center gap-1">
                <GitBranch className="w-3 h-3" />
                <span>{edgeCount} edges</span>
              </div>
            )}
          </div>

          {/* Tags */}
          {metadata.tags && metadata.tags.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap justify-end">
              <Tag className="w-3 h-3 text-muted-foreground" />
              {metadata.tags.slice(0, 3).map((tag) => (
                <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                  {tag}
                </Badge>
              ))}
              {metadata.tags.length > 3 && (
                <span className="text-[10px] text-muted-foreground">
                  +{metadata.tags.length - 3}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default WorkflowHeader;
