import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import { getAdminCredentials, getTestBaseUrl } from "../utils/test-config.js";
import { dockerExecSync } from "../utils/docker-command.js";

const codespaceId = "00000000-0000-4000-8000-000000000162";
const operationId = "00000000-0000-4000-8000-000000000163";
const actions = [
  "create",
  "list",
  "setup_help",
  "get",
  "start",
  "stop",
  "delete",
  "exec",
  "stat",
  "search",
  "read",
  "write",
  "apply_patch",
  "upload",
  "download",
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
    throw new Error("Codespace transfer fixture requires a local test container");
  }
  const script = `
    const { CodespaceTransferRepository, CodespaceTransferService, getSqliteInstance,
      getCodespaceResourcePolicy, getDbPath } = await import('@mcp-moira/shared');
    const { dirname, join } = await import('node:path');
    const db = getSqliteInstance();
    const service = new CodespaceTransferService({
      repository: new CodespaceTransferRepository(db), policy: getCodespaceResourcePolicy,
      root: join(dirname(getDbPath()), 'codespace-transfers'),
    });
    if (process.argv[1] === 'seed') {
      const user = db.prepare('SELECT id FROM user WHERE email = ?').get(process.argv[2]);
      if (!user) throw new Error('Explicit authenticated fixture owner missing');
      const reservation = service.reserveDownload(user.id, {
        fileName: 'codespace-http-probe.bin', mimeType: 'application/octet-stream', maxBytes: 6,
      });
      const handle = await service.publishDownload(reservation, Buffer.from([0, 255, 1, 128, 10, 42]));
      process.stdout.write('TRANSFER_FIXTURE:' + JSON.stringify({
        id: reservation.record.id, referenceId: handle.referenceId,
      }));
    } else {
      const record = db.prepare('SELECT * FROM codespaceTransfer WHERE id = ?').get(process.argv[2]);
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
    throw new Error(`Codespace transfer HTTP fixture ${action} failed`);
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

describe("Codespace MCP HTTP contract on a default-disabled installation", () => {
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

  test("should publish one codespace tool carrying every action and its file schemas", async () => {
    const catalog = await client.listTools();
    expect(catalog.tools.filter((tool) => tool.name.startsWith("codespace_"))).toEqual([]);
    const codespace = catalog.tools.find((tool) => tool.name === "codespace")!;
    expect(codespace.description?.length).toBeGreaterThan(20);
    expect(JSON.stringify(codespace.inputSchema)).not.toMatch(
      /"(?:chat_id|session_id|access_token|refresh_token|ssh_key)"/,
    );
    // Every action the tool serves is offered to the agent by name, or an action it can perform is
    // one no client can discover.
    const action = codespace.inputSchema.properties?.action as { enum?: string[] };
    expect([...(action.enum ?? [])].sort()).toEqual([...actions].sort());
    for (const field of ["stdin_file", "file"]) {
      const file = codespace.inputSchema.properties?.[field] as Record<string, unknown>;
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
    // Both native file parameters belong to the one tool now.
    expect(codespace._meta).toEqual({ "openai/fileParams": ["stdin_file", "file"] });
    // Root-object catalog: every action's fields are visible at the top level, only `action` is
    // required, and the exact form of each action is enforced at dispatch.
    expect(codespace.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: expect.objectContaining({
        argv: expect.any(Object),
        timeout_seconds: expect.any(Object),
        stdin_text: { type: "string" },
        stdin_file: expect.any(Object),
        operation_id: expect.any(Object),
        // The session form reaches the agent through the published catalog, not only through the
        // in-process schema: a projection that dropped these would leave an agent unable to ask
        // for a session while every in-process check still passed.
        session: expect.objectContaining({
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
        }),
        session_start: expect.objectContaining({ type: "boolean" }),
        session_end: expect.objectContaining({ type: "boolean" }),
        script: expect.objectContaining({ type: "string" }),
        env: expect.objectContaining({ type: "object" }),
        path: expect.any(Object),
        max_bytes: expect.any(Object),
        repository_id: expect.any(Object),
        confirm_delete: expect.any(Object),
      }),
    });
    expect(codespace.inputSchema).not.toHaveProperty("anyOf");
  });

  test("should list safe setup status without provisioning or exposing credentials", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: "codespace", arguments: { action: "list" } }),
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
      codespaces: [],
      // The user's limits are present even while the feature is off: nothing held, and provider
      // billing reported as unavailable rather than as a number.
      limits: {
        codespaces: { held: 0 },
        lifecycle: { idle: { provider_max_minutes: 240 } },
        provider: { billing: "unavailable" },
      },
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

  test("should return provider-owned setup guidance without provisioning", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: "codespace", arguments: { action: "setup_help" } }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      situation: "not_configured",
      provider: "github-codespaces",
      reason: "NOT_CONFIGURED",
      instruction: expect.any(String),
      links: expect.arrayContaining([
        expect.objectContaining({ id: "settings", label: expect.any(String) }),
        expect.objectContaining({ id: "create_repository", label: expect.any(String) }),
      ]),
    });
    const links = result.structuredContent?.links as Array<{ id: string; url: string }>;
    expectSettingsLink(links.find((link) => link.id === "settings")?.url);
    expect(JSON.stringify(result)).not.toMatch(
      /accessToken|refreshToken|clientSecret|vaultKey|BEGIN .*PRIVATE KEY/,
    );
  });

  test("should report the same readiness decision through MCP health as through the list action", async () => {
    const listed = CallToolResultSchema.parse(
      await client.callTool({ name: "codespace", arguments: { action: "list" } }),
    );
    const instance = listed.structuredContent?.instance as { state: string; provider: string };
    const health = JSON.parse(dockerExecSync(["curl", "-s", "http://localhost:3000/health"])) as {
      status: string;
      codespaces: Record<string, unknown>;
    };
    // The public liveness surface carries only the decision, never operator detail.
    expect(health.codespaces).toEqual({
      state: instance.state,
      provider: instance.provider,
      degraded: false,
    });
    // A disabled feature must not degrade the MCP process.
    expect(health.status).toBe("healthy");
  });

  test("should route an invalid public download capability to the private transfer handler", async () => {
    const response = await fetch(
      `${getTestBaseUrl()}/api/codespaces/transfers/${"invalid-http-route-canary".padEnd(43, "x")}`,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "codespace_transfer_not_found" });
  });

  test("should deliver exact private bytes once through the public application origin", async () => {
    const output = transferFixtureCommand("seed", getAdminCredentials().email);
    const marker = "TRANSFER_FIXTURE:";
    if (!output.includes(marker))
      throw new Error("Codespace transfer fixture did not return a handle");
    const fixture = JSON.parse(output.slice(output.lastIndexOf(marker) + marker.length)) as {
      id: string;
      referenceId: string;
    };
    try {
      // Keep the capability out of assertion diagnostics, logs and test artifacts.
      const token = fixture.referenceId.slice("codespace-file://".length);
      const url = `${getTestBaseUrl()}/api/codespaces/transfers/${encodeURIComponent(token)}`;
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        Buffer.from([0, 255, 1, 128, 10, 42]),
      );
      expect(response.headers.get("content-type")).toBe("application/octet-stream");
      expect(response.headers.get("content-disposition")).toContain(
        'attachment; filename="codespace-http-probe.bin"',
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const replay = await fetch(url);
      expect(replay.status).toBe(404);
      await expect(replay.json()).resolves.toEqual({ error: "codespace_transfer_not_found" });
    } finally {
      transferFixtureCommand("cleanup", fixture.id);
    }
  });

  test.each([
    ["create", { repository_id: "162", ref: "master" }],
    ["exec", { codespace_id: codespaceId, argv: ["pwd"], timeout_seconds: 10 }],
    [
      "exec",
      {
        codespace_id: codespaceId,
        argv: ["cat"],
        timeout_seconds: 10,
        stdin_file: {
          file_id: "sediment://file_httpcontract",
          download_url: "https://files.oaiusercontent.com/http-contract",
        },
      },
    ],
    [
      "upload",
      {
        codespace_id: codespaceId,
        path: "input.txt",
        expected: { exists: false },
        file: {
          file_id: "sediment://file_httpcontract",
          download_url: "https://files.oaiusercontent.com/http-contract",
        },
      },
    ],
    [
      "download",
      {
        codespace_id: codespaceId,
        operation_id: operationId,
        file_name: "result.txt",
        mime_type: "text/plain",
      },
    ],
    ["get", { codespace_id: codespaceId }],
    ["start", { codespace_id: codespaceId }],
    ["stop", { codespace_id: codespaceId }],
    ["delete", { codespace_id: codespaceId, expected_generation: 1, confirm_delete: true }],
    ["stat", { codespace_id: codespaceId, path: "package.json" }],
    ["search", { codespace_id: codespaceId, path: ".", query: "TODO" }],
    ["read", { codespace_id: codespaceId, path: "package.json" }],
    ["write", { codespace_id: codespaceId, path: "a.txt", text: "x", expected: { exists: false } }],
    [
      "apply_patch",
      {
        codespace_id: codespaceId,
        files: [
          {
            path: "a.txt",
            expected: { exists: true },
            edits: [{ start: 0, end: 1, text: "y" }],
          },
        ],
      },
    ],
  ])("should return a website-only setup error from action %s over HTTP", async (action, args) => {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: "codespace", arguments: { action, ...args } }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: "CODESPACE_NOT_CONFIGURED",
        message: expect.any(String),
        retryable: expect.any(Boolean),
      },
    });
    expectSettingsLink((result.structuredContent?.error as Record<string, unknown>).settings_url);
    expect(JSON.stringify(result)).not.toMatch(
      /accessToken|refreshToken|clientSecret|vaultKey|github\.com\/login|device_code/,
    );
  });

  test("should reject mixed text and native-file stdin before codespace dispatch", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "codespace",
        arguments: {
          action: "exec",
          codespace_id: codespaceId,
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
    expect(JSON.stringify(result)).not.toContain("CODESPACE_NOT_CONFIGURED");
    expect(JSON.stringify(result)).not.toContain("exclusive-input-canary");
  });

  test.each(["access_token", "chat_id", "session_id", "ssh_key"])(
    "should reject agent-supplied %s at the MCP input boundary",
    async (field) => {
      const result = CallToolResultSchema.parse(
        await client.callTool({
          name: "codespace",
          arguments: {
            action: "exec",
            codespace_id: codespaceId,
            argv: ["pwd"],
            timeout_seconds: 10,
            [field]: "rejected-input-canary",
          },
        }),
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/validat|invalid|unrecognized/i);
      expect(JSON.stringify(result)).not.toContain("CODESPACE_NOT_CONFIGURED");
      expect(JSON.stringify(result)).not.toContain("rejected-input-canary");
    },
  );
});
