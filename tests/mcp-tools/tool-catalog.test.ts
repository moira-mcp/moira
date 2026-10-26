import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Ajv } from "ajv";
import { encodeReference } from "@mcp-moira/shared/workspace-references";
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

  test("publishes strict action branches and supports root-only native client rewriting", async () => {
    const tools = (await client.listTools()).tools;

    for (const tool of tools) {
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
    }

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "artifacts",
      "codespace",
      "codespace_download",
      "codespace_edit",
      "codespace_git",
      "codespace_read",
      "codespace_search",
      "codespace_terminal",
      "codespace_upload",
      "communication",
      "execution",
      "help",
      "notes",
      "playbooks",
      "settings",
      "workflow",
    ]);
    const ajv = new Ajv({ strict: false, validateFormats: false });
    const execution = ajv.compile(tools.find((tool) => tool.name === "execution")!.inputSchema);
    expect(
      execution({ action: "prepare", workflowId: "moira/quick-task", parentExecutionId: "none" }),
    ).toBe(true);
    expect(
      execution({ action: "execute", startAttemptId: "00000000-0000-4000-8000-000000000001" }),
    ).toBe(true);
    expect(execution({ action: "execute", workflowId: "moira/quick-task" })).toBe(false);
    expect(execution({ action: "user", executionId: "00000000-0000-4000-8000-000000000001" })).toBe(
      false,
    );

    const terminal = tools.find((tool) => tool.name === "codespace_terminal")!;
    const schema = structuredClone(terminal.inputSchema);
    // Native hosts replace only the root file property with a local path. A second object
    // restriction inside an action branch would make this otherwise valid request impossible.
    schema.properties!.stdin_file = { type: "string" };
    const masked = ajv.compile(schema);
    const command = {
      command: { argv: ["cat"] },
      workspace: encodeReference("workspace", {
        resourceId: "00000000-0000-4000-8000-000000000162",
        provider: "github-codespaces",
        generation: 1,
      }),
    };
    expect(masked({ ...command, action: "run" })).toBe(true);
    expect(masked({ ...command, action: "run_native", stdin_file: "/tmp/input.txt" })).toBe(true);
    expect(masked({ ...command, action: "run_native" })).toBe(false);
    expect(masked({ ...command, action: "run", stdin_file: "/tmp/input.txt" })).toBe(false);
  });
});
