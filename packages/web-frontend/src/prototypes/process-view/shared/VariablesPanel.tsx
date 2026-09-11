/**
 * Runtime surfaces: the live variables panel of a recorded run, and the per-block values line.
 *
 * Both read the trace only. The panel also carries the runtime-adjustment mockup — set a value on
 * the running execution, or supply the decision the run is waiting for — labelled as actions on the
 * run so they are never confused with editing the flow definition (that is the authoring toggle).
 */

import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, History, SlidersHorizontal, Undo2, Variable } from "lucide-react";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GuidanceCallout } from "./Guidance";
import type { AuthoredNode, ProcessProjection } from "../model";
import type { RunTrace } from "../trace";
import {
  blockVariableUsage,
  countAdjustments,
  variableStates,
  type RuntimeAdjustments,
} from "../variables";

export function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** Panel: every variable with its current value, history, and the adjustment controls. */
export function VariablesPanel({
  trace,
  cursor,
  authored,
  adjustments,
  onAdjust,
}: {
  trace: RunTrace;
  cursor: number | null;
  authored: AuthoredNode[];
  adjustments: RuntimeAdjustments;
  onAdjust: (next: RuntimeAdjustments) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  const states = useMemo(() => variableStates(trace, cursor ?? undefined), [trace, cursor]);
  const variables = states.filter((s) => s.kind === "variable");
  const outputs = states.filter((s) => s.kind === "output");
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [overrideName, setOverrideName] = useState<string>(variables[0]?.name ?? "");
  const [overrideValue, setOverrideValue] = useState("");
  const [decision, setDecision] = useState<Record<string, string>>({});
  const last = trace.visits[trace.visits.length - 1];
  const waitingNode =
    trace.status === "waiting" && last ? authored.find((n) => n.id === last.nodeId) : undefined;
  const canDecide = Boolean(waitingNode) && !adjustments.decision;

  const parse = (raw: string): unknown => {
    const trimmed = raw.trim();
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    return raw;
  };

  return (
    <div className="space-y-3" data-testid="variables-panel">
      <GuidanceCallout
        title={t("pages.processViewPrototype.variables.guideTitle")}
        testId="guidance-variables"
      >
        {t("pages.processViewPrototype.variables.guideBody")}
      </GuidanceCallout>

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="overflow-x-auto rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-semibold">
                  {t("pages.processViewPrototype.variables.name")}
                </th>
                <th className="px-3 py-2 font-semibold">
                  {t("pages.processViewPrototype.variables.value")}
                </th>
                <th className="px-3 py-2 text-right font-semibold">
                  {t("pages.processViewPrototype.variables.changes")}
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
                    <td className="px-3 py-1.5 font-mono text-xs">
                      <Variable
                        className="mr-1 inline size-3 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {v.name}
                    </td>
                    <td
                      className="max-w-[420px] truncate px-3 py-1.5 font-mono text-xs"
                      title={formatValue(v.current)}
                    >
                      {formatValue(v.current)}
                      {v.adjusted && (
                        <span className="ml-2 rounded-full bg-warning/20 px-1.5 text-[10px] font-medium text-warning-foreground">
                          {t("pages.processViewPrototype.variables.adjusted")}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right">
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
                              <span className="w-12 text-right text-muted-foreground">
                                #{h.seq}
                              </span>
                              <span className="w-56 truncate text-muted-foreground">
                                {h.nodeId}
                              </span>
                              <span className="truncate">{formatValue(h.value)}</span>
                              {h.adjusted && (
                                <span className="text-warning-foreground">
                                  {t("pages.processViewPrototype.variables.adjusted")}
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
            </tbody>
          </table>
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center gap-1.5 border-t px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground">
              {t("pages.processViewPrototype.variables.outputs", { count: outputs.length })}
              <ChevronDown
                className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
                aria-hidden="true"
              />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <ul className="max-h-64 divide-y overflow-y-auto border-t font-mono text-[11px]">
                {outputs.map((o) => (
                  <li key={o.name} className="flex gap-3 px-3 py-1" data-output={o.name}>
                    <span className="w-72 shrink-0 truncate">{o.name}</span>
                    <span className="truncate text-muted-foreground" title={formatValue(o.current)}>
                      {formatValue(o.current)}
                    </span>
                  </li>
                ))}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </div>

        <aside
          className="space-y-3 rounded-lg border border-warning/50 bg-warning/5 p-3 text-sm"
          data-testid="runtime-adjust"
        >
          <p className="flex items-center gap-1.5 font-semibold">
            <SlidersHorizontal className="size-4 text-warning-foreground" aria-hidden="true" />
            {t("pages.processViewPrototype.variables.adjustTitle")}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("pages.processViewPrototype.variables.adjustBody")}
          </p>
          <div className="space-y-1.5">
            <p className="text-xs font-medium">
              {t("pages.processViewPrototype.variables.setValue")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              <Select value={overrideName} onValueChange={setOverrideName}>
                <SelectTrigger className="h-8 w-[150px] text-xs" data-testid="adjust-variable">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {variables.map((v) => (
                    <SelectItem key={v.name} value={v.name}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={overrideValue}
                onChange={(e) => setOverrideValue(e.target.value)}
                placeholder={t("pages.processViewPrototype.variables.newValue")}
                className="h-8 w-[120px] text-xs"
                data-testid="adjust-value"
              />
              <button
                type="button"
                className="h-8 rounded-md border bg-background px-2 text-xs font-medium hover:bg-accent disabled:opacity-40"
                disabled={!overrideName || overrideValue.trim() === ""}
                onClick={() => {
                  onAdjust({
                    ...adjustments,
                    overrides: { ...adjustments.overrides, [overrideName]: parse(overrideValue) },
                  });
                  setOverrideValue("");
                }}
                data-testid="adjust-apply"
              >
                {t("pages.processViewPrototype.variables.apply")}
              </button>
            </div>
          </div>
          {waitingNode && (
            <div className="space-y-1.5" data-testid="adjust-decision">
              <p className="text-xs font-medium">
                {t("pages.processViewPrototype.variables.decideAt", { node: waitingNode.id })}
              </p>
              {(waitingNode.inputs ?? []).map((field) => (
                <label key={field} className="flex items-center gap-2 text-xs">
                  <span className="w-36 truncate font-mono">{field}</span>
                  <Input
                    value={decision[field] ?? ""}
                    onChange={(e) => setDecision({ ...decision, [field]: e.target.value })}
                    className="h-7 text-xs"
                    disabled={!canDecide}
                    data-testid={`decision-${field}`}
                  />
                </label>
              ))}
              <button
                type="button"
                className="h-8 rounded-md border bg-background px-2 text-xs font-medium hover:bg-accent disabled:opacity-40"
                disabled={!canDecide || Object.values(decision).every((v) => !v.trim())}
                onClick={() =>
                  onAdjust({
                    ...adjustments,
                    decision: Object.fromEntries(
                      Object.entries(decision)
                        .filter(([, v]) => v.trim())
                        .map(([k, v]) => [k, parse(v)]),
                    ),
                  })
                }
                data-testid="decision-apply"
              >
                {t("pages.processViewPrototype.variables.decide")}
              </button>
            </div>
          )}
          <div className="flex items-center justify-between border-t pt-2 text-xs">
            <span data-testid="adjust-count">
              {t("pages.processViewPrototype.variables.adjustCount", {
                count: countAdjustments(adjustments),
              })}
            </span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 hover:bg-accent disabled:opacity-40"
              disabled={countAdjustments(adjustments) === 0}
              onClick={() => onAdjust({ overrides: {}, decision: null })}
              data-testid="adjust-reset"
            >
              <Undo2 className="size-3" aria-hidden="true" />
              {t("pages.processViewPrototype.variables.revert")}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** One line inside a block's detail: what the block wrote and what it read, from the trace. */
export function BlockVariables({
  projection,
  trace,
  cursor,
  blockId,
  className,
}: {
  projection: ProcessProjection;
  trace: RunTrace | null | undefined;
  cursor: number | null | undefined;
  blockId: string;
  className?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const usage = useMemo(
    () => (trace ? blockVariableUsage(projection, trace, blockId, cursor ?? undefined) : null),
    [projection, trace, blockId, cursor],
  );
  if (!usage || (usage.writes.length === 0 && usage.reads.length === 0)) return null;
  // The latest write per name, so a repeated block shows its current values, not every pass.
  const latest = new Map<string, (typeof usage.writes)[number]>();
  for (const w of usage.writes) latest.set(w.name, w);
  return (
    <div
      className={cn("flex flex-wrap items-center gap-1 text-[11px]", className)}
      data-testid={`block-variables-${blockId}`}
    >
      {latest.size > 0 && (
        <span className="mr-1 text-muted-foreground">
          {t("pages.processViewPrototype.variables.wrote")}
        </span>
      )}
      {[...latest.values()].map((w) => (
        <span
          key={w.name}
          className={cn(
            "inline-flex max-w-[280px] items-center gap-1 truncate rounded-md border bg-background px-1.5 font-mono leading-5",
            w.adjusted && "border-warning bg-warning/10",
          )}
          title={`${w.name} = ${formatValue(w.value)} (#${w.seq})`}
          data-block-write={w.name}
          data-block-write-value={formatValue(w.value)}
        >
          <span className="text-muted-foreground">{w.name}</span>
          <span>= {formatValue(w.value)}</span>
          <span className="text-muted-foreground">#{w.seq}</span>
        </span>
      ))}
      {usage.reads.length > 0 && (
        <span className="ml-2 mr-1 text-muted-foreground">
          {t("pages.processViewPrototype.variables.read")}
        </span>
      )}
      {usage.reads.map((r) => (
        <span
          key={r}
          className="rounded-md bg-muted px-1.5 font-mono leading-5 text-muted-foreground"
          data-block-read={r}
        >
          {r}
        </span>
      ))}
    </div>
  );
}
