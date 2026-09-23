/**
 * Destructive colours are legible in both themes, measured on the theme tokens themselves
 * (`styles/globals.css`) with the WCAG 2 contrast ratio: destructive text against the surfaces it
 * sits on, and the text drawn on every solid destructive fill. The bar is WCAG AA for normal text,
 * 4.5:1. Both checks run together, so a token change that rescues one role cannot silently break
 * the other.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "@jest/globals";

const css = fs.readFileSync(path.resolve("packages/web-frontend/src/styles/globals.css"), "utf8");

type Oklch = { l: number; c: number; h: number };

/** The custom properties of one theme block (`:root` or `.dark`), as written. */
function themeTokens(selector: ":root" | ".dark"): Map<string, string> {
  const escaped = selector.replace(".", "\\.");
  const block = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!block) throw new Error(`no ${selector} block in globals.css`);
  const tokens = new Map<string, string>();
  for (const match of block[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

function parseOklch(value: string): Oklch {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!match) throw new Error(`not an oklch() colour: ${value}`);
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]) };
}

/** OKLCH → linear sRGB (Björn Ottosson's OKLab matrices), clamped to the displayable gamut. */
function linearSrgb({ l, c, h }: Oklch): [number, number, number] {
  const radians = (h * Math.PI) / 180;
  const a = c * Math.cos(radians);
  const b = c * Math.sin(radians);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  return [
    clamp(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    clamp(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    clamp(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

/**
 * WCAG relative luminance. The gamut-clamped linear values are encoded to 8-bit sRGB and decoded
 * again with the WCAG formula, which is what a browser paints and what a contrast checker measures.
 */
function luminance(colour: Oklch): number {
  const channel = (linear: number) => {
    const encoded = linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
    const byte = Math.round(encoded * 255) / 255;
    return byte <= 0.04045 ? byte / 12.92 : ((byte + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = linearSrgb(colour).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(first: Oklch, second: Oklch): number {
  const [light, dark] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const WHITE: Oklch = { l: 1, c: 0, h: 0 };
const AA = 4.5;

describe("the contrast function", () => {
  test.each([
    // Reference values from any WCAG contrast checker.
    ["white on black", WHITE, { l: 0, c: 0, h: 0 }, 21],
    ["white on white", WHITE, WHITE, 1],
    // oklch(0.577 0.245 27.325) is #e7000b (Tailwind v4 red-600): 4.77:1 against white.
    ["white on Tailwind red-600", WHITE, { l: 0.577, c: 0.245, h: 27.325 }, 4.77],
  ])("%s", (_label, first, second, expected) => {
    expect(contrast(first, second)).toBeCloseTo(expected, 1);
  });
});

describe.each([
  ["light", ":root"],
  ["dark", ".dark"],
] as const)("destructive colours in the %s theme", (_theme, selector) => {
  const tokens = themeTokens(selector);
  const token = (name: string) => {
    const value = tokens.get(name);
    if (!value) throw new Error(`--${name} is not defined for ${selector}`);
    return parseOklch(value);
  };

  // The surfaces destructive text is written on: the page, cards, and popovers and menus.
  test.each(["background", "card", "popover"])("destructive text on --%s reaches AA", (surface) => {
    expect(contrast(token("destructive"), token(surface))).toBeGreaterThanOrEqual(AA);
  });

  test("the destructive foreground on the destructive fill reaches AA (badges, the failed status)", () => {
    expect(
      contrast(token("destructive-foreground"), token("destructive-fill")),
    ).toBeGreaterThanOrEqual(AA);
  });

  test("white on the destructive fill reaches AA (destructive buttons and danger counters)", () => {
    expect(contrast(WHITE, token("destructive-fill"))).toBeGreaterThanOrEqual(AA);
  });
});

describe("solid destructive fills", () => {
  // Every component that draws text on a solid destructive fill names the fill token, not the
  // text-and-accent token, and no longer fades the fill over an unknown surface in the dark theme.
  const frontend = path.resolve("packages/web-frontend/src");
  test.each([
    "components/ui/button.tsx",
    "components/ui/badge.tsx",
    "components/status-badge.tsx",
    "components/diagram/IndexBadge.tsx",
    "components/run/TabBadge.tsx",
    "pages/AdminDashboard.tsx",
    "pages/Admin.tsx",
  ])("%s draws its text on the fill token", (file) => {
    const source = fs.readFileSync(path.join(frontend, file), "utf8");
    expect(source).toMatch(/bg-destructive-fill\b/);
    expect(source).not.toMatch(/bg-destructive[\s"'`]/);
    expect(source).not.toMatch(/dark:bg-destructive\/\d+/);
  });
});
