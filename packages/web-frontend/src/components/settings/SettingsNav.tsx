/**
 * The in-page navigation of a long settings page: a sticky list of its sections beside the content
 * on wide screens, a sticky row of chips above it on narrow ones. The section being read is marked
 * as the reader scrolls; choosing one moves to it.
 *
 * It holds no scrolling logic of its own beyond noticing where the reader is: moving to a section
 * is the page's (`onSelect`), so the same jump serves the navigation, deep links and tutorials.
 */

import React, { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SettingsNavItem {
  id: string;
  label: string;
  icon: LucideIcon;
}

/**
 * The section currently being read: the last one whose top has passed the upper third of the
 * scroll container. Scrolling is observed on the nearest scrolling ancestor of the sections.
 */
export function useActiveSection(ids: readonly string[], ready = true): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  useEffect(() => {
    if (!ready || ids.length === 0) return;
    const sections = ids
      .map((id) => document.querySelector<HTMLElement>(`[data-settings-section="${id}"]`))
      .filter((element): element is HTMLElement => element !== null);
    if (sections.length === 0) return;
    const scroller = scrollParent(sections[0]);
    const update = () => {
      const top = scroller === window ? 0 : (scroller as HTMLElement).getBoundingClientRect().top;
      const height =
        scroller === window ? window.innerHeight : (scroller as HTMLElement).clientHeight;
      const line = top + height / 3;
      let current = sections[0].dataset.settingsSection ?? null;
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= line)
          current = section.dataset.settingsSection ?? current;
      }
      // At the very bottom the last section wins even when it is too short to reach the line.
      const element = scroller === window ? document.documentElement : (scroller as HTMLElement);
      if (
        element.scrollHeight > element.clientHeight + 2 &&
        element.scrollTop + element.clientHeight >= element.scrollHeight - 2
      ) {
        current = sections[sections.length - 1].dataset.settingsSection ?? current;
      }
      setActive(current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      scroller.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [ids, ready]);
  return active;
}

function scrollParent(element: HTMLElement): HTMLElement | Window {
  let node: HTMLElement | null = element.parentElement;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return window;
}

export function SettingsNav({
  items,
  active,
  onSelect,
  label,
}: {
  items: readonly SettingsNavItem[];
  active: string | null;
  onSelect: (id: string) => void;
  /** Accessible name of the navigation landmark. */
  label: string;
}): React.JSX.Element {
  const select = (event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    event.preventDefault();
    window.history.replaceState(window.history.state, "", `#${id}`);
    onSelect(id);
  };
  return (
    <>
      {/* Narrow screens: a sticky row of chips above the sections. */}
      <nav
        aria-label={label}
        data-testid="settings-nav-chips"
        className="sticky top-0 z-20 -mx-4 mb-6 border-b bg-background/95 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 lg:hidden"
      >
        <ul className="flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]">
          {items.map(({ id, label: itemLabel, icon: Icon }) => (
            <li key={id} className="shrink-0">
              <a
                href={`#${id}`}
                onClick={(event) => select(event, id)}
                aria-current={active === id ? "location" : undefined}
                data-testid={`settings-nav-chip-${id}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active === id
                    ? "border-primary/40 bg-primary/10 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {itemLabel}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {/* Wide screens: a sticky list beside the sections. */}
      <nav
        aria-label={label}
        data-testid="settings-nav"
        className="sticky top-8 hidden self-start lg:block"
      >
        <ul className="space-y-0.5">
          {items.map(({ id, label: itemLabel, icon: Icon }) => (
            <li key={id}>
              <a
                href={`#${id}`}
                onClick={(event) => select(event, id)}
                aria-current={active === id ? "location" : undefined}
                data-testid={`settings-nav-${id}`}
                className={cn(
                  "relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active === id
                    ? "bg-accent font-medium text-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-primary"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{itemLabel}</span>
              </a>
            </li>
          ))}
        </ul>
      </nav>
    </>
  );
}
