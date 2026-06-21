/* eslint-disable no-console */
/**
 * McpPromptsEditor - Master-detail MCP prompt editor with scope/model selection
 *
 * Layout: Left panel with clickable prompt list, right panel with full-height editor.
 * Features:
 * - 10 prompts (systemPrompt, systemReminder, 8 tool descriptions)
 * - Each prompt has Scope dropdown (Default/Claude/ChatGPT/Gemini/Cursor)
 * - Model dropdown (disabled when Default, populated with vendor-specific models)
 * - Dynamic loading of values based on scope/model selection
 * - Save/Reset buttons per prompt
 *
 * Note: console.error used for browser debugging of API errors
 */

import React, { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { diffLines, type Change } from "diff";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2, Save, RotateCcw, History, RotateCw } from "lucide-react";
import { cn } from "@/lib/utils";

// Prompt types
export const PROMPT_TYPES = [
  "systemPrompt",
  "systemReminder",
  "toolDescription.list",
  "toolDescription.start",
  "toolDescription.step",
  "toolDescription.manage",
  "toolDescription.help",
  "toolDescription.settings",
  "toolDescription.session",
  "toolDescription.token",
] as const;

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
  "toolDescription.list": "Tool: list",
  "toolDescription.start": "Tool: start",
  "toolDescription.step": "Tool: step",
  "toolDescription.manage": "Tool: manage",
  "toolDescription.help": "Tool: help",
  "toolDescription.settings": "Tool: settings",
  "toolDescription.session": "Tool: session",
  "toolDescription.token": "Tool: token",
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

/** Inline diff view showing line-by-line changes */
const InlineDiffView: React.FC<{ oldText: string; newText: string }> = ({ oldText, newText }) => {
  const changes = useMemo(() => diffLines(oldText, newText), [oldText, newText]);

  return (
    <div className="font-mono text-xs leading-relaxed" data-testid="inline-diff-view">
      {changes.map((change: Change, i: number) => {
        const lines = change.value.split("\n");
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
            <span className="select-none inline-block w-4 mr-1 text-muted-foreground/50">
              {change.added ? "+" : change.removed ? "−" : " "}
            </span>
            {line || " "}
          </div>
        ));
      })}
    </div>
  );
};

const PromptDetailEditor: React.FC<{
  promptType: PromptType;
  onFetchValue: McpPromptsEditorProps["onFetchValue"];
  onSave: McpPromptsEditorProps["onSave"];
  onReset: McpPromptsEditorProps["onReset"];
  onHistoryClick?: (settingsKey: string) => void;
  onFetchHistory?: (settingsKey: string) => Promise<PromptHistoryEntry[]>;
  testIdPrefix: string;
}> = ({
  promptType,
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
  });

  // Inline version history state
  const [historyEntries, setHistoryEntries] = useState<PromptHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [diffMode, setDiffMode] = useState<"current" | "changes">("current");

  const testId = `${testIdPrefix}-${promptType.replace(".", "-")}`;

  // Load value when scope/model changes
  const loadValue = useCallback(
    async (vendor: Vendor, model: string | null) => {
      setState((prev) => ({ ...prev, loading: true }));
      try {
        const result = await onFetchValue(promptType, vendor, model);
        setState((prev) => ({
          ...prev,
          value: result.value ?? "",
          originalValue: result.value,
          loading: false,
          hasOverride: result.value !== null,
          settingsKey: result.key,
        }));
      } catch (error) {
        console.error("Failed to load prompt value:", error);
        setState((prev) => ({
          ...prev,
          value: "",
          originalValue: null,
          loading: false,
          hasOverride: false,
          settingsKey: null,
        }));
      }
    },
    [onFetchValue, promptType],
  );

  // Initial load
  useEffect(() => {
    loadValue(state.vendor, state.model);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleVendorChange = (newVendor: Vendor) => {
    const newModel = null;
    setState((prev) => ({
      ...prev,
      vendor: newVendor,
      model: newModel,
    }));
    loadValue(newVendor, newModel);
  };

  const handleModelChange = (newModel: string) => {
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
      await onSave(promptType, state.vendor, state.model, valueToSave);
      setState((prev) => ({
        ...prev,
        saving: false,
        originalValue: valueToSave,
        hasOverride: valueToSave !== null,
      }));
    } catch (error) {
      console.error("Failed to save prompt:", error);
      setState((prev) => ({ ...prev, saving: false }));
    }
  };

  const handleReset = async () => {
    setState((prev) => ({ ...prev, saving: true }));
    try {
      await onReset(promptType, state.vendor, state.model);
      setState((prev) => ({
        ...prev,
        value: "",
        originalValue: null,
        saving: false,
        hasOverride: false,
      }));
    } catch (error) {
      console.error("Failed to reset prompt:", error);
      setState((prev) => ({ ...prev, saving: false }));
    }
  };

  // Load version history for current settings key
  const loadHistory = useCallback(async () => {
    if (!onFetchHistory || !state.settingsKey) return;
    setHistoryLoading(true);
    try {
      const entries = await onFetchHistory(state.settingsKey);
      setHistoryEntries(entries);
    } catch (error) {
      console.error("Failed to load history:", error);
      setHistoryEntries([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [onFetchHistory, state.settingsKey]);

  const toggleHistory = useCallback(() => {
    if (!showHistory && historyEntries.length === 0) {
      loadHistory();
    }
    setShowHistory((prev) => !prev);
    setSelectedVersionId(null);
  }, [showHistory, historyEntries.length, loadHistory]);

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
    if (selectedVersion?.changes.newValue == null) return;
    const valueToApply = selectedVersion.changes.newValue ?? "";
    setState((prev) => ({ ...prev, value: valueToApply }));
    setShowHistory(false);
    setSelectedVersionId(null);
  };

  const hasChanges = state.value !== (state.originalValue ?? "");
  const isDefaultScope = state.vendor === "default";
  const availableModels = !isDefaultScope ? VENDOR_MODELS[state.vendor] : [];

  return (
    <div className="flex flex-col h-full" data-testid={testId}>
      {/* Header with title, scope/model, and status */}
      <div className="flex-shrink-0 p-4 border-b border-border space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-base font-semibold">{PROMPT_LABELS[promptType]}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isDefaultScope
                ? "Default prompt used by all agents"
                : state.model
                  ? `Override for ${VENDOR_LABELS[state.vendor]} / ${state.model}`
                  : `Override for all ${VENDOR_LABELS[state.vendor]} models`}
            </p>
          </div>
          {state.hasOverride && !isDefaultScope && (
            <span className="text-xs px-2 py-1 rounded bg-primary/10 text-primary">
              Override Active
            </span>
          )}
          {!state.hasOverride && !isDefaultScope && (
            <span className="text-xs px-2 py-1 rounded bg-muted text-muted-foreground">
              Using Fallback
            </span>
          )}
        </div>

        {/* Scope and Model dropdowns */}
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="text-sm text-muted-foreground mb-1 block">Scope</label>
            <Select
              value={state.vendor}
              onValueChange={(v) => handleVendorChange(v as Vendor)}
              disabled={state.loading || state.saving}
            >
              <SelectTrigger data-testid={`${testId}-scope`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {VENDORS.map((v) => (
                  <SelectItem key={v} value={v}>
                    {VENDOR_LABELS[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1">
            <label className="text-sm text-muted-foreground mb-1 block">Model</label>
            <Select
              value={state.model ?? "none"}
              onValueChange={handleModelChange}
              disabled={isDefaultScope || state.loading || state.saving}
            >
              <SelectTrigger data-testid={`${testId}-model`}>
                <SelectValue placeholder={isDefaultScope ? "(N/A)" : "All models"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">All models</SelectItem>
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
          {state.loading ? (
            <div className="h-full flex items-center justify-center bg-muted rounded-lg">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <textarea
              value={state.value}
              onChange={(e) => setState((prev) => ({ ...prev, value: e.target.value }))}
              className="w-full h-full px-3 py-2 font-mono text-sm border border-border rounded-lg bg-background text-foreground resize-none"
              placeholder={
                isDefaultScope ? "Enter default prompt..." : "Leave empty to use fallback..."
              }
              data-testid={`${testId}-input`}
              disabled={state.saving}
            />
          )}
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
                        {entry.userName ?? entry.userEmail ?? "system"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {selectedVersion && selectedVersion.changes.newValue != null && (
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
              {historyEntries.length === 0 && !historyLoading && (
                <span className="text-xs text-muted-foreground">
                  {t("admin.mcpPrompts.history.noEntries")}
                </span>
              )}
            </div>
            {selectedVersion && (
              <div className="flex-1 overflow-auto px-4 py-2">
                <InlineDiffView
                  oldText={
                    diffMode === "current" ? state.value : (selectedVersion.changes.oldValue ?? "")
                  }
                  newText={selectedVersion.changes.newValue ?? ""}
                />
              </div>
            )}
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
              onClick={handleReset}
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
    </div>
  );
};

const SYSTEM_PROMPTS = PROMPT_TYPES.filter(
  (pt) => pt === "systemPrompt" || pt === "systemReminder",
);
const TOOL_PROMPTS = PROMPT_TYPES.filter((pt) => pt.startsWith("toolDescription."));

export const McpPromptsEditor: React.FC<McpPromptsEditorProps> = ({
  onFetchValue,
  onSave,
  onReset,
  onHistoryClick,
  onFetchHistory,
  testIdPrefix = "mcp-prompt",
}) => {
  const { t } = useTranslation();
  const [selectedPrompt, setSelectedPrompt] = useState<PromptType>("systemPrompt");

  return (
    <div
      className="flex border border-border rounded-lg overflow-hidden min-h-[400px] h-[calc(100vh-350px)]"
      data-testid="mcp-prompts-editor"
    >
      {/* Left panel — prompt list */}
      <nav
        className="w-56 flex-shrink-0 border-r border-border overflow-y-auto bg-muted/30"
        data-testid="prompt-list"
      >
        <div className="p-3 space-y-4">
          <div>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-1 px-2">
              {t("admin.mcpPrompts.systemPrompts")}
            </h3>
            {SYSTEM_PROMPTS.map((pt) => (
              <button
                key={pt}
                onClick={() => setSelectedPrompt(pt)}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                  selectedPrompt === pt
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-foreground hover:bg-muted",
                )}
                data-testid={`prompt-item-${pt.replace(".", "-")}`}
              >
                {PROMPT_LABELS[pt]}
              </button>
            ))}
          </div>
          <div>
            <h3 className="text-xs font-semibold uppercase text-muted-foreground mb-1 px-2">
              {t("admin.mcpPrompts.toolDescriptions")}
            </h3>
            {TOOL_PROMPTS.map((pt) => (
              <button
                key={pt}
                onClick={() => setSelectedPrompt(pt)}
                className={cn(
                  "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                  selectedPrompt === pt
                    ? "bg-primary text-primary-foreground font-medium"
                    : "text-foreground hover:bg-muted",
                )}
                data-testid={`prompt-item-${pt.replace(".", "-")}`}
              >
                {PROMPT_LABELS[pt]}
              </button>
            ))}
          </div>
        </div>
      </nav>

      {/* Right panel — full-height editor */}
      <div className="flex-1 min-w-0">
        <PromptDetailEditor
          key={selectedPrompt}
          promptType={selectedPrompt}
          onFetchValue={onFetchValue}
          onSave={onSave}
          onReset={onReset}
          onHistoryClick={onHistoryClick}
          onFetchHistory={onFetchHistory}
          testIdPrefix={testIdPrefix}
        />
      </div>
    </div>
  );
};

export default McpPromptsEditor;
