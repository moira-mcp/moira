/** @jest-environment jsdom */
/**
 * The words of the process interface exist in both languages.
 *
 * Two failures this guards. The first is a one-sided key: a string added to `en.json` and not to
 * `ru.json` reaches a Russian reader as English, and nothing in the product says so — i18next
 * falls back silently. The second is a component that never asked the locale at all: a literal,
 * or a `t(key, { defaultValue })` / `t(key, "text")` fallback, which renders the same English (or,
 * in this codebase's history, Russian) text in every language and hides the missing key from the
 * first check, because the key is then never missed.
 *
 * Scope is the surfaces the diagram design system owns — the map, the graph, the panels, the
 * toolbar and the two pages that mount them. Keys are extracted statically; the handful of keys
 * those components build at run time are enumerated here from the product's own id lists (the
 * layout presets, the view modes, the walkthrough steps), so adding a preset or a step without
 * its words fails this test rather than a screenshot.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@jest/globals";
import { LAYOUT_PRESETS } from "../../../packages/web-frontend/src/components/diagram/layoutPreset.js";
import { MODES } from "../../../packages/web-frontend/src/components/run/modes.js";
import { GUIDE_STEPS } from "../../../packages/web-frontend/src/components/run/Walkthrough.js";
import { flowGuideSteps } from "../../../packages/web-frontend/src/components/flow/guideSteps.js";
import { SETTINGS_TOURS } from "../../../packages/web-frontend/src/pages/settings/settingsTours.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "../../../packages/web-frontend/src");
const locales = path.join(frontend, "locales");

type Tree = { [key: string]: Tree | string };

function read(language: "en" | "ru"): Tree {
  return JSON.parse(fs.readFileSync(path.join(locales, `${language}.json`), "utf8")) as Tree;
}

function flatten(tree: Tree, prefix = ""): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? flatten(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;
const plainKey = (key: string): string => key.replace(PLURAL_SUFFIX, "");

const KEYS = { en: flatten(read("en")), ru: flatten(read("ru")) };
const BASE = {
  en: new Set(KEYS.en.map(plainKey)),
  ru: new Set(KEYS.ru.map(plainKey)),
};

/**
 * The components whose words this unit owns: the diagram primitives, the run surfaces, the two
 * diagram organisms, the run page and the flow page.
 */
const SCOPE: string[] = [
  ...fs
    .readdirSync(path.join(frontend, "components/diagram"))
    .map((file) => `components/diagram/${file}`),
  ...fs.readdirSync(path.join(frontend, "components/run")).map((file) => `components/run/${file}`),
  "components/flow/guideSteps.ts",
  "components/workflow/WorkflowGraph.tsx",
  "components/workflow/graphNodes.tsx",
  "components/execution/ExecutionInspector.tsx",
  "pages/FlowPage.tsx",
].filter((file) => /\.tsx?$/.test(file));

const SOURCE = new Map(
  SCOPE.map((file) => [file, fs.readFileSync(path.join(frontend, file), "utf8")]),
);

/** Every key named by a string literal inside a `t(...)` call. */
function literalKeys(source: string): string[] {
  return [...source.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)].map((match) => match[1]);
}

/** The keys the scoped components assemble at run time, enumerated from the product's own ids. */
function runtimeKeys(): string[] {
  const keys: string[] = [];
  for (const surface of ["map", "graph"]) {
    for (const preset of LAYOUT_PRESETS) {
      keys.push(`components.diagram.presets.${surface}.${preset}.label`);
      keys.push(`components.diagram.presets.${surface}.${preset}.hint`);
    }
  }
  for (const page of ["pages.runPage", "pages.flowPage"]) {
    for (const mode of MODES.map((mode) => mode.id)) {
      keys.push(`${page}.modeGuide.${mode}.title`);
      keys.push(`${page}.modeGuide.${mode}.body`);
    }
  }
  for (const [page, steps] of [
    ["pages.runPage.guide", GUIDE_STEPS],
    ["pages.flowPage.guide", flowGuideSteps(true)],
  ] as const) {
    for (const step of steps) {
      keys.push(`${page}.steps.${step.id}.title`);
      keys.push(`${page}.steps.${step.id}.body`);
    }
  }
  // A step card and the node panel name the same section by whether the step routes or instructs.
  for (const family of ["components.diagram.stepFacts", "components.nodePanel.sections"]) {
    keys.push(`${family}.directive`, `${family}.message`);
  }
  return keys;
}

/** Every leaf string of a locale with its key. */
function entries(tree: Tree, prefix = ""): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "object" && value !== null
      ? entries(value, `${prefix}${key}.`)
      : [[`${prefix}${key}`, value] as [string, string]],
  );
}

describe("the English and Russian locales", () => {
  test.each(["en", "ru"] as const)(
    "%s never tells a reader to put a bot token into a URL",
    (language) => {
      // A token in a URL is kept in browser history, screenshots, proxies and logs; the Telegram
      // setup guide sends readers to @userinfobot for the chat ID instead.
      const offenders = entries(read(language))
        .filter(([, text]) => /bot<|getUpdates|api\.telegram\.org\/bot/i.test(text))
        .map(([key]) => key);
      expect(offenders).toEqual([]);
    },
  );

  test("hold exactly the same keys", () => {
    expect([...BASE.en].filter((key) => !BASE.ru.has(key))).toEqual([]);
    expect([...BASE.ru].filter((key) => !BASE.en.has(key))).toEqual([]);
  });

  test.each(["en", "ru"] as const)(
    "%s gives every counted phrase the plural forms its language has",
    (language) => {
      const required = new Intl.PluralRules(language, { type: "cardinal" }).resolvedOptions()
        .pluralCategories;
      const forms = new Map<string, Set<string>>();
      for (const key of KEYS[language]) {
        const match = key.match(PLURAL_SUFFIX);
        if (!match) continue;
        const base = plainKey(key);
        if (!forms.has(base)) forms.set(base, new Set());
        forms.get(base)!.add(match[1]);
      }
      expect(forms.size).toBeGreaterThan(0);
      const missing = [...forms]
        .flatMap(([base, has]) =>
          required.filter((form) => !has.has(form)).map((f) => `${base}_${f}`),
        )
        .sort();
      expect(missing).toEqual([]);
    },
  );
});

describe("the process interface's components", () => {
  const referenced = [
    ...new Set([...SOURCE.values()].flatMap(literalKeys).concat(runtimeKeys())),
  ].sort();

  test("reach the locale for a number of keys, not a handful", () => {
    // Guards the extraction itself: a regex that stopped matching would make every other
    // assertion here pass on an empty set.
    expect(referenced.length).toBeGreaterThan(80);
  });

  test.each(["en", "ru"] as const)("name only keys %s defines", (language) => {
    expect(referenced.filter((key) => !BASE[language].has(key))).toEqual([]);
  });

  test("carry no translation fallback that would hide a missing key", () => {
    const offenders: string[] = [];
    for (const [file, source] of SOURCE) {
      if (source.includes("defaultValue")) offenders.push(`${file}: defaultValue`);
      for (const match of source.matchAll(/\bt\(\s*"[A-Za-z0-9_.]+"\s*,\s*"/g)) {
        offenders.push(`${file}: ${match[0].trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("carry no accessible label, hint or placeholder written as a literal", () => {
    // `aria-label="…"` is what a screen reader says; a literal there is a word no locale owns.
    const offenders: string[] = [];
    for (const [file, source] of SOURCE) {
      for (const line of source.split("\n")) {
        // A doc comment may quote the attribute; only markup counts.
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
        for (const match of line.matchAll(
          /\b(aria-label|title|placeholder|data-hint)="[A-Za-z][^"]*"/g,
        )) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("carry no Russian text written into the component itself", () => {
    const offenders: string[] = [];
    for (const [file, source] of SOURCE) {
      for (const line of source.split("\n")) {
        if (/[А-Яа-яЁё]/.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the Settings page's components", () => {
  /** The page, its section components and the settings primitives. */
  const settingsFiles = [
    "pages/Settings.tsx",
    ...fs
      .readdirSync(path.join(frontend, "pages/settings"))
      .map((file) => `pages/settings/${file}`),
    ...fs
      .readdirSync(path.join(frontend, "components/settings"))
      .map((file) => `components/settings/${file}`),
  ].filter((file) => /\.tsx?$/.test(file));
  const sources = new Map(
    settingsFiles.map((file) => [file, fs.readFileSync(path.join(frontend, file), "utf8")]),
  );
  const tourKeys = Object.entries(SETTINGS_TOURS).flatMap(([tour, steps]) => [
    ...["title", "open", "back", "next", "finish", "close"].map(
      (key) => `pages.settings.tours.${tour}.${key}`,
    ),
    ...steps.flatMap((step) => [
      `pages.settings.tours.${tour}.steps.${step.id}.title`,
      `pages.settings.tours.${tour}.steps.${step.id}.body`,
    ]),
  ]);
  const referenced = [
    ...new Set([...sources.values()].flatMap(literalKeys).concat(tourKeys)),
  ].sort();

  test("reach the locale for a number of keys, not a handful", () => {
    expect(referenced.length).toBeGreaterThan(150);
  });

  test.each(["en", "ru"] as const)("name only keys %s defines", (language) => {
    expect(referenced.filter((key) => !BASE[language].has(key))).toEqual([]);
  });

  test("carry no accessible label or placeholder written as a literal", () => {
    const offenders: string[] = [];
    for (const [file, source] of sources) {
      for (const line of source.split("\n")) {
        if (/^\s*(\*|\/\/|\/\*)/.test(line)) continue;
        for (const match of line.matchAll(
          /\b(aria-label|placeholder|data-hint)="[A-Za-z][^"]*"/g,
        )) {
          offenders.push(`${file}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
