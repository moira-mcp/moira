/**
 * Unit tests for get-help MDX processing functions
 */

import fs from "node:fs";
import path from "node:path";

import { describe, it, expect, beforeEach } from "@jest/globals";
import { _testing } from "../../../packages/mcp-server/src/tools/get-help.js";
import { renderToolReference } from "../../../packages/mcp-server/src/tools/tool-definitions.js";
import {
  configGenerators,
  deeplinkGenerators,
  mcpClients,
  tokenConfigGenerators,
  type McpClient,
} from "../../../packages/shared/src/mcp-clients/index.js";
import { renderPortableHelpTokens } from "../../../packages/shared/src/utils/portable-help.js";
import {
  getClientSetupPresentation,
  renderClientSetupMarkdown,
} from "../../../packages/mcp-server/src/help/client-presentation.js";

const {
  composePortableHelpFile,
  scanHelpFiles,
  extractFrontmatter,
  filePathToTopicId,
  resolveTopicId,
  getTopicList,
  generateHelpContent,
  resetCache,
} = _testing;

const publicDocsDirectory = path.resolve("packages/docs/src/content/docs/docs");
const helpDirectory = path.resolve("packages/mcp-server/src/help/content");

describe("MDX Processing", () => {
  describe("extractFrontmatter", () => {
    it("should extract title and description from frontmatter", () => {
      const input = `---
title: Test Title
description: Test description
---

# Content`;

      const result = extractFrontmatter(input);
      expect(result.title).toBe("Test Title");
      expect(result.description).toBe("Test description");
    });

    it("should handle quoted values", () => {
      const input = `---
title: "Quoted Title"
description: 'Single quoted'
---`;

      const result = extractFrontmatter(input);
      expect(result.title).toBe("Quoted Title");
      expect(result.description).toBe("Single quoted");
    });

    it("should return empty strings when frontmatter is missing", () => {
      const input = `# No frontmatter`;

      const result = extractFrontmatter(input);
      expect(result.title).toBe("");
      expect(result.description).toBe("");
    });

    it("should handle frontmatter with other fields", () => {
      const input = `---
title: My Title
sidebar:
  order: 2
description: My description
tags:
  - one
---`;

      const result = extractFrontmatter(input);
      expect(result.title).toBe("My Title");
      expect(result.description).toBe("My description");
    });
  });

  describe("filePathToTopicId", () => {
    it("should convert simple paths to topic IDs", () => {
      expect(filePathToTopicId("concepts/nodes.mdx")).toBe("nodes");
      expect(filePathToTopicId("concepts/nodes.md")).toBe("nodes");
      expect(filePathToTopicId("getting-started/quickstart.before.md")).toBe("quickstart");
      expect(filePathToTopicId("concepts/workflows.mdx")).toBe("workflows");
      expect(filePathToTopicId("getting-started/introduction.mdx")).toBe("introduction");
    });

    it("should handle index.mdx files", () => {
      expect(filePathToTopicId("patterns/index.mdx")).toBe("patterns");
    });

    it("should prefix pattern files", () => {
      expect(filePathToTopicId("patterns/skip.mdx")).toBe("pattern-skip");
      expect(filePathToTopicId("patterns/validation-loop.mdx")).toBe("pattern-validation-loop");
    });

    it("should prefix workflow reference files", () => {
      expect(filePathToTopicId("reference/workflows/robust-task.mdx")).toBe("workflow-robust-task");
      expect(filePathToTopicId("reference/workflows/verified-research.mdx")).toBe(
        "workflow-verified-research",
      );
    });

    it("should handle nested paths correctly", () => {
      expect(filePathToTopicId("reference/tools.mdx")).toBe("tools");
      expect(filePathToTopicId("integration/claude-code.mdx")).toBe("claude-code");
    });
  });

  describe("resolveTopicId", () => {
    it("should resolve aliases to canonical topic IDs", () => {
      expect(resolveTopicId("overview")).toBe("introduction");
      expect(resolveTopicId("intro")).toBe("introduction");
      expect(resolveTopicId("start")).toBe("quickstart");
      expect(resolveTopicId("getting-started")).toBe("introduction");
      expect(resolveTopicId("node")).toBe("nodes");
      expect(resolveTopicId("workflow")).toBe("workflows");
      expect(resolveTopicId("template")).toBe("templates");
      expect(resolveTopicId("tool")).toBe("tools");
      expect(resolveTopicId("validate")).toBe("validation");
      expect(resolveTopicId("pattern")).toBe("patterns");
    });

    it("should return original topic if no alias exists", () => {
      expect(resolveTopicId("nodes")).toBe("nodes");
      expect(resolveTopicId("workflows")).toBe("workflows");
      expect(resolveTopicId("pattern-skip")).toBe("pattern-skip");
      expect(resolveTopicId("unknown-topic")).toBe("unknown-topic");
    });
  });

  describe("Topic Discovery Integration", () => {
    beforeEach(() => {
      // Reset cache before each test
      resetCache();
    });

    it("should have expected topic categories defined", () => {
      // This test verifies the CATEGORY_ORDER constant
      const expectedCategories = [
        "Getting Started",
        "Concepts",
        "Guides",
        "Patterns",
        "Integration",
        "Reference",
      ];

      // We can't directly test internal constants, but we can verify
      // the file path to topic ID mapping produces expected results
      const testCases = [
        { path: "getting-started/quickstart.mdx", expectedId: "quickstart" },
        { path: "concepts/nodes.mdx", expectedId: "nodes" },
        { path: "guides/workflow-creation.mdx", expectedId: "workflow-creation" },
        { path: "patterns/skip.mdx", expectedId: "pattern-skip" },
        { path: "integration/agent-guide.mdx", expectedId: "agent-guide" },
        { path: "reference/tools.mdx", expectedId: "tools" },
      ];

      for (const { path, expectedId } of testCases) {
        expect(filePathToTopicId(path)).toBe(expectedId);
      }
    });

    it("should prefix workflow reference files correctly", () => {
      // reference/workflows/*.mdx files should get workflow- prefix
      expect(filePathToTopicId("reference/workflows/robust-task.mdx")).toBe("workflow-robust-task");
      expect(filePathToTopicId("reference/workflows/verified-research.mdx")).toBe(
        "workflow-verified-research",
      );
      expect(filePathToTopicId("reference/workflows/test-planning.mdx")).toBe(
        "workflow-test-planning",
      );
      expect(filePathToTopicId("reference/workflows/simple-plan-execution.mdx")).toBe(
        "workflow-simple-plan-execution",
      );
      expect(filePathToTopicId("reference/workflows/infinite-task-loop.mdx")).toBe(
        "workflow-infinite-task-loop",
      );
      expect(filePathToTopicId("reference/workflows/task-breakdown-flow.mdx")).toBe(
        "workflow-task-breakdown-flow",
      );
    });
  });

  describe("getTopicList - Workflow Mapping for Non-Claude Agents", () => {
    it("advertises the direct tools reference as a canonical Reference topic", () => {
      const result = getTopicList();

      expect(result).toContain(
        "- `tools` - Complete reference for all MCP tools available in Moira",
      );
      expect(result.match(/^- `tools`/gm)).toHaveLength(1);
      expect(resolveTopicId("tool")).toBe("tools");
    });

    it("should include task-to-workflow mapping section", () => {
      const result = getTopicList();

      // Verify workflow mapping section exists
      expect(result).toContain("## Task → Workflow Mapping");
      expect(result).toContain("complete authorized catalog with `list()`");
    });

    it("should include key workflow trigger mappings", () => {
      const result = getTopicList();

      // Verify essential workflow mappings are present
      expect(result).toContain("workflow-management-flow");
      expect(result).toContain("test-generation");
      expect(result).toContain("test-planning");
      expect(result).toContain("test-suite-audit");
      expect(result).toContain("content-creation");
      expect(result).toContain("research");
      expect(result).toContain("iterative-research");
      expect(result).toContain("universal-research-workflow");
      expect(result).toContain("prd-creation");
      expect(result).toContain("ux-design");
      expect(result).toContain("data-analysis");
      expect(result).toContain("marketing-campaign");
      expect(result).toContain("quick-task");
      expect(result).toContain("robust-task");
      expect(result).toContain("simple-plan-execution");
      expect(result).toContain("task-breakdown-flow");
      expect(result).toContain("infinite-task-loop");
      expect(result).toContain("software-development-flow");
    });

    it("should include trigger phrases for workflow mapping", () => {
      const result = getTopicList();

      // Verify trigger phrases are documented
      expect(result).toContain("create workflow");
      expect(result).toContain("implement executable tests");
      expect(result).toContain("test plan");
      expect(result).toContain("test suite audit");
      expect(result).toContain("one reviewed article");
      expect(result).toContain("research");
      expect(result).toContain("repeated independent zero-issue review");
      expect(result).toContain("develop feature");
      expect(result).toContain("implement");
      expect(result).toContain("build feature");
      expect(result).toContain("fix bug");
      expect(result).toContain("tasks that are not known in advance");
      expect(result).toContain("independent item review, changed retries, suffix revision");
    });

    it("should include start command with parentExecutionId", () => {
      const result = getTopicList();

      // Verify correct start command format for non-Claude agents
      expect(result).toContain("mcp__moira__start({ workflowId:");
      expect(result).toContain('parentExecutionId: "none"');
    });
  });

  describe("portable runtime topics", () => {
    it("uses each MCP-owned semantic source from both public language shells", () => {
      const discovered = scanHelpFiles(helpDirectory, helpDirectory);
      const discoveredIds = discovered.map(filePathToTopicId).sort();
      const publicIds = fs
        .readdirSync(publicDocsDirectory, { recursive: true })
        .filter(
          (file): file is string =>
            typeof file === "string" &&
            file.endsWith(".mdx") &&
            file !== "index.mdx" &&
            file !== "reference/tools.mdx" &&
            !file.startsWith("reference/workflows/"),
        )
        .map(filePathToTopicId)
        .sort();

      expect(discoveredIds).toEqual(publicIds);

      for (const file of discovered) {
        const shellPath = file.replace(/\.before\.md$/, ".mdx").replace(/\.md$/, ".mdx");
        const englishShell = fs.readFileSync(path.join(publicDocsDirectory, shellPath), "utf8");
        const russianShell = fs.readFileSync(
          path.resolve("packages/docs/src/content/docs/ru/docs", shellPath),
          "utf8",
        );
        const englishSource = fs.readFileSync(path.join(helpDirectory, file), "utf8");
        const russianSource = fs.readFileSync(path.join(helpDirectory, "ru", file), "utf8");
        expect(extractFrontmatter(englishSource)).toEqual(extractFrontmatter(englishShell));
        expect(extractFrontmatter(russianSource)).toEqual(extractFrontmatter(russianShell));
        expect(englishShell).toContain(`@mcp-moira/mcp-server/help-content/${file}`);
        expect(russianShell).toContain(`@mcp-moira/mcp-server/help-content/ru/${file}`);
        if (file.endsWith(".before.md") && !file.endsWith("agent-instructions.before.md")) {
          const after = file.replace(".before.md", ".after.md");
          expect(englishShell).toContain(`@mcp-moira/mcp-server/help-content/${after}`);
          expect(russianShell).toContain(`@mcp-moira/mcp-server/help-content/ru/${after}`);
        }
      }
    });

    it("renders every registry client from the shared localized presentation model", () => {
      for (const language of ["en", "ru"] as const) {
        const markdown = renderClientSetupMarkdown(language, "{MCP_URL}");
        const presentations = getClientSetupPresentation(language, "{MCP_URL}");
        expect(presentations).toHaveLength(mcpClients.length);
        for (const presentation of presentations) {
          expect(presentation.label).not.toContain("quickStart.tabs.");
          const sectionStart = `### ${presentation.label}`;
          const section = markdown.split(sectionStart)[1]?.split("\n### ")[0];
          expect(section).toBeDefined();
          const titles = [
            presentation.primary?.title,
            presentation.auth?.title,
            presentation.alternative?.title,
            presentation.tokenAuth?.code.title,
          ].filter((title): title is string => Boolean(title));
          for (const title of titles) expect(section).toContain(`**${title}**`);
          const { client } = presentation;
          if (client.setup.primaryGenerator) {
            expect(presentation.primary?.code).toBe(
              configGenerators[client.setup.primaryGenerator]("{MCP_URL}"),
            );
          }
          if (client.setup.alternative?.generator) {
            expect(presentation.alternative?.code).toBe(
              configGenerators[client.setup.alternative.generator]("{MCP_URL}"),
            );
          }
          if (client.setup.tokenAuth) {
            expect(presentation.tokenAuth?.code.code).toBe(
              tokenConfigGenerators[client.setup.tokenAuth.generator]("{MCP_URL}"),
            );
          }
        }
      }
    });

    it("propagates an injected registry deeplink generator without a parser key inventory", () => {
      const cursor = mcpClients.find((client) => client.id === "cursor")!;
      const fixtureClient: McpClient = {
        ...cursor,
        deeplinkGenerator: "fixture-client" as McpClient["deeplinkGenerator"],
      };
      const generated = renderClientSetupMarkdown("en", "{MCP_URL}", [fixtureClient]);
      expect(generated).toContain("{{MCP_DEEPLINK:fixture-client}}");

      const rendered = renderPortableHelpTokens(generated, {
        mcpUrl: "https://fixture.example/mcp",
        moiraUrl: "https://fixture.example",
        staticDomain: "static.fixture.example",
        deeplinkGenerators: {
          ...deeplinkGenerators,
          "fixture-client": (mcpUrl) => `fixture:mcp?url=${encodeURIComponent(mcpUrl)}`,
        },
      });
      expect(rendered).toContain("fixture:mcp?url=https%3A%2F%2Ffixture.example%2Fmcp");
      expect(rendered).not.toContain("{{MCP_DEEPLINK:fixture-client}}");
      for (const unsupportedId of ["unknown", "toString", "constructor"]) {
        const token = `{{MCP_DEEPLINK:${unsupportedId}}}`;
        expect(
          renderPortableHelpTokens(token, {
            mcpUrl: "https://fixture.example/mcp",
            moiraUrl: "https://fixture.example",
            staticDomain: "static.fixture.example",
            deeplinkGenerators,
          }),
        ).toBe(token);
      }
    });

    it("resolves every discovered non-tools topic to its complete portable source", async () => {
      const discovered = scanHelpFiles(helpDirectory, helpDirectory);

      expect(discovered.length).toBeGreaterThan(0);
      for (const file of discovered) {
        expect(fs.existsSync(path.join(helpDirectory, file))).toBe(true);
        const rendered = composePortableHelpFile(file, { helpDirectory });
        expect(rendered).not.toBeNull();
        const topic = filePathToTopicId(file);
        const resolved = await generateHelpContent(topic, undefined, undefined, {
          helpDirectory,
        });
        expect(resolved).toBe(rendered);
        expect(rendered).not.toMatch(
          /<(?:Aside|Card|CardGrid|ClientSetupTabs|FileTree|McpUrl|MoiraUrl|StaticUrl|Steps|SystemPromptContent|TabItem|Tabs)\b/,
        );
        expect(rendered).not.toMatch(/^import\s/m);
        expect(rendered).not.toMatch(
          /\{\{(?:CLIENT_SETUP|SYSTEM_PROMPT_CONTENT)|\{(?:MCP_URL|MOIRA_URL|STATIC_DOMAIN)\}/,
        );
      }
    });

    it("preserves configured URLs, registry-owned clients, imported content, and component labels", async () => {
      const previousHost = process.env.MOIRA_HOST;
      const previousStaticDomain = process.env.STATIC_ARTIFACTS_DOMAIN;
      process.env.MOIRA_HOST = "help.example.test";
      process.env.STATIC_ARTIFACTS_DOMAIN = "artifacts.example.test";

      try {
        const read = (file: string): string => composePortableHelpFile(file, { helpDirectory })!;
        const paths = { helpDirectory };
        const clients = await generateHelpContent("mcp-clients", undefined, undefined, paths);
        const quickstart = await generateHelpContent("quickstart", undefined, undefined, paths);

        expect(clients).toContain("https://help.example.test/mcp");
        expect(quickstart).toContain("https://help.example.test");
        expect(quickstart).toContain("https://help.example.test/mcp");
        for (const presentation of getClientSetupPresentation("en", "{MCP_URL}")) {
          const sectionStart = `### ${presentation.label}`;
          expect(clients).toContain(sectionStart);
          const section = clients.split(sectionStart)[1]?.split("\n### ")[0];
          const titles = [
            presentation.primary?.title,
            presentation.auth?.title,
            presentation.alternative?.title,
            presentation.tokenAuth?.code.title,
          ].filter((title): title is string => Boolean(title));
          for (const title of titles) expect(section).toContain(`**${title}**`);
        }
        expect(clients).toContain("Authorization");
        expect(read("integration/claude-code.md")).toContain("https://help.example.test/mcp");
        expect(read("concepts/artifacts.md")).toContain("artifacts.example.test");
        expect(read("integration/agent-instructions.before.md")).toContain("## Purpose");
        expect(read("concepts/nodes.md")).toContain("### Telegram Notification");
        expect(read("guides/workflow-creation.md")).toContain("### File Upload");
      } finally {
        if (previousHost === undefined) delete process.env.MOIRA_HOST;
        else process.env.MOIRA_HOST = previousHost;
        if (previousStaticDomain === undefined) delete process.env.STATIC_ARTIFACTS_DOMAIN;
        else process.env.STATIC_ARTIFACTS_DOMAIN = previousStaticDomain;
      }
    });
  });

  describe("generated tool reference", () => {
    it("serves the registry directly for the tools topic and its alias", async () => {
      const direct = await generateHelpContent("tools", undefined, () => renderToolReference("en"));
      const alias = await generateHelpContent("tool", undefined, () => renderToolReference("en"));

      expect(direct).toBe(alias);
      expect(direct).toContain("# MCP tools");
      expect(direct).toContain("## `reconciliation`");
      expect(direct).toContain("`set-visibility`");
      expect(direct).toContain("### Input schema");
      expect(direct).toContain('"parentExecutionId"');
      expect(direct).toContain("nextOffset");
      expect(direct).not.toContain("import {");
    });
  });
});
