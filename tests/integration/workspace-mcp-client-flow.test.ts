import { afterEach, describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  WORKSPACE_PROVIDER_CONTRACT_VERSION,
  WorkspaceConnectionRepository,
  WorkspaceConnectionService,
  WorkspaceFileService,
  WorkspaceOperationRepository,
  WorkspaceOperationService,
  WorkspaceProviderRegistry,
  WorkspaceResourceRepository,
  WorkspaceResourceService,
  WorkspaceTransferRepository,
  WorkspaceTransferService,
  type GitHubWorkspaceClient,
  type WorkspaceGitHubConfigStatus,
  type WorkspaceNativeFileReference,
  type WorkspaceProviderAdapter,
  type WorkspaceProviderResource,
  type WorkspaceResourcePolicy,
} from "@mcp-moira/shared";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import {
  setWorkspaceToolServicesLoaderForTests,
  type WorkspaceToolServices,
} from "../../packages/mcp-server/src/tools/manage-workspaces.js";
import { registerTools } from "../../packages/mcp-server/src/tools/register-tools.js";
import { GitHubCodespacesConnector } from "../../packages/web-backend/src/services/github-codespaces-connector.js";

const USER_ID = "chatgpt-user";
const OTHER_USER_ID = "other-user";
const FILE_ID = "sediment://file_000000000b1c8210a7cb1a2d896b2ee4";
const nativeBytes = Buffer.from([0, 255, 17, 128, 4]);
const initialSource = "export const value = 1;\n";
const supervisorSource = readFileSync(
  resolve("packages/web-backend/src/services/github-codespaces-remote-supervisor.mjs"),
  "utf8",
);
const policy: WorkspaceResourcePolicy = {
  enabled: true,
  maxCpuCores: 4,
  maxMemoryBytes: 8 * 1024 ** 3,
  maxStorageBytes: 32 * 1024 ** 3,
  maxActivePerUser: 2,
  maxActiveGlobal: 4,
  maxOperationsPerDay: 100,
  createThrottleMs: 0,
  remoteTtlMs: 60_000,
  createDeadlineMs: 30_000,
  cleanupDeadlineMs: 30_000,
  claimLeaseMs: 5_000,
  reconcileIntervalMs: 60_000,
  maxConcurrentOperationsPerUser: 2,
  maxConcurrentOperationsGlobal: 4,
  maxOperationMs: 60_000,
  maxTransferFileBytes: 4 * 1024 ** 2,
};

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Only the external provider lifecycle is substituted. All local domain state,
// authorization, wire encoding, filesystem operations and commands are production code.
class LifecycleProvider implements WorkspaceProviderAdapter {
  readonly id = "github-codespaces";
  readonly contractVersion = WORKSPACE_PROVIDER_CONTRACT_VERSION;
  readonly capabilities = {
    disposable: true,
    persistent: true,
    exactLifecycle: true,
    personalBillingOnly: true,
    connector: "github-cli-ssh",
  };
  current: WorkspaceProviderResource | null = null;
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
  async create(_credential: string, input: Parameters<WorkspaceProviderAdapter["create"]>[1]) {
    this.current = {
      name: "silver-space",
      displayName: input.operationMarker,
      ownerId: "101",
      billableOwnerId: "101",
      repositoryId: input.repository.id,
      repositoryFullName: input.repository.fullName,
      ref: input.ref,
      state: "available",
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

class DomainFixture {
  readonly root = mkdtempSync(join(tmpdir(), "moira-mcp-domain-"));
  readonly repositoryPath = join(this.root, "workspaces", "repository");
  readonly databasePath = join(this.root, "domain.sqlite");
  readonly provider = new LifecycleProvider();
  readonly jobs: Array<{ action: string; remoteMarker: string }> = [];
  readonly fetchedReferences: WorkspaceNativeFileReference[] = [];
  loseNextResponse: "execute" | "file-execute" | null = null;
  sqlite!: Database.Database;
  transfers!: WorkspaceTransferService;
  services!: WorkspaceToolServices;
  connection!: WorkspaceConnectionService;

  constructor() {
    mkdirSync(this.repositoryPath, { recursive: true });
    for (const args of [
      ["init", "--initial-branch=main", this.repositoryPath],
      [
        "-C",
        this.repositoryPath,
        "remote",
        "add",
        "origin",
        "https://github.com/owner/repository.git",
      ],
    ])
      this.git(args);
    this.reopen();
    for (const id of [USER_ID, OTHER_USER_ID]) {
      this.sqlite
        .prepare(
          "INSERT INTO user (id, email, handle, createdAt, updatedAt) VALUES (?, ?, ?, 'now', 'now')",
        )
        .run(id, `${id}@example.test`, id);
    }
  }

  git(args: string[]) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }

  async authorizeOnWebsite(userId = USER_ID) {
    const url = await this.connection.beginAuthorization(userId, "website-session");
    await this.connection.completeAuthorization({
      userId,
      sessionToken: "website-session",
      state: new URL(url).searchParams.get("state")!,
      code: "github-code-from-website",
    });
    expect(this.connection.getStatus(userId).state).toBe("connected");
  }

  reopen() {
    this.sqlite?.close();
    this.sqlite = new Database(this.databasePath);
    this.sqlite.pragma("foreign_keys = ON");
    migrate(drizzle(this.sqlite), { migrationsFolder: resolve("packages/web-backend/drizzle") });
    const config: Extract<WorkspaceGitHubConfigStatus, { state: "available" }> = {
      state: "available",
      clientId: "Iv23abcdefgh1234",
      clientSecret: "fixture-client-secret-not-a-real-credential",
      callbackUrl: "https://moira.example/api/integrations/github/callback",
      installationUrl: "https://github.com/apps/moira-workspaces/installations/new",
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
    const github: GitHubWorkspaceClient = {
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
        { id: "301", fullName: "owner/repository", private: true },
      ],
      revokeToken: async () => undefined,
      revokeGrant: async () => undefined,
    };
    this.connection = new WorkspaceConnectionService({
      repository: new WorkspaceConnectionRepository(this.sqlite),
      config: () => config,
      client: () => github,
    });
    const registry = new WorkspaceProviderRegistry();
    registry.register(this.provider);
    const resourceRepository = new WorkspaceResourceRepository(this.sqlite);
    const operationRepository = new WorkspaceOperationRepository(this.sqlite);
    const connector = new GitHubCodespacesConnector(this.requestImpl);
    this.transfers = new WorkspaceTransferService({
      repository: new WorkspaceTransferRepository(this.sqlite),
      root: join(this.root, "transfers"),
      policy: () => policy,
    });
    const nativeFetcher = {
      fetch: async (reference: WorkspaceNativeFileReference) => {
        this.fetchedReferences.push(reference);
        return {
          contentLength: nativeBytes.length,
          mimeType: "application/octet-stream",
          body: (async function* () {
            yield nativeBytes;
          })(),
        };
      },
    };
    const credentials = {
      getCredential: (userId: string) => this.connection.getAccessToken(userId),
    };
    const dependencies = {
      repository: operationRepository,
      transport: connector,
      credentials,
      policy: () => policy,
      transfers: this.transfers,
      nativeFetcher,
    };
    this.services = {
      connection: this.connection,
      resource: new WorkspaceResourceService({
        repository: resourceRepository,
        repositories: resourceRepository,
        registry,
        credentials,
        providerId: this.provider.id,
        requiredCapabilities: { exactLifecycle: true, personalBillingOnly: true },
        policy: () => policy,
      }),
      operation: new WorkspaceOperationService(dependencies),
      file: new WorkspaceFileService(dependencies),
    };
  }

  private requestImpl = (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ): ClientRequest => {
    const request = new EventEmitter() as ClientRequest;
    Object.assign(request, {
      setTimeout: () => request,
      destroy: (error: Error) => queueMicrotask(() => request.emit("error", error)),
      end: (payload?: Buffer) => {
        void (async () => {
          const body = payload ? JSON.parse(payload.toString("utf8")) : null;
          let value: unknown = { state: "available", reason: null };
          if (options.path === "/job") {
            this.jobs.push({ action: body.job.action, remoteMarker: body.job.remoteMarker });
            const result = await this.runSupervisor(body.job);
            if (this.loseNextResponse === body.job.action) {
              this.loseNextResponse = null;
              throw new Error("SSH response lost after remote submission");
            }
            value = { value: JSON.stringify(result) };
          }
          const response = new EventEmitter() as IncomingMessage;
          response.statusCode = 200;
          callback(response);
          response.emit("data", Buffer.from(JSON.stringify(value)));
          response.emit("end");
        })().catch((error: unknown) => request.emit("error", error));
      },
    });
    return request;
  };

  private runSupervisor(job: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, ["--input-type=module"], {
        env: {
          ...process.env,
          MOIRA_WORKSPACES_ROOT: join(this.root, "workspaces"),
          MOIRA_OPERATION_STATE_DIR: join(this.root, "remote-state"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) return reject(new Error(Buffer.concat(stderr).toString("utf8")));
        try {
          resolveResult(JSON.parse(Buffer.concat(stdout).toString("utf8")).result);
        } catch (error) {
          reject(error);
        }
      });
      const encoded = Buffer.from(JSON.stringify(job)).toString("base64");
      child.stdin.end(`${supervisorSource}\nawait runEncoded("${encoded}");\n`);
    });
  }

  close() {
    this.sqlite.close();
    rmSync(this.root, { recursive: true, force: true });
  }
}

async function client() {
  const server = new McpServer(
    { name: "workspace-client-test", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  registerTools(server, { agent: "chatgpt" }, () => null);
  const mcp = new Client({ name: "chatgpt-compatible", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return {
    call: (name: string, args: Record<string, unknown>, userId = USER_ID) =>
      runWithMCPContext(
        { userId, agent: "chatgpt" },
        () => mcp.callTool({ name, arguments: args }) as Promise<CallToolResult>,
      ),
    close: async () => {
      await mcp.close();
      await server.close();
    },
  };
}

function operation(result: CallToolResult): { operation_id: string; state: string } {
  if (!result.structuredContent?.operation)
    throw new Error(`Missing operation: ${JSON.stringify(result)}`);
  return result.structuredContent!.operation as { operation_id: string; state: string };
}

async function finish(
  mcp: Awaited<ReturnType<typeof client>>,
  name: string,
  workspaceId: string,
  first: CallToolResult,
): Promise<CallToolResult> {
  let result = first;
  // Polling observes the production detached runner; it never resubmits argv or bytes.
  const deadline = Date.now() + 10_000;
  while (["reserved", "running", "reconcile_pending"].includes(operation(result).state)) {
    if (Date.now() >= deadline)
      throw new Error(`Operation did not finish: ${JSON.stringify(result)}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    result = await mcp.call(name, {
      workspace_id: workspaceId,
      operation_id: operation(result).operation_id,
    });
  }
  return result;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const fixture = new DomainFixture();
  cleanups.push(() => fixture.close());
  await fixture.authorizeOnWebsite();
  await fixture.authorizeOnWebsite(OTHER_USER_ID);
  cleanups.push(setWorkspaceToolServicesLoaderForTests(async () => fixture.services));
  const mcp = await client();
  cleanups.push(mcp.close);
  return { fixture, mcp };
}

async function createWorkspace(mcp: Awaited<ReturnType<typeof client>>) {
  const created = await mcp.call("workspace_create", { repository_id: "301", ref: "main" });
  expect(created).toEqual(expect.not.objectContaining({ isError: true }));
  expect(created.structuredContent).toMatchObject({ workspace: { state: "usable" } });
  expect(JSON.stringify(created)).not.toContain("ghu_fixture_secret");
  return (created.structuredContent!.workspace as { workspace_id: string }).workspace_id;
}

function fileReference() {
  return {
    file_id: FILE_ID,
    download_url: "https://oaisdmntprdenmarkeast.blob.core.windows.net/file?sig=fixture-private",
    file_name: "input.bin",
    mime_type: "application/octet-stream",
  };
}

async function expectDownloadBytes(fixture: DomainFixture, result: CallToolResult, bytes: Buffer) {
  const link = result.content[0];
  if (link.type !== "resource_link")
    throw new Error(`Expected download link: ${JSON.stringify(result)}`);
  const token = new URL(link.uri).pathname.split("/").pop()!;
  const referenceId = `workspace-file://${token}`;
  const claim = await fixture.transfers.claimDownload(referenceId);
  const chunks: Buffer[] = [];
  for await (const chunk of claim.stream) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);
  await fixture.transfers.consume(claim.record);
  await expect(fixture.transfers.claimDownload(referenceId)).rejects.toThrow();
}

describe("ChatGPT-compatible workspace MCP with real domain services", () => {
  it("edits and tests actual code, transfers actual binary bytes, and reuses a workspace after restart", async () => {
    const { fixture, mcp } = await setup();
    expect((await mcp.call("workspace_list", {})).structuredContent).toMatchObject({
      repositories: [{ repository_id: "301" }],
      workspaces: [],
    });
    const workspaceId = await createWorkspace(mcp);
    const args = { workspace_id: workspaceId };
    const written = await mcp.call("workspace_write", {
      ...args,
      path: "app.mjs",
      text: initialSource,
      expected: { exists: false },
    });
    expect(written.structuredContent).toMatchObject({ operation: { state: "succeeded" } });
    expect(written.isError).not.toBe(true);
    expect(readFileSync(join(fixture.repositoryPath, "app.mjs"), "utf8")).toBe(initialSource);
    fixture.git(["-C", fixture.repositoryPath, "add", "app.mjs"]);
    fixture.git([
      "-C",
      fixture.repositoryPath,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "fixture baseline",
    ]);
    const stat = await mcp.call("workspace_stat", { ...args, path: "app.mjs" });
    expect(stat.structuredContent).toMatchObject({
      result: { stat: { version: { sha256: digest(Buffer.from(initialSource)) } } },
    });
    expect(
      (await mcp.call("workspace_read", { ...args, path: "app.mjs", offset: 0, length: 1024 }))
        .structuredContent,
    ).toMatchObject({ result: { text: initialSource } });
    expect(
      (
        await mcp.call("workspace_search", {
          ...args,
          path: ".",
          query: "value",
          mode: "literal",
          max_matches: 10,
          max_bytes: 4096,
        })
      ).structuredContent,
    ).toMatchObject({ result: { matches: [expect.objectContaining({ path: "app.mjs" })] } });
    const patched = await mcp.call("workspace_apply_patch", {
      ...args,
      files: [
        {
          path: "app.mjs",
          expected: {
            exists: true,
            size_bytes: Buffer.byteLength(initialSource),
            sha256: digest(Buffer.from(initialSource)),
          },
          edits: [{ start: 21, end: 22, text: "2" }],
        },
      ],
    });
    expect(patched.structuredContent).toMatchObject({
      result: { summary: { files_changed: 1, edits_applied: 1 } },
    });
    expect(readFileSync(join(fixture.repositoryPath, "app.mjs"), "utf8")).toBe(
      "export const value = 2;\n",
    );
    const run = async (argv: string[]) =>
      finish(
        mcp,
        "workspace_exec",
        workspaceId,
        await mcp.call("workspace_exec", { ...args, argv, cwd: ".", timeout_seconds: 10 }),
      );
    const tests = await run([
      process.execPath,
      "--input-type=module",
      "-e",
      "import { value } from './app.mjs'; if (value !== 2) process.exit(23); console.log('tests pass');",
    ]);
    expect(tests.structuredContent).toMatchObject({
      result: { stdout: "tests pass\n", exit_code: 0 },
    });
    const failed = await run([
      process.execPath,
      "--input-type=module",
      "-e",
      "import { value } from './app.mjs'; if (value !== 1) process.exit(23);",
    ]);
    expect(failed.structuredContent).toMatchObject({ result: { state: "failed", exit_code: 23 } });
    expect(failed.isError).toBe(true);
    const diff = await run(["git", "diff", "--", "app.mjs"]);
    expect(diff.structuredContent).toMatchObject({
      result: { stdout: expect.stringContaining("+export const value = 2;"), exit_code: 0 },
    });
    const upload = await mcp.call("workspace_upload", {
      ...args,
      path: "input.bin",
      file: fileReference(),
      expected: { exists: false },
    });
    expect(upload.isError).not.toBe(true);
    expect(readFileSync(join(fixture.repositoryPath, "input.bin"))).toEqual(nativeBytes);
    const nativeExec = await finish(
      mcp,
      "workspace_exec",
      workspaceId,
      await mcp.call("workspace_exec", {
        ...args,
        argv: [
          process.execPath,
          "-e",
          "const {createHash}=require('node:crypto'); const h=createHash('sha256');process.stdin.on('data',b=>h.update(b));process.stdin.on('end',()=>process.stdout.write(h.digest('hex')));",
        ],
        cwd: ".",
        timeout_seconds: 10,
        stdin_file: {
          file_id: FILE_ID.slice("sediment://".length),
          download_url: fileReference().download_url,
        },
      }),
    );
    expect(nativeExec.structuredContent).toMatchObject({
      result: { stdout: digest(nativeBytes), exit_code: 0 },
    });
    expect(fixture.fetchedReferences).toHaveLength(2);
    expect(fixture.fetchedReferences[0]).toEqual({
      fileId: FILE_ID,
      downloadUrl: fileReference().download_url,
      fileName: "input.bin",
      mimeType: "application/octet-stream",
    });
    expect(fixture.fetchedReferences[1]).toEqual({
      fileId: FILE_ID.slice("sediment://".length),
      downloadUrl: fileReference().download_url,
    });
    const textStdin = await finish(
      mcp,
      "workspace_exec",
      workspaceId,
      await mcp.call("workspace_exec", {
        ...args,
        argv: [process.execPath, "-e", "process.stdin.pipe(process.stdout)"],
        cwd: ".",
        timeout_seconds: 10,
        stdin_text: "literal stdin text\n",
      }),
    );
    expect(textStdin.structuredContent).toMatchObject({
      result: { stdout: "literal stdin text\n", exit_code: 0 },
    });
    const download = await mcp.call("workspace_download", {
      ...args,
      path: "input.bin",
      max_bytes: 1024,
      file_name: "input.bin",
      mime_type: "application/octet-stream",
    });
    expect(download.content).toEqual([
      expect.objectContaining({
        type: "resource_link",
        name: "input.bin",
        size: nativeBytes.length,
      }),
    ]);
    await expectDownloadBytes(fixture, download, nativeBytes);

    fixture.reopen();
    const second = await client();
    cleanups.push(second.close);
    expect((await second.call("workspace_get", args)).structuredContent).toMatchObject({
      workspace: { workspace_id: workspaceId },
    });
    expect((await second.call("workspace_stop", args)).structuredContent).toMatchObject({
      data_preserved: true,
      workspace: { state: "stopped" },
    });
    expect(readFileSync(join(fixture.repositoryPath, "input.bin"))).toEqual(nativeBytes);
    const started = await second.call("workspace_start", args);
    expect(started.structuredContent).toMatchObject({ workspace: { state: "usable" } });
    expect(
      (await second.call("workspace_read", { ...args, path: "app.mjs", offset: 0, length: 1024 }))
        .structuredContent,
    ).toMatchObject({ result: { text: "export const value = 2;\n" } });
    const generation = (started.structuredContent!.workspace as { generation: number }).generation;
    expect(
      (
        await second.call("workspace_delete", {
          ...args,
          expected_generation: generation - 1,
          confirm_delete: true,
        })
      ).isError,
    ).toBe(true);
    const deleted = await second.call("workspace_delete", {
      ...args,
      expected_generation: generation,
      confirm_delete: true,
    });
    expect(deleted.structuredContent).toMatchObject({
      data_preserved: false,
      workspace: { state: "deleted" },
    });
    expect(fixture.provider.current).toBeNull();
  });

  it("recovers lost write and exec responses from reopened SQLite without redispatch or foreign access", async () => {
    const { fixture, mcp } = await setup();
    const workspaceId = await createWorkspace(mcp);
    for (const kind of ["workspace_write", "workspace_exec"] as const) {
      fixture.loseNextResponse = kind === "workspace_write" ? "file-execute" : "execute";
      const first = await mcp.call(
        kind,
        kind === "workspace_write"
          ? {
              workspace_id: workspaceId,
              path: "once.txt",
              text: "once\n",
              expected: { exists: false },
            }
          : {
              workspace_id: workspaceId,
              argv: [
                process.execPath,
                "-e",
                "require('node:fs').appendFileSync('executions.txt','once\\n');process.stdout.write('recovered');",
              ],
              cwd: ".",
              timeout_seconds: 10,
            },
      );
      expect(operation(first).state).toBe("reconcile_pending");
      const operationId = operation(first).operation_id;
      fixture.reopen();
      const second = await client();
      cleanups.push(second.close);
      const beforeForeign = fixture.jobs.length;
      const foreign = await second.call(
        kind,
        { workspace_id: workspaceId, operation_id: operationId },
        OTHER_USER_ID,
      );
      expect(foreign.isError).toBe(true);
      expect(fixture.jobs).toHaveLength(beforeForeign);
      const recovered = await finish(
        second,
        kind,
        workspaceId,
        await second.call(kind, { workspace_id: workspaceId, operation_id: operationId }),
      );
      expect(operation(recovered).state).toBe("succeeded");
      const row = fixture.sqlite
        .prepare("SELECT state, kind FROM workspaceOperation WHERE id = ?")
        .get(operationId);
      expect(row).toEqual({
        state: "succeeded",
        kind: kind === "workspace_write" ? "write" : "exec",
      });
      const action = kind === "workspace_write" ? "file-execute" : "execute";
      expect(fixture.jobs.filter((job) => job.action === action)).toHaveLength(1);
      expect(
        readFileSync(
          join(fixture.repositoryPath, kind === "workspace_write" ? "once.txt" : "executions.txt"),
          "utf8",
        ),
      ).toBe("once\n");
    }
    const serializedRows = JSON.stringify(
      fixture.sqlite.prepare("SELECT * FROM workspaceOperation").all(),
    );
    expect(serializedRows).not.toContain("appendFileSync");
    expect(serializedRows).not.toContain("once\\n");
    expect(serializedRows).not.toContain("ghu_fixture_secret");
  });

  it("publishes retained download bytes after a lost response using only the operation ID", async () => {
    const { fixture, mcp } = await setup();
    const workspaceId = await createWorkspace(mcp);
    const bytes = Buffer.from("retained file bytes\n");
    const written = await mcp.call("workspace_write", {
      workspace_id: workspaceId,
      path: "output.txt",
      text: bytes.toString("utf8"),
      expected: { exists: false },
    });
    expect(operation(written).state).toBe("succeeded");
    fixture.loseNextResponse = "file-execute";
    const first = await mcp.call("workspace_download", {
      workspace_id: workspaceId,
      path: "output.txt",
      max_bytes: 1024,
      file_name: "output.txt",
      mime_type: "text/plain",
    });
    expect(operation(first).state).toBe("reconcile_pending");
    const operationId = operation(first).operation_id;
    const marker = fixture.jobs.at(-1)!.remoteMarker;
    fixture.reopen();
    const second = await client();
    cleanups.push(second.close);
    const resumed = await second.call("workspace_download", {
      workspace_id: workspaceId,
      operation_id: operationId,
      file_name: "output.txt",
      mime_type: "text/plain",
    });
    expect(operation(resumed)).toMatchObject({ operation_id: operationId, state: "succeeded" });
    await expectDownloadBytes(fixture, resumed, bytes);
    expect(
      fixture.jobs.filter((job) => job.remoteMarker === marker && job.action === "file-execute"),
    ).toHaveLength(1);
    expect(
      fixture.jobs.filter((job) => job.remoteMarker === marker && job.action === "file-inspect"),
    ).toHaveLength(1);
  });
});
