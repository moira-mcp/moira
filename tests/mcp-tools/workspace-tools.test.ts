import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import { getAdminCredentials, getTestBaseUrl } from "../utils/test-config.js";
import { dockerExecSync } from "../utils/docker-command.js";

const workspaceId = "00000000-0000-4000-8000-000000000162";
const operationId = "00000000-0000-4000-8000-000000000163";
const names = [
  "workspace_create",
  "workspace_list",
  "workspace_get",
  "workspace_start",
  "workspace_stop",
  "workspace_delete",
  "workspace_exec",
  "workspace_stat",
  "workspace_search",
  "workspace_read",
  "workspace_write",
  "workspace_apply_patch",
  "workspace_upload",
  "workspace_download",
];

// Run the baked service against its actual database and transfer directory. No
// capability is written to disk or included in a thrown Docker command error.
function transferFixtureCommand(action: "seed" | "cleanup", value: string): string {
  const target = new URL(getTestBaseUrl());
  if (
    process.env.REMOTE_DOCKER_CONTEXT ||
    target.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  ) {
    throw new Error("Workspace transfer fixture requires a local test container");
  }
  const script = `
    const { WorkspaceTransferRepository, WorkspaceTransferService, getSqliteInstance,
      getWorkspaceResourcePolicy, getDbPath } = await import('@mcp-moira/shared');
    const { dirname, join } = await import('node:path');
    const db = getSqliteInstance();
    const service = new WorkspaceTransferService({
      repository: new WorkspaceTransferRepository(db), policy: getWorkspaceResourcePolicy,
      root: join(dirname(getDbPath()), 'workspace-transfers'),
    });
    if (process.argv[1] === 'seed') {
      const user = db.prepare('SELECT id FROM user WHERE email = ?').get(process.argv[2]);
      if (!user) throw new Error('Explicit authenticated fixture owner missing');
      const reservation = service.reserveDownload(user.id, {
        fileName: 'workspace-http-probe.bin', mimeType: 'application/octet-stream', maxBytes: 6,
      });
      const handle = await service.publishDownload(reservation, Buffer.from([0, 255, 1, 128, 10, 42]));
      process.stdout.write('TRANSFER_FIXTURE:' + JSON.stringify({
        id: reservation.record.id, referenceId: handle.referenceId,
      }));
    } else {
      const record = db.prepare('SELECT * FROM workspaceTransfer WHERE id = ?').get(process.argv[2]);
      if (record) await service.discard(record);
    }
    db.close();
  `;
  try {
    return dockerExecSync([
      "node",
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
      action,
      value,
    ]);
  } catch {
    throw new Error(`Workspace transfer HTTP fixture ${action} failed`);
  }
}

function expectSettingsLink(value: unknown) {
  expect(typeof value).toBe("string");
  const url = new URL(value as string);
  expect(url.origin).toBe(new URL(getTestBaseUrl()).origin);
  expect(url.pathname).toBe("/settings");
  expect(url.hash).toBe("#integrations-github");
  expect(url.search).toBe("");
  expect(url.username).toBe("");
  expect(url.password).toBe("");
}

describe("Workspace MCP HTTP contract on a default-disabled installation", () => {
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

  test("should publish all workspace tools with actionable native-file and resume schemas", async () => {
    const catalog = await client.listTools();
    const workspaceTools = catalog.tools.filter((tool) => tool.name.startsWith("workspace_"));
    expect(workspaceTools.map((tool) => tool.name).sort()).toEqual([...names].sort());
    for (const tool of workspaceTools) {
      expect(tool.description?.length).toBeGreaterThan(20);
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(
        /"(?:chat_id|session_id|access_token|refresh_token|ssh_key)"/,
      );
    }
    const exec = workspaceTools.find((tool) => tool.name === "workspace_exec")!;
    const upload = workspaceTools.find((tool) => tool.name === "workspace_upload")!;
    for (const [tool, field] of [
      [exec, "stdin_file"],
      [upload, "file"],
    ] as const) {
      expect(tool._meta).toEqual({ "openai/fileParams": [field] });
      const file = tool.inputSchema.properties?.[field] as Record<string, unknown>;
      expect(file).toMatchObject({
        type: "object",
        additionalProperties: false,
        properties: {
          file_id: { type: "string" },
          download_url: { type: "string", format: "uri" },
          file_name: { type: "string" },
          mime_type: { type: "string" },
          size_bytes: { type: "integer" },
        },
      });
      expect([...(file.required as string[])].sort()).toEqual(["download_url", "file_id"]);
    }
    // Root-object catalog: every form's fields are visible at the top level, only the shared
    // identity is required, and the exclusive stdin / resume forms are enforced at dispatch.
    expect(exec.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["workspace_id"],
      properties: expect.objectContaining({
        argv: expect.any(Object),
        timeout_seconds: expect.any(Object),
        stdin_text: { type: "string" },
        stdin_file: expect.any(Object),
        operation_id: expect.any(Object),
      }),
    });
    expect(exec.inputSchema).not.toHaveProperty("anyOf");
    const download = workspaceTools.find((tool) => tool.name === "workspace_download")!;
    expect(download.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: expect.objectContaining({
        path: expect.any(Object),
        max_bytes: expect.any(Object),
        operation_id: expect.any(Object),
      }),
    });
    expect([...(download.inputSchema.required as string[])].sort()).toEqual([
      "file_name",
      "mime_type",
      "workspace_id",
    ]);
  });

  test("should list safe setup status without provisioning or exposing credentials", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: "workspace_list", arguments: {} }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      readiness: { state: "disabled", reason: "NOT_CONFIGURED" },
      instance: {
        state: "disabled",
        reason: "NOT_CONFIGURED",
        provider: "github-codespaces",
        connector: "not_applicable",
      },
      repositories: [],
      workspaces: [],
    });
    expectSettingsLink(
      (result.structuredContent?.readiness as Record<string, unknown>).settings_url,
    );
    expect(JSON.stringify(result)).not.toMatch(
      /accessToken|refreshToken|clientSecret|vaultKey|BEGIN .*PRIVATE KEY/,
    );
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type).toBe("text");
    expect(JSON.parse((text as { text: string }).text)).toEqual(result.structuredContent);
  });

  test("should report the same readiness decision through MCP health as through workspace_list", async () => {
    const listed = CallToolResultSchema.parse(
      await client.callTool({ name: "workspace_list", arguments: {} }),
    );
    const instance = listed.structuredContent?.instance as { state: string; provider: string };
    const health = JSON.parse(dockerExecSync(["curl", "-s", "http://localhost:3000/health"])) as {
      status: string;
      workspaces: Record<string, unknown>;
    };
    // The public liveness surface carries only the decision, never operator detail.
    expect(health.workspaces).toEqual({
      state: instance.state,
      provider: instance.provider,
      degraded: false,
    });
    // A disabled feature must not degrade the MCP process.
    expect(health.status).toBe("healthy");
  });

  test("should route an invalid public download capability to the private transfer handler", async () => {
    const response = await fetch(
      `${getTestBaseUrl()}/api/workspaces/transfers/${"invalid-http-route-canary".padEnd(43, "x")}`,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "workspace_transfer_not_found" });
  });

  test("should deliver exact private bytes once through the public application origin", async () => {
    const output = transferFixtureCommand("seed", getAdminCredentials().email);
    const marker = "TRANSFER_FIXTURE:";
    if (!output.includes(marker))
      throw new Error("Workspace transfer fixture did not return a handle");
    const fixture = JSON.parse(output.slice(output.lastIndexOf(marker) + marker.length)) as {
      id: string;
      referenceId: string;
    };
    try {
      // Keep the capability out of assertion diagnostics, logs and test artifacts.
      const token = fixture.referenceId.slice("workspace-file://".length);
      const url = `${getTestBaseUrl()}/api/workspaces/transfers/${encodeURIComponent(token)}`;
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        Buffer.from([0, 255, 1, 128, 10, 42]),
      );
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toContain(
        'attachment; filename="workspace-http-probe.bin"',
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const replay = await fetch(url);
      expect(replay.status).toBe(404);
      await expect(replay.json()).resolves.toEqual({ error: "workspace_transfer_not_found" });
    } finally {
      transferFixtureCommand("cleanup", fixture.id);
    }
  });

  test.each([
    ["workspace_create", { repository_id: "162", ref: "master" }],
    ["workspace_exec", { workspace_id: workspaceId, argv: ["pwd"], timeout_seconds: 10 }],
    [
      "workspace_exec",
      {
        workspace_id: workspaceId,
        argv: ["cat"],
        timeout_seconds: 10,
        stdin_file: {
          file_id: "sediment://file_httpcontract",
          download_url: "https://files.oaiusercontent.com/http-contract",
        },
      },
    ],
    [
      "workspace_upload",
      {
        workspace_id: workspaceId,
        path: "input.txt",
        expected: { exists: false },
        file: {
          file_id: "sediment://file_httpcontract",
          download_url: "https://files.oaiusercontent.com/http-contract",
        },
      },
    ],
    [
      "workspace_download",
      {
        workspace_id: workspaceId,
        operation_id: operationId,
        file_name: "result.txt",
        mime_type: "text/plain",
      },
    ],
  ])("should return a website-only setup error from %s over HTTP", async (name, args) => {
    const result = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "WORKSPACE_NOT_CONFIGURED",
        message: expect.any(String),
        retryable: expect.any(Boolean),
      },
    });
    expectSettingsLink((result.structuredContent?.error as Record<string, unknown>).settings_url);
    expect(JSON.stringify(result)).not.toMatch(
      /accessToken|refreshToken|clientSecret|vaultKey|github\.com\/login|device_code/,
    );
  });

  test("should reject mixed text and native-file stdin before workspace dispatch", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "workspace_exec",
        arguments: {
          workspace_id: workspaceId,
          argv: ["cat"],
          timeout_seconds: 10,
          stdin_text: "exclusive-input-canary",
          stdin_file: {
            file_id: "sediment://file_httpcontract",
            download_url: "https://files.oaiusercontent.com/http-contract",
          },
        },
      }),
    );
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/validat|invalid|unrecognized/i);
    expect(JSON.stringify(result)).not.toContain("WORKSPACE_NOT_CONFIGURED");
    expect(JSON.stringify(result)).not.toContain("exclusive-input-canary");
  });

  test.each(["access_token", "chat_id", "session_id", "ssh_key"])(
    "should reject agent-supplied %s at the MCP input boundary",
    async (field) => {
      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: "workspace_exec",
          arguments: {
            workspace_id: workspaceId,
            argv: ["pwd"],
            timeout_seconds: 10,
            [field]: "rejected-input-canary",
          },
        }),
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/validat|invalid|unrecognized/i);
      expect(JSON.stringify(result)).not.toContain("WORKSPACE_NOT_CONFIGURED");
      expect(JSON.stringify(result)).not.toContain("rejected-input-canary");
    },
  );
});
