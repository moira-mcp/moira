/**
 * Execution context variable editor (tree).
 *
 * Renders the execution context variables in exactly two groups: "Global variables" (declared in the
 * workflow variableRegistry, readable by bare name) and "Node outputs" (per-node-id local scopes,
 * referenced as `node-id.name`). Under the explicit output-scope model every context value is one of
 * these two, so there is no undeclared/"appeared during execution" group. A global that a node wrote
 * also lives inside that node's local scope; it is shown once under Global and hidden from the node's
 * tree to avoid duplication. Objects/arrays render as an expandable tree with alphabetically-sorted
 * keys; leaf (primitive) values are editable at any nesting level.
 *
 * - Fields render in edit mode by default; Save/Cancel are enabled only after a change (dirty).
 * - Long / multiline string values show a "long" indicator and a button opening a modal editor.
 * - Empty/blank values render with a placeholder at normal height.
 * - Search/filter is tree-aware: a nested match is shown together with its ancestor path.
 * - Saving sends a per-path update (only the edited path), never overwriting the whole object.
 *
 * Read-only mode (no onSavePath) shows values without edit controls.
 */

import React, { useMemo, useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Search, X, ChevronRight, ChevronDown, Maximize2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  buildContextVariables,
  sortVariablesByName,
  getVariableDescriptions,
  getGlobalVariableNames,
  getNodeIds,
  type VariableFilterField,
} from "../../utils/context-variable-model";
import type { WorkflowGraph } from "../../types/workflow-types";

const LONG_TEXT_THRESHOLD = 60;

type PathSeg = string | number;

interface ContextVariableEditorProps {
  variables: Record<string, unknown>;
  workflow?: WorkflowGraph;
  /** When provided, the editor is editable and calls this with the full path + new value. */
  onSavePath?: (path: PathSeg[], value: unknown) => Promise<boolean>;
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === "object";
}

function isLongText(v: unknown): boolean {
  return typeof v === "string" && (v.length > LONG_TEXT_THRESHOLD || v.includes("\n"));
}

function valueToSearch(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return "";
    }
  }
  return String(v);
}

/** Sorted child entries for a container: objects by key (alpha), arrays by index. */
function childEntries(value: Record<string, unknown> | unknown[]): Array<[PathSeg, unknown]> {
  if (Array.isArray(value)) {
    return value.map((v, i) => [i, v] as [PathSeg, unknown]);
  }
  return Object.keys(value)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0))
    .map((k) => [k, value[k]] as [PathSeg, unknown]);
}

/** Whether a subtree matches the query (key path or any value), used for tree-aware filtering. */
function subtreeMatches(
  key: PathSeg,
  value: unknown,
  q: string,
  field: VariableFilterField,
): boolean {
  if (q.length === 0) return true;
  const keyMatch = String(key).toLowerCase().includes(q);
  if (field === "key" && keyMatch) return true;
  if (field !== "key") {
    if (field === "value" || field === "both") {
      if (!isContainer(value) && valueToSearch(value).toLowerCase().includes(q)) return true;
    }
    if (field === "both" && keyMatch) return true;
  } else if (keyMatch) {
    return true;
  }
  if (isContainer(value)) {
    for (const [ck, cv] of childEntries(value)) {
      if (subtreeMatches(ck, cv, q, field)) return true;
    }
  }
  return false;
}

export const ContextVariableEditor: React.FC<ContextVariableEditorProps> = ({
  variables,
  workflow,
  onSavePath,
}) => {
  const { t } = useTranslation();
  const canEdit = Boolean(onSavePath);

  const [query, setQuery] = useState("");
  const [filterField, setFilterField] = useState<VariableFilterField>("both");

  const globalNames = useMemo(() => getGlobalVariableNames(workflow), [workflow]);
  const nodeIds = useMemo(() => getNodeIds(workflow), [workflow]);
  const descriptions = useMemo(() => getVariableDescriptions(workflow), [workflow]);

  // Top-level entries split into global / node-local / runtime, alphabetically sorted.
  const model = useMemo(() => buildContextVariables(variables, workflow), [variables, workflow]);
  const sortedNames = useMemo(() => sortVariablesByName(model).map((m) => m.name), [model]);

  const q = query.trim().toLowerCase();
  const visibleNames = useMemo(
    () => sortedNames.filter((name) => subtreeMatches(name, variables?.[name], q, filterField)),
    [sortedNames, variables, q, filterField],
  );

  // Two declared groups only. A top-level key is a global (registry) or a node-local scope (node id).
  // Anything else cannot exist under the explicit output-scope model (the engine rejects undeclared
  // keys), so it is not rendered as a separate group.
  const globalVisible = visibleNames.filter((n) => globalNames.has(n));
  // A node-local scope whose only contents are the globals the node wrote (hidden here, shown under
  // Global) — e.g. the start node's seeded globals — renders as an empty container; omit it.
  const nodeLocalVisible = visibleNames.filter((n) => {
    if (globalNames.has(n) || !nodeIds.has(n)) return false;
    const scope = variables?.[n];
    if (!isContainer(scope)) return true; // a primitive node-local value is shown as-is
    return childEntries(scope).some(
      ([ck, cv]) =>
        !(typeof ck === "string" && globalNames.has(ck)) && subtreeMatches(ck, cv, q, filterField),
    );
  });

  const fields: VariableFilterField[] = ["both", "key", "value"];

  return (
    <div className="flex flex-col gap-3">
      {/* Filter bar */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("pages.executionInspector.context.filterPlaceholder")}
            className="pl-8 h-8 text-sm"
            data-testid="context-filter-input"
          />
        </div>
        <div className="flex rounded-md border border-border overflow-hidden">
          {fields.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilterField(f)}
              className={`px-2.5 py-1 text-xs transition-colors ${
                filterField === f
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted"
              }`}
              data-testid={`context-filter-field-${f}`}
            >
              {t(`pages.executionInspector.context.filterField.${f}`)}
            </button>
          ))}
        </div>
      </div>

      {model.length === 0 ? (
        <p className="text-sm text-muted-foreground px-1 py-6 text-center">
          {t("pages.executionInspector.context.empty")}
        </p>
      ) : visibleNames.length === 0 ? (
        <p className="text-sm text-muted-foreground px-1 py-6 text-center">
          {t("pages.executionInspector.context.noMatches")}
        </p>
      ) : (
        <>
          <Section
            title={t("pages.executionInspector.context.globalSection")}
            count={globalVisible.length}
          >
            {globalVisible.map((name) => (
              <TreeNode
                key={name}
                nodeKey={name}
                value={variables[name]}
                path={[name]}
                depth={0}
                description={descriptions[name]}
                query={q}
                filterField={filterField}
                canEdit={canEdit}
                onSavePath={onSavePath}
              />
            ))}
          </Section>
          <Section
            title={t("pages.executionInspector.context.nodeLocalSection")}
            count={nodeLocalVisible.length}
          >
            {nodeLocalVisible.map((name) => (
              <TreeNode
                key={name}
                nodeKey={name}
                value={variables[name]}
                path={[name]}
                depth={0}
                description={descriptions[name]}
                query={q}
                filterField={filterField}
                canEdit={canEdit}
                onSavePath={onSavePath}
                // A global a node wrote also lives in the node scope; hide it here (shown under Global).
                hiddenChildKeys={globalNames}
              />
            ))}
          </Section>
        </>
      )}
    </div>
  );
};

const Section: React.FC<{ title: string; count: number; children: React.ReactNode }> = ({
  title,
  count,
  children,
}) => {
  if (count === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5 px-0.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <span className="text-[10px] text-muted-foreground/70">{count}</span>
      </div>
      <div className="rounded-md border border-border divide-y divide-border bg-card">
        {children}
      </div>
    </div>
  );
};

interface TreeNodeProps {
  nodeKey: PathSeg;
  value: unknown;
  path: PathSeg[];
  depth: number;
  description?: string;
  query: string;
  filterField: VariableFilterField;
  canEdit: boolean;
  onSavePath?: (path: PathSeg[], value: unknown) => Promise<boolean>;
  /** Direct-child keys to hide from this node's tree (e.g. globals a node wrote, shown under Global). */
  hiddenChildKeys?: Set<string>;
}

const TreeNode: React.FC<TreeNodeProps> = ({
  nodeKey,
  value,
  path,
  depth,
  description,
  query,
  filterField,
  canEdit,
  onSavePath,
  hiddenChildKeys,
}) => {
  const container = isContainer(value);
  // Expand by default when filtering (so matches are visible), else collapse deep nodes.
  const [expanded, setExpanded] = useState(depth < 1);
  useEffect(() => {
    if (query.length > 0) setExpanded(true);
  }, [query]);

  const indent = { paddingLeft: `${depth * 14 + 10}px` };

  const nameEl = (
    <span className="font-mono text-xs font-medium text-foreground shrink-0 max-w-[45%] truncate">
      {typeof nodeKey === "number" ? `[${nodeKey}]` : nodeKey}
    </span>
  );

  if (container) {
    const entries = childEntries(value).filter(
      ([ck, cv]) =>
        !(hiddenChildKeys && typeof ck === "string" && hiddenChildKeys.has(ck)) &&
        subtreeMatches(ck, cv, query, filterField),
    );
    const isArr = Array.isArray(value);
    return (
      <div data-testid={`context-var-${path.join(".")}`}>
        <div
          className="py-1 pr-2 flex items-center gap-1.5 cursor-pointer hover:bg-muted/40"
          style={indent}
          onClick={() => setExpanded((e) => !e)}
          data-testid={`context-node-toggle-${path.join(".")}`}
        >
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          {description ? (
            <Tooltip>
              <TooltipTrigger asChild>{nameEl}</TooltipTrigger>
              <TooltipContent className="max-w-xs">{description}</TooltipContent>
            </Tooltip>
          ) : (
            nameEl
          )}
          <span className="text-[10px] text-muted-foreground/70">
            {isArr ? `array(${(value as unknown[]).length})` : `{${entries.length}}`}
          </span>
        </div>
        {expanded &&
          entries.map(([ck, cv]) => (
            <TreeNode
              key={String(ck)}
              nodeKey={ck}
              value={cv}
              path={[...path, ck]}
              depth={depth + 1}
              query={query}
              filterField={filterField}
              canEdit={canEdit}
              onSavePath={onSavePath}
            />
          ))}
      </div>
    );
  }

  // Leaf (primitive) value
  return (
    <div
      className="py-1 pr-2 flex items-center gap-2 min-h-8"
      style={indent}
      data-testid={`context-var-${path.join(".")}`}
    >
      {description ? (
        <Tooltip>
          <TooltipTrigger asChild>{nameEl}</TooltipTrigger>
          <TooltipContent className="max-w-xs">{description}</TooltipContent>
        </Tooltip>
      ) : (
        nameEl
      )}
      <LeafEditor path={path} value={value} canEdit={canEdit} onSavePath={onSavePath} />
    </div>
  );
};

interface LeafEditorProps {
  path: PathSeg[];
  value: unknown;
  canEdit: boolean;
  onSavePath?: (path: PathSeg[], value: unknown) => Promise<boolean>;
}

/** Convert an edited string back to a primitive matching the original value's type. */
function coerce(raw: string, original: unknown): unknown {
  if (typeof original === "number") {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (typeof original === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return raw;
  }
  if (original === null) {
    return raw === "null" || raw === "" ? null : raw;
  }
  return raw;
}

function toEditString(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "";
  return String(v);
}

const LeafEditor: React.FC<LeafEditorProps> = ({ path, value, canEdit, onSavePath }) => {
  const { t } = useTranslation();
  const pathId = path.join(".");
  const [draft, setDraft] = useState(toEditString(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Reset the draft when the underlying value changes (after a save/reload).
  useEffect(() => {
    setDraft(toEditString(value));
    setError(null);
  }, [value]);

  const dirty = draft !== toEditString(value);

  const doSave = useCallback(
    async (newRaw: string) => {
      if (!onSavePath) return;
      setSaving(true);
      setError(null);
      try {
        const ok = await onSavePath(path, coerce(newRaw, value));
        if (!ok) setError(t("pages.executionInspector.context.saveFailed"));
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t("pages.executionInspector.context.saveFailed"),
        );
      } finally {
        setSaving(false);
      }
    },
    [onSavePath, path, value, t],
  );

  const longText = isLongText(value) || draft.includes("\n") || draft.length > LONG_TEXT_THRESHOLD;

  if (!canEdit) {
    return (
      <code className="flex-1 min-w-0 text-xs font-mono bg-muted px-2 py-0.5 rounded truncate text-foreground">
        {toEditString(value) || t("pages.executionInspector.context.emptyValue")}
      </code>
    );
  }

  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      <div className="relative flex-1 min-w-0">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) doSave(draft);
            if (e.key === "Escape") setDraft(toEditString(value));
          }}
          placeholder={t("pages.executionInspector.context.emptyValue")}
          className="h-7 text-xs font-mono py-0 pr-7"
          disabled={saving}
          data-testid={`context-var-input-${pathId}`}
        />
        {longText && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="absolute right-0.5 top-1/2 -translate-y-1/2 h-6 w-6 p-0 text-muted-foreground"
            onClick={() => setModalOpen(true)}
            title={t("pages.executionInspector.context.editLong")}
            data-testid={`context-var-expand-${pathId}`}
          >
            <Maximize2 className="h-3 w-3" />
          </Button>
        )}
      </div>
      <Button
        size="sm"
        className="h-7 w-7 p-0 shrink-0"
        onClick={() => doSave(draft)}
        disabled={saving || !dirty}
        title={t("pages.executionInspector.context.save")}
        data-testid={`context-var-save-${pathId}`}
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0 shrink-0"
        onClick={() => setDraft(toEditString(value))}
        disabled={saving || !dirty}
        title={t("common.cancel")}
        data-testid={`context-var-cancel-${pathId}`}
      >
        <X className="h-3 w-3" />
      </Button>
      {error && <span className="text-[10px] text-destructive shrink-0">{error}</span>}

      {/* Long-text modal editor */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{pathId}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="font-mono text-xs h-72"
            data-testid={`context-var-modal-textarea-${pathId}`}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDraft(toEditString(value))} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={async () => {
                await doSave(draft);
                setModalOpen(false);
              }}
              disabled={saving || !dirty}
              data-testid={`context-var-modal-save-${pathId}`}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Check className="h-4 w-4 mr-1.5" />
              )}
              {t("pages.executionInspector.context.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
