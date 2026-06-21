/**
 * SettingsEditor - Reusable settings editor component
 * Used by both AdminSettings (global settings) and Settings (user settings) pages
 *
 * Features:
 * - Grouping by categories
 * - Inputs by type (text, number, boolean, textarea, json)
 * - Fullscreen modal for long texts
 * - Per-setting save button
 * - Loading/error states
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "../ui/card";
import { Button } from "../ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { ChevronDown } from "lucide-react";

export interface SettingDefinition {
  key: string;
  type: "string" | "number" | "boolean" | "json" | "encrypted" | "text";
  category: string;
  label: string;
  description: string | null;
  defaultValue: string | null;
  required: boolean;
  validation: string | null;
  adminOnly?: boolean;
  sortOrder?: number;
}

export interface SettingValue {
  key: string;
  value: string | number | boolean | null;
}

/** Inheritance level indicator type */
export type InheritanceLevel = "default" | "agent" | "model" | null;

export interface SettingsEditorProps {
  /** Setting definitions grouped by category */
  definitions: SettingDefinition[];
  /** Current setting values (key -> value) */
  values: Record<string, unknown>;
  /** Category display labels */
  categoryLabels?: Record<string, string>;
  /** Callback when a setting is saved */
  onSave: (key: string, value: unknown) => Promise<void>;
  /** Whether settings are loading */
  loading?: boolean;
  /** Custom category sort order */
  categorySortOrder?: string[];
  /** Show fullscreen edit button for long text */
  enableFullscreenEdit?: boolean;
  /** Data-testid prefix for testing */
  testIdPrefix?: string;
  /** Optional callback for history button click - if provided, history button is shown */
  onHistoryClick?: (key: string) => void;
  /** Show character count for long text fields */
  showCharacterCount?: boolean;
  /** Optional function to determine inheritance level for a setting */
  getInheritanceLevel?: (key: string, value: unknown) => InheritanceLevel;
  /** Optional callback for reset button click - if provided, reset button is shown for override settings */
  onResetClick?: (key: string) => void;
  /** Optional function to check if a setting can be reset */
  canReset?: (key: string) => boolean;
  /** Whether categories are collapsible (default: true). When false, all categories render expanded without collapse controls */
  collapsible?: boolean;
}

interface FullscreenModalProps {
  isOpen: boolean;
  title: string;
  value: string;
  onClose: () => void;
  onSave: (value: string) => void;
}

const FullscreenModal: React.FC<FullscreenModalProps> = ({
  isOpen,
  title,
  value,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation();
  const [editValue, setEditValue] = useState(value);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
      data-testid="fullscreen-modal"
    >
      <div className="bg-card rounded-lg w-full max-w-4xl h-[80vh] flex flex-col">
        <div className="flex justify-between items-center p-4 border-b border-border">
          <h2 className="text-xl font-semibold text-foreground">{title}</h2>
          <Button variant="ghost" onClick={onClose} data-testid="fullscreen-close">
            ✕
          </Button>
        </div>
        <div className="flex-1 p-4 overflow-hidden">
          <textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            className="w-full h-full p-3 font-mono text-sm border border-border rounded-lg bg-background text-foreground resize-none"
            data-testid="fullscreen-textarea"
          />
        </div>
        <div className="flex justify-end gap-2 p-4 border-t border-border">
          <Button variant="outline" onClick={onClose} data-testid="fullscreen-cancel">
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => {
              onSave(editValue);
              onClose();
            }}
            data-testid="fullscreen-save"
          >
            {t("common.save")}
          </Button>
        </div>
      </div>
    </div>
  );
};

export const SettingsEditor: React.FC<SettingsEditorProps> = ({
  definitions,
  values,
  categoryLabels = {},
  onSave,
  loading = false,
  categorySortOrder = [],
  enableFullscreenEdit = true,
  testIdPrefix = "setting",
  onHistoryClick,
  showCharacterCount = false,
  getInheritanceLevel,
  onResetClick,
  canReset,
  collapsible = true,
}) => {
  const { t } = useTranslation();
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [changes, setChanges] = useState<Record<string, unknown>>({});
  const [fullscreenSetting, setFullscreenSetting] = useState<SettingDefinition | null>(null);
  const [openCategories, setOpenCategories] = useState<Set<string>>(new Set());

  // Toggle category open/closed state
  const toggleCategory = (category: string) => {
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  // Group definitions by category
  const grouped = definitions.reduce(
    (acc, def) => {
      const cat = def.category || "general";
      if (!acc[cat]) acc[cat] = [];
      acc[cat].push(def);
      return acc;
    },
    {} as Record<string, SettingDefinition[]>,
  );

  // Sort categories
  const sortedCategories = Object.keys(grouped).sort((a, b) => {
    const aIndex = categorySortOrder.indexOf(a);
    const bIndex = categorySortOrder.indexOf(b);
    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return a.localeCompare(b);
  });

  const getValue = (key: string, defaultValue: string | null): unknown => {
    if (changes[key] !== undefined) return changes[key];
    if (values[key] !== undefined) return values[key];
    return defaultValue;
  };

  const handleChange = (key: string, value: unknown) => {
    setChanges((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async (key: string) => {
    setSavingKey(key);
    try {
      const value = changes[key] !== undefined ? changes[key] : values[key];
      await onSave(key, value);
      // Clear change after successful save
      setChanges((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    } finally {
      setSavingKey(null);
    }
  };

  const hasChanges = (key: string): boolean => {
    return changes[key] !== undefined && changes[key] !== values[key];
  };

  const renderInput = (def: SettingDefinition) => {
    const value = getValue(def.key, def.defaultValue);
    const isLongText =
      def.type === "string" &&
      typeof value === "string" &&
      (value.length > 200 || value.includes("\n"));

    switch (def.type) {
      case "boolean":
        return (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(value)}
              onChange={(e) => handleChange(def.key, e.target.checked)}
              className="w-4 h-4 rounded border-border"
              data-testid={`${testIdPrefix}-${def.key}-input`}
            />
            <span className="text-sm text-muted-foreground">
              {value ? t("common.enabled") : t("common.disabled")}
            </span>
          </label>
        );

      case "number":
        return (
          <input
            type="number"
            value={value as number}
            onChange={(e) => handleChange(def.key, Number(e.target.value))}
            className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground"
            data-testid={`${testIdPrefix}-${def.key}-input`}
          />
        );

      case "json": {
        const jsonValue = typeof value === "string" ? value : JSON.stringify(value, null, 2);
        return (
          <div className="space-y-2">
            <textarea
              value={jsonValue}
              onChange={(e) => handleChange(def.key, e.target.value)}
              rows={4}
              className="w-full px-3 py-2 font-mono text-sm border border-border rounded-lg bg-background text-foreground"
              data-testid={`${testIdPrefix}-${def.key}-input`}
            />
            <div className="flex items-center justify-between">
              {showCharacterCount && (
                <span className="text-xs text-muted-foreground">
                  {jsonValue.length} {t("admin.globalSettings.characters")}
                </span>
              )}
              {enableFullscreenEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFullscreenSetting(def)}
                  data-testid={`${testIdPrefix}-${def.key}-fullscreen`}
                >
                  {t("settings.editFullscreen")}
                </Button>
              )}
            </div>
          </div>
        );
      }

      case "encrypted":
        return (
          <input
            type="password"
            value={(value as string) || ""}
            onChange={(e) => handleChange(def.key, e.target.value)}
            placeholder="••••••••"
            className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground"
            data-testid={`${testIdPrefix}-${def.key}-input`}
          />
        );

      case "text": {
        // "text" type is always multiline (tool descriptions, prompts, etc.)
        const textValue = (value as string) || "";
        return (
          <div className="space-y-2">
            <textarea
              value={textValue}
              onChange={(e) => handleChange(def.key, e.target.value)}
              rows={6}
              className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground"
              data-testid={`${testIdPrefix}-${def.key}-input`}
            />
            <div className="flex items-center justify-between">
              {showCharacterCount && (
                <span className="text-xs text-muted-foreground">
                  {textValue.length} {t("admin.globalSettings.characters")}
                </span>
              )}
              {enableFullscreenEdit && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setFullscreenSetting(def)}
                  data-testid={`${testIdPrefix}-${def.key}-fullscreen`}
                >
                  {t("settings.editFullscreen")}
                </Button>
              )}
            </div>
          </div>
        );
      }

      case "string":
      default: {
        const strValue = (value as string) || "";
        if (isLongText) {
          return (
            <div className="space-y-2">
              <textarea
                value={strValue}
                onChange={(e) => handleChange(def.key, e.target.value)}
                rows={4}
                className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground"
                data-testid={`${testIdPrefix}-${def.key}-input`}
              />
              <div className="flex items-center justify-between">
                {showCharacterCount && (
                  <span className="text-xs text-muted-foreground">
                    {strValue.length} {t("admin.globalSettings.characters")}
                  </span>
                )}
                {enableFullscreenEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setFullscreenSetting(def)}
                    data-testid={`${testIdPrefix}-${def.key}-fullscreen`}
                  >
                    {t("settings.editFullscreen")}
                  </Button>
                )}
              </div>
            </div>
          );
        }
        return (
          <input
            type="text"
            value={strValue}
            onChange={(e) => handleChange(def.key, e.target.value)}
            className="w-full px-3 py-2 border border-border rounded-lg bg-background text-foreground"
            data-testid={`${testIdPrefix}-${def.key}-input`}
          />
        );
      }
    }
  };

  if (loading) {
    return <div className="text-muted-foreground">{t("common.loading")}</div>;
  }

  const renderSettingItem = (def: SettingDefinition) => {
    const currentValue = getValue(def.key, def.defaultValue);
    const inheritanceLevel = getInheritanceLevel
      ? getInheritanceLevel(def.key, currentValue)
      : null;
    const showResetButton = onResetClick && canReset && canReset(def.key) && currentValue !== null;

    return (
      <div
        key={def.key}
        className="p-4 border border-border rounded-lg"
        data-testid={`${testIdPrefix}-${def.key}`}
      >
        <div className="flex justify-between items-start mb-2">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{def.label}</span>
              {inheritanceLevel && (
                <span
                  className={`text-xs px-2 py-0.5 rounded ${
                    inheritanceLevel === "model"
                      ? "bg-success/10 text-success"
                      : inheritanceLevel === "agent"
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground"
                  }`}
                  data-testid={`${testIdPrefix}-${def.key}-inheritance`}
                >
                  {inheritanceLevel === "model"
                    ? t("settings.inheritance.model")
                    : inheritanceLevel === "agent"
                      ? t("settings.inheritance.agent")
                      : t("settings.inheritance.default")}
                </span>
              )}
              {!inheritanceLevel && canReset && canReset(def.key) && (
                <span
                  className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground"
                  data-testid={`${testIdPrefix}-${def.key}-inactive`}
                >
                  {t("settings.inheritance.inactive")}
                </span>
              )}
            </div>
            {def.description && (
              <div className="text-sm text-muted-foreground">{def.description}</div>
            )}
            <div className="text-xs text-muted-foreground mt-1">{def.key}</div>
          </div>
          <div className="flex gap-2">
            {showResetButton && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onResetClick(def.key)}
                data-testid={`${testIdPrefix}-${def.key}-reset`}
              >
                {t("settings.reset")}
              </Button>
            )}
            {onHistoryClick && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onHistoryClick(def.key)}
                data-testid={`${testIdPrefix}-${def.key}-history`}
              >
                {t("settings.history")}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => handleSave(def.key)}
              disabled={savingKey === def.key || !hasChanges(def.key)}
              data-testid={`${testIdPrefix}-${def.key}-save`}
            >
              {savingKey === def.key ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
        <div className="mt-2">{renderInput(def)}</div>
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {sortedCategories.map((category) => {
        const categoryDefs = grouped[category] || [];
        if (categoryDefs.length === 0) return null;

        const sortedDefs = [...categoryDefs].sort(
          (a, b) => (a.sortOrder || 0) - (b.sortOrder || 0),
        );

        if (!collapsible) {
          return (
            <Card key={category} data-testid={`${testIdPrefix}-category-${category}`}>
              <CardHeader>
                <CardTitle>{categoryLabels[category] || category}</CardTitle>
                <CardDescription>
                  {sortedDefs.length}{" "}
                  {sortedDefs.length === 1 ? t("settings.setting") : t("settings.settings")}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">{sortedDefs.map(renderSettingItem)}</CardContent>
            </Card>
          );
        }

        const isOpen = openCategories.has(category);

        return (
          <Collapsible
            key={category}
            open={isOpen}
            onOpenChange={() => toggleCategory(category)}
            data-testid={`${testIdPrefix}-category-${category}`}
          >
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>{categoryLabels[category] || category}</CardTitle>
                      <CardDescription>
                        {sortedDefs.length}{" "}
                        {sortedDefs.length === 1 ? t("settings.setting") : t("settings.settings")}
                      </CardDescription>
                    </div>
                    <ChevronDown
                      className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${
                        isOpen ? "rotate-180" : ""
                      }`}
                      data-testid={`${testIdPrefix}-category-${category}-chevron`}
                    />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-4">{sortedDefs.map(renderSettingItem)}</CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        );
      })}

      {/* Fullscreen edit modal */}
      {fullscreenSetting && (
        <FullscreenModal
          isOpen={!!fullscreenSetting}
          title={fullscreenSetting.label}
          value={String(getValue(fullscreenSetting.key, fullscreenSetting.defaultValue) || "")}
          onClose={() => setFullscreenSetting(null)}
          onSave={(value) => handleChange(fullscreenSetting.key, value)}
        />
      )}
    </div>
  );
};

export default SettingsEditor;
