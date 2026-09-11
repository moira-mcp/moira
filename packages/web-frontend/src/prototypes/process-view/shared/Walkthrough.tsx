/**
 * The explanatory walkthrough — Moira explained on the live process.
 *
 * A short sequence of anchored steps for a newcomer: each step defines one term (block, step,
 * evidence, loop, trace) and highlights the element on the page that shows it, in whichever mode
 * is open; when the open mode has nothing to point at, the step switches to a mode that does. The
 * step lives in the URL (`guide=N`) so it can be linked and reopened. Highlighting is a ring drawn
 * around the target element; nothing else on the page changes.
 */

import React, { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Compass, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ViewMode } from "../modes";
import type { ProcessProjection } from "../model";
import { runStateOf } from "../model";

export interface GuideStep {
  id: "process" | "agent" | "evidence" | "loop" | "trace" | "explore";
  /** Selector per mode; a mode without one switches to `fallbackView`. */
  targets: Partial<Record<ViewMode, string>>;
  fallbackView: ViewMode;
  /** The step needs a run selected. */
  needsTrace?: boolean;
  /** The step needs the active block selected (so its nodes are expanded). */
  needsActiveBlock?: boolean;
  /** The step needs the variables panel open. */
  opensVariables?: boolean;
}

export const GUIDE_STEPS: GuideStep[] = [
  {
    id: "process",
    targets: {
      canvas: "[data-block-id]",
      lanes: "[data-lane-index]",
      outline: "section[data-block-id]",
      split: '[data-testid="split-blocks"]',
      trace: '[data-testid="trace-block-summary"]',
    },
    fallbackView: "lanes",
  },
  {
    id: "agent",
    targets: {
      canvas: '[data-block-id][data-status="active"], [data-block-id][data-status="waiting"]',
      lanes: '[data-lane-index][data-status="active"], [data-lane-index][data-status="waiting"]',
      outline: '[data-node-id][aria-current="step"]',
      split: '[data-testid="split-nodes"] [data-node-id][aria-current="step"]',
      trace: '[data-testid="trace-route"] [data-visit-seq]:last-of-type',
    },
    fallbackView: "outline",
    needsTrace: true,
    needsActiveBlock: true,
  },
  {
    id: "evidence",
    targets: {
      outline: '[data-node-id][aria-current="step"] [data-node-inputs]',
      split: '[data-testid="split-nodes"] [data-node-id][aria-current="step"] [data-node-inputs]',
    },
    fallbackView: "split",
    needsTrace: true,
    needsActiveBlock: true,
  },
  {
    id: "loop",
    targets: {
      canvas: '[data-edge-kind="cycle"]',
      lanes: "[data-arc]",
      outline: '[data-transition-kind="cycle"]',
      trace: "[data-loop-marker]",
    },
    fallbackView: "lanes",
    needsTrace: true,
  },
  {
    id: "trace",
    targets: { trace: '[data-testid="trace-route"]' },
    fallbackView: "trace",
    needsTrace: true,
    opensVariables: true,
  },
  {
    id: "explore",
    targets: {
      canvas: '[role="tablist"]',
      lanes: '[role="tablist"]',
      outline: '[role="tablist"]',
      split: '[role="tablist"]',
      trace: '[role="tablist"]',
    },
    fallbackView: "canvas",
  },
];

const HIGHLIGHT_STYLE =
  "0 0 0 3px var(--primary), 0 0 0 7px color-mix(in oklab, var(--primary) 25%, transparent)";

export function Walkthrough({
  step,
  mode,
  projection,
  hasTrace,
  defaultTraceId,
  onNavigate,
}: {
  /** 1-based step from the URL; 0 or absent means closed. */
  step: number;
  mode: ViewMode;
  projection: ProcessProjection;
  hasTrace: boolean;
  defaultTraceId: string;
  onNavigate: (patch: Record<string, string | null>) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const index = Math.min(Math.max(step, 0), GUIDE_STEPS.length) - 1;
  const current = index >= 0 ? GUIDE_STEPS[index] : null;
  const activeBlockId = useMemo(
    () =>
      projection.blocks.find((b) =>
        ["active", "waiting"].includes(runStateOf(projection, b.id).status),
      )?.id ?? null,
    [projection],
  );

  // Bring the page into the state the step needs: a run, the active block, the right mode.
  useEffect(() => {
    if (!current) return;
    const patch: Record<string, string | null> = {};
    if (current.needsTrace && !hasTrace) patch.trace = defaultTraceId;
    if (!current.targets[mode]) patch.view = current.fallbackView;
    if (current.needsActiveBlock && activeBlockId) patch.block = activeBlockId;
    if (Object.keys(patch).length) onNavigate(patch);
  }, [current, mode, hasTrace, defaultTraceId, activeBlockId, onNavigate]);

  // Highlight the target once the page has rendered it.
  useEffect(() => {
    if (!current) return;
    const selector = current.targets[mode];
    if (!selector) return;
    let element: HTMLElement | null = null;
    let tries = 0;
    const timer = window.setInterval(() => {
      element = document.querySelector<HTMLElement>(selector);
      tries += 1;
      if (element || tries > 20) {
        window.clearInterval(timer);
        if (!element) return;
        if (current.opensVariables) {
          const trigger = document.querySelector<HTMLElement>(
            '[data-testid="variables-section"] > button[data-state="closed"]',
          );
          trigger?.click();
        }
        element.dataset.guideTarget = current.id;
        element.style.boxShadow = HIGHLIGHT_STYLE;
        element.style.borderRadius = element.style.borderRadius || "8px";
        element.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    }, 100);
    return () => {
      window.clearInterval(timer);
      if (element) {
        delete element.dataset.guideTarget;
        element.style.boxShadow = "";
      }
    };
  }, [current, mode, hasTrace]);

  if (!current) return null;
  const total = GUIDE_STEPS.length;
  return (
    <aside
      role="dialog"
      aria-label={t("pages.processViewPrototype.guideTour.title")}
      data-testid="walkthrough"
      data-guide-step={current.id}
      className={cn(
        "fixed bottom-4 right-4 z-40 w-[380px] max-w-[calc(100vw-2rem)] rounded-xl border bg-card p-4 shadow-xl",
      )}
    >
      <div className="flex items-start gap-2">
        <Compass className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {t("pages.processViewPrototype.guideTour.title")} · {index + 1}/{total}
          </p>
          <h2 className="mt-0.5 text-base font-semibold leading-6">
            {t(`pages.processViewPrototype.guideTour.steps.${current.id}.title`)}
          </h2>
          <p
            className="mt-1 text-sm leading-6 text-muted-foreground"
            data-testid="walkthrough-body"
          >
            {t(`pages.processViewPrototype.guideTour.steps.${current.id}.body`)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate({ guide: null })}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t("pages.processViewPrototype.guideTour.close")}
          data-testid="walkthrough-close"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <button
          type="button"
          disabled={index === 0}
          onClick={() => onNavigate({ guide: String(index) })}
          className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-40"
          data-testid="walkthrough-back"
        >
          <ChevronLeft className="size-3.5" aria-hidden="true" />
          {t("pages.processViewPrototype.guideTour.back")}
        </button>
        <div className="flex gap-1" aria-hidden="true">
          {GUIDE_STEPS.map((s, i) => (
            <span
              key={s.id}
              className={cn("size-1.5 rounded-full", i === index ? "bg-primary" : "bg-border")}
            />
          ))}
        </div>
        {index < total - 1 ? (
          <button
            type="button"
            onClick={() => onNavigate({ guide: String(index + 2) })}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="walkthrough-next"
          >
            {t("pages.processViewPrototype.guideTour.next")}
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onNavigate({ guide: null })}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="walkthrough-finish"
          >
            {t("pages.processViewPrototype.guideTour.finish")}
          </button>
        )}
      </div>
    </aside>
  );
}
