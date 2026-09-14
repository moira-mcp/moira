/**
 * The text metric the progress image's model measures with: an upper-bound advance width per
 * glyph class for the face the renderer names (DejaVu Sans), so a box that clears in the model
 * clears on the rasterised PNG. Deterministic and dependency-free; wrapping by pixel width is
 * built on it.
 */

export type ProgressFontWeight = "regular" | "semibold" | "bold";

const NARROW = /[iljtfrI.,:;'|!()`·[\]]/u;
const WIDE = /[mwMW@%—ЖЮЩФШжшщюфм]/u;
const UPPER = /[A-ZА-ЯЁ]/u;
const DIGIT = /[0-9]/u;
const LOWER = /[a-zа-яё]/u;

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
 * Wrap `value` into lines no wider than `maxWidth` pixels at the given face: whole words when
 * they fit, a word wider than the line split at the glyph that overflows. Never truncates.
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
      let piece = "";
      for (const ch of word) {
        if (piece && width(piece + ch) > maxWidth) {
          lines.push(piece);
          piece = ch;
        } else piece += ch;
      }
      current = piece;
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
