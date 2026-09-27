/**
 * The shape of a guide: one declaration per screen tour, task tour or tutorial, kept beside the
 * page it explains. A declaration is data only — the runner decides how to bring the page into the
 * state a step needs, where the step's element is, and how the step is shown — so a guide can be
 * read, checked and snapshotted without mounting anything.
 */

import type { BeginnerPanel } from "../components/onboarding/beginnerPanels";

/**
 * A screen tour explains a routed screen; a task tour one task on it, started from its section; a
 * tutorial has lessons. A fallback stands in for a screen's tour the full tour cannot show — the
 * run page for a reader with no run.
 */
export type GuideKind = "screen" | "task" | "tutorial" | "fallback";

/**
 * Who a step is shown to. `owner` and `reader` split a screen whose controls differ by whether the
 * person owns what is shown; `any` is everyone who can open the screen.
 */
export type GuideRole = "any" | "owner" | "reader";

export interface GuideStep {
  /** Stable within the guide: it keys the copy, the progress and the snapshot. */
  id: string;
  /**
   * The anchor the step points at, written in the page as `guideAnchor("<anchor>")`. A screen whose
   * views draw the same thing differently names one anchor per view; the keys are then the views
   * that draw it.
   */
  anchor: string | Record<string, string>;
  /** Whether the reader looks at the element or does something with it; both advance on Next. */
  kind: "look" | "do";
  /** Raised by the step's author when the control it explains or the meaning of its copy changes. */
  revision: number;
  /** Skipped, with a note, when its element is still absent after the wait (a hidden beginner panel). */
  optional?: boolean;
  /**
   * What tells, before looking, that an optional step's element is not on the page: the beginner
   * panel it sits in is hidden, or the query parameter its view is opened with is missing. The step
   * is then skipped at once instead of waited for.
   */
  absentWhen?: { panelHidden?: BeginnerPanel; queryMissing?: string };
  /**
   * Views that draw a single anchor; absent means every view. With per-view anchors the views are
   * the keys. Either way the first listed view is where the step goes when the open view lacks it.
   */
  views?: string[];
  /** The anchor exists only at the `md` breakpoint and wider. */
  wide?: boolean;
  /** Who sees the step; everyone when absent. */
  roles?: GuideRole;
  /**
   * What the page must show first: a panel tab, an unfolded section, the current block, a route —
   * or the app sidebar, for a step whose element is in it (on a phone the sidebar is a closed sheet).
   */
  prepare?: {
    panel?: string;
    section?: string;
    currentBlock?: boolean;
    route?: boolean;
    sidebar?: boolean;
    /** A node that names a playbook, selected so the panel shows its references. */
    playbookNode?: boolean;
  };
}

export interface GuideDefinition {
  id: string;
  kind: GuideKind;
  /** The screen the guide runs on; its page registers the controller under this id. */
  screen: string;
  /** Route patterns (react-router syntax) of the screen, for "What is this?" and the menu. */
  routes: string[];
  /** The views the screen has, in its own ids; absent for a single-view screen. */
  views?: string[];
  /** Panel tabs and foldable sections the screen can open for a step. */
  panels?: string[];
  sections?: string[];
  steps: GuideStep[];
}

/** The anchor a step points at in a given view, or null when that view does not draw it. */
export function anchorIn(step: GuideStep, view: string | undefined): string | null {
  if (typeof step.anchor !== "string") return (view && step.anchor[view]) || null;
  if (!step.views || view === undefined) return step.anchor;
  return step.views.includes(view) ? step.anchor : null;
}

/** The view a step moves to when the open one does not draw it. */
export function fallbackView(step: GuideStep): string | undefined {
  return typeof step.anchor === "string" ? step.views?.[0] : Object.keys(step.anchor)[0];
}

/** Every anchor name a step uses, whatever the view. */
export function anchorsOf(step: GuideStep): string[] {
  return typeof step.anchor === "string" ? [step.anchor] : [...new Set(Object.values(step.anchor))];
}
