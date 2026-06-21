/* eslint-disable no-console */
/**
 * Note History Dialog
 * View version history, compare diffs, and restore previous versions
 *
 * Split-pane layout: version list (left), content/diff view (right)
 * Note: console.error used for browser debugging of API errors
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Eye, GitCompareArrows, FileText, Clock } from "lucide-react";
import { diffLines, type Change } from "diff";
import { apiClient } from "../../services/api-client";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Badge } from "../ui/badge";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";

interface NoteVersion {
  version: number;
  size: number;
  preview: string;
  createdAt: number;
}

interface NoteHistoryDialogProps {
  open: boolean;
  onClose: (restored: boolean) => void;
  noteKey: string | null;
}

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 7) return new Date(timestamp).toLocaleDateString();
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const changes = useMemo(() => diffLines(oldText, newText), [oldText, newText]);

  return (
    <div className="font-mono text-sm" data-testid="diff-view">
      {changes.map((change: Change, i: number) => {
        const lines = change.value.split("\n");
        // Remove trailing empty line from split
        if (lines[lines.length - 1] === "") lines.pop();

        return lines.map((line, j) => (
          <div
            key={`${i}-${j}`}
            className={
              change.added
                ? "bg-green-500/15 text-green-700 dark:text-green-400 border-l-2 border-green-500 pl-2"
                : change.removed
                  ? "bg-red-500/15 text-red-700 dark:text-red-400 border-l-2 border-red-500 pl-2"
                  : "pl-3 text-muted-foreground"
            }
          >
            <span className="select-none inline-block w-4 mr-2 text-muted-foreground/50">
              {change.added ? "+" : change.removed ? "−" : " "}
            </span>
            {line || " "}
          </div>
        ));
      })}
    </div>
  );
}

export const NoteHistoryDialog: React.FC<NoteHistoryDialogProps> = ({ open, onClose, noteKey }) => {
  const { t } = useTranslation();

  const [history, setHistory] = useState<NoteVersion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [versionContent, setVersionContent] = useState<string | null>(null);
  const [currentContent, setCurrentContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [viewMode, setViewMode] = useState<"content" | "diff">("content");

  const isCurrentVersion = selectedVersion === history[0]?.version;

  const loadHistory = useCallback(async () => {
    if (!noteKey) return;
    try {
      setLoading(true);
      setError(null);
      const [data, currentNote] = await Promise.all([
        apiClient.getNoteHistory(noteKey),
        apiClient.getNote(noteKey),
      ]);
      setHistory(data);
      setCurrentContent(currentNote.value);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.errors.failedToLoad"));
    } finally {
      setLoading(false);
    }
  }, [noteKey, t]);

  const loadVersionContent = useCallback(
    async (version: number) => {
      if (!noteKey) return;
      try {
        setLoadingContent(true);
        setSelectedVersion(version);
        const note = await apiClient.getNote(noteKey, version);
        setVersionContent(note.value);
      } catch (err) {
        console.error("Failed to load version content:", err);
        setVersionContent(null);
      } finally {
        setLoadingContent(false);
      }
    },
    [noteKey],
  );

  useEffect(() => {
    if (open && noteKey) {
      loadHistory();
      setSelectedVersion(null);
      setVersionContent(null);
      setCurrentContent(null);
      setViewMode("content");
    }
  }, [open, noteKey, loadHistory]);

  const handleRestore = async () => {
    if (!noteKey || selectedVersion === null || !versionContent) return;
    try {
      setRestoring(true);
      const currentNote = await apiClient.getNote(noteKey);
      await apiClient.updateNote(noteKey, {
        value: versionContent,
        tags: currentNote.tags,
      });
      setRestoreDialogOpen(false);
      onClose(true);
    } catch (err) {
      console.error("Failed to restore version:", err);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose(false)}>
        <DialogContent className="max-w-5xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              {t("pages.notes.history.title")}
            </DialogTitle>
            <DialogDescription>
              {noteKey && t("pages.notes.history.description", { key: noteKey })}
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="py-12 text-center text-muted-foreground">{t("common.loading")}</div>
          ) : error ? (
            <div className="py-12 text-center text-destructive">{error}</div>
          ) : history.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              {t("pages.notes.history.noVersions")}
            </div>
          ) : (
            <div className="flex gap-4 flex-1 min-h-0">
              {/* Version list — left panel */}
              <div className="w-64 shrink-0 border rounded-lg overflow-hidden flex flex-col">
                <div className="bg-muted px-3 py-2 border-b text-sm font-medium text-muted-foreground">
                  {t("pages.notes.history.versions")} ({history.length})
                </div>
                <ScrollArea className="flex-1 max-h-[60vh]">
                  <div className="divide-y divide-border">
                    {history.map((version, index) => (
                      <div
                        key={version.version}
                        className={`px-3 py-2.5 cursor-pointer transition-colors ${
                          selectedVersion === version.version
                            ? "bg-primary/10 border-l-2 border-l-primary"
                            : "hover:bg-accent border-l-2 border-l-transparent"
                        }`}
                        onClick={() => loadVersionContent(version.version)}
                        data-testid={`version-${version.version}`}
                      >
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="font-medium text-sm text-foreground">
                            v{version.version}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {index === 0 && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                {t("pages.notes.history.current")}
                              </Badge>
                            )}
                            <span className="text-[11px] text-muted-foreground">
                              {formatSize(version.size)}
                            </span>
                          </div>
                        </div>
                        <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatRelativeTime(version.createdAt)}
                        </div>
                        {version.preview && (
                          <div className="text-xs text-muted-foreground/70 mt-1 truncate">
                            {version.preview}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>

              {/* Content/diff view — right panel */}
              <div className="flex-1 border rounded-lg overflow-hidden flex flex-col min-w-0">
                <div className="bg-muted px-3 py-2 border-b flex items-center justify-between">
                  {selectedVersion !== null ? (
                    <Tabs
                      value={viewMode}
                      onValueChange={(v) => setViewMode(v as "content" | "diff")}
                    >
                      <TabsList className="h-7">
                        <TabsTrigger value="content" className="text-xs px-2 h-6">
                          <FileText className="h-3 w-3 mr-1" />
                          {t("pages.notes.history.content")}
                        </TabsTrigger>
                        <TabsTrigger
                          value="diff"
                          className="text-xs px-2 h-6"
                          disabled={isCurrentVersion}
                        >
                          <GitCompareArrows className="h-3 w-3 mr-1" />
                          {t("pages.notes.history.diff")}
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  ) : (
                    <span className="text-sm font-medium text-muted-foreground">
                      {t("pages.notes.history.content")}
                    </span>
                  )}

                  {selectedVersion !== null && !isCurrentVersion && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => setRestoreDialogOpen(true)}
                      disabled={!versionContent}
                      data-testid="restore-version-button"
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />
                      {t("pages.notes.history.restore")}
                    </Button>
                  )}
                </div>

                <ScrollArea className="flex-1 max-h-[60vh]">
                  {loadingContent ? (
                    <div className="p-8 text-center text-muted-foreground">
                      {t("common.loading")}
                    </div>
                  ) : selectedVersion === null ? (
                    <div className="p-8 text-center text-muted-foreground flex flex-col items-center gap-3">
                      <Eye className="h-10 w-10 opacity-30" />
                      <span>{t("pages.notes.history.selectVersion")}</span>
                    </div>
                  ) : versionContent !== null ? (
                    viewMode === "diff" && currentContent !== null && !isCurrentVersion ? (
                      <div className="p-2">
                        <div className="text-xs text-muted-foreground px-2 py-1 mb-1">
                          {t("pages.notes.history.diffDescription", {
                            from: selectedVersion,
                            to: history[0]?.version,
                          })}
                        </div>
                        <DiffView oldText={versionContent} newText={currentContent} />
                      </div>
                    ) : (
                      <pre
                        className="p-4 text-sm font-mono whitespace-pre-wrap break-words text-foreground"
                        data-testid="version-content"
                      >
                        {versionContent}
                      </pre>
                    )
                  ) : (
                    <div className="p-8 text-center text-muted-foreground">
                      {t("pages.notes.history.noContent")}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={restoreDialogOpen} onOpenChange={setRestoreDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.notes.history.restoreTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.notes.history.restoreDescription", { version: selectedVersion })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestore} disabled={restoring}>
              {restoring ? t("common.loading") : t("pages.notes.history.restore")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
