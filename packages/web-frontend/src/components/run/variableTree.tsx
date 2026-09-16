/**
 * The pieces the variables surfaces share: an aligned row (name, value, trailing controls, an
 * expandable body), a collapsible group of rows, the value tree (objects and arrays as nested
 * rows with alphabetically sorted keys, filtered tree-aware) and the leaf editor (an input in
 * edit mode, dirty-gated save and cancel, a modal for long text, a per-path save). The run page's
 * panel and the flow page's registry compose these; nothing here knows where a value comes from.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronRight, Loader2, Maximize2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { VariableFilterField } from "../../utils/context-variable-model";

const LONG_TEXT_THRESHOLD = 60;

export type PathSeg = string | number;
export type SavePath = (path: PathSeg[], value: unknown) => Promise<boolean>;

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
export function subtreeMatches(
  key: PathSeg,
  value: unknown,
  q: string,
  field: VariableFilterField,
): boolean {
  if (q.length === 0) return true;
  const keyMatch = String(key).toLowerCase().includes(q);
  if (field !== "value" && keyMatch) return true;
  if (field !== "key" && !isContainer(value) && valueToSearch(value).toLowerCase().includes(q)) {
    return true;
  }
  if (isContainer(value)) {
    for (const [ck, cv] of childEntries(value)) {
      if (subtreeMatches(ck, cv, q, field)) return true;
    }
  }
  return false;
}

/** A short account of a container for a collapsed row. */
function containerSummary(value: Record<string, unknown> | unknown[]): string {
  return Array.isArray(value) ? `array(${value.length})` : `{${Object.keys(value).length}}`;
}

/**
 * One aligned row: the name (with its description as a tooltip), the value cell, trailing
 * controls, and an optional body shown when the row is expanded (a chevron before the name
 * toggles it). Rows in one group share the column grid, so names and values line up.
 */
export function VariableRow({
  name,
  description,
  value,
  trailing,
  body,
  expanded,
  onToggle,
  depth = 0,
  className,
  testId,
  toggleTestId,
  ...rest
}: {
  name: React.ReactNode;
  description?: string;
  value: React.ReactNode;
  trailing?: React.ReactNode;
  body?: React.ReactNode;
  /** Controlled expansion; a row without a body has no chevron. */
  expanded?: boolean;
  onToggle?: () => void;
  depth?: number;
  className?: string;
  testId?: string;
  /** The chevron's test id; defaults to the row's with a `context-node-toggle-` prefix. */
  toggleTestId?: string;
} & Record<`data-${string}`, string | undefined>): React.JSX.Element {
  // The full name is always reachable: a long one is cut in the column but shown on hover.
  const nameEl = (
    <span
      className="min-w-0 truncate font-mono text-xs font-medium text-foreground"
      title={typeof name === "string" ? name : undefined}
    >
      {name}
    </span>
  );
  const expandable = onToggle !== undefined;
  return (
    <div className={cn("text-sm", className)} data-testid={testId} {...rest}>
      <div
        className="grid min-h-8 grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)_auto] items-center gap-x-2 py-1 pr-2"
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <div className="flex min-w-0 items-center gap-1">
          {expandable ? (
            <button
              type="button"
              onClick={onToggle}
              className="-ml-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-expanded={expanded}
              data-testid={
                toggleTestId ??
                (testId ? testId.replace(/^context-var-/, "context-node-toggle-") : undefined)
              }
            >
              {expanded ? (
                <ChevronDown className="size-3.5" aria-hidden="true" />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden="true" />
              )}
            </button>
          ) : (
            <i className="size-5 shrink-0" aria-hidden="true" />
          )}
          {description ? (
            <Tooltip>
              <TooltipTrigger asChild>{nameEl}</TooltipTrigger>
              <TooltipContent className="max-w-xs">{description}</TooltipContent>
            </Tooltip>
          ) : (
            nameEl
          )}
        </div>
        <div className="flex min-w-0 items-center">{value}</div>
        <div className="flex items-center justify-end gap-1">{trailing}</div>
      </div>
      {expanded && body}
    </div>
  );
}

/** A collapsible group of rows with a secondary count; open by default unless told otherwise. */
export function VariableGroup({
  id,
  title,
  count,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg border bg-card"
      data-testid={`variables-group-${id}`}
      data-open={open ? "true" : "false"}
    >
      {/* The same header as `PanelSection`: title left, the count as the summary, chevron right. */}
      <CollapsibleTrigger
        className="group flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
        data-testid={`variables-group-toggle-${id}`}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        <span className="ml-auto text-xs tabular-nums text-foreground/80">{count}</span>
        <ChevronDown
          className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="divide-y border-t">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export interface TreeNodeProps {
  nodeKey: PathSeg;
  value: unknown;
  path: PathSeg[];
  depth: number;
  description?: string;
  query: string;
  filterField: VariableFilterField;
  canEdit: boolean;
  onSavePath?: SavePath;
  /** Trailing controls on the row (history, adjustment marks). */
  trailing?: React.ReactNode;
  /** Shown under the row when it is expanded, before the children. */
  extra?: React.ReactNode;
  /** Whether a container row opens on first render; deeper rows fold unless a filter is on. */
  defaultExpanded?: boolean;
  /** Attributes for the row element. */
  attributes?: Record<`data-${string}`, string | undefined>;
}

/** A value as a row: a leaf with its editor, or a container whose children are nested rows. */
export function TreeNode({
  nodeKey,
  value,
  path,
  depth,
  description,
  query,
  filterField,
  canEdit,
  onSavePath,
  trailing,
  extra,
  defaultExpanded,
  attributes,
}: TreeNodeProps): React.JSX.Element {
  const container = isContainer(value);
  const [expanded, setExpanded] = useState(defaultExpanded ?? depth < 1);
  useEffect(() => {
    if (query.length > 0) setExpanded(true);
  }, [query]);
  const testId = `context-var-${path.join(".")}`;
  const label = typeof nodeKey === "number" ? `[${nodeKey}]` : nodeKey;
  // What a row shows under itself (a history list) is independent of its children's expansion.
  if (container) {
    const entries = childEntries(value).filter(([ck, cv]) =>
      subtreeMatches(ck, cv, query, filterField),
    );
    return (
      <>
        <VariableRow
          name={label}
          description={description}
          value={
            <span className="text-[11px] text-muted-foreground/80">{containerSummary(value)}</span>
          }
          trailing={trailing}
          expanded={expanded}
          onToggle={() => setExpanded((e) => !e)}
          depth={depth}
          testId={testId}
          body={
            <>
              {entries.map(([ck, cv]) => (
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
            </>
          }
          {...attributes}
        />
        {extra}
      </>
    );
  }
  return (
    <>
      <VariableRow
        name={label}
        description={description}
        value={<LeafEditor path={path} value={value} canEdit={canEdit} onSavePath={onSavePath} />}
        trailing={trailing}
        depth={depth}
        testId={testId}
        {...attributes}
      />
      {extra}
    </>
  );
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

/** A leaf value: read-only text, or an input with dirty-gated save/cancel and a long-text modal. */
function LeafEditor({
  path,
  value,
  canEdit,
  onSavePath,
}: {
  path: PathSeg[];
  value: unknown;
  canEdit: boolean;
  onSavePath?: SavePath;
}): React.JSX.Element {
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

  if (!canEdit || !onSavePath) {
    const text = toEditString(value);
    return (
      <code
        className={cn(
          "min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs",
          text ? "text-foreground" : "text-muted-foreground",
        )}
        title={text}
      >
        {text || t("pages.executionInspector.context.emptyValue")}
      </code>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div className="relative min-w-0 flex-1">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && dirty) void doSave(draft);
            if (e.key === "Escape") setDraft(toEditString(value));
          }}
          placeholder={t("pages.executionInspector.context.emptyValue")}
          className="h-7 py-0 pr-7 font-mono text-xs"
          disabled={saving}
          data-testid={`context-var-input-${pathId}`}
        />
        {longText && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="absolute right-0.5 top-1/2 h-6 w-6 -translate-y-1/2 p-0 text-muted-foreground"
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
        className="h-7 w-7 shrink-0 p-0"
        onClick={() => void doSave(draft)}
        disabled={saving || !dirty}
        title={t("pages.executionInspector.context.save")}
        data-testid={`context-var-save-${pathId}`}
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 shrink-0 p-0"
        onClick={() => setDraft(toEditString(value))}
        disabled={saving || !dirty}
        title={t("common.cancel")}
        data-testid={`context-var-cancel-${pathId}`}
      >
        <X className="h-3 w-3" />
      </Button>
      {error && <span className="shrink-0 text-[10px] text-destructive">{error}</span>}

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{pathId}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="h-72 font-mono text-xs"
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
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-1.5 h-4 w-4" />
              )}
              {t("pages.executionInspector.context.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
