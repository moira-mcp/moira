/**
 * The flow page's edit bar: how many flow-file entries the draft changes, undo and discard, the
 * state of the draft's check (the process contract in the browser, the server's dry run) which is
 * also why Save is or is not available, Save against the loaded revision, and the export that
 * lists exactly what the save would change. Below it, the problems of the definition, each with
 * the place it belongs to.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { guideAnchor } from "../../guides/anchors";
import { useGuides } from "../../guides/GuideContext";
import { EDITOR_GUIDE_ID } from "../../pages/flowEditor.guide";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  FileDiff,
  Loader2,
  CircleHelp,
  RotateCcw,
  Save,
  Undo2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { PlacedIssue, SaveGate } from "./issues";
import type { PausedRunWarning } from "./structure";
import { exportLine, type ExportEntry } from "./operations";
import { ExecutionStopButton } from "../execution/ExecutionStop";

function GateStatus({
  gate,
  processProblems,
  serverErrors,
  onRetry,
}: {
  gate: SaveGate;
  processProblems: number;
  serverErrors: number;
  onRetry: () => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const tone = {
    unchanged: "text-muted-foreground",
    checking: "text-muted-foreground",
    stale: "text-muted-foreground",
    diagnostics: "text-destructive",
    invalid: "text-destructive",
    "check-failed": "text-destructive",
    ready: "text-success",
  }[gate.reason];
  const icon =
    gate.reason === "checking" || gate.reason === "stale" ? (
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
    ) : gate.reason === "ready" ? (
      <CheckCircle2 className="size-3.5" aria-hidden="true" />
    ) : gate.reason === "unchanged" ? null : (
      <AlertCircle className="size-3.5" aria-hidden="true" />
    );
  const text =
    gate.reason === "diagnostics"
      ? t("pages.flowPage.edit.gate.diagnostics", { count: processProblems })
      : gate.reason === "invalid"
        ? t("pages.flowPage.edit.gate.invalid", { count: serverErrors })
        : gate.reason === "stale"
          ? t("pages.flowPage.edit.gate.checking")
          : t(
              `pages.flowPage.edit.gate.${gate.reason === "check-failed" ? "checkFailed" : gate.reason}`,
            );
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 text-xs font-medium", tone)}
      role="status"
      data-testid="flow-edit-gate"
      data-gate={gate.reason}
    >
      {icon}
      {text}
      {gate.reason === "check-failed" && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-1 rounded px-1 underline underline-offset-2 hover:bg-accent"
          data-testid="flow-edit-retry"
        >
          {t("pages.flowPage.edit.gate.retry")}
        </button>
      )}
    </span>
  );
}

function ExportEntryView({ entry }: { entry: ExportEntry }): React.JSX.Element {
  if (entry.kind !== "change") {
    const tone =
      entry.kind === "add-node" || entry.kind === "add-block"
        ? "text-success"
        : entry.kind === "rename-node"
          ? "text-foreground"
          : "text-destructive";
    return (
      <li
        className={cn("rounded-md bg-card p-2 font-semibold", tone)}
        data-export-entry={entry.kind}
      >
        {exportLine(entry)}
      </li>
    );
  }
  return (
    <li className="rounded-md bg-card p-2" data-export-path={entry.path}>
      <p className="font-semibold">{entry.path}</p>
      <p className="text-destructive">- {JSON.stringify(entry.before)}</p>
      <p className="text-success">+ {JSON.stringify(entry.after)}</p>
    </li>
  );
}

export function EditBar({
  diff,
  canUndo,
  onUndo,
  onReset,
  gate,
  processProblems,
  serverErrors,
  onRetry,
  saving,
  onSave,
  revision,
  saveError,
  runWarnings = [],
}: {
  diff: readonly ExportEntry[];
  canUndo: boolean;
  onUndo: () => void;
  onReset: () => void;
  gate: SaveGate;
  processProblems: number;
  serverErrors: number;
  onRetry: () => void;
  saving: boolean;
  onSave: () => void;
  revision: number;
  saveError: string | null;
  /** The owner's paused runs on nodes this draft renames or removes. */
  runWarnings?: readonly PausedRunWarning[];
}): React.JSX.Element {
  const { t } = useTranslation();
  const { start } = useGuides();
  const count = diff.length;
  return (
    <div
      className="border-b border-warning/50 bg-warning/5 px-3 py-1.5"
      data-testid="flow-edit-panel"
      {...guideAnchor("flow.edit-bar")}
    >
      <Collapsible data-testid="flow-edit-export">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span
            className="inline-flex items-center gap-1.5 text-sm font-medium tabular-nums"
            data-testid="flow-edit-count"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                count > 0 ? "bg-warning" : "bg-muted-foreground/40",
              )}
              aria-hidden="true"
            />
            {t("pages.flowPage.edit.count", { count })}
          </span>
          <span className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={onUndo}
              disabled={!canUndo}
              className="h-7 gap-1 px-2 text-xs"
              data-testid="flow-edit-undo"
            >
              <Undo2 className="size-3.5" aria-hidden="true" />
              {t("pages.flowPage.edit.undo")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              disabled={!canUndo}
              className="h-7 gap-1 px-2 text-xs"
              data-testid="flow-edit-reset"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              {t("pages.flowPage.edit.reset")}
            </Button>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                disabled={count === 0}
                className="group h-7 gap-1 px-2 text-xs"
                data-testid="flow-edit-export-toggle"
              >
                <FileDiff className="size-3.5" aria-hidden="true" />
                {t("pages.flowPage.edit.export", { count })}
                <ChevronDown
                  className="size-3 transition-transform group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </Button>
            </CollapsibleTrigger>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => start(EDITOR_GUIDE_ID)}
            data-testid="editor-tour-open"
          >
            <CircleHelp className="size-3.5" aria-hidden="true" />
            {t("guides.flow-editor.open")}
          </Button>
          <span className="ml-auto flex items-center gap-3">
            <GateStatus
              gate={gate}
              processProblems={processProblems}
              serverErrors={serverErrors}
              onRetry={onRetry}
            />
            <span
              className="text-xs tabular-nums text-muted-foreground"
              {...guideAnchor("flow.edit-revision")}
            >
              {t("pages.flowPage.edit.revision", { revision })}
            </span>
            <Button
              size="sm"
              onClick={onSave}
              disabled={!gate.enabled || saving}
              className="h-7 gap-1 text-xs"
              data-testid="flow-edit-save"
              {...guideAnchor("flow.edit-save")}
            >
              {saving ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Save className="size-3.5" aria-hidden="true" />
              )}
              {t("pages.flowPage.edit.save")}
            </Button>
          </span>
        </div>
        {runWarnings.length > 0 && (
          <div
            className="mt-1.5 rounded-md border border-warning/60 bg-warning/10 px-2.5 py-1.5 text-xs"
            role="alert"
            data-testid="flow-edit-run-warnings"
          >
            <p className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
              {t("pages.flowPage.edit.pausedRuns.title")}
            </p>
            <ul className="mt-1 space-y-0.5 pl-5">
              {runWarnings.map((warning) => (
                <li
                  key={warning.executionId}
                  className="min-w-0 [overflow-wrap:anywhere]"
                  data-run-warning={warning.executionId}
                >
                  <span data-testid={`flow-edit-run-task-${warning.executionId}`}>
                    {t("pages.flowPage.edit.pausedRuns.item", {
                      id:
                        warning.taskTitle ??
                        warning.workflowName ??
                        warning.executionId.slice(0, 8),
                      node: warning.nodeId,
                      change:
                        warning.change === "renamed"
                          ? t("pages.flowPage.edit.pausedRuns.renamed", { to: warning.to })
                          : t("pages.flowPage.edit.pausedRuns.removed"),
                    })}
                  </span>
                  <ExecutionStopButton
                    target={{
                      executionId: warning.executionId,
                      title: warning.taskTitle ?? warning.workflowName ?? warning.executionId,
                      stopCapability: warning.stopCapability,
                    }}
                  />
                  {warning.note ? (
                    <p
                      className="text-muted-foreground"
                      data-testid={`flow-edit-run-note-${warning.executionId}`}
                    >
                      {t("pages.overview.panel.note")}: {warning.note}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-muted-foreground">{t("pages.flowPage.edit.pausedRuns.hint")}</p>
          </div>
        )}
        {saveError && (
          <p className="mt-1 text-xs text-destructive" role="alert" data-testid="flow-save-error">
            {saveError}
          </p>
        )}
        <CollapsibleContent>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("pages.flowPage.edit.exportHint")}
          </p>
          <ul className="scrollbar-thin mt-1.5 max-h-[30vh] space-y-1 overflow-auto font-mono text-[11px]">
            {diff.map((entry, index) => (
              <ExportEntryView key={index} entry={entry} />
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/** Where a problem belongs, as the list names it: an edge, a step, a block, or the definition. */
function locationOf(issue: PlacedIssue): string | null {
  return issue.edge ?? issue.nodeId ?? issue.blockId ?? null;
}

/**
 * The definition's problems in one list, each with its place; a step's or an edge's place brings
 * that step into view.
 */
export function ProblemList({
  issues,
  onFocusNode,
}: {
  issues: readonly PlacedIssue[];
  onFocusNode: (nodeId: string) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  if (issues.length === 0) return null;
  return (
    <section
      className="border-b bg-destructive/5 px-4 py-2 text-xs"
      aria-label={t("pages.flowPage.diagnostics")}
      data-testid="flow-diagnostics"
    >
      <p className="mb-1 font-semibold text-destructive">
        {t("pages.flowPage.problems", { count: issues.length })}
      </p>
      <ul className="scrollbar-thin max-h-[20vh] space-y-1 overflow-auto">
        {issues.map((issue, index) => {
          const place = locationOf(issue);
          const node = issue.nodeId;
          return (
            <li
              key={index}
              className={cn(
                "flex items-start gap-2",
                issue.severity === "error" ? "text-destructive" : "text-warning-foreground",
              )}
              data-issue-source={issue.source}
            >
              {issue.severity === "error" ? (
                <AlertCircle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              ) : (
                <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              )}
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">
                {place &&
                  (node ? (
                    <button
                      type="button"
                      onClick={() => onFocusNode(node)}
                      className="mr-1.5 rounded border border-current/30 px-1 font-mono hover:bg-accent"
                      data-issue-place={place}
                    >
                      {place}
                    </button>
                  ) : (
                    <span className="mr-1.5 rounded border border-current/30 px-1 font-mono">
                      {place}
                    </span>
                  ))}
                {issue.source === "process" && <span className="font-mono">{issue.code}: </span>}
                {issue.message}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
