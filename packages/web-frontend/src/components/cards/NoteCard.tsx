/**
 * A note as a CardShell item: its key as the title, the beginning of its text as the description,
 * and its tags (a click filters by one), size, version and last change as the meta line.
 */

import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StickyNote, Pencil, History, Trash2, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatRelativeTime, formatSize } from "./format-utils";
import { CardShell, type CardAction } from "./CardShell";

export interface NoteCardData {
  id: string;
  key: string;
  tags: string[];
  size: number;
  currentVersion: number;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

interface NoteCardProps {
  note: NoteCardData;
  onClick?: (note: NoteCardData) => void;
  onEdit?: (note: NoteCardData) => void;
  onHistory?: (note: NoteCardData) => void;
  onDelete?: (note: NoteCardData) => void;
  onTagClick?: (tag: string) => void;
  compact?: boolean;
}

/** At most this many tags are shown; the rest are counted. */
const MAX_TAGS = 3;

export const NoteCard: React.FC<NoteCardProps> = ({
  note,
  onClick,
  onEdit,
  onHistory,
  onDelete,
  onTagClick,
  compact = false,
}) => {
  const { t } = useTranslation();

  const actions = useMemo(() => {
    const list: CardAction[] = [];
    if (onEdit)
      list.push({
        icon: <Pencil className="w-3.5 h-3.5" />,
        label: t("common.edit", { defaultValue: "Edit" }),
        onClick: () => onEdit(note),
        testId: compact ? undefined : `edit-note-${note.key}`,
      });
    if (onHistory)
      list.push({
        icon: <History className="w-3.5 h-3.5" />,
        label: t("common.history", { defaultValue: "History" }),
        onClick: () => onHistory(note),
        testId: compact ? undefined : `history-note-${note.key}`,
      });
    if (onDelete)
      list.push({
        icon: <Trash2 className="w-3.5 h-3.5" />,
        label: t("common.delete", { defaultValue: "Delete" }),
        onClick: () => onDelete(note),
        variant: "destructive",
        testId: compact ? undefined : `delete-note-${note.key}`,
      });
    return list;
  }, [onEdit, onHistory, onDelete, note, t, compact]);

  return (
    <CardShell
      compact={compact}
      onClick={onClick ? () => onClick(note) : undefined}
      actions={actions}
      testId={compact ? "note-card" : `note-row-${note.key}`}
      icon={<StickyNote aria-hidden="true" />}
      title={<span className="font-mono">{note.key}</span>}
      description={note.preview || undefined}
      meta={
        <>
          {note.tags.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1">
              {note.tags.slice(0, MAX_TAGS).map((tag) => (
                <Badge
                  key={tag}
                  variant="outline"
                  className={cn(
                    "h-5 gap-0.5 px-1.5 text-[11px]",
                    onTagClick && "cursor-pointer hover:bg-accent",
                  )}
                  data-testid={`tag-${tag}`}
                  onClick={
                    onTagClick
                      ? (e) => {
                          e.stopPropagation();
                          onTagClick(tag);
                        }
                      : undefined
                  }
                >
                  <Tag className="size-2.5" aria-hidden="true" />
                  {tag}
                </Badge>
              ))}
              {note.tags.length > MAX_TAGS && (
                <span className="text-[11px]">+{note.tags.length - MAX_TAGS}</span>
              )}
            </span>
          )}
          <span>
            {formatSize(note.size)} · v{note.currentVersion}
          </span>
          <span>{formatRelativeTime(note.updatedAt)}</span>
        </>
      }
    />
  );
};
