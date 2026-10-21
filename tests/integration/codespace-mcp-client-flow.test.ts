import { afterEach, describe, expect, it } from "@jest/globals";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomBytes, randomUUID } from "node:crypto";
import { createWorkspaceRequestId } from "@mcp-moira/shared/workspace-request-id";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, statSync, watch } from "node:fs";
import { request as tlsRequest } from "node:https";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import express from "express";
import httpRequest from "supertest";
import { createWorkspacePublicationHandler } from "../../packages/mcp-server/src/workspace-publication-route.js";
import sharp from "sharp";
import { extract } from "tar-stream";
import {
  DatabaseRepository,
  ProgressImageService,
  type WorkflowGraph,
  type WorkflowExecution,
} from "@mcp-moira/workflow-engine";
import { sdfExecution, sdfWorkflow } from "../helpers/sdf-progress-fixture.js";
import { LiveCommunicationFileOwner } from "../../packages/web-backend/src/services/communication-file-owner.js";
import { redeemProgressImage } from "../../packages/web-backend/src/routes/execution-progress-image.js";
import { createExecutionMaterializeRoutes } from "../../packages/web-backend/src/routes/execution-materialize.js";
import { join, resolve } from "node:path";
import {
  CodespaceConnectionRepository,
  CodespaceConnectionService,
  CodespaceObservabilityService,
  GitHubResourceRepository,
  LocalDeviceRepository,
  LocalDeviceService,
  CodespaceResourceError,
  evaluateCodespaceResourcePolicy,
  type CodespaceProviderResource,
  type CodespaceGitHubConfigStatus,
  type GitHubCodespaceClient,
  type LocalControllerClient,
  getSqliteInstance,
  getWorkflowService,
  TokenManager,
  metadataRevision,
  WorkspaceAuthRepository,
} from "@mcp-moira/shared";
import { runWithMCPContext } from "../../packages/mcp-server/src/core/request-context.js";
import { createWorkspaceToolHandler } from "../../packages/mcp-server/src/tools/workspace-tools.js";
import { TOOL_BINDINGS } from "../../packages/mcp-server/src/tools/tool-bindings.js";
import {
  WORKSPACE_TOOL_SCHEMAS,
  type WorkspaceToolName,
} from "../../packages/mcp-server/src/tools/workspace-tool-contract.js";
import { getUserContext } from "../../packages/mcp-server/src/core/request-context.js";
import {
  createWorkspaceSemanticServices,
  type WorkspaceSemanticDependencies,
} from "../../packages/web-backend/src/services/workspace-semantic-service.js";
import type { CodespaceProviderServices } from "../../packages/web-backend/src/services/codespace-services.js";
import {
  encodeReference,
  decodeReference,
  type OwnerSelector,
} from "@mcp-moira/shared/workspace-references";
import { registerTools } from "../../packages/mcp-server/src/tools/register-tools.js";
import { createWorkspaceClient } from "../../packages/web-backend/src/services/workspace-client.js";
import { GitHubResourceService } from "../../packages/web-backend/src/services/github-resource-service.js";
import { HttpGitHubCodespaceClient } from "../../packages/web-backend/src/services/github-codespace-client.js";
import { PrivateState } from "../../packages/local/src/private-state.js";
import { LocalRecords } from "../../packages/local/src/space-record.js";
import { LocalManager } from "../../packages/local/src/manager.js";
import { LocalRelay } from "../../packages/local/src/relay.js";
import { LocalController, startLocalController } from "../../packages/local/src/controller.js";
import type {
  GitHubProviderAction,
  GitHubResourceAuthority,
  GitHubProvisionProof,
} from "../../packages/shared/src/codespaces/local-controller-protocol.js";

const USER_ID = "chatgpt-user",
  OTHER_USER_ID = "other-user";
type Fixture = {
  root: string;
  directory: string;
  socketPath: string;
  publicationScope?: Record<string, unknown>;
  ownerSelector?: OwnerSelector;
  remote?: Record<string, unknown>;
  environment?: Record<string, string>;
};
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
class LifecycleProvider extends HttpGitHubCodespaceClient {
  readonly id = "github-codespaces";
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
  override async create(
    _credential: string,
    input: Parameters<HttpGitHubCodespaceClient["create"]>[1],
  ) {
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

async function setup(fileDatabase = false) {
  const value = guest.createFixture();
  cleanups.push(() => guest.dispose(value));
  await guest.start(value);
  const sqlite = new Database(
    fileDatabase ? join(value.directory, "test-authority.db") : ":memory:",
  );
  sqlite.pragma("journal_mode=WAL");
  cleanups.push(() => {
    sqlite.close();
  });
  migrate(drizzle(sqlite), { migrationsFolder: resolve("packages/web-backend/drizzle") });
  for (const id of [USER_ID, OTHER_USER_ID])
    sqlite
      .prepare(
        "INSERT INTO user(id,email,handle,createdAt,updatedAt,approvedAt,emailVerified) VALUES(?,?,?,'now','now','approved',1)",
      )
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
  const provider = new LifecycleProvider(config),
    repository = new GitHubResourceRepository(sqlite);
  const controllerTransport: { wire?: ReturnType<typeof createWorkspaceClient> } = {};
  const controllerHeaders = (userId: string, deviceId: string) => {
    if (!controllerTransport.wire || userId !== USER_ID || deviceId !== auth.deviceId)
      throw new CodespaceResourceError(
        "CODESPACE_PROVIDER_UNAVAILABLE",
        "Assigned controller unavailable",
      );
    return {
      "x-moira-device-id": deviceId,
      "x-moira-device-generation": String(auth.deviceGeneration),
      "x-moira-connection-id": auth.connectionId,
    };
  };
  const pairedClient: LocalControllerClient = {
    async json(
      userId: string,
      deviceId: string,
      input: { method: string; path: string; body?: unknown },
    ): Promise<Record<string, unknown>> {
      const headers = controllerHeaders(userId, deviceId);
      return controllerTransport.wire!.json(userId, deviceId, {
        ...input,
        headers,
      });
    },
  };
  const devices = new LocalDeviceService(new LocalDeviceRepository(sqlite), Date.now, pairedClient);
  const pair = devices.beginEnrollment(USER_ID),
    deviceId = randomUUID(),
    credential = randomBytes(32).toString("base64url");
  devices.approveLocalEnrollment({
    pairingId: pair.pairingId,
    pairingToken: pair.pairingToken,
    credential,
    deviceId,
    label: "Fixture controller",
  });
  await devices.confirmEnrollment(USER_ID, pair.pairingId, 2);
  const auth = devices.authenticateDevice(credential);
  const resource = new GitHubResourceService(
    repository,
    connection,
    provider,
    devices,
    pairedClient,
    async () => undefined,
    () => policy,
    () => config,
    () => "https://moira.example",
  );
  const ownerRoot = await realpath(await mkdtemp("/tmp/mci-"));
  cleanups.push(() => rm(ownerRoot, { recursive: true, force: true }));
  const records = new LocalRecords(await PrivateState.open(ownerRoot));
  await records.state.write("connection.json", {
    ...auth,
    label: "Fixture controller",
    origin: "https://moira.example",
    credential,
    pairingId: pair.pairingId,
  });
  class Relay extends LocalRelay {
    override githubAssignment(id: string, _signal?: AbortSignal, purpose?: "adopt" | "retire") {
      return resource.assignment(auth, id, purpose);
    }
    override async registerGitHubResource(id: string, input: GitHubResourceAuthority) {
      await resource.advanceAuthority(auth, id, input);
    }
    override githubProvider(id: string, input: GitHubProviderAction) {
      return resource.providerAction(auth, id, input);
    }
    override enrollGitHubWorkspace(id: string, proof: GitHubProvisionProof) {
      return resource.enroll(auth, id, proof);
    }
  }
  const wire = createWorkspaceClient(value.socketPath);
  const manager = new LocalManager(records),
    owner = new LocalController(manager, auth, undefined, undefined, {
      relay: new Relay(records),
      readiness: async () => ({ state: "available" }),
      provision: async (target, dependencies) => {
        await dependencies.inspect();
        const root = statSync(value.root, { bigint: true });
        const proof = {
          requestId: target.requestId,
          resourceGeneration: target.resourceGeneration,
          authorizationGeneration: target.authorizationGeneration,
          providerResourceName: target.providerResourceName,
          repositoryId: target.repositoryId,
          repositoryFullName: target.repositoryFullName,
          root: value.root,
          rootDevice: String(root.dev),
          rootInode: String(root.ino),
          release: "a".repeat(64),
          environmentIdentity: String(
            (await wire.json(USER_ID, target.resourceId, { method: "GET", path: "/v1/health" }))
              .environmentIdentity,
          ),
        };
        await dependencies.enroll(proof);
        return { proof, health: {} };
      },
    });
  const endpoint = await startLocalController(owner);
  controllerTransport.wire = createWorkspaceClient(endpoint.socketPath, "controller");
  cleanups.push(async () => {
    await endpoint.retire();
    await endpoint.close();
    await manager.close();
  });
  const authorize = (userId: string, resourceId: string) => {
    return resource.authority(userId, resourceId);
  };
  const workspace: ReturnType<typeof createWorkspaceClient> = {
    request(userId, id, input, signal) {
      authorize(userId, id);
      return wire.request(userId, id, input, signal);
    },
    json(userId, id, input, signal) {
      authorize(userId, id);
      return wire.json(userId, id, input, signal);
    },
  };
  const nativeBytes = Buffer.alloc(8 * 1024 * 1024 + 31, 0xa7);
  const bundle: CodespaceProviderServices = {
    provider: provider.id,
    connection,
    resource,
    workspace,
    guidance: () => ({ provider: provider.id, situation: "ready", instruction: null, links: [] }),
    observability: new CodespaceObservabilityService({
      providerId: provider.id,
      config: () => config,
      policy: () => policy,
    }),
  };
  const semantic = createWorkspaceSemanticServices({
    providers: [bundle],
    select(userId, input) {
      if (input.codespaceId) authorize(userId, input.codespaceId);
      return bundle;
    },
    devices,
    workspace,
    controller: controllerTransport.wire!,
    repositories: {} as WorkspaceSemanticDependencies["repositories"],
    repositoryCreation: {} as WorkspaceSemanticDependencies["repositoryCreation"],
  });
  const fileOwner = new LiveCommunicationFileOwner({
    devices: () => devices,
    controller: () => controllerTransport.wire!,
    workspace: () => workspace,
    authorizePublication: () => USER_ID,
  });
  const execute = createWorkspaceToolHandler(semantic, {
    owner: fileOwner,
    communicationService: {
      deliver: async () => {
        throw new Error("Unexpected text");
      },
      deliverChannel: async () => {
        throw new Error("Unexpected text");
      },
    },
    repository: {} as never,
    audit: async () => {},
  });
  const bindings = TOOL_BINDINGS as Record<string, unknown>;
  for (const name of Object.keys(WORKSPACE_TOOL_SCHEMAS) as WorkspaceToolName[]) {
    const original = bindings[name];
    bindings[name] = (request: unknown) => execute(name, request, getUserContext().userId);
    cleanups.push(() => {
      bindings[name] = original;
    });
  }
  const mcp = await client();
  cleanups.push(mcp.close);
  const created = await mcp.call("workspace_create", {
    target: encodeReference("target", {
      provider: "github-codespaces",
      repositoryId: "301",
      controller: { deviceId: auth.deviceId, connectionId: auth.connectionId },
    }),
    branch: "main",
  });
  const creationId = decodeReference(
    String(created.structuredContent!.operation),
    "operation",
  ).requestId;
  const id = creationId.slice(4);
  await owner.state.drain();
  const receipt = await owner.collectOperation(creationId);
  expect(receipt).toMatchObject({ state: "completed", outcome: { ok: true } });
  await guest.stop(value);
  const admitted = repository.getOwned(USER_ID, id)!;
  value.publicationScope = {
    resourceId: id,
    resourceGeneration: admitted.generation,
    authorizationGeneration: admitted.authorizationGeneration,
    publicOrigin: "https://moira.example",
  };
  value.ownerSelector = { kind: "github", resourceId: id };
  await guest.start(value);
  return Object.assign(value, {
    mcp,
    id,
    reference: encodeReference("workspace", {
      resourceId: id,
      provider: "github-codespaces",
      generation: admitted.generation,
    }),
    nativeBytes,
    wire,
    sqlite,
    devices,
    auth,
    controllerWire: {
      request(...args: Parameters<ReturnType<typeof createWorkspaceClient>["request"]>) {
        const [userId, deviceId, input, signal] = args;
        const headers = { ...input.headers, ...controllerHeaders(userId, deviceId) };
        return controllerTransport.wire!.request(userId, deviceId, { ...input, headers }, signal);
      },
      json(...args: Parameters<ReturnType<typeof createWorkspaceClient>["json"]>) {
        const [userId, deviceId, input, signal] = args;
        const headers = { ...input.headers, ...controllerHeaders(userId, deviceId) };
        return controllerTransport.wire!.json(userId, deviceId, { ...input, headers }, signal);
      },
    },
  });
}

describe("registered MCP tools against actual workspace and lifecycle services", () => {
  it("separate cloud caller streams the enrolled owner's publication and collects one delivery after caller loss", async () => {
    const value = await setup(true);
    const database = value.sqlite.name;
    const health = await value.wire.json(USER_ID, value.id, { method: "GET", path: "/v1/health" });
    const resource = new GitHubResourceRepository(value.sqlite).getOwned(USER_ID, value.id)!;
    const credential = new WorkspaceAuthRepository(value.sqlite).issue(
      {
        userId: USER_ID,
        resourceId: value.id,
        resourceGeneration: resource.generation,
        authorizationGeneration: resource.authorizationGeneration,
        environmentIdentity: String(health.environmentIdentity),
      },
      null,
    );
    for (const [key, setting] of [
      ["telegram.bot_token", "123:fixture"],
      ["telegram.chat_id", "42"],
    ]) {
      value.sqlite
        .prepare(
          "INSERT OR IGNORE INTO settingDefinition(key,type,category,label,createdAt,updatedAt) VALUES(?,'string','telegram',?,1,1)",
        )
        .run(key, key);
      value.sqlite
        .prepare(
          "INSERT INTO userSettingValue(userId,settingKey,value,encrypted,updatedAt) VALUES(?,?,?,0,1)",
        )
        .run(USER_ID, key, setting);
    }
    const key = join(value.directory, "key.pem"),
      ca = join(value.directory, "ca.pem");
    expect(
      spawnSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-keyout",
          key,
          "-out",
          ca,
        ],
        { stdio: "ignore" },
      ).status,
    ).toBe(0);
    let sequence = 0;
    const startCloud = async (role: "backend" | "caller") => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import {startCloudProcess} from ${JSON.stringify(pathToFileURL(resolve("tests/fixtures/workspace-cloud.ts")).href)};await startCloudProcess(${JSON.stringify(role)},${JSON.stringify({ directory: value.directory, userId: USER_ID })});`,
        ],
        {
          env: {
            ...process.env,
            DB_PATH: database,
            CODESPACE_CODESPACES_ENABLED: "true",
            NODE_EXTRA_CA_CERTS: ca,
          },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let diagnostics = "";
      child.stderr!.on("data", (bytes) => {
        diagnostics += String(bytes);
      });
      const exited = new Promise<never>((_done, reject) =>
        child.once("exit", (code) => reject(new Error(`${role} exited ${code}: ${diagnostics}`))),
      );
      cleanups.push(async () => {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "exit");
          child.kill("SIGTERM");
          await closed;
        }
      });
      const [ready] = await Promise.race([once(child, "message"), exited]);
      expect(ready).toMatchObject({ ready: true, database });
      expect((ready as { pid: number }).pid).not.toBe(process.pid);
      return child;
    };
    const callCloud = (
      child: ChildProcess,
      action: string,
      request: Record<string, unknown> = {},
    ) =>
      new Promise<Record<string, unknown>>((done, reject) => {
        const id = ++sequence;
        const closed = () => {
          child.off("message", reply);
          reject(new Error("Cloud caller closed before its reply"));
        };
        const reply = (message: {
          id?: number;
          result?: Record<string, unknown>;
          error?: string;
        }) => {
          if (message.id !== id) return;
          child.off("message", reply);
          child.off("exit", closed);
          if (message.error) reject(new Error(message.error));
          else done(message.result!);
        };
        child.on("message", reply);
        child.once("exit", closed);
        child.send({ id, action, request });
      });
    const backend = await startCloud("backend");
    await guest.stop(value);
    value.remote = {
      origin: "https://127.0.0.1:3100",
      credential,
      environmentIdentity: health.environmentIdentity,
    };
    value.environment = { NODE_EXTRA_CA_CERTS: ca };
    await guest.start(value);
    let caller = await startCloud("caller");
    expect(caller.pid).not.toBe(backend.pid);
    writeFileSync(join(value.root, "binary.bin"), value.nativeBytes);
    const download = await callCloud(caller, "tool", {
      tool: "file_download",
      request: { workspace: value.reference, path: "binary.bin" },
    });
    expect(download.isError).not.toBe(true);
    const file = (download.structuredContent as { file: { reference_id: string; sha256: string } })
      .file;
    const token = file.reference_id.split("/").at(-1)!;
    const publicRead = async () => {
      const reply = await createWorkspaceClient(join(value.directory, "caller.sock")).request(
        USER_ID,
        value.id,
        { method: "GET", path: `/api/codespaces/files/${value.id}/${token}` },
      );
      const chunks: Buffer[] = [];
      for await (const chunk of reply.body) chunks.push(Buffer.from(chunk));
      return { status: reply.statusCode, bytes: Buffer.concat(chunks) };
    };
    expect(await publicRead()).toEqual({ status: 200, bytes: value.nativeBytes });
    const scope = {
      kind: "workspace",
      resourceId: value.id,
      resourceGeneration: resource.generation,
      authorizationGeneration: resource.authorizationGeneration,
      environmentIdentity: health.environmentIdentity,
    };
    const prepare = (bearer: string, currentScope = scope) =>
      new Promise<number>((done, reject) => {
        const outgoing = tlsRequest(
          {
            hostname: "127.0.0.1",
            port: 3100,
            path: "/api/communication/owner/prepare",
            method: "POST",
            ca: readFileSync(ca),
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          },
          (reply) => {
            reply.resume();
            reply.once("end", () => done(reply.statusCode!));
          },
        );
        outgoing.once("error", reject);
        outgoing.end(
          JSON.stringify({
            scope: currentScope,
            requestId: createWorkspaceRequestId(),
            channelIds: ["telegram"],
            kind: "document",
            text: "Report",
            file: {
              fileName: "binary.bin",
              mimeType: "application/octet-stream",
              size: value.nativeBytes.length,
            },
          }),
        );
      });
    expect(await prepare("f".repeat(43))).toBe(403);
    expect(await prepare(credential, { ...scope, resourceId: randomUUID() })).toBe(403);
    expect(await prepare(credential)).toBe(200);
    const requestId = createWorkspaceRequestId();
    const delivery = {
      requestId,
      action: "deliver",
      source: { type: "publication", referenceId: file.reference_id },
      kind: "document",
      text: "Report",
      channelIds: ["telegram"],
    };
    const delivered = new Promise<void>((done, reject) => {
      const marker = join(value.directory, "vendor-effects");
      const inspect = () => {
        void readFile(marker, "utf8").then(
          () => {
            observer.close();
            done();
          },
          (error) => {
            if (error.code !== "ENOENT") {
              observer.close();
              reject(error);
            }
          },
        );
      };
      const observer = watch(value.directory, inspect);
      cleanups.push(() => observer.close());
      observer.once("error", reject);
      inspect();
    });
    const pending = callCloud(caller, "submit", delivery);
    const lostReply = expect(pending).rejects.toThrow("closed before its reply");
    await Promise.race([
      delivered,
      pending.then(() => {
        throw new Error("Delivery replied before the vendor barrier");
      }),
    ]);
    const closed = once(caller, "exit");
    caller.kill("SIGTERM");
    await closed;
    await lostReply;
    caller = await startCloud("caller");
    expect(await callCloud(caller, "collect", { requestId, resourceId: value.id })).toMatchObject({
      requestId,
      state: "accepted",
    });
    const completed = new Promise<void>((done, reject) => {
      const directory = join(value.directory, "state", "communication");
      const inspect = () => {
        void readFile(join(directory, requestId + ".json"), "utf8").then((bytes) => {
          if (JSON.parse(bytes).outcome) {
            observer.close();
            done();
          }
        }, reject);
      };
      const observer = watch(directory, inspect);
      cleanups.push(() => observer.close());
      observer.once("error", reject);
      inspect();
    });
    await callCloud(backend, "release-vendor");
    await completed;
    // Re-submitting the same admitted input collects its original result, never a second vendor effect.
    const receipt = await callCloud(caller, "submit", delivery);
    expect(receipt).toMatchObject({
      requestId,
      state: "completed",
      outcome: { ok: true, result: { status: "delivered" } },
    });
    expect(await callCloud(caller, "collect", { requestId, resourceId: value.id })).toEqual(
      receipt,
    );
    expect(readFileSync(join(value.directory, "vendor-effects"), "utf8")).toBe("delivered\n");
    const multipart = readFileSync(join(value.directory, "vendor-body"));
    const contentStart =
      multipart.indexOf(Buffer.from("Content-Type: application/octet-stream\r\n\r\n")) +
      Buffer.byteLength("Content-Type: application/octet-stream\r\n\r\n");
    expect(contentStart).toBeGreaterThan(
      Buffer.byteLength("Content-Type: application/octet-stream\r\n\r\n"),
    );
    expect(multipart.subarray(contentStart, contentStart + value.nativeBytes.length)).toEqual(
      value.nativeBytes,
    );
    await callCloud(backend, "revoke-at-rendezvous", { resourceId: value.id });
    const refused = await callCloud(caller, "tool", {
      tool: "command_run",
      request: {
        workspace: value.reference,
        command: {
          argv: [
            process.execPath,
            "-e",
            "require('node:fs').writeFileSync('revoked-effect','unexpected')",
          ],
        },
      },
    });
    expect(refused).toMatchObject({ isError: true });
    const refusal = refused.structuredContent as { operation: string };
    const refusedId = decodeReference(refusal.operation, "operation").requestId;
    expect(
      await value.wire.json(USER_ID, value.id, {
        method: "GET",
        path: `/v1/operations/${refusedId}`,
      }),
    ).toMatchObject({ requestId: refusedId, state: "absent" });
    await expect(readFile(join(value.root, "revoked-effect"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await prepare(credential)).toBe(403);
    expect((await publicRead()).status).toBe(404);
    expect(readFileSync(join(value.directory, "vendor-effects"), "utf8")).toBe("delivered\n");
  });

  it("streams an actual controller-built tar and repeats its immutable original without another submission", async () => {
    const value = await setup();
    const db = getSqliteInstance();
    const existingUser = db.prepare("SELECT id FROM user WHERE id = ?").get(USER_ID);
    if (!existingUser)
      db.prepare(
        "INSERT INTO user(id,email,handle,createdAt,updatedAt,approvedAt,emailVerified) VALUES(?,?,?,'now','now','approved',1)",
      ).run(USER_ID, `${USER_ID}@example.test`, USER_ID);
    const graph: WorkflowGraph = {
      id: randomUUID(),
      metadata: { name: "Owner archive", version: "1.0.0", description: "" },
      variableRegistry: {
        guide: { type: "string", description: "Guide", default: "Привет {{name}}\n" },
        name: { type: "string", description: "Recipient", default: "default" },
      },
      nodes: [
        { id: "start", type: "start", connections: { default: "materialize" } },
        {
          id: "materialize",
          type: "materialize",
          basePath: "workspace",
          files: [
            { path: "nested/guide.md", from: "guide" },
            { path: "empty.txt", content: "" },
          ],
          connections: { success: "end" },
        },
        { id: "end", type: "end" },
      ],
    };
    const tokens = TokenManager.getInstance();
    const repository = new DatabaseRepository();
    const saved = await getWorkflowService().save({ graph, userId: USER_ID });
    graph.id = saved.id;
    const run: WorkflowExecution = {
      executionId: randomUUID(),
      workflowId: graph.id!,
      userId: USER_ID,
      revision: 0,
      status: "running",
      currentNodeId: "materialize",
      waitingForInputNodeId: "materialize",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      globalContext: {
        executionId: "",
        workflowId: graph.id!,
        userId: USER_ID,
        variables: { name: "мир" },
        nodeStates: {},
      },
    };
    run.globalContext.executionId = run.executionId;
    const issued: string[] = [];
    cleanups.push(() => {
      for (const token of issued) tokens.deleteToken(token);
      db.prepare("DELETE FROM workflowExecution WHERE executionId = ?").run(run.executionId);
      db.prepare("DELETE FROM workflow WHERE id = ?").run(graph.id);
      if (!existingUser) db.prepare("DELETE FROM user WHERE id = ?").run(USER_ID);
    });
    await repository.saveExecution(run);
    const calls: Array<{ method: string; path: string }> = [];
    const fileOwner = new LiveCommunicationFileOwner({
      devices: () => value.devices,
      controller: () => ({
        request: value.controllerWire.request,
        async json(...args: Parameters<typeof value.controllerWire.json>) {
          calls.push({ method: args[2].method, path: args[2].path });
          return value.controllerWire.json(...args);
        },
      }),
      workspace: () => value.wire,
      authorizePublication: () => USER_ID,
    });
    const token = tokens.createMaterializeToken(
      run.executionId,
      "materialize",
      USER_ID,
      metadataRevision(run.globalContext),
    );
    issued.push(token);
    const app = express().use(
      "/api/public/executions",
      createExecutionMaterializeRoutes(tokens, repository, fileOwner),
    );
    const download = () =>
      httpRequest(app)
        .get(`/api/public/executions/materialize/${token}`)
        .buffer(true)
        .parse((response, callback) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          response.once("end", () => callback(null, Buffer.concat(chunks)));
          response.once("error", callback);
        });
    const first = await download();
    expect(first.status).toBe(200);
    const entries: Array<{ path: string; content: string }> = [];
    const parser = extract();
    await new Promise<void>((done, reject) => {
      parser.on("entry", (header, stream, next) => {
        const chunks: Buffer[] = [];
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.once("end", () => {
          entries.push({ path: header.name, content: Buffer.concat(chunks).toString("utf8") });
          next();
        });
        stream.once("error", reject);
      });
      parser.once("finish", done);
      parser.once("error", reject);
      parser.end(first.body);
    });
    expect(entries).toEqual([
      { path: "nested/guide.md", content: "Привет мир\n" },
      { path: "empty.txt", content: "" },
    ]);
    const assignment = tokens.getMaterializeArchive(token)!;
    expect(assignment.owner).toEqual(await fileOwner.select(USER_ID, value.auth.deviceId));
    graph.variableRegistry!.guide.default = "changed source";
    db.prepare("UPDATE workflow SET graph = ? WHERE id = ?").run(JSON.stringify(graph), graph.id);
    const repeated = await download();
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual(first.body);
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      { method: "POST", path: "/v1/communication" },
    ]);
    expect(calls.filter((call) => call.method === "GET")).toEqual([
      { method: "GET", path: `/v1/communication/operations/${assignment.requestId}` },
    ]);
  });

  it("renders distinct progress views at the actual controller and enforces one-use and stale public grants", async () => {
    const value = await setup();
    const db = getSqliteInstance();
    const existingUser = db.prepare("SELECT id FROM user WHERE id = ?").get(USER_ID);
    if (!existingUser)
      db.prepare(
        "INSERT INTO user(id,email,handle,createdAt,updatedAt,approvedAt,emailVerified) VALUES(?,?,?,'now','now','approved',1)",
      ).run(USER_ID, `${USER_ID}@example.test`, USER_ID);
    const graph: WorkflowGraph = { ...sdfWorkflow(), id: randomUUID() };
    const start = graph.nodes.find((node) => node.type === "start");
    expect(start).toBeDefined();
    const run = {
      ...sdfExecution(graph, start!.id),
      executionId: randomUUID(),
      userId: USER_ID,
    };
    run.globalContext = {
      ...run.globalContext,
      executionId: run.executionId,
      userId: USER_ID,
    };
    const tokens = TokenManager.getInstance();
    const issued: string[] = [];
    cleanups.push(() => {
      for (const token of issued) tokens.deleteToken(token);
      db.prepare("DELETE FROM workflowExecution WHERE executionId = ?").run(run.executionId);
      db.prepare("DELETE FROM workflow WHERE id = ?").run(graph.id);
      if (!existingUser) db.prepare("DELETE FROM user WHERE id = ?").run(USER_ID);
    });
    const repository = new DatabaseRepository();
    const saved = await getWorkflowService().save({ graph, userId: USER_ID });
    graph.id = saved.id;
    run.workflowId = saved.id;
    run.globalContext.workflowId = saved.id;
    await repository.saveExecution(run);
    const controllerObservations: Array<Record<string, unknown>> = [];
    const fileOwner = new LiveCommunicationFileOwner({
      devices: () => value.devices,
      controller: () => ({
        request: value.controllerWire.request,
        async json(...args: Parameters<typeof value.controllerWire.json>) {
          try {
            const reply = await value.controllerWire.json(...args);
            const outcome = reply.outcome as
              { ok?: boolean; error?: { code?: string } } | undefined;
            controllerObservations.push({
              path: args[2].path,
              keys: Object.keys(reply),
              state: reply.state,
              requestId: reply.requestId,
              outcomeOk: outcome?.ok,
              outcomeCode: outcome?.error?.code,
            });
            return reply;
          } catch (error) {
            const observed = error as {
              name?: string;
              message?: string;
              statusCode?: number;
              details?: { error?: { code?: string } };
            };
            controllerObservations.push({
              path: args[2].path,
              statusCode: observed.statusCode,
              code: observed.details?.error?.code,
              name: observed.name,
              message: observed.message,
            });
            throw error;
          }
        },
      }),
      workspace: () => value.wire,
      authorizePublication: () => USER_ID,
    });
    const images = new ProgressImageService(
      repository,
      tokens,
      () => "https://moira.example",
      fileOwner,
    );
    const routes = express().get("/progress/:token", (req, res, next) =>
      redeemProgressImage(req, res, next, images),
    );
    const mint = async (options: Parameters<ProgressImageService["mint"]>[2]) => {
      const grant = await images.mint(run.executionId, USER_ID, options, value.auth.deviceId);
      const token = new URL(grant.downloadUrl).pathname.split("/").at(-1)!;
      issued.push(token);
      return { grant, token };
    };
    const cards = await mint({ viewportWidth: 960 });
    const process = await mint({ viewportWidth: 960, view: "process" });
    const hidden = await mint({
      viewportWidth: 960,
      view: "process",
      hide: ["health", "notify-plan-approval"],
      collapse: ["finalize"],
    });
    expect(cards.grant.options).toMatchObject({ view: "cards", hide: [], collapse: [] });
    expect(hidden.grant.options).toMatchObject({
      hide: ["health", "plan-approval"],
      collapse: ["finalize"],
    });
    const pngs: Buffer[] = [];
    for (const image of [cards, process, hidden]) {
      const responses = await Promise.all(
        Array.from({ length: image === process ? 2 : 1 }, () =>
          httpRequest(routes).get(`/progress/${image.token}`),
        ),
      );
      for (const response of responses) {
        if (response.status !== 200 && response.status !== 401)
          throw new Error(
            JSON.stringify({
              status: response.status,
              body: response.text.replaceAll(image.token, "[progress-token]"),
              controllerObservations,
            }),
          );
      }
      expect(responses.map((response) => response.status).sort()).toEqual(
        image === process ? [200, 401] : [200],
      );
      const response = responses.find((response) => response.status === 200)!;
      expect(response.status).toBe(200);
      expect(await sharp(response.body).metadata()).toMatchObject({ format: "png", width: 960 });
      pngs.push(response.body);
    }
    expect(pngs[0].equals(pngs[1])).toBe(false);
    expect(pngs[1].equals(pngs[2])).toBe(false);
    expect((await sharp(pngs[2]).metadata()).height!).toBeLessThan(
      (await sharp(pngs[1]).metadata()).height!,
    );
    expect((await httpRequest(routes).get(`/progress/${process.token}`)).status).toBe(401);
    const stale = await mint({ view: "process" });
    // saveExecution takes the observed revision and advances it atomically.
    await repository.saveExecution({ ...run });
    expect((await httpRequest(routes).get(`/progress/${stale.token}`)).status).toBe(401);
    const fresh = await mint({ view: "process" });
    expect(fresh.grant.executionRevision).toBeGreaterThan(stale.grant.executionRevision);
    expect((await httpRequest(routes).get(`/progress/${fresh.token}`)).status).toBe(200);
    expect(
      value.sqlite.prepare("SELECT COUNT(*) AS n FROM archiveCommunicationTransfer").get(),
    ).toEqual({ n: 0 });
  });

  it("edits and executes actual code, then observes preserved files after service restart", async () => {
    const value = await setup();
    const args = { workspace: value.reference };
    const source = "export const value = 1;\n";
    const written = await value.mcp.call("file_create", {
      ...args,
      path: "app.mjs",
      text: source,
    });
    expect(written.isError).not.toBe(true);
    const patched = await value.mcp.call("file_patch", {
      ...args,
      files: [
        {
          path: "app.mjs",
          expected: { text: source },
          replacements: [{ old_text: "value = 1", new_text: "value = 2" }],
        },
      ],
    });
    expect(patched.isError).not.toBe(true);
    const tested = await value.mcp.call("command_run", {
      ...args,
      command: {
        argv: [
          process.execPath,
          "--input-type=module",
          "-e",
          "import {value} from './app.mjs'; if(value!==2)process.exit(23); console.log('tests pass')",
        ],
      },
    });
    expect(tested).toMatchObject({
      structuredContent: {
        state: "completed",
        outcome: { ok: true, result: { exitCode: 0 } },
        stdout: "tests pass\n",
      },
    });
    await guest.stop(value);
    await guest.start(value);
    expect(
      (await value.mcp.call("file_read", { ...args, path: "app.mjs" })).structuredContent,
    ).toMatchObject({ text: "export const value = 2;\n" });
    expect(readFileSync(join(value.root, "app.mjs"), "utf8")).toBe("export const value = 2;\n");
    expect(
      (await value.mcp.call("file_read", { ...args, path: "app.mjs" }, OTHER_USER_ID)).isError,
    ).toBe(true);
  });

  it("publishes a large immutable owner file through registered MCP and the live public route without cloud storage", async () => {
    const value = await setup();
    const args = { workspace: value.reference };
    writeFileSync(join(value.root, "binary.bin"), value.nativeBytes);
    const boundedDownload = await value.mcp.call("file_download", {
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
    const download = await value.mcp.call("file_download", {
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
    expect(file.reference_id).toMatch(
      new RegExp(`^owner-file://workspace/${value.id}/[A-Za-z0-9_-]{43}$`),
    );
    const token = file.reference_id.split("/").at(-1)!;
    const routes = express();
    routes.get(
      "/files/:resourceId/:token",
      createWorkspacePublicationHandler({ authorize: () => USER_ID, workspace: value.wire }),
    );
    for (let read = 0; read < 2; read++) {
      const response = await httpRequest(routes).get(`/files/${value.id}/${token}`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(value.nativeBytes);
    }
    expect(
      value.sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='codespaceTransfer'")
        .all(),
    ).toEqual([]);
    expect(
      value.sqlite.prepare("SELECT COUNT(*) AS n FROM archiveCommunicationTransfer").get(),
    ).toEqual({
      n: 0,
    });
  });
});
