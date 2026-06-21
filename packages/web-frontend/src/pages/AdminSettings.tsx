/* eslint-disable no-console */
/**
 * Global Settings Page
 * Dedicated admin interface for managing global settings VALUES (tool descriptions, prompts, etc.)
 * Located at /admin/global-settings
 *
 * Uses SettingsEditor component for unified settings editing experience.
 * Page-level features: History modal with rollback, Export/Import values
 *
 * Note: Schema management (definitions) is in SystemSettings (Settings Manager).
 * Note: console.error used for browser debugging of admin API errors
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { apiClient } from "../services/api-client";
import { formatDate } from "../components/cards/format-utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Loader2,
  AlertCircle,
  History,
  RotateCcw,
  Download,
  Upload,
  Check,
  X,
  Plus,
} from "lucide-react";
import { SettingsEditor, SettingDefinition } from "@/components/settings/SettingsEditor";
import {
  McpPromptsEditor,
  PromptType,
  Vendor,
  McpPromptFetchResult,
} from "@/components/settings/McpPromptsEditor";
import { PageShell } from "../components/PageShell";

interface GlobalSetting {
  key: string;
  value: string | null;
  type: string;
  label: string;
  description: string | null;
  category: string;
  sortOrder: number;
  updatedAt: number;
  updatedBy: string | null;
}

interface HistoryEntry {
  id: string;
  userId?: string;
  userEmail: string | null;
  userName: string | null;
  action: string;
  changes?: string;
  createdAt: number;
}

interface ParsedChanges {
  oldValue?: string | null;
  newValue?: string | null;
}

interface ExportData {
  version: string;
  exportedAt: string;
  values: Record<string, string | null>;
}

interface ImportChange {
  key: string;
  type: "overwrite" | "add" | "unchanged";
  oldValue: string | null;
  newValue: string | null;
  label?: string;
}

// Category display order and labels for non-MCP settings
// MCP categories are handled by McpPromptsEditor with dynamic scope/model selection
const CATEGORY_ORDER = ["system", "messages"];
const CATEGORY_LABELS: Record<string, string> = {
  system: "System Configuration",
  messages: "Messages & Validation",
};

// MCP categories to exclude from SettingsEditor (handled by McpPromptsEditor)
const MCP_CATEGORIES = ["mcp", "mcp-agent-prompts", "mcp-model-prompts"];

/**
 * Determines the inheritance level of a setting based on its key and value
 * Returns: "default" | "agent" | "model"
 */
const getInheritanceLevel = (
  key: string,
  value: string | null,
): "default" | "agent" | "model" | null => {
  // If value is null or empty, it's using the parent/default value
  if (value === null || value === "") {
    return null;
  }

  // Check if this is a model override key (contains .model.)
  if (key.includes(".model.")) {
    return "model";
  }

  // Check if this is an agent override key (starts with mcp.agent.)
  if (key.startsWith("mcp.agent.")) {
    return "agent";
  }

  // Default level
  return "default";
};

/**
 * Check if a setting is an override that can be reset
 */
const isOverrideSetting = (key: string): boolean => {
  return key.startsWith("mcp.agent.");
};

interface AdminSettingsProps {
  embedded?: boolean;
}

export const AdminSettings: React.FC<AdminSettingsProps> = ({ embedded = false }) => {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<GlobalSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // History modal state
  const [historySetting, setHistorySetting] = useState<GlobalSetting | null>(null);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Rollback confirmation state
  const [rollbackEntry, setRollbackEntry] = useState<{
    settingKey: string;
    oldValue: string | null;
    entryId: string;
  } | null>(null);

  // Import/Export state (values only)
  const [importPreviewOpen, setImportPreviewOpen] = useState(false);
  const [importChanges, setImportChanges] = useState<ImportChange[]>([]);
  const [importLoading, setImportLoading] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Reset confirmation state
  const [resetKey, setResetKey] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settingsData = await apiClient.getGlobalSettings();
      setSettings(settingsData.settings);
    } catch (err) {
      console.error("Failed to load global settings:", err);
      setError(t("admin.globalSettings.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  // Filter out MCP categories - they're handled by McpPromptsEditor
  const nonMcpSettings = settings.filter((s) => !MCP_CATEGORIES.includes(s.category));

  // Convert GlobalSetting to SettingDefinition for SettingsEditor (non-MCP only)
  const definitions: SettingDefinition[] = nonMcpSettings.map((s) => ({
    key: s.key,
    type: s.type as SettingDefinition["type"],
    category: s.category,
    label: s.label,
    description: s.description,
    defaultValue: null,
    required: false,
    validation: null,
    sortOrder: s.sortOrder,
  }));

  // Convert settings to values map for SettingsEditor (non-MCP only)
  const values: Record<string, unknown> = {};
  nonMcpSettings.forEach((s) => {
    values[s.key] = s.value;
  });

  // MCP Prompts Editor handlers
  const handleMcpFetchValue = useCallback(
    async (
      promptType: PromptType,
      vendor: Vendor,
      model: string | null,
    ): Promise<McpPromptFetchResult> => {
      try {
        const result = await apiClient.getMcpPromptScopeValue({
          promptType,
          vendor,
          model,
        });
        return { value: result.value, key: result.key };
      } catch (error) {
        console.error("Failed to fetch MCP prompt value:", error);
        // Return a fallback key based on the request params for history lookup
        const fallbackKey =
          vendor === "default"
            ? `mcp.${promptType}`
            : model
              ? `mcp.agent.${vendor}.model.${model}.${promptType}`
              : `mcp.agent.${vendor}.${promptType}`;
        return { value: null, key: fallbackKey };
      }
    },
    [],
  );

  const handleMcpSave = useCallback(
    async (
      promptType: PromptType,
      vendor: Vendor,
      model: string | null,
      value: string | null,
    ): Promise<void> => {
      await apiClient.setMcpPromptScopeValue({
        promptType,
        vendor,
        model,
        value,
      });
    },
    [],
  );

  const handleMcpReset = useCallback(
    async (promptType: PromptType, vendor: Vendor, model: string | null): Promise<void> => {
      await apiClient.setMcpPromptScopeValue({
        promptType,
        vendor,
        model,
        value: null,
      });
    },
    [],
  );

  // Handle save from SettingsEditor
  const handleSave = async (key: string, value: unknown) => {
    await apiClient.updateGlobalSetting(key, value as string | null);
    await loadSettings();
  };

  // Handle history button click from SettingsEditor
  const handleHistoryClick = (key: string) => {
    const setting = settings.find((s) => s.key === key);
    if (setting) {
      openHistoryModal(setting);
    }
  };

  // Handle history button click from McpPromptsEditor
  // MCP prompts may not exist in settings list (if using default/fallback)
  // so we create a minimal GlobalSetting object with the key
  const handleMcpHistoryClick = useCallback(
    (key: string) => {
      // Try to find existing setting first
      const existingSetting = settings.find((s) => s.key === key);
      if (existingSetting) {
        openHistoryModal(existingSetting);
        return;
      }

      // Create minimal setting object for history lookup
      // The key is sufficient for audit log query
      const mcpSetting: GlobalSetting = {
        key,
        value: null,
        type: "text",
        label: key.replace(/^mcp\./, "").replace(/\./g, " → "),
        description: null,
        category: "mcp",
        sortOrder: 0,
        updatedAt: Date.now(),
        updatedBy: null,
      };
      openHistoryModal(mcpSetting);
    },
    [settings],
  );

  // Fetch history entries for inline version history panel
  const handleMcpFetchHistory = useCallback(async (key: string) => {
    return await apiClient.getSettingHistory(key, 20);
  }, []);

  // Handle reset button click - opens confirmation dialog
  const handleResetClick = (key: string) => {
    setResetKey(key);
  };

  // Perform reset - set value to null
  const performReset = async () => {
    if (!resetKey) return;

    try {
      await apiClient.resetGlobalSetting(resetKey);
      await loadSettings();
    } catch (err) {
      console.error("Failed to reset setting:", err);
      throw err;
    }
  };

  const closeResetConfirmation = () => {
    setResetKey(null);
  };

  // Helper function for inheritance level
  const handleGetInheritanceLevel = (key: string, value: unknown) => {
    return getInheritanceLevel(key, value as string | null);
  };

  const openHistoryModal = async (setting: GlobalSetting) => {
    setHistorySetting(setting);
    setHistoryLoading(true);
    setHistoryEntries([]);

    try {
      const entries = await apiClient.getSettingHistory(setting.key, 20);
      setHistoryEntries(entries);
    } catch (err) {
      console.error("Failed to load setting history:", err);
    } finally {
      setHistoryLoading(false);
    }
  };

  const closeHistoryModal = () => {
    setHistorySetting(null);
    setHistoryEntries([]);
  };

  const parseChanges = (changesJson?: string): ParsedChanges => {
    if (!changesJson) return {};
    try {
      const parsed = JSON.parse(changesJson);
      // Changes are stored as array: [{field, oldValue, newValue}]
      // Extract the value change
      if (Array.isArray(parsed)) {
        const valueChange = parsed.find(
          (c: { field?: string; oldValue?: string | null; newValue?: string | null }) =>
            c.field === "value",
        );
        if (valueChange) {
          return {
            oldValue: valueChange.oldValue,
            newValue: valueChange.newValue,
          };
        }
      }
      // Fallback for direct object format
      return parsed;
    } catch {
      return {};
    }
  };

  const truncateValue = (value: string | null | undefined, maxLength = 100): string => {
    if (!value) return t("admin.globalSettings.history.emptyValue");
    if (value.length <= maxLength) return value;
    return value.substring(0, maxLength) + "...";
  };

  const openRollbackConfirmation = (
    settingKey: string,
    oldValue: string | null,
    entryId: string,
  ) => {
    setRollbackEntry({ settingKey, oldValue, entryId });
  };

  const closeRollbackConfirmation = () => {
    setRollbackEntry(null);
  };

  const performRollback = async () => {
    if (!rollbackEntry) return;

    try {
      await apiClient.updateGlobalSetting(rollbackEntry.settingKey, rollbackEntry.oldValue);
      await loadSettings();
      closeHistoryModal();
    } catch (err) {
      console.error("Failed to rollback setting:", err);
      throw err;
    }
  };

  // Export settings via API (includes audit logging)
  const handleExport = async () => {
    setExportLoading(true);
    try {
      const apiExportData = await apiClient.exportGlobalSettings();

      // Transform to expected format for download
      const exportData: ExportData = {
        version: apiExportData.version,
        exportedAt: apiExportData.exportedAt,
        values: {},
      };

      apiExportData.settings.forEach((setting) => {
        exportData.values[setting.key] = setting.value;
      });

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `moira-settings-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to export settings:", err);
    } finally {
      setExportLoading(false);
    }
  };

  // Trigger file input for import
  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  // Process imported file
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text) as ExportData;

      if (!data.values || typeof data.values !== "object") {
        console.error("Invalid import file format: missing values");
        return;
      }

      // Build settings map for quick lookup
      const settingsMap = new Map<string, GlobalSetting>();
      settings.forEach((s) => settingsMap.set(s.key, s));

      // Analyze changes
      const changes: ImportChange[] = [];

      // Check imported values
      Object.entries(data.values).forEach(([key, newValue]) => {
        const existingSetting = settingsMap.get(key);
        if (existingSetting) {
          const oldValue = existingSetting.value;
          if (oldValue !== newValue) {
            changes.push({
              key,
              type: "overwrite",
              oldValue,
              newValue: newValue ?? null,
              label: existingSetting.label,
            });
          } else {
            changes.push({
              key,
              type: "unchanged",
              oldValue,
              newValue: newValue ?? null,
              label: existingSetting.label,
            });
          }
        } else {
          // Key doesn't exist in current settings - will be added if definition exists
          changes.push({
            key,
            type: "add",
            oldValue: null,
            newValue: newValue ?? null,
          });
        }
      });

      // Sort: overwrite first, then add, then unchanged
      changes.sort((a, b) => {
        const order = { overwrite: 0, add: 1, unchanged: 2 };
        return order[a.type] - order[b.type];
      });

      setImportChanges(changes);
      setImportPreviewOpen(true);
    } catch (err) {
      console.error("Failed to parse import file:", err);
    } finally {
      // Reset file input so same file can be selected again
      event.target.value = "";
    }
  };

  // Apply imported changes
  const performImport = async () => {
    setImportLoading(true);
    try {
      const changesToApply = importChanges.filter((c) => c.type !== "unchanged");

      for (const change of changesToApply) {
        // Only update existing settings (add requires definition)
        if (change.type === "overwrite") {
          await apiClient.updateGlobalSetting(change.key, change.newValue);
        }
        // Skip "add" type - can't add without definition
      }

      await loadSettings();
      setImportPreviewOpen(false);
      setImportChanges([]);
    } catch (err) {
      console.error("Failed to import settings:", err);
    } finally {
      setImportLoading(false);
    }
  };

  const closeImportPreview = () => {
    setImportPreviewOpen(false);
    setImportChanges([]);
  };

  if (loading) {
    if (embedded) {
      return (
        <div className="py-8 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      );
    }
    return <PageShell title={t("admin.globalSettings.title")} loading />;
  }

  if (error) {
    if (embedded) {
      return (
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
            <Button onClick={loadSettings} className="mt-4">
              {t("admin.globalSettings.retry")}
            </Button>
          </CardContent>
        </Card>
      );
    }
    return (
      <PageShell title={t("admin.globalSettings.title")} error={error} onRetry={loadSettings} />
    );
  }

  const content = (
    <>
      {!embedded && (
        <div className="mb-6 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={handleExport}
            disabled={exportLoading || settings.length === 0}
            data-testid="export-settings"
          >
            {exportLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            {t("admin.globalSettings.export.button")}
          </Button>
          <Button
            variant="outline"
            onClick={handleImportClick}
            disabled={settings.length === 0}
            data-testid="import-settings"
          >
            <Upload className="h-4 w-4 mr-2" />
            {t("admin.globalSettings.import.button")}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileChange}
            className="hidden"
            data-testid="import-file-input"
          />
        </div>
      )}
      {embedded && (
        <div className="flex gap-2 mb-6">
          <Button
            variant="outline"
            onClick={handleExport}
            disabled={exportLoading || settings.length === 0}
            data-testid="export-settings"
          >
            {exportLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            {t("admin.globalSettings.export.button")}
          </Button>
          <Button
            variant="outline"
            onClick={handleImportClick}
            disabled={settings.length === 0}
            data-testid="import-settings"
          >
            <Upload className="h-4 w-4 mr-2" />
            {t("admin.globalSettings.import.button")}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileChange}
            className="hidden"
            data-testid="import-file-input"
          />
        </div>
      )}

      {settings.length === 0 ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-muted-foreground">{t("admin.globalSettings.noSettings")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          {/* MCP Prompts - Dynamic Editor with Scope/Model Selection */}
          <div>
            <h2 className="text-xl font-semibold mb-4">{t("admin.mcpPrompts.title")}</h2>
            <details className="mb-4">
              <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
                {t("admin.mcpPrompts.howItWorks")}
              </summary>
              <div className="mt-2 p-4 bg-muted rounded-lg text-sm">
                <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                  <li>{t("admin.mcpPrompts.hint1")}</li>
                  <li>{t("admin.mcpPrompts.hint2")}</li>
                  <li>{t("admin.mcpPrompts.hint3")}</li>
                </ul>
              </div>
            </details>
            <McpPromptsEditor
              onFetchValue={handleMcpFetchValue}
              onSave={handleMcpSave}
              onReset={handleMcpReset}
              onHistoryClick={handleMcpHistoryClick}
              onFetchHistory={handleMcpFetchHistory}
              testIdPrefix="mcp-prompt"
            />
          </div>

          {/* Other Settings - Traditional Collapsible Categories */}
          {nonMcpSettings.length > 0 && (
            <div>
              <h2 className="text-xl font-semibold mb-4">
                {t("admin.globalSettings.otherSettings")}
              </h2>
              <SettingsEditor
                definitions={definitions}
                values={values}
                categoryLabels={CATEGORY_LABELS}
                onSave={handleSave}
                loading={loading}
                categorySortOrder={CATEGORY_ORDER}
                enableFullscreenEdit={true}
                testIdPrefix="setting"
                onHistoryClick={handleHistoryClick}
                showCharacterCount={true}
                getInheritanceLevel={handleGetInheritanceLevel}
                onResetClick={handleResetClick}
                canReset={isOverrideSetting}
              />
            </div>
          )}
        </div>
      )}

      {/* Reset Confirmation Dialog */}
      <ConfirmDialog
        open={!!resetKey}
        onOpenChange={(open) => !open && closeResetConfirmation()}
        title={t("admin.globalSettings.reset.confirmTitle")}
        description={
          <>
            {t("admin.globalSettings.reset.confirmDescription")}
            <div className="mt-4 p-3 bg-muted rounded-lg">
              <span className="text-sm font-medium">{t("admin.globalSettings.reset.key")}:</span>
              <code className="block mt-1 text-xs break-all">{resetKey}</code>
            </div>
          </>
        }
        confirmLabel={t("admin.globalSettings.reset.confirmButton")}
        cancelLabel={t("admin.globalSettings.cancel")}
        variant="destructive"
        onConfirm={performReset}
      />

      {/* History Modal */}
      <Dialog open={!!historySetting} onOpenChange={(open) => !open && closeHistoryModal()}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              <History className="h-5 w-5 inline mr-2" />
              {t("admin.globalSettings.history.title")}
            </DialogTitle>
            <DialogDescription>
              {historySetting?.label}
              <br />
              <span className="text-xs">
                Key: <code className="bg-muted px-1 rounded">{historySetting?.key}</code>
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto" data-testid="history-list">
            {historyLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : historyEntries.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                {t("admin.globalSettings.history.noHistory")}
              </div>
            ) : (
              <div className="space-y-4">
                {historyEntries.map((entry, index) => {
                  const changes = parseChanges(entry.changes);
                  const canRollback = index > 0 && changes.oldValue !== undefined;

                  return (
                    <div
                      key={entry.id}
                      className="border rounded-lg p-4"
                      data-testid={`history-entry-${entry.id}`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <span className="font-medium">
                            {entry.userName ||
                              entry.userEmail ||
                              t("admin.globalSettings.history.system")}
                          </span>
                          <span className="text-sm text-muted-foreground ml-2">
                            {formatDate(entry.createdAt)}
                          </span>
                        </div>
                        {canRollback && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              openRollbackConfirmation(
                                historySetting!.key,
                                changes.oldValue ?? null,
                                entry.id,
                              )
                            }
                            data-testid={`rollback-${entry.id}`}
                          >
                            <RotateCcw className="h-4 w-4 mr-1" />
                            {t("admin.globalSettings.history.rollback")}
                          </Button>
                        )}
                      </div>
                      <div className="text-sm space-y-2">
                        {changes.oldValue !== undefined && (
                          <div>
                            <span className="text-muted-foreground">
                              {t("admin.globalSettings.history.oldValue")}:{" "}
                            </span>
                            <code className="bg-destructive/10 px-1 rounded text-xs">
                              {truncateValue(changes.oldValue)}
                            </code>
                          </div>
                        )}
                        {changes.newValue !== undefined && (
                          <div>
                            <span className="text-muted-foreground">
                              {t("admin.globalSettings.history.newValue")}:{" "}
                            </span>
                            <code className="bg-success/10 px-1 rounded text-xs">
                              {truncateValue(changes.newValue)}
                            </code>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeHistoryModal}>
              {t("admin.globalSettings.history.close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rollback Confirmation Dialog */}
      <ConfirmDialog
        open={!!rollbackEntry}
        onOpenChange={(open) => !open && closeRollbackConfirmation()}
        title={t("admin.globalSettings.history.confirmRollback")}
        description={
          <>
            {t("admin.globalSettings.history.rollbackWarning")}
            <div className="mt-4 p-3 bg-muted rounded-lg">
              <span className="text-sm font-medium">
                {t("admin.globalSettings.history.restoreTo")}:
              </span>
              <code className="block mt-1 text-xs break-all">
                {truncateValue(rollbackEntry?.oldValue, 200)}
              </code>
            </div>
          </>
        }
        confirmLabel={t("admin.globalSettings.history.confirmRollbackButton")}
        cancelLabel={t("admin.globalSettings.cancel")}
        variant="destructive"
        onConfirm={performRollback}
      />

      {/* Import Preview Modal */}
      <Dialog open={importPreviewOpen} onOpenChange={(open) => !open && closeImportPreview()}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              <Upload className="h-5 w-5 inline mr-2" />
              {t("admin.globalSettings.import.previewTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("admin.globalSettings.import.previewDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto" data-testid="import-preview-list">
            {importChanges.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                {t("admin.globalSettings.import.noChanges")}
              </div>
            ) : (
              <div className="space-y-3">
                {importChanges.map((change) => (
                  <div
                    key={change.key}
                    className={`border rounded-lg p-3 ${
                      change.type === "overwrite"
                        ? "border-warning/30 bg-warning/10"
                        : change.type === "add"
                          ? "border-success/30 bg-success/10"
                          : "border-border opacity-60"
                    }`}
                    data-testid={`import-change-${change.key}`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      {change.type === "overwrite" && (
                        <span className="text-warning">
                          <RotateCcw className="h-4 w-4" />
                        </span>
                      )}
                      {change.type === "add" && (
                        <span className="text-success">
                          <Plus className="h-4 w-4" />
                        </span>
                      )}
                      {change.type === "unchanged" && (
                        <span className="text-muted-foreground">
                          <Check className="h-4 w-4" />
                        </span>
                      )}
                      <span className="font-medium">{change.label || change.key}</span>
                      <span className="text-xs px-2 py-0.5 rounded bg-muted">
                        {t(`admin.globalSettings.import.type.${change.type}`)}
                      </span>
                    </div>
                    {change.type !== "unchanged" && (
                      <div className="text-xs space-y-1">
                        {change.type === "overwrite" && (
                          <div className="flex gap-2">
                            <span className="text-muted-foreground min-w-16">
                              {t("admin.globalSettings.history.oldValue")}:
                            </span>
                            <code className="bg-destructive/10 px-1 rounded truncate max-w-md">
                              {truncateValue(change.oldValue, 60)}
                            </code>
                          </div>
                        )}
                        <div className="flex gap-2">
                          <span className="text-muted-foreground min-w-16">
                            {t("admin.globalSettings.history.newValue")}:
                          </span>
                          <code className="bg-success/10 px-1 rounded truncate max-w-md">
                            {truncateValue(change.newValue, 60)}
                          </code>
                        </div>
                      </div>
                    )}
                    {change.type === "add" && (
                      <div className="text-xs text-muted-foreground mt-1">
                        <X className="h-3 w-3 inline mr-1" />
                        {t("admin.globalSettings.import.addSkipped")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {importChanges.filter((c) => c.type === "overwrite").length}{" "}
              {t("admin.globalSettings.import.willOverwrite")}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={closeImportPreview} disabled={importLoading}>
                {t("admin.globalSettings.cancel")}
              </Button>
              <Button
                onClick={performImport}
                disabled={
                  importLoading || importChanges.filter((c) => c.type === "overwrite").length === 0
                }
                data-testid="import-confirm"
              >
                {importLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <Upload className="h-4 w-4 mr-1" />
                )}
                {t("admin.globalSettings.import.confirm")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) return content;
  return <PageShell title={t("admin.globalSettings.title")}>{content}</PageShell>;
};
