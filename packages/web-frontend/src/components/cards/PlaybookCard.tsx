/**
 * A playbook as a CardShell item: its name as the title and its slug beside it, its description
 * (or the beginning of its text) as the description, and its visibility (a toggle for its owner),
 * size, revision and last change as the meta line.
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Pencil, History, Trash2 } from "lucide-react";
import type { PlaybookSummary } from "../../services/api-client";
import { VisibilityToggle } from "../access/VisibilityToggle";
import { formatRelativeTime, formatSize } from "./format-utils";
import { CardShell, type CardAction } from "./CardShell";

interface PlaybookCardProps {
  playbook: PlaybookSummary;
  onClick?: (playbook: PlaybookSummary) => void;
  onEdit?: (playbook: PlaybookSummary) => void;
  onHistory?: (playbook: PlaybookSummary) => void;
  onDelete?: (playbook: PlaybookSummary) => void;
  compact?: boolean;
}

export const PlaybookCard: React.FC<PlaybookCardProps> = ({
  playbook,
  onClick,
  onEdit,
  onHistory,
  onDelete,
  compact = false,
}) => {
  const { t } = useTranslation();

  const actions = useMemo(() => {
    const list: CardAction[] = [];
    if (onEdit)
      list.push({
        icon: <Pencil className="w-3.5 h-3.5" />,
        label: t("common.edit", { defaultValue: "Edit" }),
        onClick: () => onEdit(playbook),
        testId: `edit-playbook-${playbook.slug}`,
      });
    if (onHistory)
      list.push({
        icon: <History className="w-3.5 h-3.5" />,
        label: t("history.title"),
        onClick: () => onHistory(playbook),
        testId: `history-playbook-${playbook.slug}`,
      });
    if (onDelete)
      list.push({
        icon: <Trash2 className="w-3.5 h-3.5" />,
        label: t("common.delete", { defaultValue: "Delete" }),
        onClick: () => onDelete(playbook),
        variant: "destructive",
        testId: `delete-playbook-${playbook.slug}`,
      });
    return list;
  }, [onEdit, onHistory, onDelete, playbook, t]);

  const description = playbook.description || playbook.preview;

  return (
    <CardShell
      compact={compact}
      onClick={onClick ? () => onClick(playbook) : undefined}
      actions={actions}
      testId={`playbook-card-${playbook.slug}`}
      icon={<BookOpen aria-hidden="true" />}
      title={playbook.name || playbook.slug}
      titleAside={playbook.name ? <code>{playbook.slug}</code> : undefined}
      description={
        description ? (
          <span className={playbook.description ? undefined : "font-mono text-xs"}>
            {description}
          </span>
        ) : undefined
      }
      meta={
        <>
          <VisibilityToggle
            visibility={playbook.visibility}
            testId={`playbook-visibility-${playbook.slug}`}
          />
          <span>
            {formatSize(playbook.size)} · v{playbook.revision}
          </span>
          <span>{formatRelativeTime(playbook.updatedAt)}</span>
        </>
      }
    />
  );
};
