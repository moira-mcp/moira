/**
 * Artifact Card Component
 * Displays artifact info in list (compact) or grid mode using CardShell
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FileCode, Copy, Edit2, ExternalLink, Trash2, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDate, formatSize } from "./format-utils";
import { CardShell, type CardAction } from "./CardShell";

export interface ArtifactCardData {
  uuid: string;
  url: string;
  name: string;
  size: number;
  mimeType: string;
  executionId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  /** Admin-only: display string for artifact owner */
  userDisplay?: string;
  /** Admin-only: whether artifact is soft-deleted */
  deleted?: boolean;
}

interface ArtifactCardProps {
  artifact: ArtifactCardData;
  onClick?: (artifact: ArtifactCardData) => void;
  onCopyUrl?: (artifact: ArtifactCardData) => void;
  onEdit?: (artifact: ArtifactCardData) => void;
  onOpen?: (artifact: ArtifactCardData) => void;
  onDelete?: (artifact: ArtifactCardData) => void;
  compact?: boolean;
}

export const ArtifactCard: React.FC<ArtifactCardProps> = ({
  artifact,
  onClick,
  onCopyUrl,
  onEdit,
  onOpen,
  onDelete,
  compact = false,
}) => {
  const { t } = useTranslation();
  const isExpired = new Date(artifact.expiresAt) < new Date();
  const isDeleted = artifact.deleted === true;

  const actions = useMemo(() => {
    const list: CardAction[] = [];
    if (onCopyUrl)
      list.push({
        icon: <Copy className="w-3.5 h-3.5" />,
        label: t("common.copyUrl", { defaultValue: "Copy URL" }),
        onClick: () => onCopyUrl(artifact),
        testId: compact ? undefined : `copy-url-${artifact.uuid}`,
      });
    if (onEdit)
      list.push({
        icon: <Edit2 className="w-3.5 h-3.5" />,
        label: t("common.edit", { defaultValue: "Edit" }),
        onClick: () => onEdit(artifact),
        testId: compact ? undefined : `edit-${artifact.uuid}`,
      });
    if (onOpen)
      list.push({
        icon: <ExternalLink className="w-3.5 h-3.5" />,
        label: t("common.open", { defaultValue: "Open" }),
        onClick: () => onOpen(artifact),
        testId: compact ? undefined : `open-${artifact.uuid}`,
      });
    if (onDelete)
      list.push({
        icon: <Trash2 className="w-3.5 h-3.5" />,
        label: t("common.delete", { defaultValue: "Delete" }),
        onClick: () => onDelete(artifact),
        variant: "destructive",
        testId: compact ? undefined : `delete-${artifact.uuid}`,
      });
    return list;
  }, [onCopyUrl, onEdit, onOpen, onDelete, artifact, t, compact]);

  if (compact) {
    return (
      <CardShell
        compact
        onClick={() => onClick?.(artifact)}
        actions={actions}
        className={cn((isExpired || isDeleted) && "opacity-60")}
        testId="artifact-card"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <FileCode className="w-4 h-4 text-primary flex-shrink-0" />
            <span className="font-medium text-sm text-foreground truncate">{artifact.name}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 mt-auto flex-wrap">
          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
            {formatSize(artifact.size)}
          </Badge>
          {isDeleted ? (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 h-4 border-destructive/30 text-destructive"
            >
              {t("common.deleted", { defaultValue: "Deleted" })}
            </Badge>
          ) : isExpired ? (
            <Badge
              variant="outline"
              className="text-[10px] px-1 py-0 h-4 border-destructive/30 text-destructive"
            >
              {t("common.expired", { defaultValue: "Expired" })}
            </Badge>
          ) : (
            <span className="text-[10px] text-muted-foreground">
              <Clock className="w-3 h-3 inline mr-0.5" />
              {formatDate(artifact.expiresAt)}
            </span>
          )}
          {artifact.userDisplay && (
            <span className="text-[10px] text-muted-foreground font-mono truncate">
              {artifact.userDisplay}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto">
            {formatDate(artifact.createdAt)}
          </span>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell
      onClick={() => onClick?.(artifact)}
      actions={actions}
      className={cn((isExpired || isDeleted) && "opacity-60")}
      testId={`artifact-row-${artifact.uuid}`}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <FileCode className="w-4 h-4 text-primary flex-shrink-0" />
        <span className="font-medium text-sm text-foreground truncate">{artifact.name}</span>
        <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 flex-shrink-0">
          {formatSize(artifact.size)}
        </Badge>
        {isDeleted && (
          <Badge
            variant="outline"
            className="text-[10px] px-1 py-0 h-4 border-destructive/30 text-destructive flex-shrink-0"
          >
            {t("common.deleted", { defaultValue: "Deleted" })}
          </Badge>
        )}
      </div>

      {artifact.userDisplay && (
        <span className="text-[11px] text-muted-foreground font-mono flex-shrink-0 hidden sm:block">
          {artifact.userDisplay}
        </span>
      )}

      <span className="text-[11px] text-muted-foreground flex-shrink-0 hidden sm:block">
        {isDeleted
          ? t("common.deleted", { defaultValue: "Deleted" })
          : isExpired
            ? t("common.expired", { defaultValue: "Expired" })
            : formatDate(artifact.expiresAt)}
      </span>

      <div className="flex items-center gap-1 flex-shrink-0">
        <span className="text-[10px] text-muted-foreground">{formatDate(artifact.createdAt)}</span>
      </div>
    </CardShell>
  );
};
