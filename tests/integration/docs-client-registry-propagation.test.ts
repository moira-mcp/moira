import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "@jest/globals";
import { defaultTreeAdapter, parse, type DefaultTreeAdapterMap } from "parse5";
import { getClientSetupPresentation } from "@mcp-moira/shared/mcp-clients";
import { renderClientSetupMarkdown } from "../../packages/mcp-server/src/help/client-presentation.js";
import { mcpClients } from "../../packages/shared/src/mcp-clients/index.js";
import { renderPortableHelpTokens } from "../../packages/shared/src/utils/portable-help.js";
import {
  addedRegistryClient,
  registryWithAddedClient,
} from "../fixtures/docs-client-registry/client-registry-fixture.js";

const nodes = (node: DefaultTreeAdapterMap["node"]): DefaultTreeAdapterMap["element"][] => [
  ...(defaultTreeAdapter.isElementNode(node) ? [node] : []),
  ...("childNodes" in node ? node.childNodes.flatMap(nodes) : []),
];
const attribute = (node: DefaultTreeAdapterMap["element"], name: string) =>
  node.attrs.find((entry) => entry.name === name)?.value;
const text = (node: DefaultTreeAdapterMap["node"]): string =>
  defaultTreeAdapter.isTextNode(node)
    ? defaultTreeAdapter.getTextNodeContent(node)
    : "childNodes" in node
      ? node.childNodes.map(text).join("")
      : "";
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();

describe("client registry presentation propagation", () => {
  test("one registry addition reaches public Astro and portable runtime presentations", () => {
    const fixtureSourceRoot = path.resolve("tests/fixtures/docs-client-registry");
    const fixtureRoot = mkdtempSync(
      path.join(path.dirname(fixtureSourceRoot), ".docs-client-registry-"),
    );
    const outputRoot = mkdtempSync(path.join(tmpdir(), "moira-client-registry-"));
    const fixtureNodeModules = path.join(fixtureRoot, "node_modules");

    try {
      cpSync(fixtureSourceRoot, fixtureRoot, { recursive: true });
      symlinkSync(path.resolve("node_modules"), fixtureNodeModules, "junction");
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
            MOIRA_HOST: "fixture.example",
            MOIRA_ASTRO_TEST_CACHE_DIR: path.join(outputRoot, "cache"),
          },
          stdio: "pipe",
        },
      );
      const publicHtml = readFileSync(path.join(outputRoot, "index.html"), "utf8");
      const rendered = nodes(parse(publicHtml));
      for (const language of ["en", "ru"] as const) {
        const section = rendered.find((node) => attribute(node, "data-language") === language);
        if (!section) throw new Error(`Missing ${language} documentation section`);
        const panels = nodes(section).filter((node) => attribute(node, "role") === "tabpanel");
        const presentations = getClientSetupPresentation(
          language,
          "https://fixture.example/mcp",
          registryWithAddedClient,
        );
        for (const [index, presentation] of presentations.entries()) {
          const panel = panels[index];
          if (!panel) throw new Error(`Missing ${presentation.label} panel`);
          const content = normalize(text(panel));
          expect(content).toContain(normalize(presentation.setup));
          expect(content).toContain(normalize(presentation.authIntro));
          expect(content).toContain(normalize(presentation.verification));
          expect(
            nodes(panel)
              .filter((node) => node.tagName === "a")
              .map((node) => attribute(node, "href")),
          ).toContain(presentation.officialDocs.url);
        }
        expect(text(section)).not.toMatch(/quickStart\.(clients|tabs)\./);
      }
      const portableMarkdown = renderPortableHelpTokens(
        renderClientSetupMarkdown("en", "{MCP_URL}", [addedRegistryClient]),
        {
          mcpUrl: "https://fixture.example/mcp",
          moiraUrl: "https://fixture.example",
          staticDomain: "static.fixture.example",
        },
      );

      expect(registryWithAddedClient).toHaveLength(mcpClients.length + 1);
      for (const presentation of [publicHtml, portableMarkdown]) {
        expect(presentation).toContain("Fixture Client");
        expect(presentation).toContain("Fixture Registry Addition");
        expect(presentation).toContain("cursor://anysphere.cursor-deeplink/mcp/install");
      }
      expect(portableMarkdown).not.toContain("{{MCP_DEEPLINK:");
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
