/**
 * Going to a section of a long settings page ends with that section in view and briefly marked —
 * whether the reader arrived through a link (`/settings#integrations-github`) or picked it in the
 * page's navigation.
 *
 * A deep link is honoured only once the page is `ready`: before its data arrives the section may
 * not be where it will end up. After the jump, the page keeps the section at the top while the
 * content above it finishes settling (lists and cards that load on their own change height), and
 * stops doing so the moment the reader scrolls, types or clicks — the page never fights the reader.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useHighlightTarget, type HighlightRequest } from "../diagram/useHighlightTarget";

/** How long a jump keeps following a layout that is still settling. */
export const SECTION_SETTLE_MS = 3000;

function sectionSelector(name: string): string {
  return `[data-settings-section="${name.replace(/["\\]/g, "\\$&")}"]`;
}

export function useSectionHighlight(
  container: RefObject<HTMLElement | null>,
  ready: boolean,
): { highlight: (name: string) => void } {
  const [request, setRequest] = useState<HighlightRequest | null>(null);
  const handledHash = useRef(false);

  const highlight = useCallback((name: string) => {
    setRequest((previous) => ({ name, token: (previous?.token ?? 0) + 1 }));
  }, []);

  // The deep link: the hash present when the page's data arrived, once.
  useEffect(() => {
    if (!ready || handledHash.current) return;
    handledHash.current = true;
    const name = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    if (name && container.current?.querySelector(sectionSelector(name))) highlight(name);
  }, [ready, container, highlight]);

  useHighlightTarget(container, request, sectionSelector, 2600, { block: "start" });

  // Keep the section in place while what is above it finishes loading, until the reader acts.
  useEffect(() => {
    const root = container.current;
    if (!request || !root || typeof ResizeObserver === "undefined") return;
    const target = root.querySelector<HTMLElement>(sectionSelector(request.name));
    if (!target) return;
    let active = true;
    const stop = () => {
      active = false;
    };
    const follow = new ResizeObserver(() => {
      if (active) target.scrollIntoView({ block: "start" });
    });
    follow.observe(root);
    const timer = window.setTimeout(stop, SECTION_SETTLE_MS);
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    for (const event of events) window.addEventListener(event, stop, { passive: true });
    return () => {
      follow.disconnect();
      window.clearTimeout(timer);
      for (const event of events) window.removeEventListener(event, stop);
    };
  }, [request, container]);

  return { highlight };
}
