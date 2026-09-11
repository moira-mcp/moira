/**
 * Variables — every value of the run at the cursor with its history, and the two runtime
 * adjustments the page offers as engine operations: answering the step the run waits for (the
 * fields its input schema demands, submitted through the answer endpoint) and setting a variable
 * (handed to the existing context editor, which saves through the policy-governed path). Both are
 * recorded by the engine as adjusted visits with the acting user; nothing here touches the
 * definition.
 */

import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, History, Loader2, PencilLine, Send, Variable } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { GuidanceCallout } from "./Guidance";
import type { ExecutionProgress, EvidenceField, StepInfo } from "./model";
import { formatValue } from "./model";

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

export function VariablesPanel({
  progress,
  cursor,
  waiting,
  waitingBlockName,
  canAdjust,
  editableVariableNames,
  onAnswer,
  onEditVariable,
}: {
  progress: ExecutionProgress;
  cursor: number | null;
  /** The step the run waits for, when the page may answer it. */
  waiting: StepInfo | null;
  waitingBlockName: string | null;
  canAdjust: boolean;
  editableVariableNames: ReadonlySet<string>;
  onAnswer: (input: Record<string, unknown>) => Promise<string | null>;
  /** Open the context editor on a variable. */
  onEditVariable: (name: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const variables = useMemo(
    () => progress.variables.filter((v) => v.kind === "variable"),
    [progress.variables],
  );
  const outputs = useMemo(
    () => progress.variables.filter((v) => v.kind === "output"),
    [progress.variables],
  );
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const adjustments = progress.route.filter((v) => v.adjusted).length;

  return (
    <div className="space-y-3 p-3" data-testid="variables-panel">
      <GuidanceCallout title={t("pages.runPage.variables.guideTitle")} testId="guidance-variables">
        {t("pages.runPage.variables.guideBody")}
      </GuidanceCallout>
      {cursor !== null && (
        <p className="text-xs text-muted-foreground" data-testid="variables-cursor-note">
          {t("pages.runPage.variables.atCursor", { at: cursor })}
        </p>
      )}

      {canAdjust && waiting && (
        <AnswerForm step={waiting} blockName={waitingBlockName} onAnswer={onAnswer} />
      )}

      <div className="rounded-lg border bg-card">
        {/* A fixed layout keeps long values from widening the table past the panel: names and
            values wrap inside their columns instead of pushing the first column out of view. */}
        <table className="w-full table-fixed text-sm">
          <colgroup>
            <col className="w-[36%]" />
            <col />
            <col className="w-[88px]" />
          </colgroup>
          <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-semibold">{t("pages.runPage.variables.name")}</th>
              <th className="px-3 py-2 font-semibold">{t("pages.runPage.variables.value")}</th>
              <th className="px-3 py-2 text-right font-semibold">
                {t("pages.runPage.variables.changes")}
              </th>
            </tr>
          </thead>
          <tbody>
            {variables.map((v) => (
              <React.Fragment key={v.name}>
                <tr
                  className={cn("border-t", v.adjusted && "bg-warning/10")}
                  data-variable={v.name}
                  data-value={formatValue(v.current)}
                  data-adjusted={v.adjusted ? "true" : undefined}
                >
                  <td className="break-all px-3 py-1.5 font-mono text-xs">
                    <Variable
                      className="mr-1 inline size-3 text-muted-foreground"
                      aria-hidden="true"
                    />
                    {v.name}
                  </td>
                  <td className="break-all px-3 py-1.5 font-mono text-xs">
                    <span className="line-clamp-3" title={formatValue(v.current)}>
                      {formatValue(v.current)}
                    </span>
                    {v.adjusted && (
                      <span className="ml-2 rounded-full bg-warning/20 px-1.5 text-[10px] font-medium text-warning-foreground">
                        {t("pages.runPage.variables.adjusted")}
                      </span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right">
                    {canAdjust && editableVariableNames.has(v.name) && (
                      <button
                        type="button"
                        className="mr-1 inline-flex items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => onEditVariable(v.name)}
                        data-testid={`variable-edit-${v.name}`}
                        title={t("pages.runPage.variables.edit")}
                      >
                        <PencilLine className="size-3" aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-md px-1.5 text-xs tabular-nums text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                      disabled={v.history.length === 0}
                      onClick={() => setOpenHistory(openHistory === v.name ? null : v.name)}
                      data-testid={`variable-history-${v.name}`}
                      aria-expanded={openHistory === v.name}
                    >
                      <History className="size-3" aria-hidden="true" />
                      {v.history.length}
                    </button>
                  </td>
                </tr>
                {openHistory === v.name && (
                  <tr className="border-t bg-muted/30" data-history-of={v.name}>
                    <td colSpan={3} className="px-3 py-2">
                      <ol className="space-y-0.5 font-mono text-[11px]">
                        {v.history.map((h) => (
                          <li key={h.seq} className="flex gap-3" data-history-seq={h.seq}>
                            <span className="w-10 shrink-0 text-right text-muted-foreground">
                              #{h.seq}
                            </span>
                            <span className="w-28 shrink-0 truncate text-muted-foreground">
                              {h.nodeId}
                            </span>
                            <span className="min-w-0 break-all">{formatValue(h.value)}</span>
                            {h.adjusted && (
                              <span className="shrink-0 text-warning-foreground">
                                {t("pages.runPage.variables.adjusted")}
                              </span>
                            )}
                          </li>
                        ))}
                      </ol>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
            {variables.length === 0 && (
              <tr className="border-t">
                <td colSpan={3} className="px-3 py-3 text-center text-xs text-muted-foreground">
                  {t("pages.runPage.variables.none")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        <Collapsible>
          <CollapsibleTrigger className="group flex w-full items-center gap-1.5 border-t px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground">
            {t("pages.runPage.variables.outputs", { count: outputs.length })}
            <ChevronDown
              className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="max-h-64 divide-y overflow-y-auto border-t font-mono text-[11px]">
              {outputs.map((o) => (
                <li key={o.name} className="flex gap-3 px-3 py-1" data-output={o.name}>
                  <span className="w-48 shrink-0 truncate">{o.name}</span>
                  <span className="truncate text-muted-foreground" title={formatValue(o.current)}>
                    {formatValue(o.current)}
                  </span>
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="adjustment-count">
        {t("pages.runPage.variables.adjustmentCount", { count: adjustments })}
      </p>
    </div>
  );
}
