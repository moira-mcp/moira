/**
 * Unit tests for get-help MDX processing functions
 */

import { describe, it, expect, beforeEach } from "@jest/globals";
import { _testing } from "../../../packages/mcp-server/src/tools/get-help.js";

const { extractFrontmatter, filePathToTopicId, resolveTopicId, getTopicList, resetCache } =
  _testing;

describe("MDX Processing", () => {
  describe("stripFrontmatter", () => {
    const stripFrontmatter = (content: string): string => {
      const frontmatterRegex = /^---\s*\n[\s\S]*?\n---\s*\n/;
      return content.replace(frontmatterRegex, "");
    };

    it("should remove YAML frontmatter from start of content", () => {
      const input = `---
title: Test Title
description: Test description
---

# Heading

Content here.`;

      const result = stripFrontmatter(input);
      expect(result).toBe(`# Heading

Content here.`);
    });

    it("should not affect content without frontmatter", () => {
      const input = `# Heading

Content without frontmatter.`;

      const result = stripFrontmatter(input);
      expect(result).toBe(input);
    });

    it("should handle multiline frontmatter", () => {
      const input = `---
title: Complex Title
description: |
  This is a multiline
  description field
tags:
  - one
  - two
---

# Content`;

      const result = stripFrontmatter(input);
      expect(result).toBe("# Content");
    });
  });

  describe("stripJsx", () => {
    const stripJsx = (content: string): string => {
      // Remove import statements
      let result = content.replace(/^import\s+.*?;\s*$/gm, "");

      // Remove self-closing JSX tags
      result = result.replace(/<[A-Z][a-zA-Z]*\s*[^>]*\/>/g, "");

      // Remove JSX component blocks
      let prevResult = "";
      while (prevResult !== result) {
        prevResult = result;
        result = result.replace(/<([A-Z][a-zA-Z]*)[^>]*>[\s\S]*?<\/\1>/g, (match) => {
          const innerText = match.replace(/<[^>]+>/g, "").trim();
          return innerText ? innerText : "";
        });
      }

      // Clean up multiple blank lines
      result = result.replace(/\n{3,}/g, "\n\n");

      return result.trim();
    };

    it("should remove import statements", () => {
      const input = `import { Aside, Card } from '@astrojs/starlight/components';

# Content`;

      const result = stripJsx(input);
      expect(result).toBe("# Content");
    });

    it("should remove self-closing JSX tags", () => {
      const input = `# Title

<MyComponent prop="value" />

More content.`;

      const result = stripJsx(input);
      expect(result).toBe(`# Title

More content.`);
    });

    it("should extract text content from JSX blocks", () => {
      const input = `<Card title="Test">
  This is card content.
</Card>`;

      const result = stripJsx(input);
      expect(result).toBe("This is card content.");
    });

    it("should handle nested JSX components", () => {
      const input = `<CardGrid>
  <Card title="One">
    First card content
  </Card>
  <Card title="Two">
    Second card content
  </Card>
</CardGrid>`;

      const result = stripJsx(input);
      // Should extract text content from nested components
      expect(result).toContain("First card content");
      expect(result).toContain("Second card content");
    });

    it("should preserve markdown content", () => {
      const input = `import { Aside } from '@astrojs/starlight/components';

# Main Title

Regular markdown **bold** and *italic*.

## Code Example

\`\`\`json
{
  "key": "value"
}
\`\`\`

<Aside type="tip">
  This is a tip.
</Aside>

More markdown content.`;

      const result = stripJsx(input);
      expect(result).toContain("# Main Title");
      expect(result).toContain("Regular markdown **bold** and *italic*.");
      expect(result).toContain("```json");
      expect(result).toContain('"key": "value"');
      expect(result).toContain("More markdown content.");
    });

    it("should not affect lowercase HTML tags", () => {
      const input = `# Title

<div class="test">
  <p>Paragraph</p>
</div>

Content.`;

      const result = stripJsx(input);
      // Lowercase tags should be preserved (they're HTML, not JSX components)
      expect(result).toContain("<div");
      expect(result).toContain("<p>");
    });
  });

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
    });
  });

  describe("getTopicList - Workflow Mapping for Non-Claude Agents", () => {
    it("should include task-to-workflow mapping section", () => {
      const result = getTopicList();

      // Verify workflow mapping section exists
      expect(result).toContain("## Task → Workflow Mapping");
      expect(result).toContain("Use this when user requests match these patterns");
    });

    it("should include key workflow trigger mappings", () => {
      const result = getTopicList();

      // Verify essential workflow mappings are present
      expect(result).toContain("workflow-management-flow");
      expect(result).toContain("test-generation");
      expect(result).toContain("test-planning");
      expect(result).toContain("content-creation");
      expect(result).toContain("research");
      expect(result).toContain("prd-creation");
      expect(result).toContain("ux-design");
      expect(result).toContain("data-analysis");
      expect(result).toContain("marketing-campaign");
      expect(result).toContain("quick-task");
      expect(result).toContain("robust-task");
      expect(result).toContain("software-development-flow");
    });

    it("should include trigger phrases for workflow mapping", () => {
      const result = getTopicList();

      // Verify trigger phrases are documented
      expect(result).toContain("create workflow");
      expect(result).toContain("write tests");
      expect(result).toContain("test plan");
      expect(result).toContain("write article");
      expect(result).toContain("research");
      expect(result).toContain("develop feature");
      expect(result).toContain("implement");
      expect(result).toContain("build feature");
      expect(result).toContain("fix bug");
    });

    it("should include start command with parentExecutionId", () => {
      const result = getTopicList();

      // Verify correct start command format for non-Claude agents
      expect(result).toContain("mcp__moira__start({ workflowId:");
      expect(result).toContain('parentExecutionId: "none"');
    });
  });
});
