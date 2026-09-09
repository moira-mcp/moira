import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createAuthenticatedMCPClient } from "../utils/mcp-auth.js";

describe("MCP tool catalog", () => {
  let client: Client;
  let cleanup: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const authenticated = await createAuthenticatedMCPClient();
    client = authenticated.client;
    cleanup = authenticated.cleanup;
  });

  afterAll(async () => {
    await cleanup?.();
  });

  test("publishes Claude Code-compatible root-object input schemas", async () => {
    const tools = (await client.listTools()).tools;

    for (const tool of tools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema).not.toHaveProperty("anyOf");
      expect(schema).not.toHaveProperty("oneOf");
    }

    const start = tools.find((tool) => tool.name === "start");
    expect(start).toBeDefined();
    const startSchema = start!.inputSchema as {
      properties?: Record<string, { enum?: string[] }>;
    };
    expect(startSchema.properties?.action?.enum).toEqual(["prepare", "execute"]);
    expect(startSchema.properties).toEqual(
      expect.objectContaining({
        workflowId: expect.any(Object),
        parentExecutionId: expect.any(Object),
        startAttemptId: expect.any(Object),
      }),
    );
  });
});
