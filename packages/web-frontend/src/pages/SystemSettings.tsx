/**
 * System Settings Page
 * Admin panel for managing setting definitions (schema) at /admin/settings
 * Includes: definition CRUD, schema export/import, database maintenance
 */

import React, { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "../services/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Download, FileCode, Plus, RotateCcw, Check, AlertTriangle } from "lucide-react";

/**
 * Standalone Maintenance section (vacuum, backup)
 * Extracted to allow rendering in a separate tab in AdminSettingsUnified
 */
export const MaintenanceContent: React.FC = () => {
  const { t } = useTranslation();
  const [vacuumDialogOpen, setVacuumDialogOpen] = useState(false);
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);

  const confirmVacuum = async () => {
    try {
      await apiClient.vacuumDatabase();
      toast.success(t("admin.systemSettings.dbMaintenance.vacuum.success"));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : undefined;
      toast.error(message || t("admin.systemSettings.dbMaintenance.vacuum.error"));
      throw err;
    }
  };

  const confirmBackup = async () => {
    try {
      const blob = await apiClient.downloadDatabaseBackup();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `moira-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : undefined;
      toast.error(message || t("admin.systemSettings.dbMaintenance.backup.error"));
      throw err;
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("admin.systemSettings.dbMaintenance.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <h3 className="font-medium text-foreground">
                {t("admin.systemSettings.dbMaintenance.vacuum.title")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("admin.systemSettings.dbMaintenance.vacuum.description")}
              </p>
            </div>
            <Button variant="outline" onClick={() => setVacuumDialogOpen(true)}>
              {t("admin.systemSettings.dbMaintenance.vacuum.button")}
            </Button>
          </div>
          <div className="flex items-start gap-4">
            <div className="flex-1">
              <h3 className="font-medium text-foreground">
                {t("admin.systemSettings.dbMaintenance.backup.title")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("admin.systemSettings.dbMaintenance.backup.description")}
              </p>
            </div>
            <Button variant="outline" onClick={() => setBackupDialogOpen(true)}>
              {t("admin.systemSettings.dbMaintenance.backup.button")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={vacuumDialogOpen}
        onOpenChange={setVacuumDialogOpen}
        title={t("admin.systemSettings.dbMaintenance.vacuum.title")}
        description={t("admin.systemSettings.dbMaintenance.vacuum.confirm")}
        confirmLabel={t("admin.systemSettings.dbMaintenance.vacuum.button")}
        onConfirm={confirmVacuum}
      />

      <ConfirmDialog
        open={backupDialogOpen}
        onOpenChange={setBackupDialogOpen}
        title={t("admin.systemSettings.dbMaintenance.backup.title")}
        description={t("admin.systemSettings.dbMaintenance.backup.confirm")}
        confirmLabel={t("admin.systemSettings.dbMaintenance.backup.button")}
        onConfirm={confirmBackup}
      />
    </>
  );
};

interface SettingDefinition {
  key: string;
  type: string;
  category: string;
  label: string;
  description: string | null;
  defaultValue: string | null;
  required: boolean;
  validation: string | null;
  adminOnly: boolean;
  protected?: boolean;
}

interface SchemaExportData {
  version: string;
  exportedAt: string;
  definitions: Array<{
    key: string;
    type: string;
    category: string;
    label: string;
    description: string | null;
    defaultValue: string | null;
    adminOnly: boolean;
  }>;
}

interface SchemaImportChange {
  key: string;
  type: "new" | "changed" | "type_changed" | "unchanged";
  changes: string[];
  oldDefinition?: SettingDefinition;
  newDefinition: {
    key: string;
    type: string;
    category: string;
    label: string;
    description: string | null;
    defaultValue: string | null;
    adminOnly: boolean;
  };
}

interface SystemSettingsProps {
  embedded?: boolean;
  hideMaintenance?: boolean;
}

export const SystemSettings: React.FC<SystemSettingsProps> = ({
  embedded = false,
  hideMaintenance = false,
}) => {
  const { t } = useTranslation();
  const [definitions, setDefinitions] = useState<SettingDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [formData, setFormData] = useState<Partial<SettingDefinition>>({});

  // Confirmation dialog state
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; settingKey?: string }>({
    open: false,
  });

  // Schema Import/Export state
  const [schemaImportPreviewOpen, setSchemaImportPreviewOpen] = useState(false);
  const [schemaImportChanges, setSchemaImportChanges] = useState<SchemaImportChange[]>([]);
  const [schemaImportLoading, setSchemaImportLoading] = useState(false);
  const [schemaExportLoading, setSchemaExportLoading] = useState(false);
  const [schemaTypeChangeConfirmed, setSchemaTypeChangeConfirmed] = useState(false);
  const schemaFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadDefinitions();
  }, []);

  const loadDefinitions = async () => {
    setLoading(true);
    try {
      const defs = await apiClient.getSettingDefinitions();
      setDefinitions(defs);
    } catch {
      toast.error("Failed to load setting definitions");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDefinition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.key || !formData.type || !formData.category || !formData.label) {
      toast.error(t("admin.systemSettings.fillRequired"));
      return;
    }
    try {
      interface SettingDefPayload {
        key: string;
        type: string;
        category: string;
        label: string;
        description?: string;
        defaultValue?: string;
        required?: boolean;
        validation?: string;
        adminOnly?: boolean;
      }
      await apiClient.createSettingDefinition(formData as SettingDefPayload);
      setFormData({});
      await loadDefinitions();
    } catch {
      toast.error("Failed to create definition");
    }
  };

  const handleDeleteDefinition = (key: string) => {
    setDeleteDialog({ open: true, settingKey: key });
  };

  const confirmDelete = async () => {
    if (!deleteDialog.settingKey) return;
    try {
      await apiClient.deleteSettingDefinition(deleteDialog.settingKey);
      await loadDefinitions();
    } catch {
      toast.error("Failed to delete definition");
      throw new Error("delete failed");
    }
  };

  // Schema Export - export all definitions via API (includes audit logging)
  const handleSchemaExport = async () => {
    setSchemaExportLoading(true);
    try {
      const exportData = await apiClient.exportSettingDefinitions();

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `moira-schema-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Failed to export schema");
    } finally {
      setSchemaExportLoading(false);
    }
  };

  // Trigger file input for schema import
  const handleSchemaImportClick = () => {
    schemaFileInputRef.current?.click();
  };

  // Process imported schema file
  const handleSchemaFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text) as SchemaExportData;

      if (!data.definitions || !Array.isArray(data.definitions)) {
        toast.error("Invalid schema file format: missing definitions");
        return;
      }

      // Build definitions map for quick lookup
      const definitionsMap = new Map<string, SettingDefinition>();
      definitions.forEach((d) => definitionsMap.set(d.key, d));

      // Analyze changes
      const changes: SchemaImportChange[] = [];

      data.definitions.forEach((newDef) => {
        const existingDef = definitionsMap.get(newDef.key);

        if (!existingDef) {
          // New definition
          changes.push({
            key: newDef.key,
            type: "new",
            changes: ["New definition"],
            newDefinition: newDef,
          });
        } else {
          // Compare fields
          const changedFields: string[] = [];
          let hasTypeChange = false;

          if (existingDef.type !== newDef.type) {
            changedFields.push(`type: ${existingDef.type} → ${newDef.type}`);
            hasTypeChange = true;
          }
          if (existingDef.category !== newDef.category) {
            changedFields.push(`category: ${existingDef.category} → ${newDef.category}`);
          }
          if (existingDef.label !== newDef.label) {
            changedFields.push(`label changed`);
          }
          if (existingDef.description !== newDef.description) {
            changedFields.push(`description changed`);
          }
          if (existingDef.defaultValue !== newDef.defaultValue) {
            changedFields.push(`defaultValue changed`);
          }
          if (existingDef.adminOnly !== newDef.adminOnly) {
            changedFields.push(`adminOnly: ${existingDef.adminOnly} → ${newDef.adminOnly}`);
          }

          if (changedFields.length > 0) {
            changes.push({
              key: newDef.key,
              type: hasTypeChange ? "type_changed" : "changed",
              changes: changedFields,
              oldDefinition: existingDef,
              newDefinition: newDef,
            });
          } else {
            changes.push({
              key: newDef.key,
              type: "unchanged",
              changes: [],
              oldDefinition: existingDef,
              newDefinition: newDef,
            });
          }
        }
      });

      // Sort: type_changed first (most important), then new, changed, unchanged
      changes.sort((a, b) => {
        const order = { type_changed: 0, new: 1, changed: 2, unchanged: 3 };
        return order[a.type] - order[b.type];
      });

      setSchemaImportChanges(changes);
      setSchemaTypeChangeConfirmed(false);
      setSchemaImportPreviewOpen(true);
    } catch {
      toast.error("Failed to parse schema file");
    } finally {
      event.target.value = "";
    }
  };

  // Apply imported schema changes
  const performSchemaImport = async () => {
    setSchemaImportLoading(true);
    try {
      const changesToApply = schemaImportChanges.filter((c) => c.type !== "unchanged");

      for (const change of changesToApply) {
        if (change.type === "new") {
          await apiClient.createSettingDefinition(change.newDefinition);
        } else if (change.type === "changed" || change.type === "type_changed") {
          await apiClient.updateSettingDefinition(change.key, change.newDefinition);
        }
      }

      await loadDefinitions();
      setSchemaImportPreviewOpen(false);
      setSchemaImportChanges([]);
      setSchemaTypeChangeConfirmed(false);
    } catch {
      toast.error("Failed to import schema");
    } finally {
      setSchemaImportLoading(false);
    }
  };

  const closeSchemaImportPreview = () => {
    setSchemaImportPreviewOpen(false);
    setSchemaImportChanges([]);
    setSchemaTypeChangeConfirmed(false);
  };

  const hasTypeChanges = schemaImportChanges.some((c) => c.type === "type_changed");
  const canConfirmSchemaImport =
    schemaImportChanges.filter((c) => c.type !== "unchanged").length > 0 &&
    (!hasTypeChanges || schemaTypeChangeConfirmed);

  return (
    <div className={embedded ? "" : "p-8"}>
      {!embedded && (
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-3xl font-bold text-foreground">{t("admin.systemSettings.title")}</h1>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={handleSchemaExport}
              disabled={schemaExportLoading || definitions.length === 0}
              data-testid="export-schema"
            >
              {schemaExportLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              {t("admin.systemSettings.schema.exportButton")}
            </Button>
            <Button variant="outline" onClick={handleSchemaImportClick} data-testid="import-schema">
              <FileCode className="h-4 w-4 mr-2" />
              {t("admin.systemSettings.schema.importButton")}
            </Button>
            <input
              ref={schemaFileInputRef}
              type="file"
              accept=".json"
              onChange={handleSchemaFileChange}
              className="hidden"
              data-testid="import-schema-file-input"
            />
          </div>
        </div>
      )}
      {embedded && (
        <div className="flex gap-2 mb-6">
          <Button
            variant="outline"
            onClick={handleSchemaExport}
            disabled={schemaExportLoading || definitions.length === 0}
            data-testid="export-schema"
          >
            {schemaExportLoading ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : (
              <Download className="h-4 w-4 mr-2" />
            )}
            {t("admin.systemSettings.schema.exportButton")}
          </Button>
          <Button variant="outline" onClick={handleSchemaImportClick} data-testid="import-schema">
            <FileCode className="h-4 w-4 mr-2" />
            {t("admin.systemSettings.schema.importButton")}
          </Button>
          <input
            ref={schemaFileInputRef}
            type="file"
            accept=".json"
            onChange={handleSchemaFileChange}
            className="hidden"
            data-testid="import-schema-file-input"
          />
        </div>
      )}

      {/* Create New Form */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">{t("admin.systemSettings.createNew")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreateDefinition} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Input
                type="text"
                placeholder={t("admin.systemSettings.keyPlaceholder")}
                value={formData.key || ""}
                onChange={(e) => setFormData({ ...formData, key: e.target.value })}
                required
              />
              <Select
                value={formData.type || undefined}
                onValueChange={(value) => setFormData({ ...formData, type: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("admin.systemSettings.selectType")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">string</SelectItem>
                  <SelectItem value="number">number</SelectItem>
                  <SelectItem value="boolean">boolean</SelectItem>
                  <SelectItem value="text">text</SelectItem>
                  <SelectItem value="encrypted">encrypted</SelectItem>
                </SelectContent>
              </Select>
              <Input
                type="text"
                placeholder={t("admin.systemSettings.categoryPlaceholder")}
                value={formData.category || ""}
                onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                required
              />
              <Input
                type="text"
                placeholder={t("admin.systemSettings.labelPlaceholder")}
                value={formData.label || ""}
                onChange={(e) => setFormData({ ...formData, label: e.target.value })}
                required
              />
            </div>
            <Input
              type="text"
              placeholder={t("admin.systemSettings.descriptionPlaceholder")}
              className="w-full"
              value={formData.description || ""}
              onChange={(e) => setFormData({ ...formData, description: e.target.value })}
            />
            <div className="flex gap-3">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.required || false}
                  onChange={(e) => setFormData({ ...formData, required: e.target.checked })}
                />
                <span className="text-sm text-muted-foreground">
                  {t("admin.systemSettings.required")}
                </span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.adminOnly || false}
                  onChange={(e) => setFormData({ ...formData, adminOnly: e.target.checked })}
                />
                <span className="text-sm text-muted-foreground">
                  {t("admin.systemSettings.adminOnly")}
                </span>
              </label>
            </div>
            <Button type="submit">{t("admin.systemSettings.createButton")}</Button>
          </form>
        </CardContent>
      </Card>

      {/* Definitions List */}
      {loading ? (
        <p className="text-muted-foreground">{t("admin.systemSettings.loading")}</p>
      ) : (
        <div className="space-y-2">
          {definitions.map((def) => (
            <Card key={def.key} data-testid={`definition-${def.key}`}>
              <CardContent className="p-4">
                <div className="flex justify-between items-start">
                  <div>
                    <div className="font-medium text-foreground">{def.key}</div>
                    <div className="text-sm text-muted-foreground">
                      {t("admin.systemSettings.type")}: {def.type} |{" "}
                      {t("admin.systemSettings.category")}: {def.category}
                    </div>
                    {def.description && (
                      <div className="text-sm text-muted-foreground mt-1">{def.description}</div>
                    )}
                    <div className="text-xs text-muted-foreground mt-1">
                      {def.required && (
                        <span className="mr-2">• {t("admin.systemSettings.required")}</span>
                      )}
                      {def.adminOnly && (
                        <span className="mr-2">• {t("admin.systemSettings.adminOnly")}</span>
                      )}
                      {def.protected && (
                        <span className="text-primary">
                          • {t("admin.systemSettings.protected")}
                        </span>
                      )}
                    </div>
                  </div>
                  {!def.protected && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDeleteDefinition(def.key)}
                    >
                      {t("admin.systemSettings.delete")}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Database Maintenance - shown when not hidden */}
      {!hideMaintenance && (
        <div className="mt-8">
          <MaintenanceContent />
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog
        open={deleteDialog.open}
        onOpenChange={(open) => setDeleteDialog({ open })}
        title={t("admin.systemSettings.delete")}
        description={t("admin.systemSettings.confirmDelete", {
          key: deleteDialog.settingKey || "",
        })}
        confirmLabel={t("admin.systemSettings.delete")}
        variant="destructive"
        onConfirm={confirmDelete}
      />

      {/* Schema Import Preview Modal */}
      <Dialog
        open={schemaImportPreviewOpen}
        onOpenChange={(open) => !open && closeSchemaImportPreview()}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              <FileCode className="h-5 w-5 inline mr-2" />
              {t("admin.systemSettings.schema.previewTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("admin.systemSettings.schema.previewDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto" data-testid="schema-import-preview-list">
            {schemaImportChanges.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                {t("admin.systemSettings.schema.noChanges")}
              </div>
            ) : (
              <div className="space-y-3">
                {schemaImportChanges.map((change) => (
                  <div
                    key={change.key}
                    className={`border rounded-lg p-3 ${
                      change.type === "type_changed"
                        ? "border-destructive/30 bg-destructive/10"
                        : change.type === "new"
                          ? "border-success/30 bg-success/10"
                          : change.type === "changed"
                            ? "border-warning/30 bg-warning/10"
                            : "border-border opacity-60"
                    }`}
                    data-testid={`schema-change-${change.key}`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      {change.type === "type_changed" && (
                        <span className="text-destructive">
                          <AlertTriangle className="h-4 w-4" />
                        </span>
                      )}
                      {change.type === "new" && (
                        <span className="text-success">
                          <Plus className="h-4 w-4" />
                        </span>
                      )}
                      {change.type === "changed" && (
                        <span className="text-warning">
                          <RotateCcw className="h-4 w-4" />
                        </span>
                      )}
                      {change.type === "unchanged" && (
                        <span className="text-muted-foreground">
                          <Check className="h-4 w-4" />
                        </span>
                      )}
                      <span className="font-medium">{change.key}</span>
                      <span
                        className={`text-xs px-2 py-0.5 rounded ${
                          change.type === "type_changed"
                            ? "bg-destructive/20 text-destructive"
                            : "bg-muted"
                        }`}
                      >
                        {t(`admin.systemSettings.schema.type.${change.type}`)}
                      </span>
                    </div>
                    {change.changes.length > 0 && (
                      <div className="text-xs space-y-1">
                        {change.changes.map((c, idx) => (
                          <div key={idx} className="text-muted-foreground">
                            • {c}
                          </div>
                        ))}
                      </div>
                    )}
                    {change.type === "type_changed" && (
                      <div className="text-xs text-destructive mt-2 font-medium">
                        <AlertTriangle className="h-3 w-3 inline mr-1" />
                        {t("admin.systemSettings.schema.typeChangeWarning")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          {hasTypeChanges && (
            <div className="border-t pt-4 mt-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={schemaTypeChangeConfirmed}
                  onChange={(e) => setSchemaTypeChangeConfirmed(e.target.checked)}
                  className="w-4 h-4"
                  data-testid="schema-type-change-confirm"
                />
                <span className="text-destructive">
                  {t("admin.systemSettings.schema.confirmTypeChange")}
                </span>
              </label>
            </div>
          )}
          <DialogFooter className="flex items-center justify-between">
            <div className="text-sm text-muted-foreground">
              {schemaImportChanges.filter((c) => c.type !== "unchanged").length}{" "}
              {t("admin.systemSettings.schema.willChange")}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={closeSchemaImportPreview}
                disabled={schemaImportLoading}
              >
                {t("admin.systemSettings.cancel")}
              </Button>
              <Button
                onClick={performSchemaImport}
                disabled={schemaImportLoading || !canConfirmSchemaImport}
                data-testid="schema-import-confirm"
              >
                {schemaImportLoading ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1" />
                ) : (
                  <FileCode className="h-4 w-4 mr-1" />
                )}
                {t("admin.systemSettings.schema.confirm")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
