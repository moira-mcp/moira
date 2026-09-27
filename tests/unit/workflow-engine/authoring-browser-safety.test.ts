/**
 * The authoring entry is loaded by the browser bundle, so its runtime module graph must stay inside
 * `src/authoring/`: no Node built-in, no validator, no extension registry, no other package. A
 * test that merely imports the entry would pass either way (Jest resolves Node modules even under
 * jsdom), so this walks the entry's actual runtime imports instead. Type-only imports are erased at
 * build time and are allowed.
 */

import { describe, expect, test } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

const AUTHORING = path.join(process.cwd(), "packages/workflow-engine/src/authoring");

/** Runtime import/export specifiers of a module (type-only forms excluded). */
function runtimeSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /^\s*(import|export)\s+(type\s+)?[^;]*?\sfrom\s+["']([^"']+)["']/gms;
  for (const match of source.matchAll(pattern)) {
    if (match[2]) continue; // `import type … from` / `export type … from`
    specifiers.push(match[3]);
  }
  for (const match of source.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) specifiers.push(match[1]);
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g))
    specifiers.push(match[1]);
  return specifiers;
}

function reachedModules(entry: string): { modules: Set<string>; external: string[] } {
  const modules = new Set<string>();
  const external: string[] = [];
  const visit = (file: string): void => {
    if (modules.has(file)) return;
    modules.add(file);
    for (const specifier of runtimeSpecifiers(fs.readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        external.push(specifier);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), specifier).replace(/\.js$/, ".ts");
      visit(resolved);
    }
  };
  visit(entry);
  return { modules, external };
}

describe("authoring entry browser safety", () => {
  test("the entry's runtime imports stay inside the authoring directory", () => {
    const { modules, external } = reachedModules(path.join(AUTHORING, "index.ts"));
    expect(external).toEqual([]);
    const outside = [...modules].filter((file) => !file.startsWith(`${AUTHORING}${path.sep}`));
    expect(outside).toEqual([]);
  });

  test("the walk sees a runtime import that would leave the directory", () => {
    const sample = `import type { A } from "../x.js";\nimport { readFileSync } from "node:fs";\nexport { b } from "./b.js";`;
    expect(runtimeSpecifiers(sample)).toEqual(["node:fs", "./b.js"]);
  });
});
