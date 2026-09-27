/**
 * The beginner panels a reader can hide for good: each is shown until its owner hides it, from the
 * panel itself or from Settings, and stays hidden on every device they sign in from. The hidden set
 * is one user setting on the server; every panel and the Settings switches read the same in-page
 * copy of it, so hiding in one place is seen everywhere at once.
 */

import { createUserSettingStore } from "../../lib/userSettingStore";

/** The user setting holding the ids of the hidden panels (seeded in category `ui`). */
export const HIDDEN_PANELS_KEY = "ui.hidden_panels";

/** Every beginner panel, in the order Settings lists them. */
export const BEGINNER_PANELS = [
  "home-intro",
  "quick-start",
  "home-recommended",
  "workflows-recommended",
  "run-variables-guide",
  "registry-guide",
] as const;

export type BeginnerPanel = (typeof BEGINNER_PANELS)[number];

/** The stored value, keeping only ids this build knows. */
function parse(value: unknown): ReadonlySet<BeginnerPanel> {
  const known = new Set<string>(BEGINNER_PANELS);
  return new Set(
    (Array.isArray(value) ? value : []).filter(
      (id): id is BeginnerPanel => typeof id === "string" && known.has(id),
    ),
  );
}

const store = createUserSettingStore<ReadonlySet<BeginnerPanel>>(HIDDEN_PANELS_KEY, {
  parse,
  serialize: (hidden) => BEGINNER_PANELS.filter((id) => hidden.has(id)),
  // Unreadable settings show every panel.
  whenUnreadable: () => new Set(),
});

/**
 * Hide or show a panel. The change is seen at once and saved; a save the server refuses or fails
 * is undone and reported by the returned promise. The change is applied to the stored list, read
 * just before saving, so it never undoes what another device changed meanwhile.
 */
export function setPanelHidden(panel: BeginnerPanel, hide: boolean): Promise<void> {
  return store.change((hidden) => {
    const next = new Set(hidden);
    if (hide) next.add(panel);
    else next.delete(panel);
    return next;
  });
}

/** The hidden set as this page knows it; `loaded` is false until the stored value is read. */
export function useBeginnerPanels(): {
  loaded: boolean;
  isHidden: (panel: BeginnerPanel) => boolean;
} {
  const { loaded, value } = store.useValue();
  return { loaded, isHidden: (panel) => value?.has(panel) ?? false };
}

/**
 * Whether a panel should be drawn: only once the stored value is known, and only if not hidden. A
 * component that is a beginner panel only sometimes passes no id and is always drawn.
 */
export function usePanelVisible(panel?: BeginnerPanel): boolean {
  const { loaded, isHidden } = useBeginnerPanels();
  return panel === undefined || (loaded && !isHidden(panel));
}

/** Forget the in-page copy; for tests that sign in as another user. */
export function resetBeginnerPanels(): void {
  store.reset();
}
