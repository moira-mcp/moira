/** Time on the overview as a person reads it: one unit of age, and dates for the hints. */

import type { TFunction } from "i18next";
import { ageOf } from "./model";

/** `5 min`, `3 h`, `2 d`, or "just now". */
export function ageText(ms: number, t: TFunction): string {
  const age = ageOf(Math.max(0, ms));
  return age.unit === "now"
    ? t("pages.overview.age.now")
    : t(`pages.overview.age.${age.unit}`, { count: age.count });
}

/** `5 min ago`, or "just now". */
export function agoText(ms: number, t: TFunction): string {
  const age = ageOf(Math.max(0, ms));
  return age.unit === "now"
    ? t("pages.overview.age.now")
    : t("pages.overview.age.ago", { age: ageText(ms, t) });
}

/** `30 Sep, 14:05` in the interface language; "—" without a moment. */
export function dateText(at: number | null | undefined, language?: string): string {
  if (at === null || at === undefined || !Number.isFinite(at)) return "—";
  return new Date(at).toLocaleString(language || undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Whole days in a span, for "no movement for N days". */
export function daysIn(ms: number): number {
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}
