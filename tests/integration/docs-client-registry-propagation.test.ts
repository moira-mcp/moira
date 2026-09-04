import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "@jest/globals";
import { renderClientSetupMarkdown } from "../../packages/docs/src/utils/client-setup-markdown.js";
import { mcpClients } from "../../packages/shared/src/mcp-clients/index.js";
import { renderPortableHelpTokens } from "../../packages/shared/src/utils/portable-help.js";
import {
  addedRegistryClient,
  registryWithAddedClient,
} from "../fixtures/docs-client-registry/client-registry-fixture.js";

describe("client registry presentation propagation", () => {
  test("one registry addition reaches public Astro and portable runtime presentations", () => {
    const fixtureRoot = path.resolve("tests/fixtures/docs-client-registry");
    const outputRoot = mkdtempSync(path.join(tmpdir(), "moira-client-registry-"));

    try {
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
          env: { ...process.env, MOIRA_ASTRO_TEST_CACHE_DIR: path.join(outputRoot, "cache") },
          stdio: "pipe",
        },
      );
      const publicHtml = readFileSync(path.join(outputRoot, "index.html"), "utf8");
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
        expect(presentation).toContain("quickStart.tabs.fixture-client.label");
        expect(presentation).toContain("Fixture Registry Addition");
        expect(presentation).toContain("cursor://anysphere.cursor-deeplink/mcp/install");
      }
      expect(portableMarkdown).not.toContain("{{MCP_DEEPLINK:");
    } finally {
      rmSync(outputRoot, { recursive: true, force: true });
      rmSync(path.join(fixtureRoot, ".astro"), { recursive: true, force: true });
      rmSync(path.join(fixtureRoot, "node_modules"), { recursive: true, force: true });
    }
  }, 30_000);
});
