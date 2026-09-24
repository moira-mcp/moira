/**
 * The variable registry of the definition as the same rows the run page uses: one row per
 * declared global with its type and default in the value column, the description and the whole
 * declaration (as JSON Schema) in the expanded body. In edit mode the type, default, description
 * and schema are editable in place (JSON validated locally before it is applied), entries can be
 * removed and new ones declared. The server remains the judge: the save validates the whole
 * definition.
 */

import React, { useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useHighlightTarget, type HighlightRequest } from "../diagram/useHighlightTarget";
import { Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GuidanceCallout } from "../run/Guidance";
import { VariableGroup, VariableRow } from "../run/variableTree";
import { useEditing } from "./editing";
import type { RegistryVariable } from "../../types/workflow-types";

const TYPES: RegistryVariable["type"][] = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
  "null",
];

function formatDefault(value: unknown): string {
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function Entry({ name, entry }: { name: string; entry: RegistryVariable }): React.JSX.Element {
  const { t } = useTranslation();
  const { enabled, setRegistry } = useEditing();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const defaultText = draft ?? formatDefault(entry.default);
  const [schemaDraft, setSchemaDraft] = useState<string | null>(null);
  const [schemaInvalid, setSchemaInvalid] = useState(false);
  const schemaText = schemaDraft ?? JSON.stringify(entry, null, 2);

  // The whole declaration as JSON Schema: enum, items, properties and any other keyword.
  const commitSchema = (text: string): void => {
    setSchemaDraft(text);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object");
      setSchemaInvalid(false);
      setRegistry(name, parsed as RegistryVariable);
      setDraft(null);
    } catch {
      setSchemaInvalid(true);
    }
  };

  const commitDefault = (text: string): void => {
    setDraft(text);
    if (text.trim() === "") {
      setInvalid(false);
      const { default: _omitted, ...rest } = entry;
      void _omitted;
      setRegistry(name, rest as RegistryVariable);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setInvalid(false);
      setRegistry(name, { ...entry, default: parsed });
    } catch {
      setInvalid(true);
    }
  };

  const type = enabled ? (
    <Select
      value={entry.type}
      onValueChange={(next) =>
        setRegistry(name, { ...entry, type: next as RegistryVariable["type"] })
      }
    >
      <SelectTrigger
        className="h-7 w-[104px] shrink-0 text-xs"
        aria-label={t("pages.flowPage.registry.type")}
        data-testid={`registry-${name}-type`}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TYPES.map((option) => (
          <SelectItem key={option} value={option}>
            {option}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ) : (
    <span className="shrink-0 rounded border bg-muted/40 px-1.5 text-[11px]">{entry.type}</span>
  );

  const value = enabled ? (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {type}
      <span className="min-w-0 flex-1">
        <Input
          value={defaultText}
          onChange={(e) => commitDefault(e.target.value)}
          placeholder={t("pages.flowPage.registry.noDefault")}
          className={cn("h-7 font-mono text-xs", invalid && "border-destructive")}
          aria-invalid={invalid || undefined}
          aria-label={t("pages.flowPage.registry.default")}
          data-testid={`registry-${name}-default`}
        />
        {invalid && (
          <span
            className="block text-[11px] text-destructive"
            data-testid="registry-invalid-default"
          >
            {t("pages.flowPage.registry.invalidJson")}
          </span>
        )}
      </span>
    </span>
  ) : (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {type}
      <code className="min-w-0 truncate font-mono text-xs" data-hint={formatDefault(entry.default)}>
        {entry.default === undefined ? (
          <span className="text-muted-foreground">{t("pages.flowPage.registry.noDefault")}</span>
        ) : (
          formatDefault(entry.default)
        )}
      </code>
    </span>
  );

  return (
    <VariableRow
      name={name}
      description={enabled ? undefined : entry.description || undefined}
      value={value}
      expanded={expanded}
      onToggle={() => setExpanded((e) => !e)}
      testId={`registry-${name}`}
      toggleTestId={`registry-${name}-toggle`}
      data-registry-name={name}
      trailing={
        enabled ? (
          <button
            type="button"
            onClick={() => setRegistry(name, null)}
            className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={t("pages.flowPage.registry.remove")}
            data-testid={`registry-${name}-remove`}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        ) : undefined
      }
      body={
        <div className="space-y-2 border-t bg-muted/30 px-3 py-2">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("pages.flowPage.registry.description")}
            </span>
            {enabled ? (
              <Textarea
                value={entry.description}
                onChange={(e) => setRegistry(name, { ...entry, description: e.target.value })}
                className="min-h-[48px] text-xs"
                aria-label={t("pages.flowPage.registry.description")}
                data-testid={`registry-${name}-description`}
              />
            ) : (
              <p className="text-xs leading-5 text-muted-foreground">{entry.description || "—"}</p>
            )}
          </label>
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t("pages.flowPage.registry.schema")}
            </span>
            {enabled ? (
              <Textarea
                value={schemaText}
                onChange={(e) => commitSchema(e.target.value)}
                className={cn(
                  "min-h-[96px] font-mono text-xs",
                  schemaInvalid && "border-destructive",
                )}
                aria-invalid={schemaInvalid || undefined}
                data-testid={`registry-${name}-schema`}
              />
            ) : (
              <pre className="scrollbar-thin max-h-48 overflow-auto rounded-md border bg-card p-2 font-mono text-[11px] leading-4">
                {schemaText}
              </pre>
            )}
            {schemaInvalid && (
              <span
                className="block text-[11px] text-destructive"
                data-testid="registry-invalid-schema"
              >
                {t("pages.flowPage.registry.invalidJson")}
              </span>
            )}
          </label>
        </div>
      }
    />
  );
}

export function RegistryPanel({
  registry,
  highlight = null,
}: {
  /** The registry as currently edited. */
  registry: Record<string, RegistryVariable> | undefined;
  /** A variable to bring into view and mark (a reference token was clicked). */
  highlight?: HighlightRequest | null;
}): React.JSX.Element {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  useHighlightTarget(panelRef, highlight, (name) => `[data-registry-name="${name}"]`);
  const { enabled, setRegistry } = useEditing();
  const [newName, setNewName] = useState("");
  const names = Object.keys(registry ?? {});
  const validName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(newName) && !names.includes(newName);
  return (
    <div className="space-y-3 p-3" data-testid="registry-panel" ref={panelRef}>
      <GuidanceCallout
        title={t("pages.flowPage.registry.guideTitle")}
        testId="guidance-registry"
        panel="registry-guide"
      >
        {t("pages.flowPage.registry.guideBody")}
      </GuidanceCallout>
      {names.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("pages.flowPage.registry.empty")}</p>
      ) : (
        <VariableGroup
          id="registry"
          title={t("pages.flowPage.registry.title")}
          count={names.length}
        >
          {names.map((name) => (
            <Entry key={name} name={name} entry={registry![name]} />
          ))}
        </VariableGroup>
      )}
      {enabled && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!validName) return;
            setRegistry(newName, { type: "string", description: "" });
            setNewName("");
          }}
        >
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("pages.flowPage.registry.newName")}
            className="h-8 font-mono text-xs"
            aria-label={t("pages.flowPage.registry.newName")}
            data-testid="registry-new-name"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!validName}
            data-testid="registry-add"
          >
            <Plus className="mr-1 size-3.5" aria-hidden="true" />
            {t("pages.flowPage.registry.add")}
          </Button>
        </form>
      )}
    </div>
  );
}
