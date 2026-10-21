import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { encodeReference } from "@mcp-moira/shared/workspace-references";
import { createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { dockerExecSync } from "../utils/docker-command.js";
const resourceId = "00000000-0000-4000-8000-000000000162";
const workspace = encodeReference("workspace", {
  resourceId,
  provider: "github-codespaces",
  generation: 1,
});
const processRef = encodeReference("process", {
  owner: { kind: "github", resourceId },
  requestId: "ws1-00000000-0000-4000-8000-000000000163",
});
const native = {
  file_id: "file_HttpContract",
  download_url: "https://files.oaiusercontent.com/http-contract",
};
describe("Semantic workspace MCP HTTP boundary without configured GitHub or paired Local", () => {
  let client: Client;
  let cleanup: (() => Promise<void>) | undefined;
  let accessToken: string;
  beforeAll(async () => {
    const authenticated = await createAuthenticatedMCPClient();
    client = authenticated.client;
    cleanup = authenticated.cleanup;
    accessToken = authenticated.accessToken;
  });
  afterAll(async () => {
    await cleanup?.();
  });
  test("publishes distinct strict purposes, required native fields and no flat legacy tool", async () => {
    const catalog = (await client.listTools()).tools;
    for (const name of [
      "workspace_list",
      "workspace_targets",
      "workspace_observe",
      "workspace_adopt",
      "file_create",
      "file_replace",
      "file_patch",
      "command_run",
      "command_run_native",
      "operation_get",
      "operation_find",
      "communication_send",
      "communication_deliver",
      "communication_deliver_publication",
    ])
      expect(catalog.find((tool) => tool.name === name)).toBeDefined();
    for (const name of ["codespace", "codespace_process", "communication"])
      expect(catalog.find((tool) => tool.name === name)).toBeUndefined();
    for (const [name, field] of [
      ["file_upload", "file"],
      ["command_run_native", "stdin_file"],
      ["communication_deliver", "file"],
    ]) {
      const tool = catalog.find((tool) => tool.name === name)!;
      expect(tool.inputSchema.required).toContain(field);
      expect(tool._meta).toEqual({ "openai/fileParams": [field] });
    }
    for (const tool of catalog) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema).not.toHaveProperty("oneOf");
      expect(tool.inputSchema).not.toHaveProperty("anyOf");
    }
    expect(
      catalog.find((tool) => tool.name === "command_run")!.inputSchema.properties,
    ).not.toHaveProperty("request_id");
  });
  test("lists compact available and unavailable identities without billing or credentials", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "workspace_list",
        arguments: { provider: "github-codespaces" },
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      workspaces: [],
      unavailable: [],
      has_diagnostics: false,
      provider_errors: [],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /accessToken|refreshToken|clientSecret|vaultKey|BEGIN .*PRIVATE KEY|provider_billing/,
    );
  });
  test("discovers returned targets/controllers and setup guidance without provisioning", async () => {
    const targets = CallToolResultSchema.parse(
      await client.callTool({
        name: "workspace_targets",
        arguments: { provider: "github-codespaces" },
      }),
    );
    expect(targets.structuredContent).toMatchObject({
      targets: [],
      controllers: [],
      installations: [],
    });
    const help = CallToolResultSchema.parse(
      await client.callTool({ name: "workspace_setup_help", arguments: {} }),
    );
    expect(help.isError).not.toBe(true);
    expect(help.structuredContent).toHaveProperty("result");
    expect(JSON.stringify(help)).not.toMatch(/accessToken|refreshToken|clientSecret|vaultKey/);
  });
  test.each([
    ["workspace_observe", { workspace }],
    ["workspace_lifecycle", { workspace, action: "start" }],
    ["workspace_delete", { workspace, confirm_delete: true }],
    ["file_stat", { workspace, path: "file" }],
    ["file_read", { workspace, path: "file" }],
    ["code_search", { workspace, path: ".", query: "TODO" }],
    ["file_create", { workspace, path: "file", text: "x" }],
    ["file_replace", { workspace, path: "file", text: "new", expected: { text: "old" } }],
    [
      "file_patch",
      {
        workspace,
        files: [{ path: "file", replacements: [{ old_text: "old", new_text: "new" }] }],
      },
    ],
    ["file_upload", { workspace, target: { create: { path: "input.bin" } }, file: native }],
    ["file_download", { workspace, path: "result.bin" }],
    ["file_preview", { workspace, path: "screen.png" }],
    ["command_run", { workspace, command: { argv: ["pwd"] } }],
    ["command_run_native", { workspace, command: { argv: ["cat"] }, stdin_file: native }],
    ["process_output", { process: processRef, stream: "stdout" }],
    ["process_stop", { process: processRef }],
    ["operation_get", { reference: processRef }],
    ["pull_request_create", { workspace, head: "feature/change", base: "main", title: "Change" }],
    ["pull_request_read", { workspace, query: { number: 7 } }],
  ])(
    "refuses purpose %s for a resource outside the authenticated ownership without setup fallback",
    async (name, args) => {
      const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ error: { code: "CODESPACE_NOT_FOUND" } });
      expect(JSON.stringify(result)).not.toMatch(
        /accessToken|refreshToken|clientSecret|vaultKey|github.com\/login|device_code/,
      );
    },
  );
  test.each([
    "request_id",
    "generation",
    "provider",
    "credential",
    "chat_id",
    "device_id",
    "connection_id",
  ])(
    "rejects undeclared %s before SDK normalization without reflecting its value",
    async (field) => {
      const response = await fetch(getTestBaseUrl() + "/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "command_run",
            arguments: { workspace, command: { argv: ["pwd"] }, [field]: "private-rejected-value" },
          },
        }),
      });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: -32602 } });
      expect(JSON.stringify(body)).not.toContain("private-rejected-value");
    },
  );
  test("rejects mixed native/text stdin instead of dispatching a partial request", async () => {
    const response = await fetch(getTestBaseUrl() + "/mcp", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "command_run_native",
          arguments: {
            workspace,
            command: { argv: ["cat"] },
            stdin_file: native,
            stdin_text: "exclusive-input-canary",
          },
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain("exclusive-input-canary");
  });
  test("retains provider liveness independently of ordinary discovery", async () => {
    const health = JSON.parse(dockerExecSync(["curl", "-s", "http://localhost:3000/health"])) as {
      status: string;
      codespaces: unknown;
    };
    expect(health.codespaces).toEqual({
      state: "disabled",
      provider: "github-codespaces",
      degraded: false,
    });
    expect(health.status).toBe("healthy");
  });
  test("cannot read an owner publication without current authority", async () => {
    const response = await fetch(
      getTestBaseUrl() +
        "/api/codespaces/files/" +
        resourceId +
        "/" +
        "invalid-http-route-canary".padEnd(43, "x"),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "workspace_publication_unavailable" });
  });
});
