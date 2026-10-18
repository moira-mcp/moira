import { afterAll, beforeAll, describe, expect, test } from "@jest/globals";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createAuthenticatedMCPClient } from "../utils/mcp-auth.js";
import { getTestBaseUrl } from "../utils/test-config.js";
import { dockerExecSync } from "../utils/docker-command.js";
import { createWorkspaceRequestId } from "@mcp-moira/shared/workspace-request-id";

const codespaceId = "00000000-0000-4000-8000-000000000162";
const processId = createWorkspaceRequestId();
const requestId = createWorkspaceRequestId();
const actions = [
  "create",
  "adopt",
  "list",
  "repositories",
  "local_devices",
  "operation",
  "repository_add",
  "repository_create",
  "preview_image",
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
  "pull_request_create",
  "pull_request_get",
  "pull_request_find",
];

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

describe("Codespace MCP HTTP contract without configured GitHub or paired Local", () => {
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

  test("should publish ordinary codespace and separate background process tools", async () => {
    const catalog = await client.listTools();
    expect(
      catalog.tools.filter((tool) => tool.name.startsWith("codespace_")).map((tool) => tool.name),
    ).toEqual(["codespace_process"]);
    const process = catalog.tools.find((tool) => tool.name === "codespace_process")!;
    expect(process.inputSchema.required).toEqual(["action", "codespace_id"]);
    expect(process.inputSchema.properties?.action).toMatchObject({
      enum: ["start", "get", "read", "stop"],
    });
    expect(process.inputSchema.properties?.request_id).toMatchObject({
      type: "string",
      pattern: "^ws1-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
    });
    expect(process._meta).toEqual({ "openai/fileParams": ["stdin_file"] });
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
        request_id: expect.objectContaining({
          anyOf: expect.arrayContaining([
            expect.objectContaining({ type: "string", format: "uuid" }),
            expect.objectContaining({
              type: "string",
              pattern: "^ws1-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
            }),
          ]),
        }),
        // The session form reaches the agent through the published catalog, not only through the
        // in-process schema: a projection that dropped these would leave an agent unable to ask
        // for a session while every in-process check still passed.
        session: expect.objectContaining({
          type: "string",
          pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$",
        }),
        session_start: expect.objectContaining({ type: "boolean" }),
        session_end: expect.objectContaining({ type: "boolean" }),
        script: expect.objectContaining({ type: "string" }),
        env: expect.objectContaining({ type: "object" }),
        path: expect.any(Object),
        max_bytes: expect.any(Object),
        repository_id: expect.any(Object),
        repository_name: expect.objectContaining({ type: "string", minLength: 1, maxLength: 100 }),
        installation_id: expect.objectContaining({ type: "string" }),
        confirm_delete: expect.any(Object),
        head: expect.objectContaining({ type: "string", minLength: 1, maxLength: 255 }),
        base: expect.objectContaining({ type: "string", minLength: 1, maxLength: 255 }),
        title: expect.objectContaining({ type: "string", minLength: 1 }),
        body: expect.objectContaining({ type: "string" }),
        draft: expect.objectContaining({ type: "boolean" }),
        pull_request_number: expect.objectContaining({ type: "integer", exclusiveMinimum: 0 }),
      }),
    });
    expect(codespace.inputSchema).not.toHaveProperty("anyOf");
    expect(codespace.inputSchema.properties).not.toHaveProperty("operation_id");
  });

  test("should list only compact codespaces without provisioning or exposing credentials", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: "codespace", arguments: { action: "list" } }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      codespaces: [],
      unavailable: [],
      provider_errors: [],
      provider_billing: "unavailable",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /accessToken|refreshToken|clientSecret|vaultKey|BEGIN .*PRIVATE KEY/,
    );
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type).toBe("text");
    expect(JSON.parse((text as { text: string }).text)).toEqual(result.structuredContent);
  });

  test("should discover only owned local devices without provisioning or granting consent", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: "codespace", arguments: { action: "local_devices" } }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({
      devices: [],
      installations: [],
      warning: "Connect GitHub in Moira Settings before managing repositories.",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /accessToken|refreshToken|clientSecret|vaultKey|credential/,
    );
  });

  test("should discover repositories separately from codespaces", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: "codespace", arguments: { action: "repositories" } }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ repositories: [], provider_errors: [] });
  });

  test.each([
    ["start", { request_id: requestId, argv: ["pwd"] }],
    ["get", { process_id: processId }],
    ["read", { process_id: processId, stream: "stdout", offset: 0, length: 1024 }],
    ["stop", { process_id: processId }],
  ])("should refuse process %s for a missing owned codespace", async (action, input) => {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "codespace_process",
        arguments: { action, codespace_id: codespaceId, ...input },
      }),
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "CODESPACE_AUTHORIZATION_REQUIRED" },
      request_id: action === "start" ? requestId : processId,
    });
    // Authorization refused before owner dispatch: retain correlation without inventing a process.
    expect(result.structuredContent).not.toHaveProperty("process_id");
    expect(JSON.stringify(result)).not.toMatch(/accessToken|refreshToken|clientSecret|vaultKey/);
  });

  test("should return provider-owned setup guidance without provisioning", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "codespace",
        arguments: { action: "setup_help", repository_id: "162" },
      }),
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

  test("should explain local enrollment independently of the unconfigured GitHub provider", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: "codespace", arguments: { action: "setup_help" } }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      provider: "local-sandboxes",
      situation: "connection_required",
      reason: "LOCAL_DEVICE_REQUIRED",
      instruction: expect.stringMatching(/Connect Moira Local.*approve the pairing/),
    });
    const links = result.structuredContent?.links as Array<{ id: string; url: string }>;
    const settings = new URL(links.find((link) => link.id === "settings")!.url);
    expect(settings.origin).toBe(new URL(getTestBaseUrl()).origin);
    expect(settings.pathname).toBe("/settings");
    expect(settings.hash).toBe("#integrations-local");
    expect(settings.search).toBe("");
    expect(JSON.stringify(result)).not.toMatch(/accessToken|refreshToken|clientSecret|vaultKey/);
  });

  test("should retain disabled provider liveness without exposing it in normal discovery", async () => {
    const health = JSON.parse(dockerExecSync(["curl", "-s", "http://localhost:3000/health"])) as {
      status: string;
      codespaces: Record<string, unknown>;
    };
    // The public liveness surface carries only the decision, never operator detail.
    expect(health.codespaces).toEqual({
      state: "disabled",
      provider: "github-codespaces",
      degraded: false,
    });
    // A disabled feature must not degrade the MCP process.
    expect(health.status).toBe("healthy");
  });

  test("should refuse an owner publication without a current authorized resource", async () => {
    const response = await fetch(
      getTestBaseUrl() +
        "/api/codespaces/files/" +
        codespaceId +
        "/" +
        "invalid-http-route-canary".padEnd(43, "x"),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "workspace_publication_unavailable" });
  });

  test.each([
    ["create", { repository_id: "162", ref: "master", request_id: requestId }],
    [
      "exec",
      { codespace_id: codespaceId, request_id: requestId, argv: ["pwd"], timeout_seconds: 10 },
    ],
    [
      "exec",
      {
        codespace_id: codespaceId,
        request_id: requestId,
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
        request_id: requestId,
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
        path: "result.txt",
        file_name: "result.txt",
        mime_type: "text/plain",
      },
    ],
    ["get", { codespace_id: codespaceId }],
    ["preview_image", { codespace_id: codespaceId, path: "screenshot.png" }],
    [
      "pull_request_create",
      {
        codespace_id: codespaceId,
        request_id: requestId,
        head: "feat/игра",
        base: "main",
        title: "Change",
      },
    ],
    ["pull_request_get", { codespace_id: codespaceId, pull_request_number: 7 }],
    ["pull_request_find", { codespace_id: codespaceId, head: "feat/игра", base: "main" }],
    ["start", { codespace_id: codespaceId, request_id: requestId, generation: 1 }],
    ["stop", { codespace_id: codespaceId, request_id: requestId, generation: 1 }],
    [
      "delete",
      { codespace_id: codespaceId, request_id: requestId, generation: 1, confirm_delete: true },
    ],
    ["stat", { codespace_id: codespaceId, path: "package.json" }],
    ["search", { codespace_id: codespaceId, path: ".", query: "TODO" }],
    ["read", { codespace_id: codespaceId, path: "package.json" }],
    [
      "write",
      {
        codespace_id: codespaceId,
        request_id: requestId,
        path: "a.txt",
        text: "x",
        expected: { exists: false },
      },
    ],
    [
      "apply_patch",
      {
        codespace_id: codespaceId,
        request_id: requestId,
        files: [
          {
            path: "a.txt",
            expected: { exists: true },
            edits: [{ start: 0, end: 1, text: "y" }],
          },
        ],
      },
    ],
  ])(
    "should refuse action %s with its exact selected-provider or missing-identity error over HTTP",
    async (action, args) => {
      const result = CallToolResultSchema.parse(
        await client.callTool({ name: "codespace", arguments: { action, ...args } }),
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: action === "create" ? "CODESPACE_NOT_CONFIGURED" : "CODESPACE_NOT_FOUND",
          message: expect.any(String),
          retryable: expect.any(Boolean),
        },
      });
      const error = result.structuredContent?.error as Record<string, unknown>;
      if (action === "create") expectSettingsLink(error.settings_url);
      else {
        // An absent opaque identity supplies no provider authority or setup destinations.
        expect(error).not.toHaveProperty("settings_url");
        expect(error).not.toHaveProperty("links");
      }
      expect(JSON.stringify(result)).not.toMatch(
        /accessToken|refreshToken|clientSecret|vaultKey|github\.com\/login|device_code/,
      );
    },
  );

  test("should reject mixed text and native-file stdin before codespace dispatch", async () => {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "codespace",
        arguments: {
          action: "exec",
          codespace_id: codespaceId,
          request_id: requestId,
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

  test.each([
    "access_token",
    "chat_id",
    "session_id",
    "ssh_key",
    "provider",
    "credential",
    "url",
    "device_id",
    "connection_id",
  ])("should reject agent-supplied %s at the MCP input boundary", async (field) => {
    const result = CallToolResultSchema.parse(
      await client.callTool({
        name: "codespace",
        arguments: {
          action: "exec",
          codespace_id: codespaceId,
          request_id: requestId,
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
  });
});
