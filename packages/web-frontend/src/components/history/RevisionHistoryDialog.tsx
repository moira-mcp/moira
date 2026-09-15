/* eslint-disable no-console */
/**
 * Version history for anything the shared revision store versions.
 *
 * Notes, playbooks and global settings keep their content in one store on the server, so they get
 * one history interface here rather than three that drift apart. What differs between them is only
 * where the revisions come from and what restoring means, which the caller supplies as a source.
 *
 * Note: console.error is used for browser debugging of API errors, as elsewhere in this app.
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw, Eye, GitCompareArrows, FileText, Clock, Columns2 } from "lucide-react";
import { diffLines, type Change } from "diff";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Badge } from "../ui/badge";
import { Tabs, TabsList, TabsTrigger } from "../ui/tabs";

/** One revision as the list on the left shows it. */
export interface RevisionEntry {
  revision: number;
  size: number;
  preview: string;
  createdAt: number;
}

/**
 * Where one consumer's history comes from and what restoring means for it.
 *
 * Deliberately four functions rather than an entity type: a consumer that has to be named here is
 * a consumer this component knows about, and the next one would have to edit it.
 */
export interface RevisionHistorySource {
  /** Shown in the dialog subtitle so the reader knows whose history this is. */
  label: string;
  listRevisions(): Promise<RevisionEntry[]>;
  /** Content of one revision; null when that revision recorded no content at all. */
  readRevision(revision: number): Promise<string | null>;
  /** Content in force right now. */
  readCurrent(): Promise<string | null>;
  restore(revision: number): Promise<void>;
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

/**
 * Line-by-line difference between two texts.
 *
 * Exported because more than one screen shows a difference between versions, and two hand-written
 * diff renderers drift in exactly the way a reader notices: the same change coloured differently in
 * two places. `testId` and `className` let a caller keep its own hook and density.
 */
export function DiffView({
  oldText,
  newText,
  testId = "diff-view",
  className = "font-mono text-sm",
}: {
  oldText: string;
  newText: string;
  testId?: string;
  className?: string;
}) {
  const changes = useMemo(() => diffLines(oldText, newText), [oldText, newText]);

  return (
    <div className={className} data-testid={testId}>
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

interface RevisionHistoryDialogProps {
  open: boolean;
  /** `restored` tells the caller whether the entity changed while the dialog was open. */
  onClose: (restored: boolean) => void;
  source: RevisionHistorySource | null;
}

type ViewMode = "content" | "side" | "diff";

export const RevisionHistoryDialog: React.FC<RevisionHistoryDialogProps> = ({
  open,
  onClose,
  source,
}) => {
  const { t } = useTranslation();

  const [history, setHistory] = useState<RevisionEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedRevision, setSelectedRevision] = useState<number | null>(null);
  const [revisionContent, setRevisionContent] = useState<string | null>(null);
  const [currentContent, setCurrentContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("content");

  const isCurrentRevision = selectedRevision === history[0]?.revision;

  const loadHistory = useCallback(async () => {
    if (!source) return;
    try {
      setLoading(true);
      setError(null);
      const [revisions, current] = await Promise.all([
        source.listRevisions(),
        source.readCurrent(),
      ]);
      setHistory(revisions);
      setCurrentContent(current);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.errors.failedToLoad"));
    } finally {
      setLoading(false);
    }
  }, [source, t]);

  const loadRevisionContent = useCallback(
    async (revision: number) => {
      if (!source) return;
      try {
        setLoadingContent(true);
        setSelectedRevision(revision);
        setConfirmingRestore(false);
        setRevisionContent(await source.readRevision(revision));
      } catch (err) {
        console.error("Failed to load revision content:", err);
        setRevisionContent(null);
      } finally {
        setLoadingContent(false);
      }
    },
    [source],
  );

  useEffect(() => {
    if (open && source) {
      loadHistory();
      setSelectedRevision(null);
      setRevisionContent(null);
      setCurrentContent(null);
      setViewMode("content");
      setConfirmingRestore(false);
    }
  }, [open, source, loadHistory]);

  const handleRestore = async () => {
    if (!source || selectedRevision === null) return;
    try {
      setRestoring(true);
      await source.restore(selectedRevision);
      setConfirmingRestore(false);
      onClose(true);
    } catch (err) {
      console.error("Failed to restore revision:", err);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose(false)}>
        <DialogContent className="sm:max-w-5xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              {t("history.title")}
            </DialogTitle>
            <DialogDescription>
              {source && t("history.description", { subject: source.label })}
            </DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="py-12 text-center text-muted-foreground">{t("common.loading")}</div>
          ) : error ? (
            <div className="py-12 text-center text-destructive">{error}</div>
          ) : history.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">{t("history.noVersions")}</div>
          ) : (
            <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0">
              {/* Revision list — left panel */}
              <div className="md:w-64 shrink-0 border rounded-lg overflow-hidden flex flex-col">
                <div className="bg-muted px-3 py-2 border-b text-sm font-medium text-muted-foreground">
                  {t("history.versions")} ({history.length})
                </div>
                <ScrollArea className="flex-1 max-h-[30vh] md:max-h-[60vh]">
                  <div className="divide-y divide-border">
                    {history.map((entry, index) => (
                      <div
                        key={entry.revision}
                        className={`px-3 py-2.5 cursor-pointer transition-colors ${
                          selectedRevision === entry.revision
                            ? "bg-primary/10 border-l-2 border-l-primary"
                            : "hover:bg-accent border-l-2 border-l-transparent"
                        }`}
                        onClick={() => loadRevisionContent(entry.revision)}
                        data-testid={`version-${entry.revision}`}
                      >
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="font-medium text-sm text-foreground">
                            v{entry.revision}
                          </span>
                          <div className="flex items-center gap-1.5">
                            {index === 0 && (
                              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                                {t("history.current")}
                              </Badge>
                            )}
                            <span className="text-[11px] text-muted-foreground">
                              {formatSize(entry.size)}
                            </span>
                          </div>
                        </div>
                        <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatRelativeTime(entry.createdAt)}
                        </div>
                        {entry.preview && (
                          <div className="text-xs text-muted-foreground/70 mt-1 truncate">
                            {entry.preview}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </ScrollArea>
              </div>

              {/* Content view — right panel */}
              <div className="flex-1 border rounded-lg overflow-hidden flex flex-col min-w-0">
                <div className="bg-muted px-3 py-2 border-b flex flex-wrap items-center justify-between gap-2">
                  {selectedRevision !== null ? (
                    <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
                      <TabsList className="h-7">
                        <TabsTrigger value="content" className="text-xs px-2 h-6">
                          <FileText className="h-3 w-3 mr-1" />
                          {t("history.content")}
                        </TabsTrigger>
                        <TabsTrigger
                          value="side"
                          className="text-xs px-2 h-6"
                          disabled={isCurrentRevision}
                          data-testid="side-by-side-tab"
                        >
                          <Columns2 className="h-3 w-3 mr-1" />
                          {t("history.sideBySide")}
                        </TabsTrigger>
                        <TabsTrigger
                          value="diff"
                          className="text-xs px-2 h-6"
                          disabled={isCurrentRevision}
                        >
                          <GitCompareArrows className="h-3 w-3 mr-1" />
                          {t("history.diff")}
                        </TabsTrigger>
                      </TabsList>
                    </Tabs>
                  ) : (
                    <span className="text-sm font-medium text-muted-foreground">
                      {t("history.content")}
                    </span>
                  )}

                  {/* Restoring is confirmed in place. A second modal on top of this one would be
                      the only stacked modal in the product, and closing both at once leaves the
                      reopened dialog unable to take clicks. */}
                  {selectedRevision !== null &&
                    !isCurrentRevision &&
                    (confirmingRestore ? (
                      <div
                        className="flex items-center gap-2 text-xs"
                        data-testid="restore-confirmation"
                      >
                        <span className="text-muted-foreground">
                          {t("history.restoreDescription", { version: selectedRevision })}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => setConfirmingRestore(false)}
                          disabled={restoring}
                        >
                          {t("common.cancel")}
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 text-xs"
                          onClick={handleRestore}
                          disabled={restoring}
                          data-testid="confirm-restore-button"
                        >
                          <RotateCcw className="h-3 w-3 mr-1" />
                          {restoring ? t("common.loading") : t("history.restore")}
                        </Button>
                      </div>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        onClick={() => setConfirmingRestore(true)}
                        disabled={revisionContent === null}
                        data-testid="restore-version-button"
                      >
                        <RotateCcw className="h-3 w-3 mr-1" />
                        {t("history.restore")}
                      </Button>
                    ))}
                </div>

                <ScrollArea className="flex-1 max-h-[60vh]">
                  {loadingContent ? (
                    <div className="p-8 text-center text-muted-foreground">
                      {t("common.loading")}
                    </div>
                  ) : selectedRevision === null ? (
                    <div className="p-8 text-center text-muted-foreground flex flex-col items-center gap-3">
                      <Eye className="h-10 w-10 opacity-30" />
                      <span>{t("history.selectVersion")}</span>
                    </div>
                  ) : revisionContent !== null ? (
                    viewMode === "diff" && currentContent !== null && !isCurrentRevision ? (
                      <div className="p-2">
                        <div className="text-xs text-muted-foreground px-2 py-1 mb-1">
                          {t("history.diffDescription", {
                            from: selectedRevision,
                            to: history[0]?.revision,
                          })}
                        </div>
                        <DiffView oldText={revisionContent} newText={currentContent} />
                      </div>
                    ) : viewMode === "side" && !isCurrentRevision ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border min-w-0">
                        <div className="min-w-0">
                          <div className="text-xs text-muted-foreground px-4 pt-3">
                            {t("history.selectedVersion", { version: selectedRevision })}
                          </div>
                          <pre
                            className="p-4 pt-2 text-sm font-mono whitespace-pre-wrap break-words text-foreground"
                            data-testid="version-content"
                          >
                            {revisionContent}
                          </pre>
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs text-muted-foreground px-4 pt-3">
                            {t("history.currentVersion", { version: history[0]?.revision })}
                          </div>
                          <pre
                            className="p-4 pt-2 text-sm font-mono whitespace-pre-wrap break-words text-foreground"
                            data-testid="current-content"
                          >
                            {currentContent ?? ""}
                          </pre>
                        </div>
                      </div>
                    ) : (
                      <pre
                        className="p-4 text-sm font-mono whitespace-pre-wrap break-words text-foreground"
                        data-testid="version-content"
                      >
                        {revisionContent}
                      </pre>
                    )
                  ) : (
                    <div className="p-8 text-center text-muted-foreground">
                      {t("history.noContent")}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
};
