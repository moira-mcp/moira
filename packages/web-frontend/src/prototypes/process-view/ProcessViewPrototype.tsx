/**
 * Prototype host for the aggregated process view (#180).
 *
 * Selects the variant and the fixture from the URL (`?view=…&fixture=…`) and mirrors both in
 * on-screen controls, so any state is deep-linkable and the browser's back button returns to the
 * previous one. Unknown values resolve to defaults instead of failing.
 */

import React, { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ChevronDown, GitCompareArrows } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { DEFAULT_FIXTURE, FIXTURES, isFixtureId, type FixtureId } from "./fixtures";
import { DEFAULT_SOURCE, WORKFLOWS, isSourceId, type SourceId } from "./fixtures/derived";
import { compareProjections, deriveProjection } from "./derive";
import { TRACES, findTrace } from "./traces";
import { runStateFromTrace } from "./trace";
import { EditingProvider, applyEdits, countEdits, exportDiff, useFlowEdits } from "./editing";
import { PencilLine, RotateCcw, Variable } from "lucide-react";
import { VariablesPanel } from "./shared/VariablesPanel";
import { Walkthrough } from "./shared/Walkthrough";
import { Compass } from "lucide-react";
import {
  NO_ADJUSTMENTS,
  applyAdjustments,
  countAdjustments,
  type RuntimeAdjustments,
} from "./variables";
import { GuidanceCallout, GuidanceHint } from "./shared/Guidance";
import { cn } from "@/lib/utils";
import { MODES, resolveMode, type ViewMode } from "./modes";
import { validateProjection } from "./model";
import { StatusLegend } from "./shared/status";

const VIEW_PARAM = "view";
const FIXTURE_PARAM = "fixture";
const BLOCK_PARAM = "block";
const SOURCE_PARAM = "source";
const TRACE_PARAM = "trace";
const AT_PARAM = "at";
const EDIT_PARAM = "edit";
const GUIDE_PARAM = "guide";

export function ProcessViewPrototype(): React.JSX.Element {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();

  const mode: ViewMode = resolveMode(searchParams.get(VIEW_PARAM));
  const fixtureParam = searchParams.get(FIXTURE_PARAM);
  const fixtureId: FixtureId = isFixtureId(fixtureParam) ? fixtureParam : DEFAULT_FIXTURE;
  const sourceParam = searchParams.get(SOURCE_PARAM);
  const source: SourceId = isSourceId(sourceParam) ? sourceParam : DEFAULT_SOURCE;
  const fixtureProjection = FIXTURES[fixtureId];
  // Authoring edits live in memory and apply to the annotated flow before derivation.
  const editing = searchParams.get(EDIT_PARAM) === "1";
  const [edits, setEdits] = useFlowEdits();
  const edited = useMemo(
    () => applyEdits(WORKFLOWS[fixtureId].workflow, WORKFLOWS[fixtureId].authored, edits),
    [fixtureId, edits],
  );
  const diff = useMemo(
    () => exportDiff(WORKFLOWS[fixtureId].workflow, WORKFLOWS[fixtureId].authored, edits),
    [fixtureId, edits],
  );
  // The derived model is built from the annotated flow snapshot; the fixture's run map is reused
  // so both sources show the same run and only the structure is compared.
  const derivation = useMemo(
    () => deriveProjection(edited.workflow, edited.authored, fixtureProjection.run),
    [edited, fixtureProjection],
  );
  const structure = source === "derived" ? derivation.projection : fixtureProjection;
  // A selected trace replaces the hand-written run map: block states come from the simulated run.
  const baseTrace = findTrace(fixtureId, searchParams.get(TRACE_PARAM));
  // Runtime adjustments act on the run only; they live in memory and are reset with the trace.
  const [adjustments, setAdjustments] = React.useState<RuntimeAdjustments>(NO_ADJUSTMENTS);
  const traceKey = `${fixtureId}/${baseTrace?.id ?? ""}`;
  const [adjustedKey, setAdjustedKey] = React.useState(traceKey);
  if (adjustedKey !== traceKey) {
    setAdjustedKey(traceKey);
    setAdjustments(NO_ADJUSTMENTS);
  }
  const trace = useMemo(
    () => (baseTrace ? applyAdjustments(edited.authored, baseTrace, adjustments) : null),
    [baseTrace, adjustments, edited],
  );
  const atParam = Number(searchParams.get(AT_PARAM));
  const cursor =
    trace && searchParams.has(AT_PARAM) && Number.isInteger(atParam)
      ? Math.min(Math.max(atParam, 0), trace.visits.length - 1)
      : null;
  const projection = useMemo(
    () =>
      trace
        ? { ...structure, run: runStateFromTrace(structure, trace, cursor ?? undefined) }
        : structure,
    [structure, trace, cursor],
  );
  const differences = useMemo(
    () => compareProjections(fixtureProjection, derivation.projection),
    [fixtureProjection, derivation],
  );
  const blockParam = searchParams.get(BLOCK_PARAM);
  const selectedBlockId = projection.blocks.some((b) => b.id === blockParam) ? blockParam : null;

  const issues = useMemo(
    () => [
      ...validateProjection(projection).map((i) => `${i.kind}: ${i.detail}`),
      ...(source === "derived" ? derivation.diagnostics.map((i) => `${i.kind}: ${i.detail}`) : []),
    ],
    [projection, source, derivation],
  );

  const update = useCallback(
    (
      patch: Partial<
        Record<
          | typeof VIEW_PARAM
          | typeof FIXTURE_PARAM
          | typeof BLOCK_PARAM
          | typeof SOURCE_PARAM
          | typeof TRACE_PARAM
          | typeof AT_PARAM
          | typeof EDIT_PARAM
          | typeof GUIDE_PARAM,
          string | null
        >
      >,
    ) => {
      // Radix tabs report a value on focus and again on click, both before React re-renders, so
      // the hook's `searchParams` is stale for the second call. Compare against the live URL:
      // a duplicate navigation would push a second history entry and make Back appear inert.
      const current = new URLSearchParams(window.location.search);
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined) next.delete(key);
        else next.set(key, value);
      }
      if (next.toString() === current.toString()) return;
      setSearchParams(next);
    },
    [setSearchParams],
  );

  const active = MODES.find((m) => m.id === mode) ?? MODES[0];
  const Variant = active.component;

  return (
    <div className="space-y-6 p-6" data-testid="process-view-prototype">
      <header className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">
              {t("pages.processViewPrototype.title")}
            </h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              {t("pages.processViewPrototype.subtitle")}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => update({ [GUIDE_PARAM]: "1" })}
              className="inline-flex items-center gap-1.5 rounded-lg border bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="guide-open"
            >
              <Compass className="size-3.5" aria-hidden="true" />
              {t("pages.processViewPrototype.guideTour.open")}
            </button>
            <Badge
              variant="outline"
              className={
                issues.length
                  ? "border-destructive text-destructive"
                  : "border-success/60 text-success"
              }
              data-testid="fixture-validity"
              title={issues.join("\n")}
            >
              {issues.length ? (
                <AlertTriangle className="mr-1 size-3.5" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="mr-1 size-3.5" aria-hidden="true" />
              )}
              {issues.length
                ? t("pages.processViewPrototype.fixtureIssues", { count: issues.length })
                : t("pages.processViewPrototype.fixtureComplete")}
            </Badge>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={mode} onValueChange={(value) => update({ [VIEW_PARAM]: value })}>
            <TabsList aria-label={t("pages.processViewPrototype.modeLabel")}>
              {MODES.map((definition) => {
                const Icon = definition.icon;
                return (
                  <TabsTrigger key={definition.id} value={definition.id} data-mode={definition.id}>
                    <Icon aria-hidden="true" />
                    {t(`pages.processViewPrototype.modes.${definition.labelKey}`)}
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </Tabs>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={editing}
              data-testid="edit-toggle"
              onClick={() =>
                update(
                  editing
                    ? { [EDIT_PARAM]: null }
                    : { [EDIT_PARAM]: "1", [SOURCE_PARAM]: "derived" },
                )
              }
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                editing
                  ? "border-warning bg-warning/15 text-warning-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <PencilLine className="size-3.5" aria-hidden="true" />
              {t(
                editing
                  ? "pages.processViewPrototype.edit.on"
                  : "pages.processViewPrototype.edit.off",
              )}
            </button>
            <GuidanceHint label={t("pages.processViewPrototype.edit.hintLabel")}>
              {t("pages.processViewPrototype.edit.hint")}
            </GuidanceHint>
            <span className="ml-2 text-sm text-muted-foreground">
              {t("pages.processViewPrototype.source.label")}
            </span>
            <div
              role="radiogroup"
              aria-label={t("pages.processViewPrototype.source.label")}
              className="inline-flex rounded-lg border bg-muted p-0.5"
              data-testid="source-switch"
            >
              {(["fixture", "derived"] as SourceId[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={source === id}
                  data-source={id}
                  onClick={() => update({ [SOURCE_PARAM]: id === DEFAULT_SOURCE ? null : id })}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    source === id
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t(`pages.processViewPrototype.source.${id}`)}
                </button>
              ))}
            </div>
            <GuidanceHint label={t("pages.processViewPrototype.source.hintLabel")}>
              {t("pages.processViewPrototype.source.hint")}
            </GuidanceHint>
            <span className="ml-2 text-sm text-muted-foreground">
              {t("pages.processViewPrototype.fixtureLabel")}
            </span>
            <Select
              value={fixtureId}
              onValueChange={(value) =>
                update({
                  [FIXTURE_PARAM]: value,
                  [BLOCK_PARAM]: null,
                  [TRACE_PARAM]: null,
                  [AT_PARAM]: null,
                })
              }
            >
              <SelectTrigger
                className="w-[260px]"
                aria-label={t("pages.processViewPrototype.fixtureLabel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(FIXTURES) as FixtureId[]).map((id) => (
                  <SelectItem key={id} value={id}>
                    {FIXTURES[id].title}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t("pages.processViewPrototype.fixtureSize", {
                        blocks: FIXTURES[id].blocks.length,
                        nodes: FIXTURES[id].authored.length,
                      })}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2" data-testid="trace-row">
          <span className="text-sm text-muted-foreground">
            {t("pages.processViewPrototype.trace.label")}
          </span>
          <Select
            value={trace?.id ?? "__fixture"}
            onValueChange={(value) =>
              update({ [TRACE_PARAM]: value === "__fixture" ? null : value, [AT_PARAM]: null })
            }
          >
            <SelectTrigger
              className="w-[420px] max-w-full"
              aria-label={t("pages.processViewPrototype.trace.label")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__fixture">
                {t("pages.processViewPrototype.trace.handWritten")}
              </SelectItem>
              {TRACES[fixtureId].map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.title}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t("pages.processViewPrototype.trace.visits", {
                      count: candidate.visits.length,
                    })}
                    {" · "}
                    {t(`pages.processViewPrototype.trace.status.${candidate.status}`)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <GuidanceHint label={t("pages.processViewPrototype.trace.hintLabel")}>
            {t("pages.processViewPrototype.trace.hint")}
          </GuidanceHint>
          {trace && (
            <p className="basis-full text-sm text-muted-foreground" data-testid="trace-description">
              {trace.description}
            </p>
          )}
          {trace && (
            <div
              className="flex basis-full flex-wrap items-center gap-2 rounded-lg border bg-card px-3 py-2"
              data-testid="trace-scrubber"
            >
              <button
                type="button"
                className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40"
                disabled={cursor !== null && cursor <= 0}
                onClick={() =>
                  update({
                    [AT_PARAM]: String(Math.max(0, (cursor ?? trace.visits.length - 1) - 1)),
                  })
                }
                aria-label={t("pages.processViewPrototype.traceView.prev")}
              >
                ‹
              </button>
              <input
                type="range"
                min={0}
                max={trace.visits.length - 1}
                value={cursor ?? trace.visits.length - 1}
                onChange={(e) => update({ [AT_PARAM]: e.target.value })}
                className="h-1.5 min-w-[160px] flex-1 cursor-pointer accent-primary"
                aria-label={t("pages.processViewPrototype.traceView.scrub")}
                data-testid="trace-range"
              />
              <button
                type="button"
                className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40"
                disabled={cursor === null || cursor >= trace.visits.length - 1}
                onClick={() =>
                  update({
                    [AT_PARAM]: String(Math.min(trace.visits.length - 1, (cursor ?? 0) + 1)),
                  })
                }
                aria-label={t("pages.processViewPrototype.traceView.next")}
              >
                ›
              </button>
              <span
                className="text-xs tabular-nums text-muted-foreground"
                data-testid="trace-position"
              >
                {cursor === null
                  ? t("pages.processViewPrototype.traceView.wholeRun", {
                      count: trace.visits.length,
                    })
                  : t("pages.processViewPrototype.traceView.position", {
                      at: cursor,
                      total: trace.visits.length - 1,
                      node: trace.visits[cursor]?.nodeId ?? "",
                    })}
              </span>
              {cursor !== null && (
                <button
                  type="button"
                  className="text-xs text-primary hover:underline"
                  onClick={() => update({ [AT_PARAM]: null })}
                >
                  {t("pages.processViewPrototype.traceView.clearCursor")}
                </button>
              )}
              <GuidanceHint label={t("pages.processViewPrototype.traceView.scrubHintLabel")}>
                {t("pages.processViewPrototype.traceView.scrubHint")}
              </GuidanceHint>
            </div>
          )}
        </div>

        {editing && (
          <div
            className="space-y-2 rounded-lg border border-warning/50 bg-warning/5 px-3 py-2"
            data-testid="edit-panel"
          >
            <GuidanceCallout
              title={t("pages.processViewPrototype.edit.guideTitle")}
              testId="guidance-edit"
              className="border-warning/40 bg-transparent"
            >
              {t("pages.processViewPrototype.edit.guideBody")}
            </GuidanceCallout>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <span data-testid="edit-count">
                {t("pages.processViewPrototype.edit.count", { count: countEdits(edits) })}
              </span>
              <button
                type="button"
                onClick={() => setEdits({ blocks: {}, labels: {}, ownership: {} })}
                disabled={countEdits(edits) === 0}
                className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:bg-accent disabled:opacity-40"
                data-testid="edit-reset"
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                {t("pages.processViewPrototype.edit.reset")}
              </button>
              {derivation.diagnostics.length > 0 && (
                <ul
                  className="basis-full space-y-0.5 text-xs text-destructive"
                  data-testid="edit-diagnostics"
                >
                  {derivation.diagnostics.map((d, i) => (
                    <li key={i}>
                      <span className="font-mono">{d.kind}</span>: {d.detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <Collapsible data-testid="edit-export">
              <CollapsibleTrigger className="group inline-flex items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {t("pages.processViewPrototype.edit.export", { count: diff.length })}
                <ChevronDown
                  className="size-4 transition-transform group-data-[state=open]:rotate-180"
                  aria-hidden="true"
                />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("pages.processViewPrototype.edit.exportHint")}
                </p>
                <ul className="mt-2 space-y-1 font-mono text-[11px]">
                  {diff.map((entry) => (
                    <li
                      key={entry.path}
                      className="rounded-md bg-card p-2"
                      data-export-path={entry.path}
                    >
                      <p className="font-semibold">{entry.path}</p>
                      <p className="text-destructive">- {JSON.stringify(entry.before)}</p>
                      <p className="text-success">+ {JSON.stringify(entry.after)}</p>
                    </li>
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          </div>
        )}

        {trace && (
          <Collapsible data-testid="variables-section">
            <CollapsibleTrigger className="group inline-flex items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Variable className="size-4" aria-hidden="true" />
              {t("pages.processViewPrototype.variables.title")}
              {countAdjustments(adjustments) > 0 && (
                <span className="rounded-full bg-warning/20 px-1.5 text-[10px] font-medium text-warning-foreground">
                  {t("pages.processViewPrototype.variables.adjustCount", {
                    count: countAdjustments(adjustments),
                  })}
                </span>
              )}
              <ChevronDown
                className="size-4 transition-transform group-data-[state=open]:rotate-180"
                aria-hidden="true"
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-2">
              <VariablesPanel
                trace={trace}
                cursor={cursor}
                authored={edited.authored}
                adjustments={adjustments}
                onAdjust={setAdjustments}
              />
            </CollapsibleContent>
          </Collapsible>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/30 px-3 py-2">
          <p className="text-sm">
            <span className="font-semibold">{projection.title}</span>
            {source === "derived" && (
              <span className="ml-2 rounded bg-info/10 px-1.5 py-0.5 text-[11px] font-medium text-info">
                {t("pages.processViewPrototype.source.derivedTag", {
                  version: WORKFLOWS[fixtureId].workflow.version,
                })}
              </span>
            )}
            <span className="text-muted-foreground"> — {projection.goal}</span>
          </p>
          <StatusLegend />
        </div>

        <Collapsible data-testid="source-diff">
          <CollapsibleTrigger className="group inline-flex items-center gap-1.5 rounded-md px-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <GitCompareArrows className="size-4" aria-hidden="true" />
            {t("pages.processViewPrototype.source.compare", { count: differences.length })}
            <ChevronDown
              className="size-4 transition-transform group-data-[state=open]:rotate-180"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2 space-y-2 rounded-lg border bg-card p-3 text-sm">
              <p className="text-muted-foreground">
                {t("pages.processViewPrototype.source.compareHint", {
                  version: WORKFLOWS[fixtureId].workflow.version,
                })}
              </p>
              {differences.length === 0 ? (
                <p className="font-medium text-success">
                  {t("pages.processViewPrototype.source.identical")}
                </p>
              ) : (
                <ul className="space-y-1">
                  {differences.map((d, i) => (
                    <li key={i} className="flex gap-2" data-diff-kind={d.kind}>
                      <span className="shrink-0 rounded bg-muted px-1.5 font-mono text-[11px] leading-5">
                        {d.kind}
                        {d.blockId ? ` · ${d.blockId}` : ""}
                      </span>
                      <span className="text-muted-foreground">{d.detail}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>

        <GuidanceCallout
          title={t("pages.processViewPrototype.guide.hostTitle")}
          testId="guidance-host"
        >
          {t("pages.processViewPrototype.guide.hostBody")}
        </GuidanceCallout>
      </header>

      <section
        aria-label={t(`pages.processViewPrototype.modes.${active.labelKey}`)}
        data-view={mode}
      >
        <EditingProvider enabled={editing} edits={edits} onChange={setEdits}>
          <Variant
            projection={projection}
            selectedBlockId={selectedBlockId}
            onSelectBlock={(id) => update({ [BLOCK_PARAM]: id })}
            trace={trace}
            cursor={cursor}
            onSetCursor={(at) => update({ [AT_PARAM]: at === null ? null : String(at) })}
          />
        </EditingProvider>
      </section>
      <Walkthrough
        step={Number(searchParams.get(GUIDE_PARAM)) || 0}
        mode={mode}
        projection={projection}
        hasTrace={Boolean(trace)}
        defaultTraceId={
          (
            TRACES[fixtureId].find((c) => c.status === "running" || c.status === "waiting") ??
            TRACES[fixtureId][0]
          )?.id ?? ""
        }
        onNavigate={update}
      />
    </div>
  );
}
