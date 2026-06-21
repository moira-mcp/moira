/**
 * Note Card Component
 * Displays note info in list (compact) or grid mode using CardShell
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

  if (compact) {
    return (
      <CardShell compact onClick={() => onClick?.(note)} actions={actions} testId="note-card">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <StickyNote className="w-4 h-4 text-primary flex-shrink-0" />
            <span className="font-medium text-sm text-foreground truncate font-mono">
              {note.key}
            </span>
          </div>
        </div>

        {note.preview && (
          <p className="text-xs text-muted-foreground line-clamp-2">{note.preview}</p>
        )}

        <div className="flex items-center gap-1 mt-auto flex-wrap">
          {note.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} variant="outline" className="text-[10px] px-1 py-0 h-4">
              <Tag className="w-2.5 h-2.5 mr-0.5" />
              {tag}
            </Badge>
          ))}
          {note.tags.length > 3 && (
            <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
              +{note.tags.length - 3}
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto">
            {formatSize(note.size)} · v{note.currentVersion}
          </span>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell onClick={() => onClick?.(note)} testId={`note-row-${note.key}`} actions={actions}>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <StickyNote className="w-4 h-4 text-primary flex-shrink-0" />
        <span className="font-medium text-sm text-foreground truncate font-mono">{note.key}</span>
        {note.tags.length > 0 && (
          <div className="flex items-center gap-1 hidden sm:flex">
            {note.tags.slice(0, 2).map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className={cn(
                  "text-[10px] px-1 py-0 h-4",
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
                {tag}
              </Badge>
            ))}
            {note.tags.length > 2 && (
              <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                +{note.tags.length - 2}
              </Badge>
            )}
          </div>
        )}
      </div>

      <span className="text-[11px] text-muted-foreground flex-shrink-0 hidden sm:block">
        {formatSize(note.size)} · v{note.currentVersion}
      </span>

      <div className="flex items-center gap-1 flex-shrink-0">
        <span className="text-[10px] text-muted-foreground">
          {formatRelativeTime(note.updatedAt)}
        </span>
      </div>
    </CardShell>
  );
};
