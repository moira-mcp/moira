/* eslint-disable no-console */
/**
 * Notes Page
 * User notes management with list, search, tag filtering, and quota indicator.
 * Inline expandable editor — no modal for create/edit.
 *
 * Note: console.error used for browser debugging of API errors
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X, FileText, FilePlus } from "lucide-react";
import { apiClient } from "../services/api-client";
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import { PageShell } from "../components/PageShell";
import { FilterBar } from "../components/FilterBar";
import { useDebounce } from "../hooks/useDebounce";
import { NoteInlineEditor } from "../components/notes/NoteInlineEditor";
import { NoteHistoryDialog } from "../components/notes/NoteHistoryDialog";
import { useDynamicPageSize } from "../hooks/useDynamicPageSize";
import { NoteCard } from "../components/cards";
import { formatSize } from "../components/cards/format-utils";
import { DataListView } from "../components/DataListView";
import { ConfirmDialog } from "../components/confirm-dialog";

interface NoteListItem {
  id: string;
  key: string;
  tags: string[];
  size: number;
  currentVersion: number;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

interface NoteStats {
  totalNotes: number;
  totalSize: number;
  limit: number;
  usedPercent: number;
}

export const Notes: React.FC = () => {
  const { t } = useTranslation();
  const { pageSize, containerRef } = useDynamicPageSize();

  // Data state
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [stats, setStats] = useState<NoteStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);

  // Dialog state
  const [editingNoteKey, setEditingNoteKey] = useState<string | null>(null); // null=none, '__NEW__'=create, key=edit
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedNoteKey, setSelectedNoteKey] = useState<string | null>(null);

  // Debounce search
  const debouncedSearch = useDebounce(searchQuery, 300);

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch]);

  // Load stats
  const loadStats = useCallback(async () => {
    try {
      const statsData = await apiClient.getNoteStats();
      setStats(statsData);
    } catch {
      // Stats are non-critical, don't show error
    }
  }, []);

  // Load notes
  const loadNotes = useCallback(async () => {
    try {
      setLoading(true);

      const result = await apiClient.getNotes({
        tag: tagFilter || undefined,
        keySearch: debouncedSearch || undefined,
        limit: pageSize,
        offset: (currentPage - 1) * pageSize,
      });

      setNotes(result.notes);
      setTotal(result.total);
      setAllTags(result.allTags);
      setError(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t("common.errors.failedToLoad");
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [tagFilter, debouncedSearch, currentPage, pageSize, t]);

  useEffect(() => {
    loadNotes();
    loadStats();
  }, [loadNotes, loadStats]);

  const handleTagClick = (tag: string) => {
    setTagFilter(tag === tagFilter ? null : tag);
    setCurrentPage(1);
  };

  const handleClearTagFilter = () => {
    setTagFilter(null);
    setCurrentPage(1);
  };

  const handleCreateNote = () => {
    setEditingNoteKey("__NEW__");
  };

  const handleEditNote = (key: string) => {
    setEditingNoteKey(key);
  };

  const handleViewHistory = (key: string) => {
    setSelectedNoteKey(key);
    setHistoryOpen(true);
  };

  const handleDeleteClick = (key: string) => {
    setSelectedNoteKey(key);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!selectedNoteKey) return;

    try {
      await apiClient.deleteNote(selectedNoteKey);
      setDeleteDialogOpen(false);
      setSelectedNoteKey(null);
      loadNotes();
      loadStats();
    } catch (err) {
      console.error("Failed to delete note:", err);
    }
  };

  const handleEditorClose = (saved: boolean) => {
    setEditingNoteKey(null);
    if (saved) {
      loadNotes();
      loadStats();
    }
  };

  const handleHistoryClose = (restored: boolean) => {
    setHistoryOpen(false);
    setSelectedNoteKey(null);
    if (restored) {
      loadNotes();
      loadStats();
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  if (loading && notes.length === 0) {
    return <PageShell title={t("pages.notes.title")} loading />;
  }

  if (error) {
    return (
      <PageShell
        title={t("pages.notes.title")}
        error={error}
        onRetry={loadNotes}
        retryLabel={t("pages.notes.retry")}
      />
    );
  }

  return (
    <PageShell title={t("pages.notes.title")}>
      {/* Quota indicator */}
      {stats && (
        <div className="w-64 mb-6" data-testid="quota-indicator">
          <div className="flex justify-between text-sm text-muted-foreground mb-1">
            <span>{t("pages.notes.quota.used")}</span>
            <span>
              {formatSize(stats.totalSize)} / {formatSize(stats.limit)}
            </span>
          </div>
          <Progress value={stats.usedPercent} className="h-2" />
          <div className="text-xs text-muted-foreground mt-1 text-right">
            {stats.usedPercent.toFixed(1)}% {t("pages.notes.quota.usedPercent")}
          </div>
        </div>
      )}

      {/* Filters */}
      <FilterBar
        search={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder={t("pages.notes.filters.searchPlaceholder")}
        searchTestId="notes-search"
        onReset={() => {
          setSearchQuery("");
          setTagFilter(null);
          setCurrentPage(1);
        }}
        filters={
          tagFilter ? (
            <div className="flex items-center gap-2 px-3 py-1 bg-primary/10 rounded-lg self-end h-9">
              <span className="text-sm text-primary">
                {t("pages.notes.filters.tag")}: {tagFilter}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-primary hover:text-primary"
                onClick={handleClearTagFilter}
                aria-label={t("pages.notes.filters.clearTag", { defaultValue: "Clear tag filter" })}
                data-testid="clear-tag-filter"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : undefined
        }
        actions={
          <Button onClick={handleCreateNote} data-testid="create-note-button">
            <Plus className="h-4 w-4 mr-2" />
            {t("pages.notes.actions.create")}
          </Button>
        }
      />

      {/* Inline editor for creating new note */}
      {editingNoteKey === "__NEW__" && (
        <div className="mb-4" data-testid="new-note-editor">
          <NoteInlineEditor noteKey={null} allTags={allTags} onClose={handleEditorClose} />
        </div>
      )}

      {/* Persistent "new note" card when not editing */}
      {editingNoteKey !== "__NEW__" && (
        <button
          className="w-full mb-4 p-4 border-2 border-dashed border-muted-foreground/25 rounded-lg hover:border-primary/40 hover:bg-accent/50 transition-colors flex items-center gap-3 text-muted-foreground hover:text-foreground"
          onClick={handleCreateNote}
          data-testid="new-note-card"
        >
          <FilePlus className="h-5 w-5" />
          <div className="text-left">
            <div className="text-sm font-medium">{t("pages.notes.editor.newNoteCard")}</div>
            <div className="text-xs">{t("pages.notes.editor.newNoteHint")}</div>
          </div>
        </button>
      )}

      <DataListView
        items={notes}
        renderCard={(note, viewMode) =>
          editingNoteKey === note.key ? (
            <NoteInlineEditor
              noteKey={note.key}
              allTags={allTags}
              onClose={handleEditorClose}
              onCompare={() => handleViewHistory(note.key)}
            />
          ) : (
            <NoteCard
              note={note}
              compact={viewMode === "grid"}
              onClick={() => handleEditNote(note.key)}
              onEdit={() => handleEditNote(note.key)}
              onHistory={() => handleViewHistory(note.key)}
              onDelete={() => handleDeleteClick(note.key)}
              onTagClick={handleTagClick}
            />
          )
        }
        keyExtractor={(n) => n.key}
        storageKey="notes-view-mode"
        loading={loading}
        emptyIcon={FileText}
        emptyTitle={
          debouncedSearch || tagFilter ? t("pages.notes.noResults") : t("pages.notes.noNotes")
        }
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage,
          totalPages,
          totalItems: total,
          pageSize,
          onPageChange: setCurrentPage,
        }}
        className="flex-1 min-h-0 flex flex-col"
      />

      <NoteHistoryDialog
        open={historyOpen}
        onClose={handleHistoryClose}
        noteKey={selectedNoteKey}
      />

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={t("pages.notes.delete.title")}
        description={t("pages.notes.delete.description", { key: selectedNoteKey })}
        confirmLabel={t("pages.notes.actions.delete")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={handleDeleteConfirm}
      />
    </PageShell>
  );
};
