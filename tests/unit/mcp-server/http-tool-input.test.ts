import { afterEach, expect, test } from "@jest/globals";
import express from "express";
import request from "supertest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestContext } from "@mcp-moira/shared";
import { encodeReference } from "@mcp-moira/shared/workspace-references";
import { readAuthenticatedMcpRequest } from "../../../packages/mcp-server/src/authenticated-request.js";
import { handleAuthenticatedMcpRequest } from "../../../packages/mcp-server/src/authenticated-mcp-handler.js";
import { MCP_TOOLS_REVISION } from "../../../packages/mcp-server/src/tools/tool-definitions.js";
import { registerTools } from "../../../packages/mcp-server/src/tools/register-tools.js";
import { TOOL_BINDINGS } from "../../../packages/mcp-server/src/tools/tool-bindings.js";
import { PUBLIC_TOOL_INPUT_SCHEMAS } from "../../../packages/mcp-server/src/tools/public-tool-contract.js";

const servers: McpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function fixture() {
  const app = express();
  app.post("/mcp", async (req, res) => {
    const principal = await readAuthenticatedMcpRequest(
      req,
      res,
      async () => ({ userId: "test-owner", email: "owner@example.test" }),
      async () => 1024,
    );
    if (!principal) return;
    await handleAuthenticatedMcpRequest(
      req,
      res,
      principal,
      {
        kind: "persistent",
        id: "fixture-credential",
        toolsVersion: MCP_TOOLS_REVISION,
        stampRevision: async () => true,
      },
      async () => {
        const server = new McpServer(
          { name: "http-input-test", version: "1" },
          { capabilities: { tools: {} } },
        );
        registerTools(server, undefined, () => null);
        servers.push(server);
        return server;
      },
    );
  });
  return (name: string, args: Record<string, unknown>) =>
    request(app)
      .post("/mcp")
      .set("accept", "application/json, text/event-stream")
      .set("mcp-protocol-version", "2025-03-26")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

test("HTTP admission and SDK dispatch deliver native and stringified workflow inputs identically", async () => {
  const post = fixture();
  const workflow = {
    metadata: { name: "Flow", version: "1", description: "Flow", extension: false },
    nodes: [{ id: "end", type: "end" }],
    extension: { retained: 0 },
  };
  const received: unknown[] = [];
  const original = TOOL_BINDINGS.manage;
  TOOL_BINDINGS.manage = async (params) => {
    received.push(params);
    return { success: true, data: "retained" };
  };
  try {
    const native = await post("workflow", { action: "validate", workflow });
    expect(native.status).toBe(200);
    expect(received).toEqual([{ action: "validate", workflow }]);
    const stringified = await post("workflow", {
      action: "validate",
      workflow: JSON.stringify(workflow),
    });
    expect(stringified.status).toBe(200);
    expect(stringified.text).toContain("retained");
    expect(received).toEqual([
      { action: "validate", workflow },
      { action: "validate", workflow },
    ]);
    const refused = await post("workflow", {
      action: "validate",
      workflow: JSON.stringify(workflow),
      overwrite: true,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe(-32602);
    expect(received).toHaveLength(2);
  } finally {
    TOOL_BINDINGS.manage = original;
  }
});

test("HTTP preprocessing never copies native-file arguments into generic log context", async () => {
  const post = fixture();
  const workspace = encodeReference("workspace", {
    resourceId: "00000000-0000-4000-8000-000000000001",
    provider: "github-codespaces",
    generation: 1,
  });
  const file = {
    file_id: "file_Private",
    download_url: "https://files.oaiusercontent.com/private-signed-value",
  };
  const target = { create: { path: "private-name" } };
  const received: unknown[] = [],
    contexts: unknown[] = [];
  const original = TOOL_BINDINGS.file_upload;
  TOOL_BINDINGS.file_upload = async (params) => {
    received.push(params);
    const context = getRequestContext();
    contexts.push({ inputData: context?.inputData, resourceIds: context?.resourceIds });
    return { content: [{ type: "text", text: "uploaded" }] };
  };
  try {
    for (const value of [file, JSON.stringify(file)]) {
      expect((await post("codespace_upload", { workspace, target, file: value })).status).toBe(200);
    }
    expect(received).toEqual([
      { workspace, target, file },
      { workspace, target, file },
    ]);
    expect(contexts).toEqual(
      Array(2).fill({ inputData: { workspace_tool: "file_upload" }, resourceIds: {} }),
    );
    expect(JSON.stringify(contexts)).not.toMatch(/private-name|private-signed-value|file_Private/);
  } finally {
    TOOL_BINDINGS.file_upload = original;
  }
});

test("HTTP logs and dispatch retain the same default computed during admission", async () => {
  const post = fixture();
  const originalSchema = PUBLIC_TOOL_INPUT_SCHEMAS.help,
    originalBinding = TOOL_BINDINGS.help;
  let defaults = 0;
  const received: unknown[] = [],
    logged: unknown[] = [];
  PUBLIC_TOOL_INPUT_SCHEMAS.help = z
    .object({ topic: z.string().default(() => `topic-${++defaults}`) })
    .strict();
  TOOL_BINDINGS.help = async (params) => {
    received.push(params);
    logged.push(getRequestContext()?.inputData);
    return { success: true, data: "help" };
  };
  try {
    expect((await post("help", {})).status).toBe(200);
    expect(defaults).toBe(1);
    expect(received).toEqual([{ topic: "topic-1" }]);
    expect(logged).toEqual(received);
  } finally {
    PUBLIC_TOOL_INPUT_SCHEMAS.help = originalSchema;
    TOOL_BINDINGS.help = originalBinding;
  }
});
