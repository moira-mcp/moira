/* eslint-disable no-console */
/**
 * McpPromptsEditor - Master-detail MCP prompt editor with scope/model selection
 *
 * Layout: Left panel with clickable prompt list, right panel with full-height editor.
 * Features:
 * - System prompt and system reminder editing
 * - Each prompt has Scope dropdown (Default/Claude/ChatGPT/Gemini/Cursor)
 * - Model dropdown (disabled when Default, populated with vendor-specific models)
 * - Dynamic loading of values based on scope/model selection
 * - Save/Reset buttons per prompt
 *
 * Note: console.error used for browser debugging of API errors
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { DiffView } from "../history/RevisionHistoryDialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Save, RotateCcw, History, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { DataRegion } from "@/components/DataRegion";
import { useLatestRequest } from "@/hooks/useLatestRequest";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { toast } from "sonner";
import { useRefreshOnActivation } from "./useRefreshOnActivation";

// Prompt types
export const PROMPT_TYPES = ["systemPrompt", "systemReminder"] as const;

export type PromptType = (typeof PROMPT_TYPES)[number];

// Vendor/agent configuration
export const VENDORS = ["default", "claude", "chatgpt", "gemini", "cursor"] as const;
export type Vendor = (typeof VENDORS)[number];

// Models per vendor
export const VENDOR_MODELS: Record<Exclude<Vendor, "default">, string[]> = {
  claude: ["claude-opus-4-5-20251101", "claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"],
  chatgpt: ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
  gemini: ["gemini-2.0-flash", "gemini-1.5-pro"],
  cursor: ["cursor-small"],
};

// Display labels
export const VENDOR_LABELS: Record<Vendor, string> = {
  default: "Default",
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  cursor: "Cursor",
};

export const PROMPT_LABELS: Record<PromptType, string> = {
  systemPrompt: "System Prompt",
  systemReminder: "System Reminder",
};

/** Result from fetching MCP prompt value - includes the settings key for history */
export interface McpPromptFetchResult {
  value: string | null;
  key: string;
}

/** History entry from audit log */
export interface PromptHistoryEntry {
  id: string;
  userEmail: string | null;
  userName: string | null;
  action: string;
  changes?: string;
  createdAt: number;
}

export interface McpPromptsEditorProps {
  active?: boolean;
  /** Fetch raw value for a specific scope/model/prompt - returns value and settings key */
  onFetchValue: (
    promptType: PromptType,
    vendor: Vendor,
    model: string | null,
  ) => Promise<McpPromptFetchResult>;
  /** Save value for a specific scope/model/prompt */
  onSave: (
    promptType: PromptType,
    vendor: Vendor,
    model: string | null,
    value: string | null,
  ) => Promise<void>;
  /** Reset value for a specific scope/model/prompt (set to null) */
  onReset: (promptType: PromptType, vendor: Vendor, model: string | null) => Promise<void>;
  /** Callback when history button is clicked - receives the settings key (legacy modal) */
  onHistoryClick?: (settingsKey: string) => void;
  /** Fetch history entries for a settings key (inline version history) */
  onFetchHistory?: (settingsKey: string) => Promise<PromptHistoryEntry[]>;
  /** Data-testid prefix for testing */
  testIdPrefix?: string;
}

interface PromptEditorState {
  vendor: Vendor;
  model: string | null;
  value: string;
  originalValue: string | null;
  loading: boolean;
  saving: boolean;
  hasOverride: boolean;
  /** Current settings key for history lookup */
  settingsKey: string | null;
  acceptedVendor: Vendor;
  acceptedModel: string | null;
  error: string | null;
}

/** Parse changes JSON from audit log entry */
export function parseHistoryChanges(changesJson?: string): {
  oldValue?: string | null;
  newValue?: string | null;
} {
  if (!changesJson) return {};
  try {
    const parsed = JSON.parse(changesJson);
    if (Array.isArray(parsed)) {
      const valueChange = parsed.find(
        (c: { field?: string; oldValue?: string | null; newValue?: string | null }) =>
          c.field === "value",
      );
      if (valueChange) return { oldValue: valueChange.oldValue, newValue: valueChange.newValue };
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

/**
 * The same difference renderer the version-history dialog uses, at this editor's density.
 *
 * A second diff implementation would colour the same change differently on two screens.
 */
const InlineDiffView: React.FC<{ oldText: string; newText: string }> = ({ oldText, newText }) => (
  <DiffView
    oldText={oldText}
    newText={newText}
    testId="inline-diff-view"
    className="font-mono text-xs leading-relaxed"
  />
);

const PromptDetailEditor: React.FC<{
  promptType: PromptType;
  active: boolean;
  onFetchValue: McpPromptsEditorProps["onFetchValue"];
  onSave: McpPromptsEditorProps["onSave"];
  onReset: McpPromptsEditorProps["onReset"];
  onHistoryClick?: (settingsKey: string) => void;
  onFetchHistory?: (settingsKey: string) => Promise<PromptHistoryEntry[]>;
  testIdPrefix: string;
}> = ({
  promptType,
  active,
  onFetchValue,
  onSave,
  onReset,
  onHistoryClick,
  onFetchHistory,
  testIdPrefix,
}) => {
  const { t } = useTranslation();
  const [state, setState] = useState<PromptEditorState>({
    vendor: "default",
    model: null,
    value: "",
    originalValue: null,
    loading: true,
    saving: false,
    hasOverride: false,
    settingsKey: null,
    acceptedVendor: "default",
    acceptedModel: null,
    error: null,
  });
  const drafts = useRef(new Map<string, { value: string; originalValue: string | null }>());
  const beginRequest = useLatestRequest();
  const beginHistoryRequest = useLatestRequest();
  const [resetOpen, setResetOpen] = useState(false);
  const acceptedScope = useRef({ vendor: state.acceptedVendor, model: state.acceptedModel });
  acceptedScope.current = { vendor: state.acceptedVendor, model: state.acceptedModel };

  // Inline version history state
  const [historyEntries, setHistoryEntries] = useState<PromptHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyHasResult, setHistoryHasResult] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [diffMode, setDiffMode] = useState<"current" | "changes">("current");

  const testId = `${testIdPrefix}-${promptType.replace(".", "-")}`;

  // Load value when scope/model changes
  const loadValue = useCallback(
    async (vendor: Vendor, model: string | null) => {
      const isCurrent = beginRequest();
      if (vendor !== acceptedScope.current.vendor || model !== acceptedScope.current.model) {
        beginHistoryRequest();
        setHistoryEntries([]);
        setSelectedVersionId(null);
        setShowHistory(false);
        setHistoryLoading(false);
        setHistoryError(null);
        setHistoryHasResult(false);
      }
      setState((prev) => ({ ...prev, loading: true }));
      try {
        const result = await onFetchValue(promptType, vendor, model);
        if (!isCurrent()) return;
        const draft = drafts.current.get(JSON.stringify([vendor, model]));
        setState((prev) => ({
          ...prev,
          value:
            draft && draft.value !== (draft.originalValue ?? "")
              ? draft.value
              : (result.value ?? ""),
          originalValue: result.value,
          loading: false,
          hasOverride: result.value !== null,
          settingsKey: result.key,
          acceptedVendor: vendor,
          acceptedModel: model,
          error: null,
        }));
      } catch (error) {
        if (!isCurrent()) return;
        console.error("Failed to load prompt value:", error);
        setState((prev) => ({
          ...prev,
          loading: false,
          error: t("admin.settingsRegions.loadFailed"),
        }));
      }
    },
    [beginRequest, beginHistoryRequest, onFetchValue, promptType, t],
  );

  // Initial load
  useEffect(() => {
    loadValue(state.vendor, state.model);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useRefreshOnActivation(active, () => loadValue(state.vendor, state.model));

  const handleVendorChange = (newVendor: Vendor) => {
    drafts.current.set(JSON.stringify([state.acceptedVendor, state.acceptedModel]), {
      value: state.value,
      originalValue: state.originalValue,
    });
    const newModel = null;
    setState((prev) => ({
      ...prev,
      vendor: newVendor,
      model: newModel,
    }));
    loadValue(newVendor, newModel);
  };

  const handleModelChange = (newModel: string) => {
    drafts.current.set(JSON.stringify([state.acceptedVendor, state.acceptedModel]), {
      value: state.value,
      originalValue: state.originalValue,
    });
    const modelValue = newModel === "none" ? null : newModel;
    setState((prev) => ({
      ...prev,
      model: modelValue,
    }));
    loadValue(state.vendor, modelValue);
  };

  const handleSave = async () => {
    setState((prev) => ({ ...prev, saving: true }));
    try {
      const valueToSave = state.value.trim() === "" ? null : state.value;
      await onSave(promptType, state.acceptedVendor, state.acceptedModel, valueToSave);
      drafts.current.delete(JSON.stringify([state.acceptedVendor, state.acceptedModel]));
      beginHistoryRequest();
      setHistoryEntries([]);
      setSelectedVersionId(null);
      setHistoryHasResult(false);
      if (showHistory) void loadHistory();
      setState((prev) => ({
        ...prev,
        saving: false,
        originalValue: valueToSave,
        hasOverride: valueToSave !== null,
      }));
    } catch (error) {
      console.error("Failed to save prompt:", error);
      toast.error(t("admin.settingsRegions.saveFailed"));
      setState((prev) => ({ ...prev, saving: false }));
    }
  };

  const handleReset = async () => {
    setState((prev) => ({ ...prev, saving: true }));
    try {
      await onReset(promptType, state.acceptedVendor, state.acceptedModel);
      drafts.current.delete(JSON.stringify([state.acceptedVendor, state.acceptedModel]));
      beginHistoryRequest();
      setHistoryEntries([]);
      setSelectedVersionId(null);
      setHistoryHasResult(false);
      if (showHistory) void loadHistory();
      setState((prev) => ({
        ...prev,
        value: "",
        originalValue: null,
        saving: false,
        hasOverride: false,
      }));
    } catch (error) {
      console.error("Failed to reset prompt:", error);
      toast.error(t("admin.settingsRegions.resetFailed"));
      setState((prev) => ({ ...prev, saving: false }));
      throw error;
    }
  };

  // Load version history for current settings key
  const loadHistory = useCallback(async () => {
    if (!onFetchHistory || !state.settingsKey) return;
    const isCurrent = beginHistoryRequest();
    setHistoryLoading(true);
    try {
      const entries = await onFetchHistory(state.settingsKey);
      if (!isCurrent()) return;
      setHistoryEntries(entries);
      setHistoryError(null);
      setHistoryHasResult(true);
    } catch (error) {
      if (!isCurrent()) return;
      console.error("Failed to load history:", error);
      setHistoryError(t("admin.settingsRegions.loadFailed"));
    } finally {
      if (isCurrent()) setHistoryLoading(false);
    }
  }, [beginHistoryRequest, onFetchHistory, state.settingsKey, t]);

  const toggleHistory = useCallback(() => {
    if (!showHistory) {
      loadHistory();
    }
    setShowHistory((prev) => !prev);
    setSelectedVersionId(null);
  }, [showHistory, loadHistory]);

  // Get the selected version's parsed changes
  const selectedVersion = useMemo(() => {
    if (!selectedVersionId) return null;
    const entry = historyEntries.find((e) => e.id === selectedVersionId);
    if (!entry) return null;
    const changes = parseHistoryChanges(entry.changes);
    return { entry, changes };
  }, [selectedVersionId, historyEntries]);

  // Apply historical value to editor
  const handleApplyVersion = () => {
    if (!selectedVersion || selectedVersion.changes.newValue === undefined) return;
    const valueToApply = selectedVersion.changes.newValue ?? "";
    setState((prev) => ({ ...prev, value: valueToApply }));
    setShowHistory(false);
    setSelectedVersionId(null);
  };

  const hasChanges = state.value !== (state.originalValue ?? "");
  const isDefaultScope = state.acceptedVendor === "default";
  const availableModels = state.vendor !== "default" ? VENDOR_MODELS[state.vendor] : [];

  return (
    <div className="flex flex-col h-full" data-testid={testId}>
      {/* Header with title, scope/model, and status */}
      <div className="flex-shrink-0 p-4 border-b border-border space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">{t(`admin.settingsRegions.${promptType}`)}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isDefaultScope
                ? t("admin.settingsRegions.promptDefaultDescription")
                : state.acceptedModel
                  ? t("admin.settingsRegions.promptModelDescription", {
                      vendor: VENDOR_LABELS[state.acceptedVendor],
                      model: state.acceptedModel,
                    })
                  : t("admin.settingsRegions.promptAgentDescription", {
                      vendor: VENDOR_LABELS[state.acceptedVendor],
                    })}
            </p>
          </div>
          {state.hasOverride && !isDefaultScope && (
            <span className="text-xs px-2 py-1 rounded bg-primary/10 text-primary">
              {t("admin.settingsRegions.overrideActive")}
            </span>
          )}
          {!state.hasOverride && !isDefaultScope && (
            <span className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground">
              {t("admin.settingsRegions.usingFallback")}
            </span>
          )}
        </div>

        {/* Scope and Model dropdowns */}
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="text-sm text-muted-foreground mb-1 block">
              {t("admin.settingsRegions.scope")}
            </label>
            <Select
              value={state.vendor}
              onValueChange={(v) => handleVendorChange(v as Vendor)}
              disabled={state.saving}
            >
              <SelectTrigger
                data-testid={`${testId}-scope`}
                aria-label={t("admin.settingsRegions.scope")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VENDORS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {v === "default" ? t("settings.inheritance.default") : VENDOR_LABELS[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1">
            <label className="text-sm text-muted-foreground mb-1 block">
              {t("admin.settingsRegions.model")}
            </label>
            <Select
              value={state.model ?? "none"}
              onValueChange={handleModelChange}
              disabled={state.vendor === "default" || state.saving}
            >
              <SelectTrigger
                data-testid={`${testId}-model`}
                aria-label={t("admin.settingsRegions.model")}
              >
                <SelectValue
                  placeholder={
                    state.vendor === "default"
                      ? t("admin.settingsRegions.notApplicable")
                      : t("admin.settingsRegions.allModels")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("admin.settingsRegions.allModels")}</SelectItem>
                {availableModels.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      {/* Main content area — textarea + optional history diff */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Textarea */}
        <div className={cn("p-4 min-h-0", showHistory ? "h-1/2 flex-shrink-0" : "flex-1")}>
          <DataRegion
            className="flex h-full min-h-0 flex-col"
            hasResult={state.settingsKey !== null}
            pending={state.loading}
            error={state.error}
            onRetry={() => loadValue(state.vendor, state.model)}
            testId={`${testId}-region`}
          >
            <Textarea
              value={state.value}
              onChange={(e) => {
                const value = e.currentTarget.value;
                drafts.current.set(JSON.stringify([state.acceptedVendor, state.acceptedModel]), {
                  value,
                  originalValue: state.originalValue,
                });
                setState((prev) => ({ ...prev, value }));
              }}
              className="w-full flex-1 min-h-0 px-3 py-2 font-mono text-sm border border-border rounded-lg bg-background text-foreground resize-none"
              placeholder={
                isDefaultScope
                  ? t("admin.settingsRegions.defaultPlaceholder")
                  : t("admin.settingsRegions.fallbackPlaceholder")
              }
              data-testid={`${testId}-input`}
              aria-label={t(`admin.settingsRegions.${promptType}`)}
              disabled={state.saving}
            />
          </DataRegion>
        </div>

        {/* Inline version history panel */}
        {showHistory && (
          <div
            className="flex-1 min-h-0 border-t border-border flex flex-col"
            data-testid={`${testId}-version-panel`}
          >
            <div className="flex-shrink-0 flex items-center gap-3 px-4 py-2 bg-muted/50">
              <label className="text-xs font-medium text-muted-foreground">
                {t("admin.mcpPrompts.history.version")}
              </label>
              {historyLoading ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : (
                <Select
                  value={selectedVersionId ?? "none"}
                  onValueChange={(v) => setSelectedVersionId(v === "none" ? null : v)}
                >
                  <SelectTrigger
                    className="w-64 h-8 text-xs"
                    data-testid={`${testId}-version-select`}
                  >
                    <SelectValue placeholder={t("admin.mcpPrompts.history.selectVersion")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">
                      {t("admin.mcpPrompts.history.selectVersion")}
                    </SelectItem>
                    {historyEntries.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {new Date(entry.createdAt).toLocaleString()} —{" "}
                        {entry.userName ??
                          entry.userEmail ??
                          t("admin.globalSettings.history.system")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {selectedVersion && selectedVersion.changes.newValue !== undefined && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={handleApplyVersion}
                  data-testid={`${testId}-apply-version`}
                >
                  <RotateCw className="h-3 w-3 mr-1" />
                  {t("admin.mcpPrompts.history.apply")}
                </Button>
              )}
              {selectedVersion && (
                <div
                  className="flex items-center border rounded-md overflow-hidden ml-auto"
                  data-testid={`${testId}-diff-mode-toggle`}
                >
                  <button
                    type="button"
                    className={`px-2 py-1 text-xs ${diffMode === "current" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
                    onClick={() => setDiffMode("current")}
                    data-testid={`${testId}-diff-mode-current`}
                  >
                    {t("admin.mcpPrompts.history.diffCurrent")}
                  </button>
                  <button
                    type="button"
                    className={`px-2 py-1 text-xs ${diffMode === "changes" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}
                    onClick={() => setDiffMode("changes")}
                    data-testid={`${testId}-diff-mode-changes`}
                  >
                    {t("admin.mcpPrompts.history.diffChanges")}
                  </button>
                </div>
              )}
              {historyHasResult && historyEntries.length === 0 && !historyLoading && (
                <span className="text-xs text-muted-foreground">
                  {t("admin.mcpPrompts.history.noEntries")}
                </span>
              )}
            </div>
            <DataRegion
              className="flex flex-1 min-h-0 flex-col"
              hasResult={historyHasResult}
              pending={historyLoading}
              error={historyError}
              onRetry={loadHistory}
              testId={`${testId}-history-region`}
            >
              {selectedVersion && (
                <div className="flex-1 overflow-auto px-4 py-2">
                  <InlineDiffView
                    oldText={
                      diffMode === "current"
                        ? state.value
                        : (selectedVersion.changes.oldValue ?? "")
                    }
                    newText={selectedVersion.changes.newValue ?? ""}
                  />
                </div>
              )}
            </DataRegion>
          </div>
        )}
      </div>

      {/* Footer with char count and actions */}
      <div className="flex-shrink-0 flex items-center justify-between p-4 border-t border-border">
        <span className="text-xs text-muted-foreground">
          {state.value.length} {t("admin.globalSettings.characters")}
        </span>
        <div className="flex gap-2">
          {onFetchHistory && state.settingsKey && (
            <Button
              variant={showHistory ? "secondary" : "outline"}
              size="sm"
              onClick={toggleHistory}
              disabled={state.loading || state.saving}
              data-testid={`${testId}-history`}
            >
              <History className="h-4 w-4 mr-1" />
              {t("admin.mcpPrompts.history.button")}
            </Button>
          )}
          {!onFetchHistory && onHistoryClick && state.settingsKey && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onHistoryClick(state.settingsKey!)}
              disabled={state.loading || state.saving}
              data-testid={`${testId}-history`}
            >
              <History className="h-4 w-4 mr-1" />
              {t("admin.globalSettings.history.button")}
            </Button>
          )}
          {!isDefaultScope && state.hasOverride && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setResetOpen(true)}
              disabled={state.loading || state.saving}
              data-testid={`${testId}-reset`}
            >
              {state.saving ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1" />
              ) : (
                <RotateCcw className="h-4 w-4 mr-1" />
              )}
              {t("settings.reset")}
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!hasChanges || state.loading || state.saving}
            data-testid={`${testId}-save`}
          >
            {state.saving ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            {t("common.save")}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title={t("admin.globalSettings.reset.confirmTitle")}
        description={t("admin.globalSettings.reset.confirmDescription")}
        confirmLabel={t("settings.reset")}
        variant="destructive"
        onConfirm={handleReset}
      />
    </div>
  );
};

export const McpPromptsEditor: React.FC<McpPromptsEditorProps> = ({
  active = true,
  onFetchValue,
  onSave,
  onReset,
  onHistoryClick,
  onFetchHistory,
  testIdPrefix = "mcp-prompt",
}) => {
  const { t } = useTranslation();
  const [selectedPrompt, setSelectedPrompt] = useState<PromptType>("systemPrompt");
  const [visited, setVisited] = useState<PromptType[]>(["systemPrompt"]);

  return (
    <div
      className="flex flex-col sm:flex-row border border-border rounded-lg overflow-hidden min-h-[400px] h-[calc(100vh-350px)]"
      data-testid="mcp-prompts-editor"
    >
      {/* Left panel — prompt list */}
      <nav
        className="sm:w-44 flex-shrink-0 border-b sm:border-b-0 sm:border-r border-border overflow-y-auto bg-muted/30"
        data-testid="prompt-list"
      >
        <div className="p-3 space-y-4">
          <div>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-1 px-2">
              {t("admin.mcpPrompts.systemPrompts")}
            </h3>
            {PROMPT_TYPES.map((pt) => (
              <Button
                variant="ghost"
                key={pt}
                onClick={() => {
                  setSelectedPrompt(pt);
                  setVisited((current) => (current.includes(pt) ? current : [...current, pt]));
                }}
                className={cn(
                  "w-full justify-start text-left px-3 py-2 rounded-md text-sm transition-colors",
                  selectedPrompt === pt
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-foreground hover:bg-muted",
                )}
                data-testid={`prompt-item-${pt.replace(".", "-")}`}
              >
                {t(`admin.settingsRegions.${pt}`)}
              </Button>
            ))}
          </div>
        </div>
      </nav>

      {/* Right panel — full-height editor */}
      <div className="flex-1 min-w-0">
        {visited.map((promptType) => (
          <div key={promptType} hidden={selectedPrompt !== promptType} className="h-full">
            <PromptDetailEditor
              promptType={promptType}
              active={active && selectedPrompt === promptType}
              onFetchValue={onFetchValue}
              onSave={onSave}
              onReset={onReset}
              onHistoryClick={onHistoryClick}
              onFetchHistory={onFetchHistory}
              testIdPrefix={testIdPrefix}
            />
          </div>
        ))}
      </div>
    </div>
  );
};

export default McpPromptsEditor;
