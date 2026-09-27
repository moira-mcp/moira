/**
 * The guide runner's state and the contract pages use to take part in guides.
 *
 * The open guide and its step live in the URL (`guide=<id>&step=<id>`), so a step can be linked and
 * survives a reload. A page that hosts guides registers a controller for its screen: the view it
 * shows, whether the reader owns what is shown, and the operations that bring the page into the
 * state a step needs. The runner itself — card, spotlight, keyboard — is loaded only when a guide is
 * open, so the rest of the app pays nothing for it.
 */

import React, {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { guideById } from "./registry";
import type { GuideDefinition, GuideStep } from "./types";

export const GUIDE_PARAM = "guide";
export const STEP_PARAM = "step";
/** A comma-separated list of step ids: the guide runs only those (the steps new to the reader). */
export const ONLY_PARAM = "only";

/** What a page tells the runner about itself, and what it lets the runner do. */
export interface GuidePageController {
  /** The view the screen shows now, in the ids its guides use; absent for a single-view screen. */
  view?: string;
  setView?: (view: string) => void;
  openPanel?: (tab: string) => void;
  openSection?: (id: string) => void;
  selectCurrentBlock?: () => void;
  /** The shown run has a recorded route; steps that need one wait for a view that draws it. */
  routeRecorded?: boolean;
  /** Whether the reader owns what the screen shows; steps are filtered by it. */
  owner?: boolean;
}

interface GuideContextValue {
  guide: GuideDefinition | undefined;
  steps: GuideStep[];
  stepId: string | null;
  /** The guide runs only some of its steps (the new ones); the full tour is one step away. */
  partial: boolean;
  controller: GuidePageController | undefined;
  /** Whether the reader owns what a screen shows, as its page reports; unknown when not mounted. */
  ownerOf: (screen: string) => boolean | undefined;
  /**
   * The layout has nothing more urgent to ask (the beta agreement, where it applies, is answered),
   * so the one-time first-run prompt may appear.
   */
  promptReady: boolean;
  /** The "Show me around" menu, which the first-run prompt opens too. */
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
  start: (guideId: string, stepId?: string, only?: readonly string[]) => void;
  /**
   * Move to a step. `replace` swaps the current history entry instead of adding one: a step passed
   * without being shown must leave no entry, or the browser's Back would land on it and pass it
   * forward again, and the reader could never go back past it.
   */
  go: (stepId: string, replace?: boolean) => void;
  close: (replace?: boolean) => void;
  register: (screen: string, controller: GuidePageController) => void;
  unregister: (screen: string, controller: GuidePageController) => void;
  announce: (message: string) => void;
}

const GuideContext = createContext<GuideContextValue | null>(null);

/** The steps a reader with this ownership sees, in order. */
export function visibleSteps(guide: GuideDefinition, owner: boolean): GuideStep[] {
  return guide.steps.filter(
    (step) => !step.roles || step.roles === "any" || (step.roles === "owner") === owner,
  );
}

const GuideRunner = lazy(() => import("./GuideRunner"));

export function GuideProvider({
  children,
  promptReady = true,
}: {
  children: React.ReactNode;
  promptReady?: boolean;
}): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const guide = guideById(searchParams.get(GUIDE_PARAM));
  const requestedStep = searchParams.get(STEP_PARAM);
  const onlyParam = searchParams.get(ONLY_PARAM);
  const [menuOpen, setMenuOpen] = useState(false);

  const controllers = useRef(new Map<string, GuidePageController>());
  const [version, setVersion] = useState(0);
  const register = useCallback((screen: string, controller: GuidePageController) => {
    controllers.current.set(screen, controller);
    setVersion((version) => version + 1);
  }, []);
  const unregister = useCallback((screen: string, controller: GuidePageController) => {
    if (controllers.current.get(screen) === controller) {
      controllers.current.delete(screen);
      setVersion((version) => version + 1);
    }
  }, []);
  const controller = guide ? controllers.current.get(guide.screen) : undefined;

  const steps = useMemo(() => {
    if (!guide) return [];
    const visible = visibleSteps(guide, controller?.owner ?? false);
    const only = onlyParam ? new Set(onlyParam.split(",")) : null;
    const chosen = only ? visible.filter((step) => only.has(step.id)) : visible;
    // A list naming no step this reader sees runs the whole guide rather than nothing.
    return chosen.length > 0 ? chosen : visible;
  }, [guide, controller?.owner, onlyParam]);
  const partial =
    !!guide && !!onlyParam && steps.length < visibleSteps(guide, controller?.owner ?? false).length;
  const ownerOf = useCallback(
    (screen: string) => {
      const controller = controllers.current.get(screen);
      return controller ? (controller.owner ?? false) : undefined;
    },
    // The controllers live in a ref; the version changes whenever one registers or leaves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  const stepId =
    guide && steps.length > 0
      ? (steps.find((step) => step.id === requestedStep)?.id ?? steps[0].id)
      : null;

  // Focus goes back to whatever opened the guide when it closes.
  const opener = useRef<HTMLElement | null>(null);

  const patch = useCallback(
    (values: Record<string, string | null>, replace = false) =>
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(values)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace },
      ),
    [setSearchParams],
  );

  const start = useCallback(
    (guideId: string, step?: string, only?: readonly string[]) => {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      patch({
        [GUIDE_PARAM]: guideId,
        [STEP_PARAM]: step ?? null,
        [ONLY_PARAM]: only && only.length > 0 ? only.join(",") : null,
      });
    },
    [patch],
  );
  const go = useCallback(
    (step: string, replace = false) => patch({ [STEP_PARAM]: step }, replace),
    [patch],
  );
  const close = useCallback(
    (replace = false) => {
      patch({ [GUIDE_PARAM]: null, [STEP_PARAM]: null, [ONLY_PARAM]: null }, replace);
      const back = opener.current;
      opener.current = null;
      if (back?.isConnected) window.setTimeout(() => back.focus(), 0);
    },
    [patch],
  );

  const [announcement, setAnnouncement] = useState("");
  const announce = useCallback((message: string) => setAnnouncement(message), []);

  const value = useMemo<GuideContextValue>(
    () => ({
      guide,
      steps,
      stepId,
      partial,
      controller,
      ownerOf,
      promptReady,
      menuOpen,
      setMenuOpen,
      start,
      go,
      close,
      register,
      unregister,
      announce,
    }),
    [
      guide,
      steps,
      stepId,
      partial,
      controller,
      ownerOf,
      promptReady,
      menuOpen,
      start,
      go,
      close,
      register,
      unregister,
      announce,
    ],
  );

  return (
    <GuideContext.Provider value={value}>
      {children}
      {guide && stepId && (
        <Suspense fallback={null}>
          <GuideRunner />
        </Suspense>
      )}
      <div className="sr-only" role="status" aria-live="polite" data-testid="guide-announcer">
        {announcement}
      </div>
    </GuideContext.Provider>
  );
}

export function useGuides(): GuideContextValue {
  const context = useContext(GuideContext);
  if (!context) throw new Error("useGuides must be used within a GuideProvider");
  return context;
}

/**
 * Register a page's controller for its screen while it is mounted. Pass a memoised controller: a
 * new object on every render would re-register on every render.
 */
export function useGuidePage(screen: string, controller: GuidePageController): void {
  const { register, unregister } = useGuides();
  useEffect(() => {
    register(screen, controller);
    return () => unregister(screen, controller);
  }, [screen, controller, register, unregister]);
}
