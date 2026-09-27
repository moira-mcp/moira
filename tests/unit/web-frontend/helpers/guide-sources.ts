/**
 * The guide anchors written in the web app's source, for the checks that hold guides to the
 * interface they explain.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const frontendSource = path.resolve(here, "../../../../packages/web-frontend/src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** Every anchor name written as a literal argument of `guideAnchor(...)` anywhere in the app. */
export function writtenAnchors(): Set<string> {
  const names = new Set<string>();
  for (const file of sourceFiles(frontendSource)) {
    if (file.endsWith(path.join("guides", "anchors.ts"))) continue;
    // A comment may quote the call to document it; only code writes an anchor.
    const source = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join("\n");
    for (const call of source.matchAll(/guideAnchor\(([^)]*)\)/g)) {
      for (const literal of call[1].matchAll(/"([^"]+)"/g)) names.add(literal[1]);
    }
  }
  return names;
}
