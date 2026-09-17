/**
 * No native browser tooltip inside the process pages' components: every hint is the
 * application's `Hint` (`data-hint`, drawn by the delegated `HintLayer` on the theme's surface),
 * never a `title` attribute the browser renders in its own colours, and never an SVG `<title>`.
 *
 * The scan reads the markup of the class boundary — the diagram, run, flow, workflow and
 * execution and access components and the flow page — and refuses a `title=` attribute (literal or
 * expression) on an intrinsic element or on the project's prop-forwarding primitives (`Badge`,
 * `Button`, and the `Chip` variable a step card renders as `button` or `span`), and any `<title`
 * element. A `title` prop on any other capitalised component is a heading or a hint text, not a
 * native attribute, and is allowed.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@jest/globals";

const here = path.dirname(fileURLToPath(import.meta.url));
const frontend = path.resolve(here, "../../../packages/web-frontend/src");

/** The class boundary: the two process pages and the components they mount. */
const BOUNDARY = [
  "components/diagram",
  "components/run",
  "components/flow",
  "components/workflow",
  "components/execution",
  "components/access",
  "pages/FlowPage.tsx",
];

/** Components that spread their props onto a DOM element, so a `title` on them is native. */
const FORWARDING = new Set(["Badge", "Button", "Chip"]);

function files(entry: string): string[] {
  const full = path.join(frontend, entry);
  if (fs.statSync(full).isFile()) return [entry];
  return fs
    .readdirSync(full)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => `${entry}/${name}`);
}

/** The JSX element a `title=` at `index` belongs to: the last `<Name` opened before it. */
function elementBefore(source: string, index: number): string | null {
  // The element whose attributes are being written at `index`: the innermost tag opened before
  // it and not yet closed by `>` or `/>`. Arrow functions (`=>`), closing tags (`</X>`) and a
  // comparison (`n > 1`, spaced by the formatter) carry a `>` that ends no opening tag, and an
  // element nested in an attribute expression closes before the outer tag's attributes resume.
  const open: string[] = [];
  for (const token of source
    .slice(0, index)
    .matchAll(/<\/[\w.]*\s*>|=>|<([A-Za-z][\w.]*)|\/>|(?<!\s)>/g)) {
    if (token[1]) open.push(token[1]);
    else if (token[0] === "/>" || token[0] === ">") open.pop();
  }
  return open.length > 0 ? open[open.length - 1] : null;
}

function nativeTitles(source: string): string[] {
  const offenders: string[] = [];
  // `title=` as an attribute name, not the tail of `data-step-title=`.
  for (const match of source.matchAll(/(?<![\w-])title=/g)) {
    const element = elementBefore(source, match.index!);
    const line = source.slice(0, match.index).split("\n").length;
    // A `title=` the scan cannot attribute to an element is a finding, not a pass.
    if (!element) {
      offenders.push(`line ${line}: title= on an element the scan could not resolve`);
      continue;
    }
    const intrinsic = element[0] === element[0].toLowerCase();
    if (intrinsic || FORWARDING.has(element)) {
      offenders.push(`line ${line}: title= on <${element}>`);
    }
  }
  for (const match of source.matchAll(/<title[\s>]/g)) {
    const line = source.slice(0, match.index).split("\n").length;
    offenders.push(`line ${line}: <title> element`);
  }
  return offenders;
}

describe("the process pages' components", () => {
  test("carry no native browser tooltip: no title attribute on a DOM element and no <title> element", () => {
    const offenders: string[] = [];
    for (const entry of BOUNDARY) {
      for (const file of files(entry)) {
        const source = fs.readFileSync(path.join(frontend, file), "utf8");
        for (const offender of nativeTitles(source)) offenders.push(`${file} ${offender}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the scan sees the shapes that produced the class: an intrinsic element, a forwarding primitive, an expression, an SVG title, and attributes after a nested element", () => {
    expect(
      nativeTitles(
        [
          '<button title="x" />',
          "<Badge title={`${n} errors`} />",
          "<Chip {...props} title={connection.targetName} />",
          "<g><title>{label}</title></g>",
          '<PanelSection title={t("k")} />',
          '<ToolbarButton title={hint(id)} label="l" />',
          "<PortedCard badge={<Chip status={s} />} extra={n > 1 ? <b>n</b> : undefined} title={name} />",
          "<div badge={<b>x</b>} title={name} />",
          "title={stray}",
        ].join("\n"),
      ),
    ).toEqual([
      "line 1: title= on <button>",
      "line 2: title= on <Badge>",
      "line 3: title= on <Chip>",
      "line 8: title= on <div>",
      "line 9: title= on an element the scan could not resolve",
      "line 4: <title> element",
    ]);
  });
});
