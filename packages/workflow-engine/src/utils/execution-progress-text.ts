/**
 * The text metric the progress image's model measures with: an upper-bound advance width per
 * glyph class for the face the renderer names (DejaVu Sans), so a box that clears in the model
 * clears on the rasterised PNG. Deterministic and dependency-free; wrapping and ellipsis by pixel
 * width are built on it, as is the duration wording the facts line reads.
 */

export type ProgressFontWeight = "regular" | "semibold" | "bold";

const NARROW = /[iljtfrI.,:;'|!()`·[\]]/u;
const WIDE = /[mwMW@%—ЖЮЩФШжшщюфм]/u;
const UPPER = /[A-ZА-ЯЁ]/u;
const DIGIT = /[0-9]/u;
const LOWER = /[a-zа-яё]/u;
const ELLIPSIS = "…";

/** Advance width of one glyph in em, erring wide. */
function glyphEm(ch: string): number {
  if (ch === " ") return 0.34;
  if (NARROW.test(ch)) return 0.38;
  if (WIDE.test(ch)) return 1.0;
  if (UPPER.test(ch)) return 0.8;
  if (DIGIT.test(ch)) return 0.66;
  if (LOWER.test(ch)) return 0.64;
  return 0.74;
}

/** Pixel width of `text` at `fontSize`; bold faces are about a tenth wider. */
export function progressTextWidth(
  text: string,
  fontSize: number,
  weight: ProgressFontWeight = "regular",
): number {
  let em = 0;
  for (const ch of text) em += glyphEm(ch);
  // The renderer's 600 weight resolves to the bold face, so semibold measures as bold.
  const factor = weight === "regular" ? 1 : 1.12;
  return Math.ceil(em * fontSize * factor);
}

/**
 * `value` on one line no wider than `maxWidth`: unchanged when it fits, otherwise cut at the
 * last glyph that leaves room for the ellipsis. A width too narrow for any glyph plus the
 * ellipsis yields the ellipsis alone, so the line never overflows its box.
 */
export function ellipsizeProgressText(
  value: string,
  maxWidth: number,
  fontSize: number,
  weight: ProgressFontWeight = "regular",
): string {
  const width = (text: string) => progressTextWidth(text, fontSize, weight);
  if (width(value) <= maxWidth) return value;
  let kept = "";
  for (const ch of value) {
    if (width(kept + ch + ELLIPSIS) > maxWidth) break;
    kept += ch;
  }
  return kept.trimEnd() + ELLIPSIS;
}

/**
 * Wrap `value` into lines no wider than `maxWidth` pixels at the given face: whole words when
 * they fit; a single word wider than the line takes a line of its own, ellipsised to the width,
 * so no line ever overflows the box it was wrapped for.
 */
export function wrapProgressTextToWidth(
  value: string,
  maxWidth: number,
  fontSize: number,
  weight: ProgressFontWeight = "regular",
): string[] {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return [];
  const width = (text: string) => progressTextWidth(text, fontSize, weight);
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    if (current) lines.push(current);
    current = "";
  };
  for (const word of normalized.split(" ")) {
    if (width(word) > maxWidth) {
      flush();
      lines.push(ellipsizeProgressText(word, maxWidth, fontSize, weight));
      continue;
    }
    const candidate = current ? `${current} ${word}` : word;
    if (width(candidate) <= maxWidth) current = candidate;
    else {
      flush();
      current = word;
    }
  }
  flush();
  return lines;
}

/**
 * A duration as the run page words it: `12 s`, `1 min 20 s`, `2 h 05 min`. `null` — a pass
 * recorded before timestamps existed, or a block the run has not entered — reads as `—`, never
 * as `0 s`.
 */
export function formatProgressDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return `${hours} h ${String(restMinutes).padStart(2, "0")} min`;
}
