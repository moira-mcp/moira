import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "@jest/globals";
import { getToolReferenceModel } from "@mcp-moira/mcp-server/tool-contract";
import { renderPortableHelpTokens } from "@mcp-moira/shared/portable-help";
import { createMarkdownProcessor, parseFrontmatter } from "@astrojs/markdown-remark";
import { defaultTreeAdapter, parse, type DefaultTreeAdapterMap } from "parse5";

const normalizeText = (value: string): string => value.replace(/\s+/g, " ").trim();

const getTextContent = (node: DefaultTreeAdapterMap["node"]): string => {
  // Starlight inserts accessible permalink labels into headings; they are page chrome,
  // not authored prompt text. Preserve the heading itself and every source paragraph.
  if (
    defaultTreeAdapter.isElementNode(node) &&
    node.tagName === "a" &&
    node.attrs.some(
      ({ name, value }) => name === "class" && value.split(/\s+/).includes("sl-anchor-link"),
    )
  ) {
    return "";
  }
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

const elements = (node: DefaultTreeAdapterMap["node"]): DefaultTreeAdapterMap["element"][] => [
  ...(defaultTreeAdapter.isElementNode(node) ? [node] : []),
  ...("childNodes" in node ? node.childNodes.flatMap(elements) : []),
];

const attribute = (node: DefaultTreeAdapterMap["element"], name: string): string | undefined =>
  node.attrs.find((entry) => entry.name === name)?.value;

const expectNativeTableOfContents = (html: string): void => {
  const nodes = elements(parse(html));
  const content = nodes.find((node) =>
    attribute(node, "class")?.split(/\s+/).includes("sl-markdown-content"),
  );
  const toc = nodes.find((node) => node.tagName === "starlight-toc");
  expect(content).toBeDefined();
  expect(toc).toBeDefined();
  const headings = elements(content!).filter((node) => /^h[23]$/.test(node.tagName));
  expect(headings.length).toBeGreaterThan(0);
  const links = elements(toc!).filter(
    (node) => node.tagName === "a" && attribute(node, "href") !== "#_top",
  );
  expect(links.map((node) => decodeURIComponent(attribute(node, "href")!.slice(1)))).toEqual(
    headings.map((node) => attribute(node, "id")),
  );
  expect(links.map((node) => normalizeText(getTextContent(node)))).toEqual(
    headings.map((node) => normalizeText(getTextContent(node))),
  );
};

describe("public MCP tool contract rendering", () => {
  test("real EN and RU routes render their tool contracts and default prompts", async () => {
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
        {
          cwd: docsRoot,
          env: {
            ...process.env,
            MOIRA_HOST: "localhost:3030",
            STATIC_ARTIFACTS_DOMAIN: "static.localhost",
          },
          stdio: "pipe",
        },
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

      const markdown = await createMarkdownProcessor();
      for (const [relativePath, sourcePath] of [
        ["docs/integration/agent-instructions/index.html", "config/prompts/systemPrompt.md"],
        [
          "ru/docs/integration/agent-instructions/index.html",
          "packages/docs/src/content/docs/docs/SYSTEM-PROMPT-RU.md",
        ],
      ]) {
        const html = readFileSync(path.join(outputRoot, relativePath), "utf8");
        const { content: source } = parseFrontmatter(
          readFileSync(path.resolve(sourcePath), "utf8"),
        );
        const renderedSource = await markdown.render(renderPortableHelpTokens(source));
        expect(renderedText(html)).toContain(renderedText(renderedSource.code));
      }

      // Cover a long imported topic, ordered before/after fragments, the imported default
      // prompt and ordinary authored MDX through the real Astro/Starlight build.
      for (const prefix of ["docs", "ru/docs"]) {
        for (const route of [
          "guides/workflow-creation",
          "getting-started/quickstart",
          "integration/agent-instructions",
          "reference/workflows/quick-task",
        ]) {
          expectNativeTableOfContents(
            readFileSync(path.join(outputRoot, prefix, route, "index.html"), "utf8"),
          );
        }
      }
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
      rmSync(path.join(docsRoot, ".astro"), { recursive: true, force: true });
    }
  }, 30_000);

  test("production Markdown processor preserves all custom transformations", () => {
    const fixtureSourceRoot = path.resolve("tests/fixtures/docs-markdown-plugins");
    let fixtureRoot: string | undefined;
    let outputRoot: string | undefined;

    try {
      fixtureRoot = mkdtempSync(
        path.join(path.dirname(fixtureSourceRoot), ".docs-markdown-plugins-"),
      );
      outputRoot = mkdtempSync(path.join(tmpdir(), "moira-markdown-plugins-"));
      cpSync(fixtureSourceRoot, fixtureRoot, { recursive: true });
      execFileSync(
        process.execPath,
        [
          path.resolve("node_modules/.bin/astro"),
          "build",
          "--root",
          fixtureRoot,
          "--outDir",
          outputRoot,
        ],
        {
          cwd: fixtureRoot,
          env: {
            ...process.env,
            MOIRA_ASTRO_TEST_CACHE_DIR: path.join(outputRoot, "cache"),
            MOIRA_HOST: "localhost:3030",
            STATIC_ARTIFACTS_DOMAIN: "static.localhost",
          },
          stdio: "pipe",
        },
      );

      const html = readFileSync(path.join(outputRoot, "index.html"), "utf8");
      expect(html).toContain('data-reading-time="1"');
      expect(html).toContain("https://static.localhost");
      expect(html).not.toContain("{STATIC_DOMAIN}");
      expect(html).toMatch(/<div style="overflow:auto">\s*<table>/);
      expect(html).toMatch(/<img[^>]*loading="lazy"/);
    } finally {
      if (outputRoot) rmSync(outputRoot, { recursive: true, force: true });
      if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
