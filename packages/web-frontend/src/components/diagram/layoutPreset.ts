/**
 * The reader's layout preset for the process diagrams, shared by the map and the graph and kept
 * in `localStorage` so it survives a reload. A tiny external store: every diagram subscribes, so a
 * click on one tab's buttons changes the other tab too.
 */

import { useSyncExternalStore } from "react";

export type LayoutPreset = "default" | "compact" | "flow" | "vertical";

export const LAYOUT_PRESETS: ReadonlyArray<{ id: LayoutPreset; label: string; hint: string }> = [
  {
    id: "default",
    label: "По умолчанию",
    hint: "Главная последовательность на одном ряду, ветки рядами, полосы в зазорах",
  },
  {
    id: "compact",
    label: "Компактная",
    hint: "Те же ряды с меньшими зазорами",
  },
  {
    id: "flow",
    label: "По потоку",
    hint: "Вертикальное размещение по ELK без принудительных рядов",
  },
  {
    id: "vertical",
    label: "Вертикальная",
    hint: "Сверху вниз, порты на верхней и нижней гранях",
  },
];

const STORAGE_KEY = "moira.diagram.layoutPreset";
const listeners = new Set<() => void>();

function read(): LayoutPreset {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return LAYOUT_PRESETS.some((p) => p.id === value) ? (value as LayoutPreset) : "default";
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
