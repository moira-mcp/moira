/**
 * Durations as people read them. `null` — a pass recorded before timestamps existed, or a block
 * the run has not entered — reads as "—", never as "0 s".
 */

import type { TFunction } from "i18next";

/** The unit words in the interface language. */
function unit(key: "s" | "min" | "h", t: TFunction): string {
  return t(`pages.runPage.timing.unit.${key}`);
}

/**
 * `12 s`, `1 min 20 s`, `2 h 05 min`; "—" when nothing was measured. The units are worded by the
 * calling component's `t`, so every duration on a page reads in the interface language.
 */
export function formatDuration(ms: number | null | undefined, t: TFunction): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} ${unit("s", t)}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60)
    return rest
      ? `${minutes} ${unit("min", t)} ${rest} ${unit("s", t)}`
      : `${minutes} ${unit("min", t)}`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours} ${unit("h", t)} ${String(restMinutes).padStart(2, "0")} ${unit("min", t)}`;
}

/** Wall-clock time of an epoch stamp in the interface locale; "—" when the stamp is absent. */
export function formatClock(at: number | null | undefined, language?: string): string {
  if (at === null || at === undefined || !Number.isFinite(at)) return "—";
  return new Date(at).toLocaleTimeString(language || undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
