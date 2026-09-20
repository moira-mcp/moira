/**
 * The reader's layout preset for the process diagrams, shared by the map and the graph and kept
 * in `localStorage` so it survives a reload. A tiny external store: every diagram subscribes, so a
 * click on one tab's buttons changes the other tab too.
 *
 * The module holds the ids and the store only — no React, no i18n. The two diagrams lay a preset
 * out differently (the map moves block rows, the graph moves block groups), so each names its own
 * copy: `LayoutPresetButtons` resolves `components.diagram.presets.<surface>.<id>.{label,hint}`
 * where it renders.
 */

import { useSyncExternalStore } from "react";

export type LayoutPreset = "default" | "compact" | "flow" | "vertical";

/** The surface a preset is being named for; each has its own labels and hints. */
export type PresetSurface = "map" | "graph";

export const LAYOUT_PRESETS: readonly LayoutPreset[] = ["default", "compact", "flow", "vertical"];

const STORAGE_KEY = "moira.diagram.layoutPreset";
const listeners = new Set<() => void>();

function read(): LayoutPreset {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return LAYOUT_PRESETS.some((id) => id === value) ? (value as LayoutPreset) : "default";
  } catch {
    return "default";
  }
}

let current: LayoutPreset = typeof window === "undefined" ? "default" : read();

export function setLayoutPreset(preset: LayoutPreset): void {
  current = preset;
  try {
    window.localStorage.setItem(STORAGE_KEY, preset);
  } catch {
    // Storage may be unavailable; the choice still applies for this page.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLayoutPreset(): [LayoutPreset, (preset: LayoutPreset) => void] {
  const preset = useSyncExternalStore(
    subscribe,
    () => current,
    () => "default" as LayoutPreset,
  );
  return [preset, setLayoutPreset];
}
