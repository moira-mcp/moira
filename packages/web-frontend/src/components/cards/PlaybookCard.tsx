/**
 * Playbook Card Component
 * Displays a playbook in list (compact) or grid mode using CardShell, like every other card.
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

  const title = (
    <div className="flex items-center gap-2 min-w-0 flex-1">
      <BookOpen className="w-4 h-4 text-primary flex-shrink-0" />
      <span className="font-medium text-sm text-foreground truncate">
        {playbook.name || playbook.slug}
      </span>
      <code className="text-xs text-muted-foreground truncate hidden sm:inline">
        {playbook.slug}
      </code>
    </div>
  );

  // The row card gives the name the room at phone width; the figures return with the width.
  const meta = (
    <span className="text-[10px] text-muted-foreground whitespace-nowrap hidden sm:inline">
      {formatSize(playbook.size)} · v{playbook.revision} · {formatRelativeTime(playbook.updatedAt)}
    </span>
  );

  if (compact) {
    return (
      <CardShell
        compact
        onClick={() => onClick?.(playbook)}
        actions={actions}
        testId={`playbook-card-${playbook.slug}`}
      >
        <div className="flex items-start justify-between gap-2">
          {title}
          <VisibilityToggle
            visibility={playbook.visibility}
            testId={`playbook-visibility-${playbook.slug}`}
          />
        </div>
        {playbook.description && (
          <p className="text-xs text-muted-foreground line-clamp-1">{playbook.description}</p>
        )}
        {playbook.preview && (
          <p className="text-xs text-muted-foreground/80 line-clamp-2 font-mono">
            {playbook.preview}
          </p>
        )}
        <div className="flex items-center mt-auto">{meta}</div>
      </CardShell>
    );
  }

  return (
    <CardShell
      onClick={() => onClick?.(playbook)}
      actions={actions}
      testId={`playbook-card-${playbook.slug}`}
    >
      {title}
      <VisibilityToggle
        visibility={playbook.visibility}
        testId={`playbook-visibility-${playbook.slug}`}
      />
      {meta}
    </CardShell>
  );
};
