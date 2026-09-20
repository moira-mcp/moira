/**
 * The wording of a block's run facts, shared by the map (browser) and the progress picture
 * (server): `done/total` of a bound list with one glyph for an unresolved counter, and the one
 * split of a duration into hours, minutes and seconds that every duration formatter words — the
 * picture in English, the interface in the reader's language. Pure and dependency-free.
 */

/** A duration split the way people read it: `2 h 05 min`, `1 min 20 s`, `12 s`. */
export interface DurationParts {
  hours: number;
  minutes: number;
  seconds: number;
}

/**
 * The split of `ms`, or null for a duration nobody measured (a pass recorded before timestamps
 * existed, a block the run has not entered), which reads as a dash and never as `0 s`.
 */
export function splitDuration(ms: number | null | undefined): DurationParts | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return null;
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  return { hours, minutes, seconds: total % 60 };
}

/**
 * The words of a split duration with the given unit words: under a minute the seconds alone,
 * under an hour the minutes with the seconds when there are any, and from an hour on the hours
 * with the minutes zero-padded (`2 h 05 min`).
 */
export function wordDuration(
  parts: DurationParts | null,
  units: { s: string; min: string; h: string },
): string {
  if (!parts) return "—";
  const { hours, minutes, seconds } = parts;
  if (hours === 0 && minutes === 0) return `${seconds} ${units.s}`;
  if (hours === 0)
    return seconds ? `${minutes} ${units.min} ${seconds} ${units.s}` : `${minutes} ${units.min}`;
  return `${hours} ${units.h} ${String(minutes).padStart(2, "0")} ${units.min}`;
}

/**
 * `done/total` of a bound list as one wording everywhere — the card, the contents, the panel and
 * the picture: a counter the binding did not resolve reads as "—" (never "0", never "?"); null
 * when neither counter resolves.
 */
export function listProgressLabel(
  list: { done: number | null; total: number | null } | null | undefined,
): string | null {
  if (!list || (list.done === null && list.total === null)) return null;
  const part = (n: number | null) => (n === null ? "—" : String(n));
  return `${part(list.done)}/${part(list.total)}`;
}
