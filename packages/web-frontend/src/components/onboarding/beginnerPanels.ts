/**
 * The beginner panels a reader can hide for good: each is shown until its owner hides it, from the
 * panel itself or from Settings, and stays hidden on every device they sign in from. The hidden set
 * is one user setting on the server; every panel and the Settings switches read the same in-page
 * copy of it, so hiding in one place is seen everywhere at once.
 */

import { useEffect, useSyncExternalStore } from "react";
import { useSession } from "../../auth/better-auth-client";
import { apiClient } from "../../services/api-client";

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

interface PanelsState {
  /** Whose hidden set this is: a sign-out and sign-in as someone else reads theirs afresh. */
  userId: string | null;
  /** `null` until the stored value has been read. */
  hidden: ReadonlySet<BeginnerPanel> | null;
}

/** The key of a reader whose session is not known; the server answers for whoever is signed in. */
const ANONYMOUS = "";

let state: PanelsState = { userId: null, hidden: null };
let loadingFor: string | null = null;
const listeners = new Set<() => void>();

function publish(next: PanelsState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

/** The stored value, keeping only ids this build knows. */
function parse(value: unknown): Set<BeginnerPanel> {
  const known = new Set<string>(BEGINNER_PANELS);
  return new Set(
    (Array.isArray(value) ? value : []).filter(
      (id): id is BeginnerPanel => typeof id === "string" && known.has(id),
    ),
  );
}

function load(userId: string): void {
  if (loadingFor === userId) return;
  if (state.userId !== userId) pending.clear();
  loadingFor = userId;
  publish({ userId, hidden: null });
  apiClient.getUserSettings().then(
    (settings) => {
      if (loadingFor === userId) publish({ userId, hidden: parse(settings[HIDDEN_PANELS_KEY]) });
    },
    () => {
      // Unreadable settings show every panel; the next mount asks again.
      if (loadingFor !== userId) return;
      loadingFor = null;
      publish({ userId, hidden: new Set() });
    },
  );
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes shown on this page whose save has not finished yet: panel → hidden. */
const pending = new Map<BeginnerPanel, boolean>();
/** Saves run one after another, so each applies its change to the list the previous one stored. */
let saving: Promise<void> = Promise.resolve();

function withPending(base: ReadonlySet<BeginnerPanel>): Set<BeginnerPanel> {
  const result = new Set(base);
  for (const [panel, hidden] of pending) {
    if (hidden) result.add(panel);
    else result.delete(panel);
  }
  return result;
}

/**
 * Hide or show a panel. The change is seen at once and saved; a save the server refuses or fails
 * is undone and reported by the returned promise. The change is applied to the stored list, read
 * just before saving, so it never undoes what another device changed meanwhile.
 */
export function setPanelHidden(panel: BeginnerPanel, hide: boolean): Promise<void> {
  const owner = state.userId;
  pending.set(panel, hide);
  publish({ userId: owner, hidden: withPending(state.hidden ?? new Set()) });
  const settle = () => {
    if (pending.get(panel) === hide) pending.delete(panel);
  };
  const run = saving.then(async () => {
    try {
      const stored = parse((await apiClient.getUserSettings())[HIDDEN_PANELS_KEY]);
      if (hide) stored.add(panel);
      else stored.delete(panel);
      const result = await apiClient.updateUserSettings({
        [HIDDEN_PANELS_KEY]: BEGINNER_PANELS.filter((id) => stored.has(id)),
      });
      const refused = result.refused.find((entry) => entry.key === HIDDEN_PANELS_KEY);
      if (refused) throw new Error(refused.reason);
      settle();
      if (state.userId === owner) publish({ userId: owner, hidden: withPending(stored) });
    } catch (error) {
      settle();
      if (state.userId === owner) {
        const reverted = new Set(state.hidden ?? []);
        if (hide) reverted.delete(panel);
        else reverted.add(panel);
        publish({ userId: owner, hidden: withPending(reverted) });
      }
      throw error;
    }
  });
  saving = run.catch(() => undefined);
  return run;
}

/** The hidden set as this page knows it; `loaded` is false until the stored value is read. */
export function useBeginnerPanels(): {
  loaded: boolean;
  isHidden: (panel: BeginnerPanel) => boolean;
} {
  // Pages that show the panels render behind the signed-in route, so the session is known here; a
  // change of account without a reload reads the new account's set.
  const { data: session } = useSession();
  const userId = session?.user?.id ?? ANONYMOUS;
  useEffect(() => {
    load(userId);
  }, [userId]);
  const snapshot = useSyncExternalStore(subscribe, () => state);
  const current = snapshot.userId === userId;
  return {
    loaded: current && snapshot.hidden !== null,
    isHidden: (panel) => (current && snapshot.hidden?.has(panel)) ?? false,
  };
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
  loadingFor = null;
  pending.clear();
  saving = Promise.resolve();
  state = { userId: null, hidden: null };
}
