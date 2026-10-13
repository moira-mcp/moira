import { afterEach, describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { createHash } from "node:crypto";
import { createWorkspaceRequestId } from "@mcp-moira/shared/workspace-request-id";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CODESPACE_PROVIDER_CONTRACT_VERSION,
  CodespaceConnectionRepository,
  CodespaceConnectionService,
  CodespaceObservabilityService,
  CodespaceProviderRegistry,
  CodespaceResourceRepository,
  CodespaceResourceService,
  CodespaceResourceError,
  CodespaceTransferRepository,
  CodespaceTransferService,
  evaluateCodespaceResourcePolicy,
  type CodespaceProviderAdapter,
  type CodespaceProviderResource,
  type CodespaceGitHubConfigStatus,
  type GitHubCodespaceClient,
} from "@mcp-moira/shared";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import {
  setCodespaceToolServicesLoaderForTests,
  type CodespaceToolServices,
} from "../../packages/mcp-server/src/tools/manage-codespaces.js";
import { registerTools } from "../../packages/mcp-server/src/tools/register-tools.js";
import { createWorkspaceClient } from "../../packages/web-backend/src/services/workspace-client.js";

const USER_ID = "chatgpt-user",
  OTHER_USER_ID = "other-user";
type Fixture = { root: string; directory: string; socketPath: string };
const guest = createRequire(import.meta.url)("../fixtures/workspace-service.cjs") as {
  createFixture(): Fixture;
  start(value: Fixture): Promise<void>;
  stop(value: Fixture): Promise<void>;
  dispose(value: Fixture): Promise<void>;
};
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const policy = {
  ...evaluateCodespaceResourcePolicy(() => undefined),
  enabled: true,
  createThrottleMs: 0,
};
class LifecycleProvider implements CodespaceProviderAdapter {
  readonly id = "github-codespaces";
  readonly contractVersion = CODESPACE_PROVIDER_CONTRACT_VERSION;
  readonly capabilities = {
    disposable: true,
    persistent: true,
    exactLifecycle: true,
    personalBillingOnly: true,
    connector: "github-cli-ssh",
  };
  current: CodespaceProviderResource | null = null;
  readonly machine = {
    name: "basic",
    displayName: "Basic",
    operatingSystem: "linux",
    cpuCores: 2,
    memoryBytes: 8 * 1024 ** 3,
    storageBytes: 32 * 1024 ** 3,
  };
  async health() {
    return { state: "available" as const, reason: null };
  }
  async getIdentity() {
    return { id: "101", login: "owner" };
  }
  async listMachines() {
    return [this.machine];
  }
  async preflightCreate() {
    return { billableOwnerId: "101" };
  }
  guidance() {
    return { links: [], instructions: {} };
  }
  async create(_credential: string, input: Parameters<CodespaceProviderAdapter["create"]>[1]) {
    this.current = {
      name: "silver-space",
      displayName: input.operationMarker,
      ownerId: "101",
      billableOwnerId: "101",
      repositoryId: input.repository.id,
      repositoryFullName: input.repository.fullName,
      ref: input.ref,
      state: "available",
      lastUsedAt: null,
      machine: input.machine,
      createdAt: Date.now(),
    };
    return { outcome: "accepted" as const, resource: this.current };
  }
  async listOwned() {
    return this.current ? [this.current] : [];
  }
  async getExact(_credential: string, name: string) {
    return this.current?.name === name ? this.current : null;
  }
  async startExact() {
    if (this.current) this.current.state = "available";
    return "accepted" as const;
  }
  async stopExact() {
    if (this.current) this.current.state = "shutdown";
    return "accepted" as const;
  }
  async deleteExact() {
    this.current = null;
    return "accepted" as const;
  }
  async probeConnector() {}
}

async function client() {
  const server = new McpServer(
    { name: "codespace-client-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, { agent: "chatgpt" }, () => null);
  const mcp = new Client({ name: "chatgpt-compatible", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return {
    process: (action: string, args: Record<string, unknown>, userId = USER_ID) =>
      runWithMCPContext(
        { userId, agent: "chatgpt" },
        () =>
          mcp.callTool({
            name: "codespace_process",
            arguments: { action, ...args },
          }) as Promise<CallToolResult>,
      ),
    call: (action: string, args: Record<string, unknown>, userId = USER_ID) =>
      runWithMCPContext(
        { userId, agent: "chatgpt" },
        () =>
          mcp.callTool({
            name: "codespace",
            arguments: { action, ...args },
          }) as Promise<CallToolResult>,
      ),
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

async function setup() {
  const value = guest.createFixture();
  cleanups.push(() => guest.dispose(value));
  await guest.start(value);
  const sqlite = new Database(":memory:");
  cleanups.push(() => {
    sqlite.close();
  });
  migrate(drizzle(sqlite), { migrationsFolder: resolve("packages/web-backend/drizzle") });
  for (const id of [USER_ID, OTHER_USER_ID])
    sqlite
      .prepare("INSERT INTO user(id,email,handle,createdAt,updatedAt) VALUES(?,?,?,'now','now')")
      .run(id, id + "@example.test", id);
  const config: Extract<CodespaceGitHubConfigStatus, { state: "available" }> = {
    state: "available",
    clientId: "Iv23abcdefgh1234",
    clientSecret: "fixture-client-secret-not-a-real-credential",
    callbackUrl: "https://moira.example/api/integrations/github/callback",
    installationUrl: "https://github.com/apps/moira-codespaces/installations/new",
    vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
    vaultKeyVersion: "v1",
    settingsUrl: "https://moira.example/app/settings#integrations-github",
  };
  const tokenResponse = () => ({
    accessToken: "ghu_fixture_secret",
    refreshToken: "ghr_fixture_secret",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    refreshTokenExpiresAt: Date.now() + 7_200_000,
  });
  const github: GitHubCodespaceClient = {
    exchangeCode: async () => tokenResponse(),
    refreshToken: async () => tokenResponse(),
    getUser: async () => ({ id: "101", login: "owner" }),
    listInstallations: async () => [
      {
        id: "201",
        accountId: "101",
        accountLogin: "owner",
        targetType: "User",
        repositorySelection: "selected",
      },
    ],
    listInstallationRepositories: async () => [
      { id: "301", fullName: "owner/project", private: true },
    ],
    revokeToken: async () => undefined,
    revokeGrant: async () => undefined,
  };
  const connection = new CodespaceConnectionService({
    repository: new CodespaceConnectionRepository(sqlite),
    config: () => config,
    client: () => github,
  });

  for (const userId of [USER_ID, OTHER_USER_ID]) {
    const url = await connection.beginAuthorization(userId, "website-session");
    await connection.completeAuthorization({
      userId,
      sessionToken: "website-session",
      state: new URL(url).searchParams.get("state")!,
      code: "fixture-code",
    });
  }
  const provider = new LifecycleProvider();
  const registry = new CodespaceProviderRegistry();
  registry.register(provider);
  const repository = new CodespaceResourceRepository(sqlite);
  const resource = new CodespaceResourceService({
    repository,
    repositories: repository,
    registry,
    credentials: { getCredential: (userId) => connection.getAccessToken(userId) },
    providerId: provider.id,
    requiredCapabilities: { exactLifecycle: true, personalBillingOnly: true },
    policy: () => policy,
  });
  const wire = createWorkspaceClient(value.socketPath);
  const authorize = (userId: string, resourceId: string) => {
    const owned = repository.getOwned(userId, resourceId);
    if (!owned) throw new CodespaceResourceError("CODESPACE_NOT_FOUND", "Unavailable");
    return owned;
  };
  const workspace: CodespaceToolServices["workspace"] = {
    request(userId, id, input, signal) {
      authorize(userId, id);
      return wire.request(userId, id, input, signal);
    },
    json(userId, id, input, signal) {
      authorize(userId, id);
      return wire.json(userId, id, input, signal);
    },
  };
  const publisher = new CodespaceTransferService({
    repository: new CodespaceTransferRepository(sqlite),
    root: join(value.directory, "attachments"),
    policy: () => policy,
  });
  const nativeBytes = Buffer.alloc(8 * 1024 * 1024 + 31, 0xa7);
  const services: CodespaceToolServices = {
    connection,
    resource,
    workspace,
    guidance: () => ({ provider: provider.id, situation: "ready", instruction: null, links: [] }),
    observability: new CodespaceObservabilityService({
      providerId: provider.id,
      config: () => config,
      policy: () => policy,
      resources: repository,
      transport: { health: async () => ({ ok: true, reason: null }) },
    }),
    attachments: {
      publisher,
      fetcher: {
        fetch: async () => ({
          contentLength: nativeBytes.length,
          mimeType: "application/octet-stream",
          body: (async function* () {
            for (let n = 0; n < nativeBytes.length; n += 65536)
              yield nativeBytes.subarray(n, n + 65536);
          })(),
        }),
      },
    },
  };
  cleanups.push(setCodespaceToolServicesLoaderForTests(async () => services));
  const mcp = await client();
  cleanups.push(mcp.close);
  const created = await mcp.call("create", { repository_id: "301", ref: "main" });
  expect(created.isError).not.toBe(true);
  const id = created.structuredContent!.codespace_id as string;
  return { ...value, mcp, id, publisher, nativeBytes };
}

describe("registered MCP tools against actual workspace and lifecycle services", () => {
  it("edits and executes actual code, then observes preserved files after service restart", async () => {
    const value = await setup();
    const args = { codespace_id: value.id };
    const source = "export const value = 1;\n";
    const written = await value.mcp.call("write", {
      ...args,
      request_id: createWorkspaceRequestId(),
      path: "app.mjs",
      expected: { exists: false },
      text: source,
    });
    expect(written.isError).not.toBe(true);
    const patched = await value.mcp.call("apply_patch", {
      ...args,
      request_id: createWorkspaceRequestId(),
      files: [
        {
          path: "app.mjs",
          expected: {
            exists: true,
            size_bytes: Buffer.byteLength(source),
            sha256: createHash("sha256").update(source).digest("hex"),
          },
          edits: [{ start: 21, end: 22, text: "2" }],
        },
      ],
    });
    expect(patched.isError).not.toBe(true);
    const tested = await value.mcp.call("exec", {
      ...args,
      request_id: createWorkspaceRequestId(),
      argv: [
        process.execPath,
        "--input-type=module",
        "-e",
        "import {value} from './app.mjs'; if(value!==2)process.exit(23); console.log('tests pass')",
      ],
    });
    expect(tested).toMatchObject({
      structuredContent: { state: "succeeded", exitCode: 0, stdout: "tests pass\n" },
    });
    await guest.stop(value);
    await guest.start(value);
    expect(
      (await value.mcp.call("read", { ...args, path: "app.mjs", offset: 0, length: 1024 }))
        .structuredContent,
    ).toMatchObject({ text: "export const value = 2;\n" });
    expect(readFileSync(join(value.root, "app.mjs"), "utf8")).toBe("export const value = 2;\n");
    expect(
      (
        await value.mcp.call(
          "read",
          { ...args, path: "app.mjs", offset: 0, length: 1024 },
          OTHER_USER_ID,
        )
      ).isError,
    ).toBe(true);
  });

  it("streams a native attachment above the former limit to a file and returns exact downloadable bytes", async () => {
    const value = await setup();
    const args = { codespace_id: value.id };
    const upload = await value.mcp.call("upload", {
      ...args,
      request_id: createWorkspaceRequestId(),
      path: "binary.bin",
      expected: { exists: false },
      file: {
        file_id: "file_fixture",
        download_url: "https://native.example.test/input",
        size_bytes: value.nativeBytes.length,
      },
    });
    expect(upload.isError).not.toBe(true);
    expect(readFileSync(join(value.root, "binary.bin"))).toEqual(value.nativeBytes);
    const boundedDownload = await value.mcp.call("download", {
      ...args,
      path: "binary.bin",
      file_name: "binary.bin",
      mime_type: "application/octet-stream",
      max_bytes: value.nativeBytes.length - 1,
    });
    expect(boundedDownload).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "CODESPACE_DOWNLOAD_BOUND_EXCEEDED" } },
    });
    expect(boundedDownload.content.some((block) => block.type === "resource_link")).toBe(false);
    const download = await value.mcp.call("download", {
      ...args,
      path: "binary.bin",
      file_name: "binary.bin",
      mime_type: "application/octet-stream",
    });
    expect(download.isError).not.toBe(true);
    expect(download.content[0]).toMatchObject({
      type: "resource_link",
      size: value.nativeBytes.length,
    });
    const file = download.structuredContent!.file as { reference_id: string; sha256: string };
    const claimed = await value.publisher.claimDownload(file.reference_id);
    const hash = createHash("sha256");
    let received = 0;
    for await (const bytes of claimed.stream) {
      hash.update(bytes);
      received += bytes.length;
    }
    expect(received).toBe(value.nativeBytes.length);
    expect(hash.digest("hex")).toBe(createHash("sha256").update(value.nativeBytes).digest("hex"));
    await value.publisher.consume(claimed.record);
    await expect(value.publisher.claimDownload(file.reference_id)).rejects.toThrow();
  });
});
