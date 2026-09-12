/**
 * "Explain this page" — Moira explained on the live run.
 *
 * A short sequence of anchored steps for a newcomer: each step defines one term (block, step,
 * evidence, loop, run) and highlights the element on the page that shows it, in whichever mode
 * is open; when the open mode has nothing to point at, the step switches to a mode that does.
 * The step lives in the URL (`guide=N`) so it can be linked and reopened. Highlighting is a ring
 * drawn around the target element; nothing else on the page changes.
 */

import React, { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, Compass, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RunViewMode } from "./modes";

export type PanelTab = "block" | "variables" | "context" | "errors" | "steps" | "graph" | "locks";

/** One anchored step of a walkthrough; `M` is the page's mode id type. */
export interface GuideStep<M extends string = RunViewMode, P extends string = PanelTab> {
  id: string;
  /** Selector per mode; a mode without one switches to `fallbackView`. */
  targets: Partial<Record<M, string>>;
  fallbackView: M;
  /** The step needs a recorded route. */
  needsRoute?: boolean;
  /** The step needs the current block selected and its panel open. */
  needsCurrentBlock?: boolean;
  /** The panel tab the step opens. */
  panel?: P;
}

const ANY_MODE = (selector: string): Partial<Record<RunViewMode, string>> => ({
  lanes: selector,
  canvas: selector,
  outline: selector,
  route: selector,
});

/** The run page's steps: block, step, evidence, loop, route, explore. */
export const GUIDE_STEPS: GuideStep[] = [
  {
    id: "process",
    targets: {
      lanes: "[data-lane-index]",
      canvas: "[data-block-id]",
      outline: "section[data-block-id]",
      route: '[data-testid="route-block-summary"]',
    },
    fallbackView: "lanes",
  },
  {
    id: "agent",
    targets: ANY_MODE('[data-testid="block-detail"] [data-node-id][aria-current="step"]'),
    fallbackView: "lanes",
    needsCurrentBlock: true,
    panel: "block",
  },
  {
    id: "evidence",
    targets: ANY_MODE(
      '[data-testid="block-detail"] [data-node-id][aria-current="step"] [data-node-inputs]',
    ),
    fallbackView: "lanes",
    needsCurrentBlock: true,
    panel: "block",
  },
  {
    id: "loop",
    targets: {
      canvas: "[data-return-chip]",
      lanes: "[data-return-chip]",
      outline: '[data-transition-kind="cycle"]',
      route: "[data-loop-marker]",
    },
    fallbackView: "lanes",
  },
  {
    id: "route",
    targets: { route: '[data-testid="route-list"]' },
    fallbackView: "route",
    needsRoute: true,
    panel: "variables",
  },
  {
    id: "explore",
    targets: ANY_MODE('[data-testid="run-modes"]'),
    fallbackView: "lanes",
  },
];

const HIGHLIGHT_STYLE =
  "0 0 0 3px var(--primary), 0 0 0 7px color-mix(in oklab, var(--primary) 25%, transparent)";

export function Walkthrough<M extends string = RunViewMode, P extends string = PanelTab>({
  step,
  mode,
  currentBlockId,
  routeRecorded,
  onNavigate,
  onPanel,
  steps = GUIDE_STEPS as unknown as GuideStep<M, P>[],
  textKey = "pages.runPage.guide",
}: {
  /** 1-based step from the URL; 0 or absent means closed. */
  step: number;
  mode: M;
  currentBlockId: string | null;
  routeRecorded: boolean;
  onNavigate: (patch: Record<string, string | null>) => void;
  onPanel: (tab: P) => void;
  /** The page's steps; the run page's by default. */
  steps?: GuideStep<M, P>[];
  /** i18n prefix holding `title`, `open`, `back`, `next`, `finish`, `close` and `steps.<id>`. */
  textKey?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const index = Math.min(Math.max(step, 0), steps.length) - 1;
  const current = index >= 0 ? steps[index] : null;

  // Bring the page into the state the step needs: the right mode, the current block, the panel.
  useEffect(() => {
    if (!current) return;
    const patch: Record<string, string | null> = {};
    if (
      !current.targets[mode] ||
      (current.needsRoute && !routeRecorded && mode !== current.fallbackView)
    )
      patch.view = current.fallbackView;
    if (current.needsCurrentBlock && currentBlockId) patch.block = currentBlockId;
    if (Object.keys(patch).length) onNavigate(patch);
    if (current.panel) onPanel(current.panel);
  }, [current, mode, routeRecorded, currentBlockId, onNavigate, onPanel]);

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
      if (element || tries > 30) {
        window.clearInterval(timer);
        if (!element) return;
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
  }, [current, mode]);

  if (!current) return null;
  const total = steps.length;
  return (
    <aside
      role="dialog"
      aria-label={t(`${textKey}.title`)}
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
            {t(`${textKey}.title`)} · {index + 1}/{total}
          </p>
          <h2 className="mt-0.5 text-base font-semibold leading-6">
            {t(`${textKey}.steps.${current.id}.title`)}
          </h2>
          <p
            className="mt-1 text-sm leading-6 text-muted-foreground"
            data-testid="walkthrough-body"
          >
            {t(`${textKey}.steps.${current.id}.body`)}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onNavigate({ guide: null })}
          className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t(`${textKey}.close`)}
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
          {t(`${textKey}.back`)}
        </button>
        <div className="flex gap-1" aria-hidden="true">
          {steps.map((s, i) => (
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
            {t(`${textKey}.next`)}
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onNavigate({ guide: null })}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            data-testid="walkthrough-finish"
          >
            {t(`${textKey}.finish`)}
          </button>
        )}
      </div>
    </aside>
  );
}
