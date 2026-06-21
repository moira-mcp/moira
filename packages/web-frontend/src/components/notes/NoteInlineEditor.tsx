/**
 * Note Inline Editor
 * In-place expandable card editor for notes — replaces modal-based editing.
 * Save triggers on Ctrl+Enter or explicit Save button click.
 * Cancel on Escape.
 * Version switcher in edit mode — select historical versions (read-only) with Restore.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  Eye,
  Edit3,
  Save,
  XCircle,
  RotateCcw,
  ChevronDown,
  GitCompareArrows,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { apiClient, ApiClientError } from "../../services/api-client";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";
import { Badge } from "../ui/badge";
import { Progress } from "../ui/progress";
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

interface NoteInlineEditorProps {
  /** Note key for edit mode; null for create mode */
  noteKey: string | null;
  /** Available tags for autocomplete */
  allTags: string[];
  /** Called after successful save or cancel */
  onClose: (saved: boolean) => void;
  /** Called to open the history/diff comparison modal */
  onCompare?: () => void;
}

const MAX_NOTE_SIZE = 100 * 1024; // 100 KB
const KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

export const NoteInlineEditor: React.FC<NoteInlineEditorProps> = ({
  noteKey,
  allTags,
  onClose,
  onCompare,
}) => {
  const { t } = useTranslation();
  const isEditMode = noteKey !== null;
  const editorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Form state
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  // UI state
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [showTagSuggestions, setShowTagSuggestions] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // Version switcher state (edit mode only)
  const [versions, setVersions] = useState<NoteVersion[]>([]);
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [versionDropdownOpen, setVersionDropdownOpen] = useState(false);
  const [restoreDialogOpen, setRestoreDialogOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);

  const isViewingOlderVersion = selectedVersion !== null && selectedVersion !== currentVersion;

  const contentSize = useMemo(() => new TextEncoder().encode(value).length, [value]);
  const sizePercent = (contentSize / MAX_NOTE_SIZE) * 100;
  const isOverLimit = contentSize > MAX_NOTE_SIZE;

  const tagSuggestions = useMemo(() => {
    if (!tagInput) return [];
    const input = tagInput.toLowerCase();
    return allTags
      .filter((tag) => tag.toLowerCase().includes(input) && !tags.includes(tag))
      .slice(0, 5);
  }, [tagInput, allTags, tags]);

  // Load note data in edit mode
  const loadNote = useCallback(async () => {
    if (!noteKey) return;
    try {
      setLoading(true);
      setError(null);
      const [note, history] = await Promise.all([
        apiClient.getNote(noteKey),
        apiClient.getNoteHistory(noteKey),
      ]);
      setKey(note.key);
      setValue(note.value);
      setTags(note.tags);
      setVersions(history);
      setCurrentVersion(note.version);
      setSelectedVersion(note.version);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.errors.failedToLoad"));
    } finally {
      setLoading(false);
    }
  }, [noteKey, t]);

  useEffect(() => {
    if (isEditMode) {
      loadNote();
    } else {
      setKey("");
      setValue("");
      setTags([]);
      setTagInput("");
      setError(null);
      setKeyError(null);
      setVersions([]);
      setCurrentVersion(null);
      setSelectedVersion(null);
    }
    setShowPreview(false);
  }, [isEditMode, loadNote]);

  // Focus textarea after load
  useEffect(() => {
    if (!loading && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [loading]);

  const handleKeyChange = (newKey: string) => {
    setKey(newKey);
    if (!newKey) {
      setKeyError(null);
      return;
    }
    if (newKey.length > 100) {
      setKeyError(t("pages.notes.editor.keyTooLong"));
    } else if (!KEY_PATTERN.test(newKey)) {
      setKeyError(t("pages.notes.editor.keyInvalidFormat"));
    } else {
      setKeyError(null);
    }
  };

  const handleAddTag = (tag: string) => {
    const trimmed = tag.trim();
    if (!trimmed || tags.includes(trimmed) || tags.length >= 10) return;
    if (trimmed.length > 50) return;
    setTags([...tags, trimmed]);
    setTagInput("");
    setShowTagSuggestions(false);
  };

  const handleRemoveTag = (tagToRemove: string) => {
    setTags(tags.filter((tag) => tag !== tagToRemove));
  };

  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (tagInput.trim()) handleAddTag(tagInput);
    } else if (e.key === "Backspace" && !tagInput && tags.length > 0) {
      handleRemoveTag(tags[tags.length - 1]);
    }
  };

  // Switch to a different version (loads content read-only)
  const handleVersionSelect = useCallback(
    async (version: number) => {
      if (!noteKey) return;
      setVersionDropdownOpen(false);
      if (version === currentVersion) {
        // Switch back to current — reload editable state
        setSelectedVersion(currentVersion);
        const note = await apiClient.getNote(noteKey);
        setValue(note.value);
        setTags(note.tags);
        return;
      }
      try {
        setLoading(true);
        const note = await apiClient.getNote(noteKey, version);
        setValue(note.value);
        setSelectedVersion(version);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("common.errors.failedToLoad"));
      } finally {
        setLoading(false);
      }
    },
    [noteKey, currentVersion, t],
  );

  // Restore a historical version (creates new version with that content)
  const handleRestore = useCallback(async () => {
    if (!noteKey || selectedVersion === null) return;
    try {
      setRestoring(true);
      setError(null);
      const currentNote = await apiClient.getNote(noteKey);
      const oldNote = await apiClient.getNote(noteKey, selectedVersion);
      await apiClient.updateNote(noteKey, { value: oldNote.value, tags: currentNote.tags });
      setRestoreDialogOpen(false);
      onClose(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.errors.failedToSave"));
    } finally {
      setRestoring(false);
    }
  }, [noteKey, selectedVersion, onClose, t]);

  const handleSave = useCallback(async () => {
    if (!key) {
      setKeyError(t("pages.notes.editor.keyRequired"));
      return;
    }
    if (keyError || isOverLimit) return;

    try {
      setSaving(true);
      setError(null);
      if (isEditMode) {
        await apiClient.updateNote(key, { value, tags });
      } else {
        await apiClient.createNote({ key, value, tags });
      }
      onClose(true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : t("common.errors.failedToSave"));
      }
    } finally {
      setSaving(false);
    }
  }, [key, keyError, isOverLimit, isEditMode, value, tags, onClose, t]);

  // Ctrl+Enter to save, Escape to cancel
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose(false);
      }
    },
    [handleSave, onClose],
  );

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    return `${(bytes / 1024).toFixed(1)} KB`;
  };

  const canSave = key && !keyError && !isOverLimit && !saving && !loading && !isViewingOlderVersion;

  return (
    <Card
      ref={editorRef}
      className="border-primary/30 shadow-md"
      data-testid="note-inline-editor"
      onKeyDown={handleKeyDown}
    >
      {loading ? (
        <div className="p-6 text-center text-muted-foreground">{t("common.loading")}</div>
      ) : (
        <div className="p-4 space-y-3">
          {error && (
            <div className="p-2 bg-destructive/10 border border-destructive/20 rounded-md text-destructive text-sm">
              {error}
            </div>
          )}

          {/* Key field — editable in create mode, read-only header in edit mode with version switcher */}
          {isEditMode ? (
            <div className="flex items-center justify-between">
              <span className="font-mono font-medium text-sm text-foreground">{key}</span>
              {versions.length > 1 && (
                <div className="flex items-center gap-2">
                  {isViewingOlderVersion && (
                    <span
                      className="text-xs text-amber-600 dark:text-amber-400"
                      data-testid="older-version-indicator"
                    >
                      {t("pages.notes.editor.olderVersion", { version: selectedVersion })}
                    </span>
                  )}
                  <div className="relative">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={() => setVersionDropdownOpen(!versionDropdownOpen)}
                      data-testid="version-switcher"
                    >
                      v{selectedVersion ?? currentVersion}
                      {selectedVersion === currentVersion && (
                        <Badge variant="secondary" className="text-[10px] px-1 py-0 ml-1">
                          {t("pages.notes.editor.currentVersion")}
                        </Badge>
                      )}
                      <ChevronDown className="h-3 w-3" />
                    </Button>
                    {versionDropdownOpen && (
                      <div
                        className="absolute right-0 top-full mt-1 w-48 bg-popover border rounded-md shadow-lg z-20 max-h-48 overflow-auto"
                        data-testid="version-dropdown"
                      >
                        {versions.map((v, i) => (
                          <button
                            key={v.version}
                            className={`w-full px-3 py-1.5 text-left text-sm hover:bg-accent first:rounded-t-md last:rounded-b-md flex items-center justify-between ${
                              v.version === selectedVersion ? "bg-accent" : ""
                            }`}
                            onClick={() => handleVersionSelect(v.version)}
                            data-testid={`version-option-${v.version}`}
                          >
                            <span>v{v.version}</span>
                            {i === 0 && (
                              <Badge variant="secondary" className="text-[10px] px-1 py-0">
                                {t("pages.notes.editor.currentVersion")}
                              </Badge>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {onCompare && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1"
                      onClick={onCompare}
                      data-testid="compare-versions-button"
                    >
                      <GitCompareArrows className="h-3 w-3" />
                      {t("pages.notes.editor.compareVersions")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <Label htmlFor="note-key">{t("pages.notes.editor.key")}</Label>
              <Input
                id="note-key"
                value={key}
                onChange={(e) => handleKeyChange(e.target.value)}
                placeholder={t("pages.notes.editor.keyPlaceholder")}
                className={keyError ? "border-destructive" : ""}
                data-testid="note-key-input"
              />
              {keyError && <p className="text-destructive text-xs">{keyError}</p>}
            </div>
          )}

          {/* Content field */}
          <div className="space-y-1">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-2">
                <Label htmlFor="note-content">{t("pages.notes.editor.content")}</Label>
                <button
                  type="button"
                  onClick={() => setShowPreview(!showPreview)}
                  className="flex items-center gap-1 px-2 py-0.5 text-xs rounded-md border hover:bg-accent transition-colors"
                  data-testid="markdown-preview-toggle"
                >
                  {showPreview ? (
                    <>
                      <Edit3 className="h-3 w-3" />
                      {t("pages.notes.editor.edit")}
                    </>
                  ) : (
                    <>
                      <Eye className="h-3 w-3" />
                      {t("pages.notes.editor.preview")}
                    </>
                  )}
                </button>
              </div>
              <span
                className={`text-xs ${isOverLimit ? "text-destructive" : "text-muted-foreground"}`}
              >
                {formatSize(contentSize)} / {formatSize(MAX_NOTE_SIZE)}
              </span>
            </div>
            {showPreview || isViewingOlderVersion ? (
              <div
                className={`min-h-[120px] p-3 border rounded-md ${isViewingOlderVersion ? "bg-amber-50/50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800" : "bg-muted"} prose prose-sm dark:prose-invert max-w-none overflow-auto`}
                data-testid="note-content-preview"
              >
                {value ? (
                  isViewingOlderVersion ? (
                    <pre className="font-mono text-sm whitespace-pre-wrap break-words">{value}</pre>
                  ) : (
                    <ReactMarkdown>{value}</ReactMarkdown>
                  )
                ) : (
                  <p className="text-muted-foreground italic">
                    {t("pages.notes.editor.noContent")}
                  </p>
                )}
              </div>
            ) : (
              <Textarea
                ref={textareaRef}
                id="note-content"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={t("pages.notes.editor.contentPlaceholder")}
                className="min-h-[120px] font-mono text-sm"
                data-testid="note-content-input"
              />
            )}
            <Progress
              value={Math.min(sizePercent, 100)}
              className={`h-1 ${isOverLimit ? "[&>div]:bg-destructive" : ""}`}
            />
            {isOverLimit && (
              <p className="text-destructive text-xs">{t("pages.notes.editor.contentTooLarge")}</p>
            )}
          </div>

          {/* Tags field */}
          <div className="space-y-1">
            <Label>{t("pages.notes.editor.tags")}</Label>
            <div className="flex flex-wrap gap-1.5 p-2 border rounded-md min-h-[36px] bg-background">
              {tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="gap-1 text-xs">
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(tag)}
                    className="ml-0.5 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
              <div className="relative flex-1 min-w-[80px]">
                <Input
                  value={tagInput}
                  onChange={(e) => {
                    setTagInput(e.target.value);
                    setShowTagSuggestions(true);
                  }}
                  onKeyDown={handleTagKeyDown}
                  onFocus={() => setShowTagSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowTagSuggestions(false), 200)}
                  placeholder={tags.length >= 10 ? "" : t("pages.notes.editor.tagPlaceholder")}
                  disabled={tags.length >= 10}
                  className="border-0 shadow-none focus-visible:ring-0 p-0 h-auto text-sm"
                  data-testid="note-tag-input"
                />
                {showTagSuggestions && tagSuggestions.length > 0 && (
                  <div className="absolute top-full left-0 mt-1 w-full bg-popover border rounded-md shadow-lg z-10">
                    {tagSuggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent first:rounded-t-md last:rounded-b-md"
                        onMouseDown={() => handleAddTag(suggestion)}
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("pages.notes.editor.tagsHint", { count: tags.length, max: 10 })}
            </p>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onClose(false)}
              disabled={saving || restoring}
              data-testid="cancel-note-button"
            >
              <XCircle className="h-3.5 w-3.5 mr-1" />
              {t("common.cancel")}
            </Button>
            {isViewingOlderVersion ? (
              <Button
                size="sm"
                variant="default"
                onClick={() => setRestoreDialogOpen(true)}
                disabled={restoring}
                data-testid="restore-version-button"
              >
                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                {t("pages.notes.editor.restoreVersion")}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleSave}
                disabled={!canSave}
                data-testid="save-note-button"
              >
                <Save className="h-3.5 w-3.5 mr-1" />
                {saving ? t("common.saving") : t("common.save")}
              </Button>
            )}
          </div>
        </div>
      )}

      <AlertDialog open={restoreDialogOpen} onOpenChange={setRestoreDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.notes.editor.restoreConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("pages.notes.editor.restoreConfirmDescription", { version: selectedVersion })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRestore}
              disabled={restoring}
              data-testid="confirm-restore-button"
            >
              {restoring ? t("common.loading") : t("pages.notes.editor.restoreVersion")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};
