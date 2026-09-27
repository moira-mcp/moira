/**
 * A guide's card and spotlight are readable in both themes. The colours come from the theme's
 * tokens, so the pairs the card and the spotlight draw are read from the stylesheet and measured
 * with the WCAG contrast ratio: text at least 4.5:1, the ring against the page at least 3:1.
 *
 * The dark theme's primary is too light for white small text (the app's own primary buttons fall
 * short there); the card's Next button therefore writes its label in the page background colour,
 * and that is the pair checked.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@jest/globals";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(
  path.resolve(here, "../../../packages/web-frontend/src/styles/globals.css"),
  "utf8",
);

type Oklch = [number, number, number];

/** The `--name: oklch(L C H)` tokens of one theme block (`:root` or `.dark`). */
function tokens(selector: ":root" | ".dark"): Map<string, Oklch> {
  const start = css.indexOf(`${selector} {`);
  const block = css.slice(start, css.indexOf("}", start));
  const found = new Map<string, Oklch>();
  for (const match of block.matchAll(/--([a-z-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g)) {
    found.set(match[1], [Number(match[2]), Number(match[3]), Number(match[4])]);
  }
  return found;
}

/** Relative luminance of an OKLCH colour, through linear sRGB (clipped to the gamut). */
function luminance([L, C, h]: Oklch): number {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clip = (value: number) => Math.min(1, Math.max(0, value));
  const red = clip(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  const green = clip(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  const blue = clip(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(one: Oklch, other: Oklch): number {
  const [high, low] = [luminance(one), luminance(other)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

describe.each([":root", ".dark"] as const)("the %s theme", (selector) => {
  const theme = tokens(selector);
  const token = (name: string) => {
    const value = theme.get(name);
    expect(value).toBeDefined();
    return value!;
  };

  test.each([
    ["the card's text on the card", "popover-foreground", "popover", 4.5],
    ["the card's secondary text on the card", "muted-foreground", "popover", 4.5],
    ["'What is this?' on the page", "primary", "background", 4.5],
    ["the spotlight's ring against the page", "primary", "background", 3],
  ])("%s reaches the contrast it needs", (_what, foreground, background, needed) => {
    expect(contrast(token(foreground), token(background))).toBeGreaterThanOrEqual(needed);
  });

  test("the Next button's label reaches 4.5:1 on the primary", () => {
    const label = selector === ".dark" ? token("background") : token("primary-foreground");
    expect(contrast(label, token("primary"))).toBeGreaterThanOrEqual(4.5);
  });
});
