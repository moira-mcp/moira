/**
 * Variables — the one variables surface of the run page: the declared variables as aligned rows
 * (the value at the cursor, a secondary history count that opens the changes, an inline editor
 * where the server allows an edit, objects and arrays as a tree inside the row) and each step's
 * outputs as a group under its node, both groups collapsible and filtered together. The answer
 * form for the waiting step sits on top. Editing saves one path through the policy-governed
 * context route and answering goes through the answer route; both are recorded by the engine as
 * adjusted visits with the acting user; nothing here touches the definition. The fullscreen mode
 * is this same panel in a dialog.
 */

import React, { useMemo, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useHighlightTarget, type HighlightRequest } from "../diagram/useHighlightTarget";
import { History, Loader2, Maximize2, Search, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { GuidanceCallout } from "./Guidance";
import type { ExecutionProgress, EvidenceField, StepInfo } from "./model";
import { formatValue } from "./model";
import type { WorkflowGraph } from "../../types/workflow-types";
import type { VariableFilterField } from "../../utils/context-variable-model";
import { variableRows, type DeclaredRow } from "./variableRows";
import { TreeNode, VariableGroup, subtreeMatches, type SavePath } from "./variableTree";

type Draft = Record<string, string>;

/** Parse one field's draft according to its declared type; strings pass through. */
export function parseFieldValue(field: EvidenceField, raw: string): unknown {
  const trimmed = raw.trim();
  switch (field.type) {
    case "number":
    case "integer":
      return trimmed === "" ? undefined : Number(trimmed);
    case "boolean":
      return trimmed === "" ? undefined : trimmed === "true";
    case "object":
    case "array":
      return trimmed === "" ? undefined : JSON.parse(trimmed);
    default:
      return raw === "" ? undefined : raw;
  }
}

/** The answer object built from the drafts: empty fields are omitted, typed fields parsed. */
export function buildAnswer(fields: EvidenceField[], draft: Draft): Record<string, unknown> {
  const answer: Record<string, unknown> = {};
  for (const field of fields) {
    const value = parseFieldValue(field, draft[field.name] ?? "");
    if (value !== undefined) answer[field.name] = value;
  }
  return answer;
}

function FieldInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: EvidenceField;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}): React.JSX.Element {
  const testId = `answer-field-${field.name}`;
  if (field.enum) {
    return (
      <select
        className="h-8 w-full rounded-md border bg-background px-2 text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        data-testid={testId}
      >
        <option value="">—</option>
        {field.enum.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "boolean") {
    return (
      <select
        className="h-8 w-full rounded-md border bg-background px-2 text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        data-testid={testId}
      >
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (field.type === "object" || field.type === "array") {
    return (
      <Textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="min-h-[64px] font-mono text-xs"
        placeholder={field.type === "array" ? "[]" : "{}"}
        data-testid={testId}
      />
    );
  }
  if (field.type === "number" || field.type === "integer") {
    return (
      <Input
        type="number"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className="h-8 text-xs"
        data-testid={testId}
      />
    );
  }
  return (
    <Textarea
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      className="min-h-[36px] text-xs"
      rows={1}
      data-testid={testId}
    />
  );
}

/** The form that answers the waiting step with the fields its input schema demands. */
export function AnswerForm({
  step,
  blockName,
  onAnswer,
}: {
  step: StepInfo;
  blockName: string | null;
  onAnswer: (input: Record<string, unknown>) => Promise<string | null>;
}): React.JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = step.evidence.filter((f) => f.required && !(draft[f.name] ?? "").trim());
  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const failure = await onAnswer(buildAnswer(step.evidence, draft));
      if (failure) setError(failure);
      else setDraft({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="space-y-2 rounded-lg border border-warning/50 bg-warning/5 p-3 text-sm"
      data-testid="answer-form"
      data-node-id={step.id}
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <Send className="size-4 text-warning-foreground" aria-hidden="true" />
        {t("pages.runPage.answer.title")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("pages.runPage.answer.body", {
          step: step.displayName ?? step.id,
          block: blockName ?? "",
        })}
      </p>
      {step.summary && <p className="text-xs italic text-muted-foreground">{step.summary}</p>}
      {step.evidence.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("pages.runPage.answer.noFields")}</p>
      ) : (
        <div className="space-y-1.5">
          {step.evidence.map((field) => (
            <label key={field.name} className="block text-xs">
              <span className="mb-0.5 flex items-center gap-1 font-mono">
                {field.name}
                {field.type && <span className="text-muted-foreground">: {field.type}</span>}
                {field.required && <span className="text-destructive">*</span>}
              </span>
              {field.description && (
                <span className="mb-0.5 block text-[11px] text-muted-foreground">
                  {field.description}
                </span>
              )}
              <FieldInput
                field={field}
                value={draft[field.name] ?? ""}
                onChange={(next) => setDraft({ ...draft, [field.name]: next })}
                disabled={busy}
              />
            </label>
          ))}
        </div>
      )}
      {error && (
        <p
          className="rounded-md bg-destructive/10 px-2 py-1 text-xs text-destructive"
          role="alert"
          data-testid="answer-error"
        >
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {t("pages.runPage.answer.recorded")}
        </span>
        <Button
          size="sm"
          onClick={submit}
          disabled={busy || missing.length > 0}
          data-testid="answer-submit"
          className="h-8"
        >
          {busy ? <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden="true" /> : null}
          {t("pages.runPage.answer.submit")}
        </Button>
      </div>
    </section>
  );
}

/** The changes a variable went through, opened from its row. */
function HistoryList({ row }: { row: DeclaredRow }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <ol
      className="space-y-0.5 border-t bg-muted/30 px-3 py-2 font-mono text-[11px]"
      data-history-of={row.name}
    >
      {row.history.map((h) => (
        <li key={h.seq} className="flex gap-3" data-history-seq={h.seq}>
          <span className="w-10 shrink-0 text-right text-muted-foreground">#{h.seq}</span>
          <span className="w-28 shrink-0 truncate text-muted-foreground">{h.nodeId}</span>
          <span className="min-w-0 break-all">{formatValue(h.value)}</span>
          {h.adjusted && (
            <span className="shrink-0 text-warning-foreground">
              {t("pages.runPage.variables.adjusted")}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

export interface VariablesPanelProps {
  /** A variable to bring into view and mark (a reference token was clicked). */
  highlight?: HighlightRequest | null;
  /** The projection shown (at the cursor while one is set); null without a process view. */
  progress: ExecutionProgress | null;
  cursor: number | null;
  /** The run's context as it stands now: the values an edit changes. */
  context: Record<string, unknown> | undefined;
  workflow: WorkflowGraph | undefined;
  /** The step the run waits for, when the page may answer it. */
  waiting: StepInfo | null;
  waitingBlockName: string | null;
  canAdjust: boolean;
  editableVariableNames: ReadonlySet<string>;
  onAnswer: (input: Record<string, unknown>) => Promise<string | null>;
  /** Per-path save; absent when the viewer may not edit (the admin page). */
  onSavePath?: SavePath;
  /** Opens the same panel in a dialog; absent inside the dialog. */
  onFullscreen?: () => void;
}

export function VariablesPanel({
  progress,
  cursor,
  context,
  workflow,
  waiting,
  waitingBlockName,
  canAdjust,
  editableVariableNames,
  onAnswer,
  onSavePath,
  onFullscreen,
  highlight = null,
}: VariablesPanelProps): React.JSX.Element {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  useHighlightTarget(panelRef, highlight, (name) => `[data-variable="${name}"]`);
  const [query, setQuery] = useState("");
  const [filterField, setFilterField] = useState<VariableFilterField>("both");
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const q = query.trim().toLowerCase();

  const rows = useMemo(
    () =>
      variableRows({
        context,
        workflow,
        projection: progress?.variables,
        atCursor: cursor !== null,
        editableNames: editableVariableNames,
      }),
    [context, workflow, progress, cursor, editableVariableNames],
  );
  const declared = rows.declared.filter((row) =>
    subtreeMatches(row.name, row.value, q, filterField),
  );
  const outputs = rows.outputs.filter((group) =>
    subtreeMatches(group.nodeId, group.value, q, filterField),
  );
  const adjustments = progress ? progress.route.filter((v) => v.adjusted).length : 0;
  const fields: VariableFilterField[] = ["both", "key", "value"];

  return (
    <div className="space-y-3 p-3" data-testid="variables-panel" ref={panelRef}>
      {onFullscreen && (
        <GuidanceCallout
          title={t("pages.runPage.variables.guideTitle")}
          testId="guidance-variables"
          panel="run-variables-guide"
        >
          {t("pages.runPage.variables.guideBody")}
        </GuidanceCallout>
      )}
      {cursor !== null && (
        <p className="text-xs text-muted-foreground" data-testid="variables-cursor-note">
          {t("pages.runPage.variables.atCursor", { at: cursor })}
        </p>
      )}

      {canAdjust && waiting && (
        <AnswerForm step={waiting} blockName={waitingBlockName} onAnswer={onAnswer} />
      )}

      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("pages.executionInspector.context.filterPlaceholder")}
            className="h-8 pl-8 text-sm"
            data-testid="context-filter-input"
          />
        </div>
        <div className="flex overflow-hidden rounded-md border border-border">
          {fields.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilterField(f)}
              className={cn(
                "px-2 py-1 text-xs transition-colors",
                filterField === f
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:bg-muted",
              )}
              data-testid={`context-filter-field-${f}`}
            >
              {t(`pages.executionInspector.context.filterField.${f}`)}
            </button>
          ))}
        </div>
        {onFullscreen && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-8 shrink-0 p-0"
            onClick={onFullscreen}
            data-hint={t("pages.runPage.variables.fullscreen")}
            aria-label={t("pages.runPage.variables.fullscreen")}
            data-testid="context-fullscreen-button"
          >
            <Maximize2 className="size-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>

      {rows.declared.length === 0 && rows.outputs.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-muted-foreground">
          {t("pages.executionInspector.context.empty")}
        </p>
      ) : declared.length === 0 && outputs.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-muted-foreground">
          {t("pages.executionInspector.context.noMatches")}
        </p>
      ) : (
        <>
          {declared.length > 0 && (
            <VariableGroup
              id="declared"
              title={t("pages.executionInspector.context.globalSection")}
              count={declared.length}
            >
              {declared.map((row) => (
                <TreeNode
                  key={row.name}
                  nodeKey={row.name}
                  value={row.value}
                  path={[row.name]}
                  depth={0}
                  description={row.description}
                  query={q}
                  filterField={filterField}
                  canEdit={row.editable && Boolean(onSavePath)}
                  onSavePath={onSavePath}
                  defaultExpanded={false}
                  attributes={{
                    "data-variable": row.name,
                    "data-value": formatValue(row.value),
                    "data-adjusted": row.adjusted ? "true" : undefined,
                  }}
                  trailing={
                    <>
                      {row.adjusted && (
                        <span className="rounded-full bg-warning/20 px-1.5 text-[10px] font-medium text-warning-foreground">
                          {t("pages.runPage.variables.adjusted")}
                        </span>
                      )}
                      {row.history.length > 0 && (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => setOpenHistory(openHistory === row.name ? null : row.name)}
                          data-testid={`variable-history-${row.name}`}
                          aria-expanded={openHistory === row.name}
                          data-hint={t("pages.runPage.variables.changes")}
                        >
                          <History className="size-3" aria-hidden="true" />
                          {row.history.length}
                        </button>
                      )}
                    </>
                  }
                  extra={openHistory === row.name ? <HistoryList row={row} /> : undefined}
                />
              ))}
            </VariableGroup>
          )}
          {outputs.length > 0 && (
            <VariableGroup
              id="outputs"
              title={t("pages.executionInspector.context.nodeLocalSection")}
              count={outputs.length}
            >
              {outputs.map((group) => (
                <TreeNode
                  key={group.nodeId}
                  nodeKey={group.nodeId}
                  value={group.value}
                  path={[group.nodeId]}
                  depth={0}
                  query={q}
                  filterField={filterField}
                  canEdit={false}
                  attributes={{ "data-output": group.nodeId }}
                />
              ))}
            </VariableGroup>
          )}
        </>
      )}
      {progress && (
        <p className="text-[11px] text-muted-foreground" data-testid="adjustment-count">
          {t("pages.runPage.variables.adjustmentCount", { count: adjustments })}
        </p>
      )}
    </div>
  );
}
