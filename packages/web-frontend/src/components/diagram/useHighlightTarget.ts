/**
 * Every "go to X" in the interface ends with X visibly marked: the target scrolls into view and
 * pulses for a moment. Pass the container and a selector for the target; a new `token` repeats
 * the highlight for the same target.
 */

import { useEffect, type RefObject } from "react";

export interface HighlightRequest {
  name: string;
  token: number;
}

export const HIGHLIGHT_CLASSES = ["ring-2", "ring-primary", "animate-pulse", "rounded-md"];

export interface HighlightOptions {
  /**
   * Where the target lands: `center` (the default) suits a small target such as a diagram card;
   * `start` suits a tall one, whose top would otherwise be scrolled out of view.
   */
  block?: ScrollLogicalPosition;
}

export function useHighlightTarget(
  container: RefObject<HTMLElement | null>,
  request: HighlightRequest | null | undefined,
  selectorFor: (name: string) => string,
  durationMs = 2200,
  options: HighlightOptions = {},
): void {
  const block = options.block ?? "center";
  useEffect(() => {
    if (!request || !container.current) return;
    const target = container.current.querySelector<HTMLElement>(selectorFor(request.name));
    if (!target) return;
    target.scrollIntoView({ block, behavior: "smooth" });
    target.classList.add(...HIGHLIGHT_CLASSES);
    target.setAttribute("data-highlighted", "true");
    const clearHighlight = () => {
      target.classList.remove(...HIGHLIGHT_CLASSES);
      target.removeAttribute("data-highlighted");
    };
    const timer = setTimeout(clearHighlight, durationMs);
    return () => {
      clearTimeout(timer);
      clearHighlight();
    };
  }, [request, container, selectorFor, durationMs, block]);
}
