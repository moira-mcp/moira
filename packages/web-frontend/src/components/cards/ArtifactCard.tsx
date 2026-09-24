/**
 * An artifact as a CardShell item: its name as the title and its size beside it, deleted or expired
 * as a badge, and when it expires, who owns it (for an administrator) and when it was made as the
 * meta line. An expired or deleted artifact is dimmed.
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
  /** Admin-only: the artifact's owner; `null` when the owner's account can no longer be found. */
  userDisplay?: string | null;
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

  const stateBadge = isDeleted
    ? t("common.deleted", { defaultValue: "Deleted" })
    : isExpired
      ? t("common.expired", { defaultValue: "Expired" })
      : null;

  return (
    <CardShell
      compact={compact}
      onClick={onClick ? () => onClick(artifact) : undefined}
      actions={actions}
      className={cn((isExpired || isDeleted) && "opacity-60")}
      testId={compact ? "artifact-card" : `artifact-row-${artifact.uuid}`}
      icon={<FileCode aria-hidden="true" />}
      title={artifact.name}
      titleAside={formatSize(artifact.size)}
      badges={
        stateBadge && (
          <Badge
            variant="outline"
            className="h-5 border-destructive/30 px-1.5 text-[11px] text-destructive"
          >
            {stateBadge}
          </Badge>
        )
      }
      meta={
        <>
          {!stateBadge && (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3" aria-hidden="true" />
              {t("components.artifactCard.expiresOn", {
                defaultValue: "Expires {{date}}",
                date: formatDate(artifact.expiresAt),
              })}
            </span>
          )}
          {artifact.userDisplay !== undefined && (
            <span className="font-mono">{artifact.userDisplay ?? t("common.unknownUser")}</span>
          )}
          <span>
            {t("components.artifactCard.createdOn", {
              defaultValue: "Created {{date}}",
              date: formatDate(artifact.createdAt),
            })}
          </span>
        </>
      }
    />
  );
};
