import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "@jest/globals";
import { getToolReferenceModel } from "@mcp-moira/mcp-server/tool-contract";
import { defaultTreeAdapter, parse, type DefaultTreeAdapterMap } from "parse5";

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

const getTextContent = (node: DefaultTreeAdapterMap["node"]): string => {
  if (defaultTreeAdapter.isTextNode(node)) {
    return defaultTreeAdapter.getTextNodeContent(node);
  }
  if ("childNodes" in node) {
    return node.childNodes.map(getTextContent).join("");
  }
  return "";
};

const renderedText = (html: string): string => {
  return normalizeText(getTextContent(parse(html)));
};

describe("public MCP tool contract rendering", () => {
  test("real EN and RU routes render every fact from the direct contract model", () => {
    const docsRoot = path.resolve("packages/docs");
    const outputRoot = mkdtempSync(path.join(tmpdir(), "moira-tool-contract-docs-"));

    try {
      execFileSync(
        process.execPath,
        [
          path.resolve("node_modules/.bin/astro"),
          "build",
          "--root",
          docsRoot,
          "--outDir",
          outputRoot,
        ],
        { stdio: "pipe" },
      );

      for (const [locale, relativePath] of [
        ["en", "docs/reference/tools/index.html"],
        ["ru", "ru/docs/reference/tools/index.html"],
      ] as const) {
        const html = readFileSync(path.join(outputRoot, relativePath), "utf8");
        const rendered = renderedText(html);
        for (const entry of getToolReferenceModel(locale)) {
          expect(rendered).toContain(entry.name);
          expect(rendered).toContain(entry.summary);
          expect(rendered).toContain(entry.result);
          for (const operation of entry.operations) expect(rendered).toContain(operation);
          expect(rendered).toContain(normalizeText(JSON.stringify(entry.inputSchema, null, 2)));
          for (const example of entry.examples) {
            expect(rendered).toContain(normalizeText(JSON.stringify(example, null, 2)));
          }
        }
        expect(html).toContain("code-block-wrapper");
      }
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
      rmSync(path.join(docsRoot, ".astro"), { recursive: true, force: true });
    }
  }, 30_000);
});
