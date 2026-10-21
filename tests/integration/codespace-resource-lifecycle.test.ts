import { describe, expect, jest, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import express from "express";
import request from "supertest";
import {
  CodespaceConnectionRepository,
  GitHubResourceRepository,
  LocalDeviceRepository,
  LocalDeviceService,
  LocalDeviceError,
  type CodespaceConnectionService,
  type CodespaceGitHubConfigStatus,
  type LocalControllerClient,
  type GitHubControllerResource,
  WorkspaceAuthRepository,
  ScopedCredentialError,
  type ControllerOperation,
} from "@mcp-moira/shared";
import { GitHubResourceService } from "../../packages/web-backend/src/services/github-resource-service.js";
import { HttpGitHubCodespaceClient } from "../../packages/web-backend/src/services/github-codespace-client.js";
import type { WorkspaceBinding } from "../../packages/web-backend/src/services/workspace-router.js";
import { createGitHubControllerRoutes } from "../../packages/web-backend/src/routes/github-controller.js";
import {
  createLocalDeviceRoutes,
  createLocalDeviceManagementRoutes,
} from "../../packages/web-backend/src/routes/local-devices.js";
import { PrivateState } from "../../packages/local/src/private-state.js";
import { LocalRecords } from "../../packages/local/src/space-record.js";
import { LocalManager } from "../../packages/local/src/manager.js";
import { LocalController } from "../../packages/local/src/controller.js";
import { LocalRelay } from "../../packages/local/src/relay.js";
import type {
  provisionGitHubWorkspace,
  resumeGitHubWorkspaceEnrollment,
} from "../../packages/local/src/github-provisioner.js";

const config: Extract<CodespaceGitHubConfigStatus, { state: "available" }> = {
  state: "available",
  clientId: "Iv23abcdefgh1234",
  clientSecret: "test-app-secret-1234567890",
  callbackUrl: "https://moira.example/api/integrations/github/callback",
  installationUrl: "https://github.com/apps/test/installations/new",
  vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
  vaultKeyVersion: "v1",
  settingsUrl: "https://moira.example/settings",
};
const preparedCreate = {
  machine: {
    name: "standard",
    displayName: "Standard",
    operatingSystem: "linux",
    cpuCores: 2,
    memoryBytes: 8 * 1024 ** 3,
    storageBytes: 32 * 1024 ** 3,
  },
  idleTimeoutMinutes: 30,
  retentionMinutes: 30 * 24 * 60,
};
function fixture() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  migrate(drizzle(sqlite), {
    migrationsFolder: path.resolve(process.cwd(), "packages/web-backend/drizzle"),
  });
  const deviceId = randomUUID(),
    deviceCredential = "b".repeat(43),
    deviceConnectionId = randomUUID(),
    githubConnectionId = randomUUID();
  sqlite
    .prepare(
      "INSERT INTO user(id,email,handle,approvedAt,emailVerified,createdAt,updatedAt) VALUES('owner','owner@example.test','owner','now',1,'now','now')",
    )
    .run();
  for (const [id, provider] of [
    [deviceConnectionId, "local-sandboxes"],
    [githubConnectionId, "github-codespaces"],
  ])
    sqlite
      .prepare(
        "INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt) VALUES(?,'owner',?,'101','person','connected',1,1,1)",
      )
      .run(id, provider);
  sqlite
    .prepare(
      "INSERT INTO codespaceLocalDevice(id,userId,connectionId,label,generation,status,credentialDigest,createdAt,updatedAt) VALUES(?,'owner',?,'Controller',1,'active',?,1,1)",
    )
    .run(deviceId, deviceConnectionId, createHash("sha256").update(deviceCredential).digest("hex"));
  sqlite
    .prepare(
      "INSERT INTO codespaceConnectionRepository(connectionId,externalInstallationId,externalRepositoryId,fullName,private,createdAt) VALUES(?,'901','201','person/project',1,1)",
    )
    .run(githubConnectionId);
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  let createResponse: () => Promise<Response> = async () => {
    throw new Error("Provider creation reply lost");
  };
  let providerResponse: () => Promise<Response> = async () => new Response(null, { status: 404 });
  let listResponse: () => Promise<Response> = async () => Response.json({ codespaces: [] });
  let beforeCreate: (() => Promise<void>) | undefined;
  const permissionReads: Array<{
    profile: string;
    permission: string;
    method: string;
    path: string;
  }> = [];
  let realOwner: LocalController | undefined;
  let ownerResources: GitHubControllerResource[] = [];
  let ownerOutcome: ControllerOperation["outcome"];
  let connectedGuest: WorkspaceBinding | null = null;
  const guestConnected = jest.fn(
    async (binding: WorkspaceBinding) =>
      connectedGuest !== null && JSON.stringify(binding) === JSON.stringify(connectedGuest),
  );
  const fetchImpl = jest.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    const credential = new Headers(init?.headers).get("authorization");
    const profile =
      credential === "Bearer ghu_test_parent"
        ? "parent-write"
        : credential === "Bearer ghu_fixture_provision"
          ? "provision-read-lifecycle"
          : "unknown";
    const method = init?.method ?? "GET";
    const permission =
      target.pathname.endsWith("/new") ||
      method === "DELETE" ||
      (method === "POST" && target.pathname.endsWith("/codespaces"))
        ? "codespaces:write"
        : target.pathname.endsWith("/machines")
          ? "codespaces_metadata:read"
          : /\/(?:start|stop)$/.test(target.pathname)
            ? "codespaces_lifecycle_admin:write"
            : "codespaces:read";
    permissionReads.push({ profile, permission, method, path: target.pathname });
    if (
      profile === "unknown" ||
      (profile === "provision-read-lifecycle" &&
        ["codespaces:write", "codespaces_metadata:read"].includes(permission))
    )
      return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    requests.push({
      method: init?.method ?? "GET",
      path: target.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (target.pathname.endsWith("/new")) return Response.json({ billable_owner: { id: 101 } });
    if (target.pathname.endsWith("/machines"))
      return Response.json({
        machines: [
          {
            name: "standard",
            display_name: "Standard",
            operating_system: "linux",
            cpus: 2,
            memory_in_bytes: 8 * 1024 ** 3,
            storage_in_bytes: 32 * 1024 ** 3,
          },
        ],
      });
    if (init?.method === "POST" && target.pathname === "/repos/person/project/codespaces") {
      await beforeCreate?.();
      return createResponse();
    }
    if (target.pathname.startsWith("/user/codespaces/")) return providerResponse();
    if (target.pathname === "/user/codespaces") return listResponse();
    throw new Error("Unexpected provider request");
  });
  const controller: LocalControllerClient = {
    async json(_userId, _deviceId, input) {
      if (realOwner) {
        if (input.path.includes("/operations/"))
          return realOwner.collectOperation(input.path.split("/").at(-1)!);
        if (input.method === "POST")
          return realOwner.githubLifecycle(input.path.split("/").at(-1)!, input.body);
        return realOwner.snapshot();
      }
      if (input.method === "POST")
        return {
          requestId: (input.body as { requestId: string }).requestId,
          state: ownerOutcome ? "completed" : "accepted",
          ...(ownerOutcome ? { outcome: ownerOutcome } : {}),
        };
      return {
        version: 1,
        userId: "owner",
        deviceId,
        deviceGeneration: 1,
        ownerConnectionId: deviceConnectionId,
        connectionId: deviceConnectionId,
        observedAt: 1,
        local: { state: "unconfigured" },
        github: { resources: ownerResources },
      };
    },
  };
  const devices = new LocalDeviceService(new LocalDeviceRepository(sqlite), Date.now, controller),
    identities = new GitHubResourceRepository(sqlite);
  const connection: Pick<CodespaceConnectionService, "getAccessToken" | "getStatus"> = {
    getAccessToken: async () => "ghu_test_parent",
    getStatus: () => ({
      state: "connected",
      reason: null,
      settingsUrl: config.settingsUrl,
      installationUrl: config.installationUrl,
      account: { id: "101", login: "person" },
      installations: [],
      repositories: [],
      canConnect: true,
      canDisconnect: true,
    }),
  };
  const retire = jest.fn<
    (userId: string, resourceId: string, throughGeneration: number) => Promise<void>
  >(async () => {});
  const service = new GitHubResourceService(
    identities,
    connection,
    new HttpGitHubCodespaceClient(config, fetchImpl),
    devices,
    controller,
    (...args) => retire(...args),
    () => ({ enabled: true, persistentRetentionMs: 30 * 24 * 60 * 60_000 }),
    () => config,
    () => "https://moira.example",
    guestConnected,
  );
  return {
    sqlite,
    service,
    identities,
    requests,
    fetchImpl,
    permissionReads,
    setBeforeCreate: (value: () => Promise<void>) => {
      beforeCreate = value;
    },
    deviceId,
    deviceCredential,
    deviceConnectionId,
    githubConnectionId,
    devices,
    setOwnerOutcome(value: ControllerOperation["outcome"]) {
      ownerOutcome = value;
    },
    retire,
    guestConnected,
    setConnectedGuest(binding: WorkspaceBinding | null) {
      connectedGuest = binding;
    },
    setCreateResponse(value: () => Promise<Response>) {
      createResponse = value;
    },
    setProviderResponse(value: () => Promise<Response>) {
      providerResponse = value;
    },
    setListResponse(value: () => Promise<Response>) {
      listResponse = value;
    },
    setRealOwner(value: LocalController) {
      realOwner = value;
    },
    setOwnerResources(value: GitHubControllerResource[]) {
      ownerResources = value;
    },
    auth: { userId: "owner", deviceId, deviceGeneration: 1, connectionId: deviceConnectionId },
  };
}
async function attachOwner(
  value: ReturnType<typeof fixture>,
  implementation?: {
    provision: typeof provisionGitHubWorkspace;
    resume: typeof resumeGitHubWorkspaceEnrollment;
  },
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "gh-owner-boundary-")));
  const records = new LocalRecords(await PrivateState.open(root));
  await records.state.write("connection.json", {
    ...value.auth,
    label: "Controller",
    origin: "https://moira.example",
    credential: value.deviceCredential,
    pairingId: randomUUID(),
  });
  const app = express();
  app.use("/api/local-devices", createLocalDeviceRoutes(value.devices, "https://moira.example"));
  app.use(
    "/api/codespaces/github/resources",
    createGitHubControllerRoutes(value.service, value.devices),
  );
  app.use(
    "/api/integrations/local",
    (req, _res, next) => {
      Object.assign(req, { userId: "owner" });
      next();
    },
    createLocalDeviceManagementRoutes(value.devices, "https://moira.example", (_req, _res, next) =>
      next(),
    ),
  );
  const bridge: typeof fetch = async (url, init) => {
    const target = new URL(String(url));
    const call =
      init?.method === "POST"
        ? request(app).post(target.pathname + target.search)
        : request(app).get(target.pathname + target.search);
    for (const [key, header] of new Headers(init?.headers)) call.set(key, header);
    if (init?.body) call.send(JSON.parse(String(init.body)));
    const response = await call;
    return Response.json(response.body, { status: response.status });
  };
  const provision = jest.fn(
    implementation?.provision ??
      (async () => {
        throw new Error("Controlled explicit adoption provisioning refusal");
      }),
  );
  const make = () =>
    new LocalController(new LocalManager(records), value.auth, undefined, undefined, {
      relay: new LocalRelay(records, bridge),
      provision,
      ...(implementation ? { resume: implementation.resume } : {}),
      readiness: async () => ({ state: "available" as const }),
    });
  const owner = make();
  value.setRealOwner(owner);
  return {
    owner,
    records,
    app,
    provision,
    restart() {
      value.setRealOwner(make());
    },
    close: () => rm(root, { recursive: true, force: true }),
  };
}
describe("GitHub cloud identity and fixed provider broker", () => {
  test("verified local GitHub readiness remains separate from missing enrollment and explicit resume uses the same original proof and generation", async () => {
    const value = fixture();
    const provider = () =>
      Response.json({
        name: "known-space",
        display_name: value.identities.listOwned("owner")[0]?.operationMarker,
        owner: { id: 101 },
        billable_owner: { id: 101 },
        repository: { id: 201, full_name: "person/project" },
        state: "Available",
        created_at: "2026-10-14T00:00:00Z",
      });
    value.setCreateResponse(async () => {
      const response = provider();
      return Response.json(await response.json(), { status: 201 });
    });
    value.setProviderResponse(async () => provider());
    const provision: typeof provisionGitHubWorkspace = async (target, deps) => {
      const { resourceId: _resource, previousRepositoryFullName: _previous, ...original } = target;
      const proof = {
        ...original,
        root: "/workspaces/project",
        rootDevice: "1",
        rootInode: "2",
        release: "b".repeat(64),
        environmentIdentity: "a".repeat(64),
      };
      await deps.prepared(proof);
      const health = {
        releaseIdentity: proof.release,
        environmentIdentity: proof.environmentIdentity,
        remote: { state: "enrollment_unavailable" as const },
      };
      await deps.ready(health);
      return { proof, health };
    };
    const resume: typeof resumeGitHubWorkspaceEnrollment = async (_target, proof, deps) => {
      const before = {
        releaseIdentity: proof.release,
        environmentIdentity: proof.environmentIdentity,
        remote: { state: "enrollment_unavailable" as const },
      };
      await deps.ready(before);
      await deps.enroll(proof);
      return { proof, health: { ...before, remote: { state: "connected" } } };
    };
    const boundary = await attachOwner(value, { provision, resume });
    const requestId = `ws1-${randomUUID()}`,
      id = requestId.slice(4);
    try {
      await value.service.create("owner", "201", "main", requestId);
      expect(await value.service.getCodespace("owner", id)).toMatchObject({
        state: "start_pending",
        remote: { state: "enrollment_unavailable" },
        lifecycle_error: "CODESPACE_LOCAL_SETUP_INCOMPLETE",
      });
      const original = await readFile(
        path.join(boundary.records.state.root, `controller-operation-${requestId}.json`),
      );
      const proof = await boundary.owner.state.githubSetupProof(id, value.auth);
      const resumed = `ws1-${randomUUID()}`;
      await value.service.resumeSetup("owner", id, resumed, 2);
      expect((await boundary.owner.snapshot()).github.resources[0]).toMatchObject({
        resourceGeneration: 2,
        environmentIdentity: proof.environmentIdentity,
        remote: { state: "connected" },
      });
      expect(
        await readFile(
          path.join(boundary.records.state.root, `controller-operation-${requestId}.json`),
        ),
      ).toEqual(original);
      expect(value.requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
      expect(new WorkspaceAuthRepository(value.sqlite).getOwned("owner", id)).toMatchObject({
        resourceGeneration: 2,
        environmentIdentity: proof.environmentIdentity,
      });
      expect(await value.service.getCodespace("owner", id)).toMatchObject({
        state: "start_pending",
      });
    } finally {
      await boundary.close();
      value.sqlite.close();
    }
  });
  test("the real owner journals prepared inputs before the fixed parent-authorized POST and lost-reply collection never repeats it", async () => {
    const value = fixture(),
      boundary = await attachOwner(value),
      requestId = `ws1-${randomUUID()}`,
      id = requestId.slice(4);
    let saved: unknown, witness: unknown;
    try {
      value.setBeforeCreate(async () => {
        saved = await boundary.records.state.read(
          `controller-operation-${requestId}.json`,
          (entry) => entry,
        );
        witness = value.identities.getOwned("owner", id);
      });
      await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject({
        code: "WORKSPACE_OUTCOME_UNCONFIRMED",
      });
      const record = path.join(
        boundary.records.state.root,
        `controller-operation-${requestId}.json`,
      );
      const original = await readFile(record);
      const post = value.requests.find((entry) => entry.method === "POST");
      expect(post?.body).toMatchObject({
        machine: preparedCreate.machine.name,
        idle_timeout_minutes: 30,
        retention_period_minutes: preparedCreate.retentionMinutes,
      });
      expect(saved).toMatchObject({ preparedCreate });
      expect(saved).toMatchObject({ phase: { name: "provider_create", resourceGeneration: 2 } });
      expect(witness).toMatchObject({ retirement: "unknown" });
      expect(original.toString()).not.toContain("ghu_test_parent");
      expect(value.permissionReads.every((entry) => entry.profile === "parent-write")).toBe(true);
      expect(value.permissionReads.filter((entry) => entry.path.endsWith("/new"))).toHaveLength(2);
      const offers = value.requests.filter((entry) => entry.path.endsWith("/machines")).length;
      boundary.restart();
      await request(boundary.app)
        .get(`/api/integrations/local/devices/${value.deviceId}/operations/${requestId}`)
        .expect(200);
      expect(await readFile(record)).toEqual(original);
      expect(value.requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
      expect(value.requests.filter((entry) => entry.path.endsWith("/machines"))).toHaveLength(
        offers,
      );
    } finally {
      await boundary.close();
      value.sqlite.close();
    }
  });
  test("the controlled permission boundary refuses provisioning-read create/delete but permits its lifecycle-admin start/stop", async () => {
    const value = fixture();
    const client = new HttpGitHubCodespaceClient(config, value.fetchImpl);
    try {
      await expect(
        client.create("ghu_fixture_provision", {
          repository: { id: "201", fullName: "person/project", private: true },
          ref: "main",
          operationMarker: `moira-${"a".repeat(24)}`,
          ...preparedCreate,
        }),
      ).resolves.toMatchObject({ outcome: "rejected", providerFailure: { status: 403 } });
      await expect(
        client.preflightCreate(
          "ghu_fixture_provision",
          { id: "201", fullName: "person/project", private: true },
          "main",
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        client.deleteExact("ghu_fixture_provision", "owned-space"),
      ).rejects.toMatchObject({ status: 403 });
      value.setProviderResponse(async () => new Response(null, { status: 202 }));
      await expect(client.startExact("ghu_fixture_provision", "owned-space")).resolves.toBe(
        "accepted",
      );
      await expect(client.stopExact("ghu_fixture_provision", "owned-space")).resolves.toBe(
        "accepted",
      );
      expect(
        value.requests.some(
          (entry) =>
            entry.method === "DELETE" ||
            (entry.method === "POST" && entry.path.endsWith("/codespaces")),
        ),
      ).toBe(false);
      expect(value.permissionReads).toEqual(
        expect.arrayContaining([
          {
            profile: "provision-read-lifecycle",
            permission: "codespaces:write",
            method: "DELETE",
            path: "/user/codespaces/owned-space",
          },
          {
            profile: "provision-read-lifecycle",
            permission: "codespaces_lifecycle_admin:write",
            method: "POST",
            path: "/user/codespaces/owned-space/start",
          },
        ]),
      );
    } finally {
      value.sqlite.close();
    }
  });
  test("one unavailable provider observation retains its owned identity beside an independent summary without leaking diagnostics or replaying work", async () => {
    const value = fixture(),
      requestId = "ws1-" + randomUUID(),
      peerRequest = "ws1-" + randomUUID();
    try {
      value.setProviderResponse(async () =>
        Response.json({
          name: "unavailable-space",
          display_name: "Owned fixture",
          owner: { id: 101 },
          billable_owner: { id: 101 },
          repository: { id: 201, full_name: "person/project" },
          state: "Available",
          created_at: "2026-10-14T00:00:00Z",
        }),
      );
      const original = await value.service.registerExisting("owner", "unavailable-space", {
        requestId,
        deviceId: value.deviceId,
      });
      await expect(value.service.create("owner", "201", "main", peerRequest)).rejects.toMatchObject(
        {
          code: "WORKSPACE_OUTCOME_UNCONFIRMED",
        },
      );
      const identities = value.identities.listOwned("owner");
      value.setProviderResponse(async () => {
        throw new Error("private-provider-token-and-URL");
      });
      const view = await value.service.listResources("owner");
      expect(view.codespaces).toEqual([
        expect.objectContaining({
          codespace_id: peerRequest.slice(4),
          generation: 1,
        }),
      ]);
      expect(view.unavailable).toEqual([
        {
          codespace_id: original.codespace_id,
          provider: "github-codespaces",
          repository_id: "201",
          repository: "person/project",
          requested_ref: "HEAD",
          created_at: original.created_at,
          device_id: value.deviceId,
          error: { code: "CODESPACE_PROVIDER_UNAVAILABLE" },
        },
      ]);
      expect(JSON.stringify(view)).not.toContain("private-provider-token-and-URL");
      expect(await value.service.refreshProviderState("owner")).toEqual({ stale: true });
      await expect(value.service.getCodespace("owner", original.codespace_id)).rejects.toThrow();
      expect(value.identities.listOwned("owner")).toEqual(identities);
      expect(value.requests.every((entry) => entry.method === "GET")).toBe(true);
      value.sqlite
        .prepare(
          "INSERT INTO user(id,email,handle,approvedAt,emailVerified,createdAt,updatedAt) VALUES('other','other@example.test','other','now',1,'now','now')",
        )
        .run();
      expect(await value.service.listResources("other")).toEqual({
        codespaces: [],
        unavailable: [],
      });
    } finally {
      value.sqlite.close();
    }
  });
  test.each(["explicit", "single-registered"] as const)(
    "%s controller admission survives a failed snapshot observer and retains its original owner receipt",
    async (selection) => {
      const value = fixture(),
        requestId = "ws1-" + randomUUID(),
        id = requestId.slice(4),
        boundary = await attachOwner(value);
      const observation = jest
        .spyOn(value.devices, "snapshot")
        .mockRejectedValue(
          new LocalDeviceError("LOCAL_UNAVAILABLE", "Controlled snapshot observer failure"),
        );
      try {
        await expect(
          value.service.create(
            "owner",
            "201",
            "main",
            requestId,
            selection === "explicit" ? { deviceId: value.deviceId } : {},
          ),
        ).rejects.toMatchObject({
          code: "WORKSPACE_OUTCOME_UNCONFIRMED",
          requestId,
          deviceId: value.deviceId,
          resourceId: id,
        });
        expect(value.identities.getOwned("owner", id)).toMatchObject({
          deviceId: value.deviceId,
          deviceGeneration: 1,
          deviceConnectionId: value.deviceConnectionId,
          retirement: "unknown",
        });
        expect(await boundary.owner.collectOperation(requestId)).toMatchObject({
          requestId,
          state: "completed",
          outcome: { ok: false, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
        });
      } finally {
        observation.mockRestore();
        await boundary.close();
        value.sqlite.close();
      }
    },
  );

  test("two registered controllers remain ambiguous when only one snapshot observer is available", async () => {
    const value = fixture(),
      requestId = "ws1-" + randomUUID(),
      offlineId = randomUUID(),
      boundary = await attachOwner(value);
    value.sqlite
      .prepare(
        "INSERT INTO codespaceLocalDevice(id,userId,connectionId,label,generation,status,credentialDigest,createdAt,updatedAt) VALUES(?,'owner',?,'Offline controller',1,'active',?,1,1)",
      )
      .run(
        offlineId,
        value.deviceConnectionId,
        createHash("sha256").update("c".repeat(43)).digest("hex"),
      );
    const snapshot = value.devices.snapshot.bind(value.devices);
    const observation = jest
      .spyOn(value.devices, "snapshot")
      .mockImplementation((userId, deviceId) => {
        if (deviceId === offlineId)
          throw new LocalDeviceError("LOCAL_UNAVAILABLE", "Controlled offline observer");
        return snapshot(userId, deviceId);
      });
    try {
      await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject({
        code: "CODESPACE_PROVIDER_UNAVAILABLE",
        message: "Select an explicit registered controller",
      });
      expect(value.identities.listOwned("owner")).toEqual([]);
      expect(await boundary.owner.collectOperation(requestId)).toEqual({
        requestId,
        state: "absent",
      });
      expect(value.requests).toEqual([]);
    } finally {
      observation.mockRestore();
      await boundary.close();
      value.sqlite.close();
    }
  });

  test("actual HTTP402 payment refusal closes its owner receipt and billable witness without provisioning or retry", async () => {
    const value = fixture(),
      requestId = "ws1-" + randomUUID(),
      id = requestId.slice(4),
      boundary = await attachOwner(value);
    const reason = "Codespaces usage not allowed by the configured budget";
    try {
      value.setCreateResponse(async () =>
        Response.json(
          { message: reason },
          { status: 402, headers: { "x-github-request-id": "AB12:CD34" } },
        ),
      );
      await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject({
        code: "CODESPACE_CREATE_REJECTED",
        requestId,
        deviceId: value.deviceId,
        providerFailure: { kind: "http", phase: "request", status: 402, reason },
      });
      const response = await request(boundary.app).get(
        `/api/integrations/local/devices/${value.deviceId}/operations/${requestId}`,
      );
      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({
        requestId,
        state: "completed",
        outcome: {
          ok: false,
          error: {
            code: "CODESPACE_CREATE_REJECTED",
            providerFailure: { kind: "http", status: 402, reason },
          },
        },
      });
      expect(value.identities.getOwned("owner", id)).toMatchObject({
        retirement: "retired",
        providerResourceName: null,
      });
      expect((await boundary.owner.snapshot()).github.resources[0].pendingRequestIds).toEqual([]);
      expect(boundary.provision).not.toHaveBeenCalled();
      expect(value.requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
      expect(() =>
        new CodespaceConnectionRepository(value.sqlite).assertAccountResourcesRetired("owner"),
      ).not.toThrow();
    } finally {
      await boundary.close();
      value.sqlite.close();
    }
  });
  test("the authenticated fixed broker preserves HTTP evidence without declaring the original provider effect absent", async () => {
    const value = fixture(),
      requestId = "ws1-" + randomUUID(),
      id = requestId.slice(4);
    try {
      await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject({
        requestId,
      });
      await value.service.advanceAuthority(value.auth, id, {
        requestId,
        resourceGeneration: 2,
        authorizationGeneration: 1,
        providerResourceName: null,
        retirement: "uncreated",
      });
      value.setCreateResponse(async () =>
        Response.json(
          { message: "Service unavailable" },
          { status: 500, headers: { "x-github-request-id": "AB12:CD34" } },
        ),
      );
      const app = express();
      app.use(
        "/api/codespaces/github/resources",
        createGitHubControllerRoutes(value.service, value.devices),
      );
      const response = await request(app)
        .post(`/api/codespaces/github/resources/${id}/provider`)
        .set("Authorization", `Bearer ${value.deviceCredential}`)
        .send({ requestId, resourceGeneration: 2, action: "create", prepared: preparedCreate });
      expect(response.status).toBe(503);
      expect(response.body.error).toMatchObject({
        code: "WORKSPACE_OUTCOME_UNCONFIRMED",
        providerFailure: {
          kind: "http",
          phase: "request",
          status: 500,
          githubRequestId: "AB12:CD34",
          reason: "Service unavailable",
        },
      });
      expect(response.text).not.toContain("ghu_test_parent");
      expect(value.identities.getOwned("owner", id)).toMatchObject({
        retirement: "unknown",
        providerResourceName: null,
      });
      expect(value.requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
    } finally {
      value.sqlite.close();
    }
  });
  test("the original owner failure reaches the public resource caller with provider evidence and lifecycle identity", async () => {
    const value = fixture(),
      requestId = "ws1-" + randomUUID(),
      providerFailure = {
        kind: "http" as const,
        phase: "request" as const,
        status: 500,
        githubRequestId: "AB12:CD34",
        reason: "Service unavailable",
      };
    try {
      value.setOwnerOutcome({
        ok: false,
        error: {
          code: "WORKSPACE_OUTCOME_UNCONFIRMED",
          message: "Collect the original request",
          providerFailure,
        },
      });
      await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject({
        code: "WORKSPACE_OUTCOME_UNCONFIRMED",
        requestId,
        deviceId: value.deviceId,
        resourceId: requestId.slice(4),
        providerFailure,
      });
      expect(value.requests).toEqual([]);
    } finally {
      value.sqlite.close();
    }
  });
  test.each(["generation", "revocation"] as const)(
    "a late accepted provider reply cannot restore %s authority and retains its physical identity only as evidence",
    async (fence) => {
      const value = fixture(),
        requestId = "ws1-" + randomUUID(),
        id = requestId.slice(4);
      const boundary = await attachOwner(value);
      try {
        let release!: (reply: Response) => void, started!: () => void;
        const reply = new Promise<Response>((resolve) => {
            release = resolve;
          }),
          dispatched = new Promise<void>((resolve) => {
            started = resolve;
          });
        value.setCreateResponse(async () => {
          started();
          return reply;
        });
        const pending = value.service.create("owner", "201", "main", requestId);
        await dispatched;
        const original = value.identities.getOwned("owner", id)!;
        if (fence === "generation")
          value.identities.advanceAuthority("owner", id, {
            resourceGeneration: 3,
            authorizationGeneration: 1,
            providerResourceName: null,
            retirement: "unknown",
          });
        else
          value.sqlite.prepare("UPDATE githubResourceIdentity SET revokedAt=10 WHERE id=?").run(id);
        const fenced = value.identities.getOwned("owner", id);
        release(
          Response.json(
            {
              name: "late-created",
              display_name: original.operationMarker,
              owner: { id: 101 },
              billable_owner: { id: 101 },
              repository: { id: 201, full_name: "person/project" },
              state: "Provisioning",
              created_at: "2026-10-14T00:00:00Z",
            },
            { status: 201, headers: { "x-github-request-id": "AB12:CD34" } },
          ),
        );
        await expect(pending).rejects.toMatchObject({
          code: "WORKSPACE_OUTCOME_UNCONFIRMED",
          requestId,
          deviceId: value.deviceId,
          providerFailure: {
            kind: "authority_changed",
            phase: "publication",
            status: 201,
            githubRequestId: "AB12:CD34",
            resource: {
              name: "late-created",
              repositoryId: "201",
              repositoryFullName: "person/project",
              ownerId: "101",
              billableOwnerId: "101",
            },
          },
        });
        expect(value.identities.getOwned("owner", id)).toEqual(fenced);
        const receipt = await request(boundary.app).get(
          `/api/integrations/local/devices/${value.deviceId}/operations/${requestId}`,
        );
        expect(receipt.status).toBe(200);
        expect(receipt.body.data).toMatchObject({
          requestId,
          state: "completed",
          outcome: {
            ok: false,
            error: {
              code: "WORKSPACE_OUTCOME_UNCONFIRMED",
              providerFailure: {
                kind: "authority_changed",
                status: 201,
                resource: { name: "late-created" },
              },
            },
          },
        });
        expect((await boundary.owner.snapshot()).github.resources[0].pendingRequestIds).toContain(
          requestId,
        );
        boundary.restart();
        const recovered = await request(boundary.app).get(
          `/api/integrations/local/devices/${value.deviceId}/operations/${requestId}`,
        );
        expect(recovered.body.data).toEqual(receipt.body.data);
        expect(value.requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
        expect(() =>
          new CodespaceConnectionRepository(value.sqlite).assertAccountResourcesRetired("owner"),
        ).toThrow();
      } finally {
        await boundary.close();
        value.sqlite.close();
      }
    },
  );
  test("a late confirmed provider refusal cannot retire a newer original ownership witness", async () => {
    const value = fixture(),
      requestId = "ws1-" + randomUUID(),
      id = requestId.slice(4);
    try {
      await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject({
        requestId,
      });
      await value.service.advanceAuthority(value.auth, id, {
        requestId,
        resourceGeneration: 2,
        authorizationGeneration: 1,
        providerResourceName: null,
        retirement: "uncreated",
      });
      let release!: (reply: Response) => void, started!: () => void;
      const reply = new Promise<Response>((resolve) => {
          release = resolve;
        }),
        dispatched = new Promise<void>((resolve) => {
          started = resolve;
        });
      value.setCreateResponse(async () => {
        started();
        return reply;
      });
      const pending = value.service.providerAction(value.auth, id, {
        requestId,
        resourceGeneration: 2,
        action: "create",
        prepared: preparedCreate,
      });
      await dispatched;
      value.identities.advanceAuthority("owner", id, {
        resourceGeneration: 3,
        authorizationGeneration: 1,
        providerResourceName: null,
        retirement: "unknown",
      });
      const fenced = value.identities.getOwned("owner", id);
      release(
        Response.json(
          { message: "Forbidden" },
          { status: 403, headers: { "x-github-request-id": "AB12:CD34" } },
        ),
      );
      await expect(pending).resolves.toMatchObject({
        outcome: "rejected",
        providerFailure: { kind: "http", status: 403, githubRequestId: "AB12:CD34" },
      });
      expect(value.identities.getOwned("owner", id)).toEqual(fenced);
    } finally {
      value.sqlite.close();
    }
  });
  async function ownedFixture() {
    const value = fixture(),
      creationId = "ws1-" + randomUUID(),
      id = creationId.slice(4);
    await expect(value.service.create("owner", "201", "main", creationId)).rejects.toMatchObject({
      requestId: creationId,
    });
    const resource = value.identities.getOwned("owner", id)!;
    value.identities.markCreationSubmitted("owner", id, 1);
    value.identities.observeCreation("owner", id, 1, {
      name: "owned-space",
      displayName: resource.operationMarker,
      ownerId: "101",
      billableOwnerId: "101",
      repositoryId: "201",
      repositoryFullName: "person/project",
      ref: "main",
      state: "available",
      lastUsedAt: null,
      machine: null,
      createdAt: 1,
    });
    return { ...value, id };
  }
  test("lost account authority retains only owned unavailable identities while exact get remains refused", async () => {
    const value = await ownedFixture();
    try {
      const original = value.identities.getOwned("owner", value.id)!,
        foreignConnection = randomUUID(),
        foreignId = randomUUID();
      value.sqlite
        .prepare(
          "INSERT INTO user(id,email,handle,approvedAt,emailVerified,createdAt,updatedAt) VALUES('other','other@example.test','other','now',1,'now','now')",
        )
        .run();
      value.sqlite
        .prepare(
          "INSERT INTO codespaceConnection(id,userId,provider,externalAccountId,externalLogin,status,credentialGeneration,createdAt,updatedAt) VALUES(?,'other','github-codespaces','999','other','connected',1,1,1)",
        )
        .run(foreignConnection);
      value.identities.reserve({
        ...original,
        id: foreignId,
        userId: "other",
        connectionId: foreignConnection,
        externalOwnerId: "999",
        billableOwnerId: "999",
        deviceId: null,
        deviceGeneration: null,
        deviceConnectionId: null,
        providerResourceName: null,
        operationMarker: "moira-" + "e".repeat(24),
      });
      value.sqlite.prepare("UPDATE user SET blocked=1 WHERE id='owner'").run();
      const requests = value.requests.slice();
      const view = await value.service.listResources("owner");
      expect(view).toEqual({
        codespaces: [],
        unavailable: [
          {
            codespace_id: value.id,
            provider: "github-codespaces",
            repository_id: original.repositoryId,
            repository: original.repositoryFullName,
            requested_ref: original.requestedRef,
            created_at: original.createdAt,
            device_id: value.deviceId,
            error: { code: "CODESPACE_AUTHORIZATION_REQUIRED" },
          },
        ],
      });
      await expect(value.service.getCodespace("owner", value.id)).rejects.toMatchObject({
        code: "CODESPACE_AUTHORIZATION_REQUIRED",
      });
      expect(await value.service.refreshProviderState("owner")).toEqual({ stale: true });
      expect(value.identities.getOwned("owner", value.id)).toEqual(original);
      expect(value.identities.getOwned("other", foreignId)).not.toBeNull();
      expect(value.requests).toEqual(requests);
    } finally {
      value.sqlite.close();
    }
  });
  test("explicit adopt previews a renewed grant without changing authority and catches up owner CAS after failed credential retirement", async () => {
    const value = await ownedFixture(),
      requestId = "ws1-" + randomUUID();
    try {
      let fullName = "person/project";
      value.setProviderResponse(async () =>
        Response.json({
          name: "owned-space",
          display_name: "A mutable label",
          owner: { id: 101 },
          billable_owner: { id: 101 },
          repository: { id: 201, full_name: fullName },
          state: "Available",
          created_at: "2026-10-14T00:00:00Z",
        }),
      );
      const oldRemote = await value.service.enroll(value.auth, value.id, {
        requestId: "ws1-" + randomUUID(),
        resourceGeneration: 1,
        authorizationGeneration: 1,
        providerResourceName: "owned-space",
        repositoryId: "201",
        repositoryFullName: fullName,
        environmentIdentity: "a".repeat(64),
        root: "/workspaces/project",
        rootDevice: "1",
        rootInode: "2",
        release: "b".repeat(64),
      });
      value.sqlite
        .prepare("UPDATE codespaceConnection SET authorityGeneration=2 WHERE id=?")
        .run(value.githubConnectionId);
      fullName = "person/renamed-project";
      value.sqlite
        .prepare("UPDATE codespaceConnectionRepository SET fullName=? WHERE connectionId=?")
        .run(fullName, value.githubConnectionId);
      await expect(
        value.service.adopt("owner", value.id, requestId, 1, { deviceId: value.deviceId }),
      ).rejects.toMatchObject({ code: "WORKSPACE_OUTCOME_UNCONFIRMED", requestId });
      expect(value.identities.getOwned("owner", value.id)).toMatchObject({
        authorizationGeneration: 1,
        generation: 1,
        repositoryFullName: "person/project",
      });
      expect(
        new WorkspaceAuthRepository(value.sqlite).authenticate(oldRemote.credential)
          .authorizationGeneration,
      ).toBe(1);
      const preview = await value.service.assignment(value.auth, value.id, "adopt");
      expect(preview).toMatchObject({
        resourceGeneration: 1,
        authorizationGeneration: 2,
        repositoryId: "201",
        repositoryFullName: fullName,
      });
      let pending = true;
      value.retire.mockImplementation(async (_user, id, generation) => {
        expect(id).toBe(value.id);
        expect(generation).toBe(pending ? 1 : 2);
        expect(value.identities.getOwned("owner", id)).toMatchObject({
          authorizationGeneration: 1,
          generation: 1,
        });
        expect(new WorkspaceAuthRepository(value.sqlite).getOwned("owner", id)).toBeNull();
        expect(
          value.sqlite
            .prepare("SELECT resourceId FROM githubWorkspaceRenewal WHERE resourceId=?")
            .get(id),
        ).toBeUndefined();
        if (pending) throw new ScopedCredentialError("SCOPED_CREDENTIAL_DISPOSAL_PENDING", 503);
      });
      await expect(
        value.service.advanceAuthority(value.auth, value.id, {
          requestId,
          resourceGeneration: 2,
          authorizationGeneration: 2,
          providerResourceName: "owned-space",
          retirement: "owned",
          rebindPurpose: "adopt",
        }),
      ).rejects.toMatchObject({ code: "SCOPED_CREDENTIAL_DISPOSAL_PENDING" });
      expect(value.identities.getOwned("owner", value.id)).toMatchObject({
        authorizationGeneration: 1,
        generation: 1,
      });
      const laterRequest = "ws1-" + randomUUID();
      await expect(
        value.service.adopt("owner", value.id, laterRequest, 2, { deviceId: value.deviceId }),
      ).rejects.toMatchObject({ code: "WORKSPACE_OUTCOME_UNCONFIRMED", requestId: laterRequest });
      pending = false;
      await value.service.advanceAuthority(value.auth, value.id, {
        requestId: laterRequest,
        resourceGeneration: 3,
        authorizationGeneration: 2,
        providerResourceName: "owned-space",
        retirement: "owned",
        rebindPurpose: "adopt",
      });
      expect(value.identities.getOwned("owner", value.id)).toMatchObject({
        id: value.id,
        authorizationGeneration: 2,
        generation: 3,
        repositoryId: "201",
        repositoryFullName: fullName,
        providerResourceName: "owned-space",
      });
      expect(value.identities.hasCurrentAuthorization("owner", value.id)).toBe(true);
      expect(new WorkspaceAuthRepository(value.sqlite).getOwned("owner", value.id)).toBeNull();
      expect(value.requests.every((request) => request.method === "GET")).toBe(true);
    } finally {
      value.sqlite.close();
    }
  });
  test("explicit public adoption closes the original lost-create receipt before advancing restored owner authority", async () => {
    const value = fixture(),
      creationId = "ws1-" + randomUUID(),
      id = creationId.slice(4),
      adoptId = "ws1-" + randomUUID(),
      boundary = await attachOwner(value);
    const collect = () =>
      request(boundary.app).get(
        `/api/integrations/local/devices/${value.deviceId}/operations/${creationId}`,
      );
    try {
      await expect(value.service.create("owner", "201", "main", creationId)).rejects.toMatchObject({
        code: "WORKSPACE_OUTCOME_UNCONFIRMED",
        requestId: creationId,
      });
      expect(boundary.provision).not.toHaveBeenCalled();
      expect(value.retire.mock.calls).toEqual([
        ["owner", id, 1],
        ["owner", id, 1],
      ]);
      value.retire.mockClear();
      expect((await boundary.owner.snapshot()).github.resources[0]).toMatchObject({
        resourceGeneration: 2,
        pendingRequestIds: [creationId],
        retirement: "unknown",
      });
      const original = value.identities.getOwned("owner", id)!;
      value.sqlite
        .prepare("UPDATE codespaceConnection SET authorityGeneration=2 WHERE id=?")
        .run(value.githubConnectionId);
      const found = {
        name: "found-original",
        display_name: original.operationMarker,
        owner: { id: 101 },
        billable_owner: { id: 101 },
        repository: { id: 201, full_name: "person/project" },
        state: "Available",
        created_at: "2026-10-14T00:00:00Z",
      };
      value.setListResponse(async () => Response.json({ codespaces: [found] }));
      value.setProviderResponse(async () => Response.json(found));
      const unresolved = await collect();
      expect(unresolved.body.data).toMatchObject({
        requestId: creationId,
        outcome: { ok: false, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
      });
      expect(value.identities.getOwned("owner", id)).toEqual(original);
      const retirementPhases: Array<{ generation: number; authorizationGeneration: number }> = [];
      value.retire.mockImplementation(async (userId, resourceId, throughGeneration) => {
        expect([userId, resourceId, throughGeneration]).toEqual(["owner", id, 2]);
        const closed = await collect();
        expect(closed.status).toBe(200);
        expect(closed.body.data).toMatchObject({
          requestId: creationId,
          state: "completed",
          outcome: { ok: false, error: { code: "GITHUB_PROVISIONING_INCOMPLETE" } },
        });
        expect(
          (await boundary.owner.snapshot()).github.resources[0].pendingRequestIds,
        ).not.toContain(creationId);
        const authority = value.identities.getOwned("owner", id)!;
        retirementPhases.push({
          generation: authority.generation,
          authorizationGeneration: authority.authorizationGeneration,
        });
        if (retirementPhases.length === 1) expect(authority).toEqual(original);
        else
          expect(authority).toMatchObject({
            generation: 3,
            authorizationGeneration: 2,
            providerResourceName: found.name,
          });
        expect(boundary.provision).not.toHaveBeenCalled();
      });
      await expect(
        value.service.adopt("owner", id, adoptId, 2, { deviceId: value.deviceId }),
      ).rejects.toMatchObject({ code: "WORKSPACE_OUTCOME_UNCONFIRMED", requestId: adoptId });
      expect(retirementPhases).toEqual([
        { generation: 2, authorizationGeneration: 1 },
        { generation: 3, authorizationGeneration: 2 },
      ]);
      expect(boundary.provision).toHaveBeenCalledTimes(1);
      expect((await collect()).body.data).toMatchObject({
        requestId: creationId,
        state: "completed",
        outcome: { ok: false, error: { code: "GITHUB_PROVISIONING_INCOMPLETE" } },
      });
      expect((await boundary.owner.snapshot()).github.resources[0]).toMatchObject({
        resourceGeneration: 3,
        authorizationGeneration: 2,
        providerResourceName: found.name,
      });
      expect((await boundary.owner.snapshot()).github.resources[0].pendingRequestIds).not.toContain(
        creationId,
      );
      expect(value.identities.getOwned("owner", id)).toMatchObject({
        generation: 3,
        authorizationGeneration: 2,
        providerResourceName: found.name,
      });
      expect(value.requests.filter((entry) => entry.method === "POST")).toHaveLength(1);
    } finally {
      await boundary.close();
      value.sqlite.close();
    }
  });
  test.each(["found", "absent", "foreign-repository"] as const)(
    "restored same-controller UNKNOWN adoption discovers %s without rebinding on read",
    async (result) => {
      const value = fixture(),
        requestId = "ws1-" + randomUUID(),
        id = requestId.slice(4);
      try {
        await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject(
          { requestId },
        );
        await value.service.advanceAuthority(value.auth, id, {
          requestId,
          resourceGeneration: 2,
          authorizationGeneration: 1,
          providerResourceName: null,
          retirement: "uncreated",
        });
        value.identities.markCreationSubmitted("owner", id, 2);
        value.sqlite
          .prepare("UPDATE codespaceConnection SET authorityGeneration=2 WHERE id=?")
          .run(value.githubConnectionId);
        const original = value.identities.getOwned("owner", id)!;
        value.setListResponse(async () =>
          Response.json({
            codespaces:
              result === "absent"
                ? []
                : [
                    {
                      name: "found-original",
                      display_name: original.operationMarker,
                      owner: { id: 101 },
                      billable_owner: { id: 101 },
                      repository: {
                        id: result === "foreign-repository" ? 999 : 201,
                        full_name: "person/project",
                      },
                      state: "Available",
                      created_at: "2026-10-14T00:00:00Z",
                    },
                  ],
          }),
        );
        if (result !== "found") {
          await expect(value.service.assignment(value.auth, id, "adopt")).rejects.toMatchObject({
            code:
              result === "absent" ? "CODESPACE_RESOURCE_INVALID" : "CODESPACE_GENERATION_CONFLICT",
          });
        } else {
          const retirementBeforeRead = value.retire.mock.calls.slice();
          const preview = await value.service.assignment(value.auth, id, "adopt");
          expect(preview).toMatchObject({
            providerResourceName: "found-original",
            authorizationGeneration: 2,
            providerResource: { name: "found-original", repositoryId: "201" },
          });
          expect(value.identities.getOwned("owner", id)).toEqual(original);
          expect(value.retire.mock.calls).toEqual(retirementBeforeRead);
          await value.service.advanceAuthority(value.auth, id, {
            requestId: "ws1-" + randomUUID(),
            resourceGeneration: 3,
            authorizationGeneration: 2,
            providerResourceName: "found-original",
            retirement: "owned",
            rebindPurpose: "adopt",
          });
          expect(value.identities.getOwned("owner", id)).toMatchObject({
            id,
            generation: 3,
            authorizationGeneration: 2,
            providerResourceName: "found-original",
            retirement: "owned",
          });
        }
        if (result !== "found") expect(value.identities.getOwned("owner", id)).toEqual(original);
        expect(value.requests.every((entry) => entry.method === "GET")).toBe(true);
      } finally {
        value.sqlite.close();
      }
    },
  );
  test.each([
    "foreign-account",
    "ungranted-numeric-repository",
    "foreign-provider-repository",
    "other-controller",
  ] as const)("explicit adopt refuses %s before changing old authority", async (failure) => {
    const value = await ownedFixture();
    try {
      value.sqlite
        .prepare("UPDATE codespaceConnection SET authorityGeneration=2 WHERE id=?")
        .run(value.githubConnectionId);
      if (failure === "foreign-account")
        value.sqlite
          .prepare("UPDATE codespaceConnection SET externalAccountId='999' WHERE id=?")
          .run(value.githubConnectionId);
      if (failure === "ungranted-numeric-repository")
        value.sqlite
          .prepare(
            "UPDATE codespaceConnectionRepository SET externalRepositoryId='999' WHERE connectionId=?",
          )
          .run(value.githubConnectionId);
      value.setProviderResponse(async () =>
        Response.json({
          name: "owned-space",
          display_name: "Any label",
          owner: { id: 101 },
          billable_owner: { id: 101 },
          repository: {
            id: failure === "foreign-provider-repository" ? 999 : 201,
            full_name: "person/project",
          },
          state: "Available",
          created_at: "2026-10-14T00:00:00Z",
        }),
      );
      await expect(
        value.service.assignment(
          failure === "other-controller" ? { ...value.auth, deviceId: randomUUID() } : value.auth,
          value.id,
          "adopt",
        ),
      ).rejects.toMatchObject({
        code:
          failure === "foreign-provider-repository"
            ? "CODESPACE_GENERATION_CONFLICT"
            : "CODESPACE_AUTHORIZATION_REQUIRED",
      });
      expect(value.identities.getOwned("owner", value.id)).toMatchObject({
        authorizationGeneration: 1,
        generation: 1,
      });
      expect(value.retire).not.toHaveBeenCalled();
    } finally {
      value.sqlite.close();
    }
  });
  test("reconnect cleanup reauthorizes only known-name absence after owner registration, with no guest issuance or delete replay", async () => {
    const value = await ownedFixture(),
      requestId = "ws1-" + randomUUID();
    try {
      value.sqlite
        .prepare("UPDATE codespaceConnection SET authorityGeneration=2 WHERE id=?")
        .run(value.githubConnectionId);
      await expect(
        value.service.deleteCodespace("owner", value.id, 1, { requestId }),
      ).rejects.toMatchObject({ code: "WORKSPACE_OUTCOME_UNCONFIRMED", requestId });
      expect(value.identities.getOwned("owner", value.id)).toMatchObject({
        authorizationGeneration: 1,
        generation: 1,
        retirement: "owned",
      });
      const preview = await value.service.assignment(value.auth, value.id, "retire");
      expect(preview.authorizationGeneration).toBe(2);
      const registration = {
        requestId,
        resourceGeneration: 2,
        authorizationGeneration: 2,
        providerResourceName: "owned-space",
        retirement: "owned",
        rebindPurpose: "retire",
      };
      await value.service.advanceAuthority(value.auth, value.id, registration);
      await expect(
        value.service.providerAction(value.auth, value.id, {
          requestId,
          resourceGeneration: 2,
          action: "delete",
        }),
      ).resolves.toBe("absent");
      await value.service.advanceAuthority(value.auth, value.id, {
        ...registration,
        retirement: "retired",
      });
      await value.service.advanceAuthority(value.auth, value.id, {
        ...registration,
        retirement: "retired",
      });
      expect(value.identities.getOwned("owner", value.id)).toMatchObject({
        id: value.id,
        authorizationGeneration: 2,
        generation: 2,
        retirement: "retired",
      });
      expect(new WorkspaceAuthRepository(value.sqlite).getOwned("owner", value.id)).toBeNull();
      expect(
        value.requests.every(
          (request) => request.method === "GET" && request.path === "/user/codespaces/owned-space",
        ),
      ).toBe(true);
    } finally {
      value.sqlite.close();
    }
  });
  test("owner running metadata cannot present an externally stopped provider workspace as usable", async () => {
    const value = fixture(),
      requestId = "ws1-" + randomUUID(),
      id = requestId.slice(4);
    try {
      await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject({
        requestId,
      });
      const resource = value.identities.getOwned("owner", id)!;
      value.identities.markCreationSubmitted("owner", id, 1);
      value.identities.observeCreation("owner", id, 1, {
        name: "owned-space",
        displayName: resource.operationMarker,
        ownerId: "101",
        billableOwnerId: "101",
        repositoryId: "201",
        repositoryFullName: "person/project",
        ref: "main",
        state: "available",
        lastUsedAt: null,
        machine: null,
        createdAt: 1,
      });
      const {
        billableOwnerId: _payer,
        creationSettings: _settings,
        ...observedAssignment
      } = await value.service.assignment(value.auth, id);
      value.setOwnerResources([
        {
          ...observedAssignment,
          state: "running",
          desiredState: "running",
          environmentIdentity: "a".repeat(64),
          observedAt: 1,
        },
      ]);
      let state = "Shutdown";
      value.setProviderResponse(async () =>
        Response.json({
          name: "owned-space",
          display_name: resource.operationMarker,
          owner: { id: 101 },
          billable_owner: { id: 101 },
          repository: { id: 201, full_name: "person/project" },
          state,
          created_at: "2026-10-14T00:00:00Z",
        }),
      );
      await expect(value.service.getCodespace("owner", id)).resolves.toMatchObject({
        state: "ambiguous",
        observed_state: "stopped",
        machine: null,
      });
      state = "Available";
      const credentials = new WorkspaceAuthRepository(value.sqlite);
      credentials.issue(
        {
          userId: "owner",
          resourceId: id,
          resourceGeneration: 1,
          authorizationGeneration: 1,
          environmentIdentity: "a".repeat(64),
        },
        null,
      );
      const binding: WorkspaceBinding = {
        kind: "workspace",
        userId: "owner",
        resourceId: id,
        resourceGeneration: 1,
        authorizationGeneration: 1,
        environmentIdentity: "a".repeat(64),
        expiresAt: null,
      };
      await expect(value.service.getCodespace("owner", id)).resolves.toMatchObject({
        state: "start_pending",
        lifecycle_error: "CODESPACE_PROVIDER_UNAVAILABLE",
      });
      value.setConnectedGuest({ ...binding, environmentIdentity: "c".repeat(64) });
      await expect(value.service.getCodespace("owner", id)).resolves.toMatchObject({
        state: "start_pending",
      });
      value.setConnectedGuest(binding);
      await expect(value.service.getCodespace("owner", id)).resolves.toMatchObject({
        state: "usable",
        observed_state: "running",
      });
      value.setOwnerResources([
        {
          ...observedAssignment,
          state: "running",
          desiredState: "running",
          environmentIdentity: "c".repeat(64),
          observedAt: 2,
        },
      ]);
      await expect(value.service.getCodespace("owner", id)).resolves.toMatchObject({
        state: "start_pending",
      });
      value.setOwnerResources([
        {
          ...observedAssignment,
          state: "running",
          desiredState: "running",
          environmentIdentity: binding.environmentIdentity,
          observedAt: 3,
        },
      ]);
      value.setConnectedGuest(null);
      await expect(value.service.getCodespace("owner", id)).resolves.toMatchObject({
        state: "start_pending",
      });
      value.setConnectedGuest(binding);
      await expect(value.service.getCodespace("owner", id)).resolves.toMatchObject({
        state: "usable",
      });
      value.sqlite
        .prepare("UPDATE workspaceAgentCredential SET resourceGeneration=2 WHERE resourceId=?")
        .run(id);
      await expect(value.service.getCodespace("owner", id)).resolves.toMatchObject({
        state: "start_pending",
      });
      expect(value.requests.every((request) => request.method === "GET")).toBe(true);
    } finally {
      value.sqlite.close();
    }
  });
  test("accepted owner create retains original identity without a cloud provider effect or operational journal", async () => {
    const value = fixture(),
      requestId = "ws1-" + randomUUID();
    try {
      await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject({
        code: "WORKSPACE_OUTCOME_UNCONFIRMED",
        requestId,
        deviceId: value.deviceId,
        resourceId: requestId.slice(4),
      });
      expect(value.requests).toEqual([]);
      expect(value.identities.getOwned("owner", requestId.slice(4))).toMatchObject({
        repositoryId: "201",
        requestedRef: "main",
        retirement: "uncreated",
        generation: 1,
      });
      expect(
        value.sqlite.prepare("SELECT COUNT(*) count FROM localResourceIdentity").get(),
      ).toEqual({
        count: 0,
      });
      expect(
        value.sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='codespaceProviderMutation'",
          )
          .get(),
      ).toBeUndefined();
      const columns = value.sqlite
        .prepare("PRAGMA table_info(githubResourceIdentity)")
        .all()
        .map((row) => (row as { name: string }).name);
      for (const retired of ["desiredState", "claimId", "createDeadlineAt", "lastOutcome"])
        expect(columns).not.toContain(retired);
    } finally {
      value.sqlite.close();
    }
  });
  test("explicit delete proves known provider absence without a DELETE and retires ownership only through owner registration", async () => {
    const value = fixture(),
      creationId = "ws1-" + randomUUID(),
      id = creationId.slice(4),
      requestId = "ws1-" + randomUUID();
    try {
      await expect(value.service.create("owner", "201", "main", creationId)).rejects.toMatchObject({
        requestId: creationId,
      });
      const resource = value.identities.getOwned("owner", id)!;
      value.identities.markCreationSubmitted("owner", id, 1);
      value.identities.observeCreation("owner", id, 1, {
        name: "owned-space",
        displayName: resource.operationMarker,
        ownerId: "101",
        billableOwnerId: "101",
        repositoryId: "201",
        repositoryFullName: "person/project",
        ref: "main",
        state: "available",
        lastUsedAt: null,
        machine: null,
        createdAt: 1,
      });
      await value.service.getCodespace("owner", id);
      expect(value.identities.getOwned("owner", id)?.retirement).toBe("owned");
      const registration = {
        requestId,
        resourceGeneration: 2,
        authorizationGeneration: 1,
        providerResourceName: "owned-space",
        retirement: "owned",
      };
      await value.service.advanceAuthority(value.auth, id, registration);
      await expect(
        value.service.providerAction(value.auth, id, {
          requestId,
          resourceGeneration: 2,
          action: "delete",
        }),
      ).resolves.toBe("absent");
      expect(value.identities.getOwned("owner", id)?.retirement).toBe("owned");
      expect(() =>
        new CodespaceConnectionRepository(value.sqlite).assertAccountResourcesRetired("owner"),
      ).toThrow();
      await value.service.advanceAuthority(value.auth, id, {
        ...registration,
        retirement: "retired",
      });
      expect(value.identities.getOwned("owner", id)?.retirement).toBe("retired");
      expect(() =>
        new CodespaceConnectionRepository(value.sqlite).assertAccountResourcesRetired("owner"),
      ).not.toThrow();
      expect(
        value.requests.every(
          (request) => request.method === "GET" && request.path === "/user/codespaces/owned-space",
        ),
      ).toBe(true);
    } finally {
      value.sqlite.close();
    }
  });
  test("lost provider creation reply leaves a billable unknown witness and cannot repeat the POST", async () => {
    const value = fixture(),
      requestId = "ws1-" + randomUUID(),
      id = requestId.slice(4);
    try {
      await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject({
        requestId,
      });
      await value.service.advanceAuthority(value.auth, id, {
        requestId,
        resourceGeneration: 2,
        authorizationGeneration: 1,
        providerResourceName: null,
        retirement: "uncreated",
      });
      await expect(
        value.service.providerAction(value.auth, id, {
          requestId,
          resourceGeneration: 2,
          action: "create",
          prepared: preparedCreate,
        }),
      ).rejects.toThrow();
      expect(value.identities.getOwned("owner", id)?.retirement).toBe("unknown");
      await expect(
        value.service.providerAction(value.auth, id, {
          requestId,
          resourceGeneration: 2,
          action: "create",
          prepared: preparedCreate,
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_OUTCOME_UNCONFIRMED" });
      await expect(
        value.service.advanceAuthority(value.auth, id, {
          requestId,
          resourceGeneration: 2,
          authorizationGeneration: 1,
          providerResourceName: null,
          retirement: "uncreated",
        }),
      ).rejects.toMatchObject({ code: "CODESPACE_GENERATION_CONFLICT" });
      expect(value.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      expect(() =>
        new CodespaceConnectionRepository(value.sqlite).assertAccountResourcesRetired("owner"),
      ).toThrow();
    } finally {
      value.sqlite.close();
    }
  });
  test("documented provider refusal retires the witness while unsubmitted identity has no billable ownership", async () => {
    const value = fixture(),
      requestId = "ws1-" + randomUUID(),
      id = requestId.slice(4);
    try {
      value.setCreateResponse(async () =>
        Response.json({ message: "Ref is invalid" }, { status: 422 }),
      );
      await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject({
        requestId,
      });
      const connections = new CodespaceConnectionRepository(value.sqlite);
      expect(() => connections.assertAccountResourcesRetired("owner")).not.toThrow();
      await value.service.advanceAuthority(value.auth, id, {
        requestId,
        resourceGeneration: 2,
        authorizationGeneration: 1,
        providerResourceName: null,
        retirement: "uncreated",
      });
      await expect(
        value.service.providerAction(value.auth, id, {
          requestId,
          resourceGeneration: 2,
          action: "create",
          prepared: preparedCreate,
        }),
      ).resolves.toMatchObject({ outcome: "rejected" });
      expect(value.identities.getOwned("owner", id)?.retirement).toBe("retired");
      expect(() => connections.assertAccountResourcesRetired("owner")).not.toThrow();
    } finally {
      value.sqlite.close();
    }
  });
  test("ordinary OAuth refresh preserves workspace authorization epoch, explicit grant replacement fences it", async () => {
    const value = fixture(),
      requestId = "ws1-" + randomUUID(),
      id = requestId.slice(4);
    try {
      await expect(value.service.create("owner", "201", "main", requestId)).rejects.toMatchObject({
        requestId,
      });
      const connections = new CodespaceConnectionRepository(value.sqlite),
        envelope = {
          envelopeVersion: 2 as const,
          keyVersion: "v1",
          iv: "iv",
          authTag: "tag",
          ciphertext: "encrypted",
          generation: 1,
        };
      value.sqlite
        .prepare(
          "INSERT INTO codespaceCredentialVault(connectionId,envelopeVersion,keyVersion,iv,authTag,ciphertext,generation,updatedAt) VALUES(?,2,'v1','iv','tag','encrypted',1,1)",
        )
        .run(value.githubConnectionId);
      const leaseId = randomUUID();
      expect(
        connections.claimRefresh({
          userId: "owner",
          connectionId: value.githubConnectionId,
          expectedGeneration: 1,
          leaseId,
          leaseExpiresAt: 100,
          now: 2,
        }),
      ).toBe(true);
      expect(
        connections.completeRefresh({
          userId: "owner",
          connectionId: value.githubConnectionId,
          expectedGeneration: 1,
          leaseId,
          envelope: { ...envelope, generation: 2 },
          now: 3,
        }),
      ).toBe(true);
      expect(value.identities.hasCurrentAuthorization("owner", id)).toBe(true);
      expect(connections.getAuthorityGeneration("owner", value.githubConnectionId)).toBe(1);
      expect(
        connections.replaceConnectedAuthorization({
          connectionId: value.githubConnectionId,
          userId: "owner",
          provider: "github-codespaces",
          externalAccountId: "101",
          externalLogin: "person",
          status: "connected",
          envelope: { ...envelope, generation: 3 },
          installations: [],
          repositories: [
            {
              externalInstallationId: "901",
              externalRepositoryId: "201",
              fullName: "person/project",
              private: true,
            },
          ],
          supersededRevocation: { id: randomUUID(), envelope: { ...envelope, generation: 2 } },
          now: 4,
          expectedGeneration: 2,
          expectedExternalAccountId: "101",
        }),
      ).toBe(true);
      expect(connections.getAuthorityGeneration("owner", value.githubConnectionId)).toBe(2);
      expect(value.identities.hasCurrentAuthorization("owner", id)).toBe(false);
    } finally {
      value.sqlite.close();
    }
  });
});
