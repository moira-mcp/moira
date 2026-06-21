/**
 * MCP E2E Tests - Help System
 * Tests: get_help with different topics
 */

import { describe, test, expect, beforeAll, afterAll } from "@jest/globals";
import { createAuthenticatedMCPClient, callMCPTool } from "../utils/mcp-auth.js";
import { MCP_TEST_DATA } from "../fixtures/mcp-test-data.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const { DOCUMENTATION } = MCP_TEST_DATA;

describe("MCP Help System E2E", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeAll(async () => {
    const mcpClient = await createAuthenticatedMCPClient();
    client = mcpClient.client;
    cleanup = mcpClient.cleanup;
  });

  afterAll(async () => {
    await cleanup();
  });

  test("get_help without topic returns topic list", async () => {
    const result = await callMCPTool<string>(client, "help", {});

    expect(typeof result).toBe("string");
    expect(result).toContain("Available Help Topics");
    expect(result).toContain("overview");
    expect(result).toContain("nodes");
    expect(result).toContain("tools");

    console.log(`✓ Topic list returned: ${result.length} characters`);
  });

  test("get_help with overview topic", async () => {
    const result = await callMCPTool<string>(client, "help", {
      topic: "overview",
    });

    expect(typeof result).toBe("string");
    // Introduction MDX contains Moira description
    expect(result).toContain("Moira");
    expect(result).toContain("workflow");
    expect(result.length).toBeLessThan(10000);

    console.log("✓ Overview documentation generated");
  });

  test("get_help with nodes topic", async () => {
    const result = await callMCPTool<string>(client, "help", {
      topic: "nodes",
    });

    expect(typeof result).toBe("string");

    // Should include all node types
    for (const nodeType of DOCUMENTATION.NODE_TYPES) {
      expect(result).toContain(nodeType);
    }

    // Should include examples
    expect(result).toContain("```");

    console.log("✓ Node types documentation with examples");
  });

  test("get_help with workflows topic", async () => {
    const result = await callMCPTool<string>(client, "help", {
      topic: "workflows",
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("metadata");
    expect(result).toContain("nodes");
    expect(result).toContain("connections");

    console.log("✓ Workflow structure documentation");
  });

  test("get_help with validation topic", async () => {
    const result = await callMCPTool<string>(client, "help", {
      topic: "validation",
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("Validation");
    expect(result.toLowerCase()).toMatch(/valid|error|warning/);

    console.log("✓ Validation rules documentation");
  });

  test("get_help with patterns topic", async () => {
    const result = await callMCPTool<string>(client, "help", {
      topic: "patterns",
    });

    expect(typeof result).toBe("string");
    expect(result.toLowerCase()).toContain("pattern");
    expect(result).toMatch(/workflow|reusable/i);

    console.log("✓ Patterns documentation generated");
  });

  test("help with tools topic lists all tools", async () => {
    const result = await callMCPTool<string>(client, "help", {
      topic: "tools",
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("workflow execution");
    expect(result).toContain("list");
    expect(result).toContain("step");

    console.log("✓ Tools list documentation");
  });

  test("help tools topic contains step details", async () => {
    // Tool-specific help is now part of 'tools' topic (MDX is single source of truth)
    const result = await callMCPTool<string>(client, "help", {
      topic: "tools",
    });

    expect(typeof result).toBe("string");
    expect(result).toContain("step");
    expect(result).toContain("Parameters");
    expect(result).toContain("Example");

    console.log("✓ Tool-specific documentation in tools topic");
  });

  test("get_help with templates topic", async () => {
    const result = await callMCPTool<string>(client, "help", {
      topic: "templates",
    });

    expect(typeof result).toBe("string");
    expect(result.toLowerCase()).toMatch(/template|variable/);

    console.log("✓ Templates documentation generated");
  });

  test("help includes core workflow concepts", async () => {
    const result = await callMCPTool<string>(client, "help", {
      topic: "overview",
    });

    // Check key workflow concepts are present (from introduction.mdx)
    const keyConcepts = ["workflow", "node", "directive", "execution"];
    for (const concept of keyConcepts) {
      expect(result.toLowerCase()).toContain(concept);
    }

    console.log(`✓ Key workflow concepts present`);
  });

  test("help is valid markdown", async () => {
    const result = await callMCPTool<string>(client, "help", {
      topic: "overview",
    });

    // Basic markdown validation
    expect(result).toMatch(/^#/m); // Has headers
    expect(result).toMatch(/\n\n/); // Has paragraphs

    // Count code blocks (should be even - opening and closing)
    const codeBlocks = result.match(/```/g);
    if (codeBlocks) {
      expect(codeBlocks.length % 2).toBe(0);
    }

    console.log("✓ Valid markdown structure");
  });

  test("all system topics generate help", async () => {
    // Test all defined topics
    const systemTopics = [
      "overview",
      "nodes",
      "workflows",
      "templates",
      "validation",
      "examples",
      "tools",
    ];
    for (const topic of systemTopics) {
      const result = await callMCPTool<string>(client, "help", {
        topic,
      });

      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(50);
    }

    console.log(`✓ All ${systemTopics.length} system topics generate valid help`);
  });

  test("get_help with unknown topic returns error and hint", async () => {
    const result = await callMCPTool<string>(client, "help", {
      topic: "nonexistent_topic_12345",
    });

    expect(typeof result).toBe("string");
    // Should contain the error message from ERRORS.unknown_help_topic
    expect(result).toContain("Unknown topic: nonexistent_topic_12345");
    // Should provide a hint on how to get the topic list (Step 7 change - concise hints instead of full list)
    expect(result).toContain("Hint:");
    expect(result).toContain("help()");

    console.log("✓ Unknown topic returns helpful error with hint");
  });
});
