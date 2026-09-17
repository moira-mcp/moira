/**
 * Durations as people read them: the engine's one split of a duration (`splitDuration`, the one
 * the progress picture words in English), worded here in the interface language. `null` — a pass
 * recorded before timestamps existed, or a block the run has not entered — reads as "—", never
 * as "0 s".
 */

import type { TFunction } from "i18next";
import { splitDuration, wordDuration } from "@mcp-moira/workflow-engine/progress-visual";

/** `12 s`, `1 min 20 s`, `2 h 05 min`; "—" when nothing was measured; units by the caller's `t`. */
export function formatDuration(ms: number | null | undefined, t: TFunction): string {
  return wordDuration(splitDuration(ms), {
    s: t("pages.runPage.timing.unit.s"),
    min: t("pages.runPage.timing.unit.min"),
    h: t("pages.runPage.timing.unit.h"),
  });
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
