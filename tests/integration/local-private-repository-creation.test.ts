import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomBytes, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { controllerFixture } from "../fixtures/local-controller.js";
import { createWorkspaceRequestId } from "@mcp-moira/shared";
import {
  LocalDeviceRepository,
  LocalDeviceService,
  RepositoryCreationRepository,
  LocalDeviceError,
  type LocalDeviceSettingsValue,
  type RepositoryCreationAuthority,
  type CodespaceGitHubConfigStatus,
} from "@mcp-moira/shared";
import { LocalRepositoryAdmissionService } from "../../packages/web-backend/src/services/local-repository-admission.js";
import { LocalPrivateRepositoryCreationService } from "../../packages/web-backend/src/services/local-private-repository-creation.js";
import { HttpGitHubCodespaceClient } from "../../packages/web-backend/src/services/github-codespace-client.js";
import { personalGitHubInstallations } from "../../packages/web-backend/src/services/local-github-repository-authority.js";
import { createWorkspaceSemanticServices } from "../../packages/web-backend/src/services/workspace-semantic-service.js";
import { encodeReference, decodeReference } from "@mcp-moira/shared/workspace-references";

let sqlite: Database.Database;
let owners: Array<Awaited<ReturnType<typeof controllerFixture>>> = [],
  directory: string;
const now = Date.now(),
  GiB = 1024 ** 3;
beforeEach(async () => {
  owners = [];
  directory = await realpath(await mkdtemp("/tmp/moira-private-owner-"));
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys=ON");
  migrate(drizzle(sqlite), { migrationsFolder: resolve("packages/web-backend/drizzle") });
  for (const id of ["owner", "other"])
    sqlite
      .prepare(
        "INSERT INTO user(id,email,handle,createdAt,updatedAt,approvedAt,emailVerified) VALUES(?,?,?,'before','before','approved',1)",
      )
      .run(id, `${id}@example.test`, id);
});
afterEach(async () => {
  for (const owner of owners) await owner.close();
  sqlite.close();
  await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const owner: { current?: Awaited<ReturnType<typeof controllerFixture>> } = {};
  const observation = {
    verified: false,
    disconnectAfterVerified: false,
    unavailable: false,
    afterVerify: undefined as undefined | (() => Promise<void>),
  };
  const devices = new LocalDeviceService(new LocalDeviceRepository(sqlite), () => now, {
    async json(user, id, input) {
      if (!owner.current || (observation.unavailable && input.path === "/v1/controller"))
        throw Object.assign(new Error("Owner unavailable"), { code: "ECONNREFUSED" });
      const result = await owner.current.client.json(user, id, input);
      if (
        input.path === "/v1/controller" &&
        observation.verified &&
        observation.disconnectAfterVerified
      )
        observation.unavailable = true;
      return result;
    },
  });
  const settings: LocalDeviceSettingsValue = {
    label: "Owned",
    enabled: true,
    cpuCores: 2,
    memoryBytes: 4 * GiB,
    storageBytes: 32 * GiB,
    dockerBytes: 4 * GiB,
    repositories: [],
    gitAuthor: null,
    agentRepositoryManagement: {
      githubUserId: "42",
      owner: "owner",
      allowExistingPrivate: false,
      allowNewPrivate: true,
      allowPush: true,
    },
  };
  const pair = devices.beginEnrollment("owner"),
    deviceId = randomUUID(),
    credential = randomBytes(32).toString("base64url");
  devices.approveLocalEnrollment({
    pairingId: pair.pairingId,
    pairingToken: pair.pairingToken,
    credential,
    deviceId,
    label: settings.label,
  });
  await devices.confirmEnrollment("owner", pair.pairingId, 2);
  const auth = devices.authenticateDevice(credential);
  owner.current = await controllerFixture(join(directory, deviceId), auth);
  owners.push(owner.current);
  await devices.requestSettings("owner", deviceId, {
    requestId: createWorkspaceRequestId(),
    expectedGeneration: 1,
    expectedRevision: 0,
    settings,
  });
  const authority: RepositoryCreationAuthority = {
    githubConnectionId: randomUUID(),
    githubUserId: "42",
    owner: "owner",
    credentialGeneration: 1,
  };
  const config: Extract<CodespaceGitHubConfigStatus, { state: "available" }> = {
    state: "available",
    clientId: "Iv23abcdefgh1234",
    clientSecret: "fixture-secret-not-provider",
    callbackUrl: "https://moira.example/api/integrations/github/callback",
    installationUrl: "https://github.com/apps/moira/installations/new",
    vaultKeyHex: "db9cae418f0673b254e0a1c76d9348fb624e37b8a901dc5f02a1e64c739db805",
    vaultKeyVersion: "v1",
    settingsUrl: "https://moira.example/settings#integrations-github",
  };
  const remote = new Map<string, Record<string, unknown>>();
  const state = {
    posts: 0,
    puts: 0,
    loseResponse: false,
    rejectStatus: 0,
    lookupRejectStatus: 0,
    installationDenied: false,
    grantVisible: true,
    installed: false,
    postBodies: [] as Record<string, unknown>[],
    changedDuringInspection: false,
    successMode: "normal" as "normal" | "public" | "malformed",
    postBarrier: null as Promise<void> | null,
    postEntered: null as (() => void) | null,
  };
  const fetchImpl: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    if (path === "/user/repos") {
      state.posts++;
      if (state.rejectStatus)
        return Response.json({ message: "fixture refusal" }, { status: state.rejectStatus });
      const body = JSON.parse(String(options?.body));
      state.postBodies.push(body);
      const created = {
        id: 77,
        full_name: `owner/${body.name}`,
        owner: { id: 42, login: "owner" },
        private: state.successMode === "public" ? false : body.private,
        description: body.description,
        permissions: { pull: true, push: true },
      };
      remote.set(body.name, created);
      state.postEntered?.();
      if (state.postBarrier) await state.postBarrier;
      if (state.loseResponse) throw new TypeError("fixture lost response");
      if (state.successMode === "malformed") return new Response("invalid JSON", { status: 201 });
      return Response.json(created, { status: 201 });
    }
    if (path.startsWith("/repos/owner/")) {
      if (state.lookupRejectStatus)
        return Response.json({ message: "fixture refusal" }, { status: state.lookupRejectStatus });
      if (state.changedDuringInspection) authority.credentialGeneration++;
      const value = remote.get(decodeURIComponent(path.slice("/repos/owner/".length)));
      return value
        ? Response.json(value)
        : Response.json({ message: "not found" }, { status: 404 });
    }
    if (path === "/user/installations/8/repositories/77") {
      state.puts++;
      if (state.installationDenied)
        return Response.json({ message: "fixture refusal" }, { status: 403 });
      state.installed = state.grantVisible;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected fixture endpoint ${path}`);
  };
  const client = new HttpGitHubCodespaceClient(config, fetchImpl);
  const repository = new RepositoryCreationRepository(sqlite, (user, id) =>
    devices.getActiveDevice(user, id),
  );
  const admission = new LocalRepositoryAdmissionService({
    devices,
    verifyAccount: async () => ({ githubUserId: "42", owner: "owner" }),
    verifyRepository: async (_user, repositoryId) => {
      const value = [...remote.values()].find((entry) => String(entry.id) === repositoryId)!;
      observation.verified = true;
      await observation.afterVerify?.();
      return {
        githubUserId: "42",
        owner: "owner",
        repositoryId,
        fullName: String(value.full_name),
        private: value.private === true,
        canRead: true,
        canPush: true,
      };
    },
  });
  const makeService = () =>
    new LocalPrivateRepositoryCreationService({
      repository,
      admission,
      authorize: async (_user, installationId) => {
        if (installationId !== "8")
          throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "Wrong installation.");
        return {
          authority: { ...authority },
          accessToken: "fixture-token",
          repositorySelection: "selected",
        };
      },
      currentAuthority: () => ({ ...authority }),
      provider: () => client,
      verifyInstallation: async () => {
        if (!state.installed)
          throw new LocalDeviceError("LOCAL_UNAUTHORIZED", "No actual installation grant.");
      },
      links: () => ({ settings: config.settingsUrl, installation: config.installationUrl }),
      now: () => now,
    });
  const input = {
    deviceId,
    requestId: randomUUID(),
    repositoryName: "new-project",
    installationId: "8",
  };
  return {
    observation,
    devices,
    auth,
    settings,
    authority,
    remote,
    state,
    repository,
    admission,
    makeService,
    input,
    deviceId,
    local: owner.current,
  };
}

describe("Private repository creation precedes local admission without repeating unknown effects", () => {
  test("explicit original repository resume finishes installation setup and applied resume remains pure", async () => {
    const f = await fixture();
    const repositoryCreation = f.makeService();
    const semantic = createWorkspaceSemanticServices({
      providers: [],
      select: () => {
        throw new Error("Repository recovery must not select a workspace provider");
      },
      devices: f.devices,
      workspace: f.local.client,
      controller: f.local.client,
      repositories: f.admission,
      repositoryCreation,
    });
    const selected = { deviceId: f.deviceId, connectionId: f.auth.connectionId };
    const controller = encodeReference("controller", selected);
    const installation = encodeReference("installation", {
      controller: selected,
      installationId: f.input.installationId,
    });
    f.state.installationDenied = true;
    const first = (await semantic.invoke(
      "owner",
      "repository_create",
      { controller, installation, name: f.input.repositoryName },
      `ws1-${f.input.requestId}`,
    )) as { operation: string; state: string; original: Record<string, unknown> };
    expect(first).toMatchObject({
      state: "pending",
      original: {
        status: "setup_required",
        error: { stage: "installation_access", provider_status: 403 },
      },
    });
    for (const field of ["request_id", "device_id", "revision"])
      expect(first.original).not.toHaveProperty(field);
    expect(first.original.instruction).not.toMatch(/request_id|repository_add|local_repository_id/);
    const originalRef = decodeReference(first.operation, "operation");
    expect(originalRef).toMatchObject({
      requestId: f.input.requestId,
      journal: "repository-create",
      kind: "repository",
    });
    const saved = f.repository.getOwned("owner", f.input.requestId)!;
    expect(saved).toMatchObject({ state: "created", repositoryId: "77", installationVerified: 0 });
    expect(f.state.posts).toBe(1);
    expect(f.state.puts).toBe(1);
    const observed = await semantic.invoke("owner", "operation_get", {
      reference: first.operation,
    });
    expect(observed).toMatchObject({ operation: first.operation, state: "pending" });
    expect(f.repository.getOwned("owner", f.input.requestId)).toEqual(saved);
    expect(f.state.posts).toBe(1);
    expect(f.state.puts).toBe(1);
    f.state.installationDenied = false;
    const resumed = (await semantic.invoke("owner", "operation_resume", {
      reference: first.operation,
    })) as { outcome: { ok: true; result: { target: string } } };
    expect(resumed).toMatchObject({
      operation: first.operation,
      state: "completed",
      outcome: { ok: true, result: { status: "applied" } },
    });
    expect(decodeReference(resumed.outcome.result.target, "target")).toMatchObject({
      provider: "local-sandboxes",
      controller: selected,
    });
    const applied = f.repository.getOwned("owner", f.input.requestId)!;
    expect(applied).toMatchObject({
      requestId: saved.requestId,
      deviceId: saved.deviceId,
      repositoryName: saved.repositoryName,
      installationId: saved.installationId,
      marker: saved.marker,
      admissionRequestId: saved.admissionRequestId,
      fingerprint: saved.fingerprint,
      repositoryId: saved.repositoryId,
      installationVerified: 1,
    });
    expect(sqlite.prepare("SELECT count(*) count FROM codespaceRepositoryRequest").get()).toEqual({
      count: 1,
    });
    expect(f.state.posts).toBe(1);
    expect(f.state.puts).toBe(2);
    const receiptPath = join(
      f.local.state.root,
      `controller-operation-ws1-${saved.admissionRequestId}.json`,
    );
    const receiptBytes = await readFile(receiptPath);
    f.observation.unavailable = true;
    f.local.manager.snapshot = async () => {
      throw new Error("Completed resume must not capture native state");
    };
    repositoryCreation.createRepository = async () => {
      throw new Error("Completed resume must not repeat provider or admission work");
    };
    const repeated = await semantic.invoke("owner", "operation_resume", {
      reference: first.operation,
    });
    expect(repeated).toMatchObject({
      operation: first.operation,
      state: "completed",
      outcome: {
        ok: true,
        result: {
          status: "applied",
          repository: `owner/${f.input.repositoryName}`,
          target: resumed.outcome.result.target,
        },
      },
    });
    expect(f.repository.getOwned("owner", f.input.requestId)).toEqual(applied);
    expect(await readFile(receiptPath)).toEqual(receiptBytes);
    expect(f.state.posts).toBe(1);
    expect(f.state.puts).toBe(2);
  });
  test("a lost applied repository reply is collected from its original controller proof without provider calls or native discovery", async () => {
    const f = await fixture();
    const created = await f.makeService().createRepository("owner", f.input);
    expect(created.status).toBe("applied");
    const retained = f.repository.getOwned("owner", f.input.requestId)!;
    expect(retained.state).toBe("created");
    const key = `controller-operation-ws1-${retained.admissionRequestId}.json`;
    const before = await readFile(join(f.local.state.root, key));
    f.observation.unavailable = true;
    f.local.manager.snapshot = async () => {
      throw new Error("Original collection must not capture native state");
    };
    const provider = f.makeService();
    provider.createRepository = async () => {
      throw new Error("Original collection must not resume or resubmit repository creation");
    };
    const controller = {
      kind: "controller" as const,
      deviceId: f.deviceId,
      connectionId: f.auth.connectionId,
    };
    const reference = encodeReference("operation", {
      owner: controller,
      requestId: f.input.requestId,
      kind: "repository",
      journal: "repository-create",
    });
    const semantic = createWorkspaceSemanticServices({
      providers: [],
      select: () => {
        throw new Error("Original collection must not select a provider");
      },
      devices: f.devices,
      workspace: f.local.client,
      controller: f.local.client,
      repositories: f.admission,
      repositoryCreation: provider,
    });
    const collected = (await semantic.invoke("owner", "operation_get", { reference })) as {
      state: string;
      outcome: { ok: true; result: { target: string } };
    };
    expect(collected).toMatchObject({
      operation: reference,
      state: "completed",
      outcome: { ok: true },
    });
    expect(collected.outcome.result).not.toHaveProperty("local_repository_id");
    expect(decodeReference(collected.outcome.result.target, "target")).toEqual({
      provider: "local-sandboxes",
      repositoryId: created.local_repository_id,
      controller: { deviceId: f.deviceId, connectionId: f.auth.connectionId },
    });
    expect(await readFile(join(f.local.state.root, key))).toEqual(before);
    expect(f.repository.getOwned("owner", f.input.requestId)).toEqual(retained);
    expect(f.state.posts).toBe(1);
    expect(f.state.puts).toBe(1);
  });
  test("historical original admission proves creation separately from the current exact grant without rewriting its receipt", async () => {
    const f = await fixture();
    await f.makeService().createRepository("owner", f.input);
    const current = await f.devices.getActiveDevice("owner", f.deviceId);
    const admitted = current.owner.local.control.repositoryAdmissions![0];
    const key = "controller-operation-ws1-" + admitted.requestId + ".json";
    const original = (await f.local.state.read(key, (value) => value)) as {
      outcome: {
        result: {
          local: {
            policy: Record<string, unknown>;
            control: { settings: Record<string, unknown>; ceiling: Record<string, unknown> };
          };
        };
      };
    };
    original.outcome.result.local.policy.leaseUntil = 1;
    original.outcome.result.local.control.settings.leaseUntil = 1;
    original.outcome.result.local.control.ceiling.maxLeaseMs = 3600000;
    await f.local.state.write(key, original);
    const before = await readFile(join(f.local.state.root, key));
    sqlite
      .prepare("UPDATE codespaceRepositoryRequest SET reservationHeld=1 WHERE requestId=?")
      .run(f.input.requestId);
    const repeated = { ...admitted, expectedRevision: current.owner.local.control.revision };
    await expect(
      f.devices.requestRepositoryAdmission("owner", f.deviceId, repeated),
    ).resolves.toMatchObject({ deviceId: f.deviceId });
    expect(f.repository.getOwned("owner", f.input.requestId)!.reservationHeld).toBe(0);
    expect(await readFile(join(f.local.state.root, key))).toEqual(before);
    await f.devices.requestSettings("owner", f.deviceId, {
      requestId: createWorkspaceRequestId(),
      expectedGeneration: 1,
      expectedRevision: current.owner.local.control.revision,
      settings: f.settings,
    });
    sqlite
      .prepare("UPDATE codespaceRepositoryRequest SET reservationHeld=1 WHERE requestId=?")
      .run(f.input.requestId);
    await expect(
      f.devices.requestRepositoryAdmission("owner", f.deviceId, repeated),
    ).rejects.toMatchObject({ code: "LOCAL_CONFLICT" });
    expect(f.repository.getOwned("owner", f.input.requestId)!.reservationHeld).toBe(1);
    expect(await readFile(join(f.local.state.root, key))).toEqual(before);
    expect(f.state.posts).toBe(1);
  });
  test("admission completes from the post-verification witness and physical owner receipt when discovery disconnects", async () => {
    const f = await fixture();
    f.observation.disconnectAfterVerified = true;
    const result = await f.makeService().createRepository("owner", f.input);
    expect(result).toMatchObject({ status: "applied", github_repository_id: "77" });
    expect((await f.local.records.policy()).repositories).toEqual([
      expect.objectContaining({ fullName: "owner/new-project", private: true }),
    ]);
    expect(f.repository.getOwned("owner", f.input.requestId)!.reservationHeld).toBe(0);
    expect(f.state.posts).toBe(1);
    expect((await f.devices.listOwned("owner")).devices[0].owner.state).toBe("unavailable");
  });
  test("consent revoked during GitHub verification refuses admission before any owner grant", async () => {
    const f = await fixture();
    f.remote.set("existing", { id: 90, full_name: "owner/existing", private: true });
    await f.devices.requestSettings("owner", f.deviceId, {
      requestId: createWorkspaceRequestId(),
      expectedGeneration: 1,
      expectedRevision: 1,
      settings: {
        ...f.settings,
        agentRepositoryManagement: {
          ...f.settings.agentRepositoryManagement!,
          allowExistingPrivate: true,
        },
      },
    });
    f.observation.afterVerify = async () => {
      await f.devices.requestSettings("owner", f.deviceId, {
        requestId: createWorkspaceRequestId(),
        expectedGeneration: 1,
        expectedRevision: 2,
        settings: { ...f.settings, agentRepositoryManagement: null },
      });
    };
    await expect(
      f.admission.addExistingRepository("owner", {
        deviceId: f.deviceId,
        requestId: randomUUID(),
        repositoryId: "90",
      }),
    ).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED" });
    expect((await f.local.records.policy()).repositories).toEqual([]);
    expect(f.state.posts).toBe(0);
  });
  test("rejected local admission names retained-repository recovery without repeating GitHub creation", async () => {
    const f = await fixture();
    await f.makeService().createRepository("owner", f.input);
    const admitted = (await f.devices.getActiveDevice("owner", f.deviceId)).owner.local.control;
    const receipt = admitted.repositoryAdmissions![0];
    await f.devices.requestSettings("owner", f.deviceId, {
      requestId: createWorkspaceRequestId(),
      expectedRevision: admitted.revision,
      expectedGeneration: 1,
      settings: f.settings,
    });
    const rejected = await f.makeService().createRepository("owner", f.input);
    expect(rejected).toMatchObject({
      status: "rejected",
      request_id: f.input.requestId,
      github_repository_id: "77",
      full_name: "owner/new-project",
      local_repository_id: null,
      error: { stage: "local_admission" },
    });
    expect(rejected.instruction).toContain("already-created repository");
    expect(rejected.instruction).toContain("repository_add");
    expect(rejected.instruction).toContain("Moira Settings");
    expect(rejected.instruction).toContain("Do not create another repository");
    expect(f.repository.getOwned("owner", f.input.requestId)?.state).toBe("created");
    const current = (await f.devices.getActiveDevice("owner", f.deviceId)).owner.local.control;
    await f.devices.requestSettings("owner", f.deviceId, {
      requestId: createWorkspaceRequestId(),
      expectedRevision: current.revision,
      expectedGeneration: 1,
      settings: { ...f.settings, repositories: [receipt.repository] },
    });
    expect(await f.makeService().createRepository("owner", f.input)).toMatchObject({
      status: "applied",
      request_id: f.input.requestId,
      github_repository_id: "77",
      local_repository_id: expect.stringContaining(receipt.localRepositoryId),
    });
    expect(f.state.posts).toBe(1);
    expect(f.remote.size).toBe(1);
  });

  test("missing applied computer delegation names the owner action before any GitHub mutation", async () => {
    const f = await fixture();
    await f.devices.requestSettings("owner", f.deviceId, {
      requestId: createWorkspaceRequestId(),
      expectedRevision: 1,
      expectedGeneration: 1,
      settings: { ...f.settings, agentRepositoryManagement: null },
    });
    const result = await f.makeService().createRepository("owner", f.input);
    expect(result).toMatchObject({
      status: "setup_required",
      error: { stage: "device_delegation" },
    });
    expect(result.instruction).toContain("Apply permission to create new private repositories");
    expect(f.state.posts).toBe(0);
    expect(result.error).not.toHaveProperty("provider_status");
  });

  test("GitHub creation refusal identifies its exact stage and preserves retry identity", async () => {
    const f = await fixture();
    f.state.rejectStatus = 403;
    const refused = await f.makeService().createRepository("owner", f.input);
    expect(refused).toMatchObject({
      status: "setup_required",
      request_id: f.input.requestId,
      error: { stage: "repository_create", provider_status: 403 },
    });
    expect(refused.instruction).toContain("Repository creation (write) or Administration (write)");
    expect(JSON.stringify(refused)).not.toContain("fixture-token");
    expect(JSON.stringify(refused)).not.toContain("fixture refusal");
    expect(f.repository.getOwned("owner", f.input.requestId)?.state).toBe("prepared");
    f.state.rejectStatus = 0;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("applied");
    expect(f.state.posts).toBe(2);
    expect(f.remote.size).toBe(1);
  });
  test.each(["tenant", "device", "revoked", "account"])(
    "%s authority denial cannot reach repository POST",
    async (failure) => {
      const f = await fixture();
      const userId = failure === "tenant" ? "other" : "owner";
      const input = failure === "device" ? { ...f.input, deviceId: randomUUID() } : f.input;
      if (failure === "revoked") await f.devices.revokeOwned("owner", f.deviceId, 1);
      if (failure === "account") f.authority.githubUserId = "43";
      expect((await f.makeService().createRepository(userId, input)).status).toBe("setup_required");
      expect(f.state.posts).toBe(0);
      expect(f.repository.getOwned("owner", f.input.requestId)).toBeNull();
    },
  );
  test.each(["public", "malformed"] as const)(
    "%s provider success cannot confirm private identity or add a grant",
    async (mode) => {
      const f = await fixture();
      f.state.successMode = mode;
      expect(await f.makeService().createRepository("owner", f.input)).toMatchObject({
        status: "unknown",
        github_repository_id: null,
        full_name: null,
        local_repository_id: null,
      });
      expect(f.state.posts).toBe(1);
      expect(f.state.puts).toBe(0);
      expect(
        (await f.devices.getActiveDevice("owner", f.deviceId)).owner.local.control
          .repositoryAdmissions,
      ).toEqual([]);
      expect(
        (await f.devices.getActiveDevice("owner", f.deviceId)).owner.local.policy.repositories,
      ).toEqual([]);
    },
  );
  test("two concurrent same-payload requests share one durable submitted claim and one POST", async () => {
    const f = await fixture();
    let entered!: () => void, finish!: () => void;
    const reachedPost = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.state.postBarrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.state.postEntered = entered;
    const first = f.makeService().createRepository("owner", f.input);
    try {
      await reachedPost;
      const second = await f.makeService().createRepository("owner", f.input);
      expect(second).toMatchObject({
        status: "pending",
        github_repository_id: null,
        local_repository_id: null,
      });
      expect(f.state.posts).toBe(1);
    } finally {
      finish();
    }
    expect((await first).status).toBe("applied");
    expect(f.state.posts).toBe(1);
  });
  test("private create and selected installation apply on the owner and replay the same identity", async () => {
    const f = await fixture();
    const pending = await f.makeService().createRepository("owner", f.input);
    expect(pending).toMatchObject({
      status: "applied",
      github_repository_id: "77",
      full_name: "owner/new-project",
      local_repository_id: expect.stringMatching(/^local:/),
    });
    expect(f.state.postBodies).toEqual([
      {
        name: "new-project",
        description: expect.stringMatching(/^Created by Moira\. Recovery marker: [a-f0-9]{64}$/),
        private: true,
        auto_init: false,
      },
    ]);
    const retained = f.repository.getOwned("owner", f.input.requestId)!;
    expect(JSON.stringify(pending)).not.toContain(retained.marker);
    expect(retained.reservationHeld).toBe(0);
    expect(
      (await f.devices.getActiveDevice("owner", f.deviceId)).owner.local.policy.repositories,
    ).toHaveLength(1);
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("applied");
    const applied = await f.makeService().createRepository("owner", f.input);
    expect(applied.status).toBe("applied");
    expect(applied.local_repository_id).toMatch(/^local:/);
    expect(f.state.posts).toBe(1);
    expect(f.state.puts).toBe(1);
    expect((await f.devices.getActiveDevice("owner", f.deviceId)).deviceGeneration).toBe(1);
  });
  test("lost create response recovers only its exact marker after process reconstruction", async () => {
    const f = await fixture();
    f.state.loseResponse = true;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("unknown");
    expect(f.repository.getOwned("owner", f.input.requestId)!.reservationHeld).toBe(1);
    f.state.loseResponse = false;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("applied");
    expect(f.state.posts).toBe(1);
    expect(f.state.puts).toBe(1);
  });
  test.each([401, 403, 429])(
    "unknown creation retains the lookup refusal HTTP%s without another create",
    async (status) => {
      const f = await fixture();
      f.state.loseResponse = true;
      await f.makeService().createRepository("owner", f.input);
      f.state.loseResponse = false;
      f.state.lookupRejectStatus = status;
      const blocked = await f.makeService().createRepository("owner", f.input);
      expect(blocked).toMatchObject({
        status: "unknown",
        request_id: f.input.requestId,
        error: { stage: "repository_lookup", provider_status: status },
      });
      expect(blocked.instruction).toContain("without repeating creation");
      expect(blocked.instruction).toContain(
        status === 401
          ? "Refresh GitHub permissions"
          : status === 429
            ? "rate limiting"
            : "repository lookup",
      );
      expect(f.repository.getOwned("owner", f.input.requestId)?.state).toBe("unknown");
      expect(f.state.posts).toBe(1);
      f.state.lookupRejectStatus = 0;
      expect((await f.makeService().createRepository("owner", f.input)).status).toBe("applied");
      expect(f.state.posts).toBe(1);
    },
  );
  test("same-name object without the persisted marker cannot resolve unknown or release its reservation", async () => {
    const f = await fixture();
    f.state.loseResponse = true;
    await f.makeService().createRepository("owner", f.input);
    f.remote.get("new-project")!.description = "Unrelated repository";
    const continued = await f.makeService().createRepository("owner", f.input);
    expect(continued).toMatchObject({
      status: "unknown",
      github_repository_id: null,
      full_name: null,
    });
    expect(f.state.posts).toBe(1);
    expect(f.state.puts).toBe(0);
    expect(f.repository.getOwned("owner", f.input.requestId)!.reservationHeld).toBe(1);
  });
  test("changed immutable payload is rejected before another provider call", async () => {
    const f = await fixture();
    await f.makeService().createRepository("owner", f.input);
    await expect(
      f.makeService().createRepository("owner", { ...f.input, repositoryName: "changed" }),
    ).rejects.toThrow("identity changed");
    expect(f.state.posts).toBe(1);
  });
  test("installation setup preserves confirmed ID and continues without repeating create", async () => {
    const f = await fixture();
    f.state.installationDenied = true;
    expect(await f.makeService().createRepository("owner", f.input)).toMatchObject({
      status: "setup_required",
      github_repository_id: "77",
      local_repository_id: null,
      error: { stage: "installation_access", provider_status: 403 },
    });
    f.state.installationDenied = false;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("applied");
    expect(f.state.posts).toBe(1);
  });
  test("successful installation PUT alone never supplies local authority", async () => {
    const f = await fixture();
    f.state.grantVisible = false;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe(
      "setup_required",
    );
    expect(
      (await f.devices.getActiveDevice("owner", f.deviceId)).owner.local.control
        .repositoryAdmissions,
    ).toEqual([]);
    f.state.grantVisible = true;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("applied");
    expect(f.state.posts).toBe(1);
  });
  test("requested new-private consent cannot reach POST before the owner applies it", async () => {
    const f = await fixture();
    await f.devices.requestSettings("owner", f.deviceId, {
      requestId: createWorkspaceRequestId(),
      expectedRevision: 1,
      expectedGeneration: 1,
      settings: {
        ...f.settings,
        agentRepositoryManagement: {
          ...f.settings.agentRepositoryManagement!,
          allowNewPrivate: false,
        },
      },
    });
    const write = f.local.state.write.bind(f.local.state);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
      }),
      continueApply = new Promise<void>((resolve) => {
        release = resolve;
      });
    f.local.state.write = async (key, value) => {
      if (key === "control-intent.json") {
        enter();
        await continueApply;
      }
      return write(key, value);
    };
    const applying = f.devices.requestSettings("owner", f.deviceId, {
      requestId: createWorkspaceRequestId(),
      expectedRevision: 2,
      expectedGeneration: 1,
      settings: f.settings,
    });
    try {
      await entered;
      expect((await f.makeService().createRepository("owner", f.input)).status).toBe(
        "setup_required",
      );
      expect(f.state.posts).toBe(0);
      expect(f.repository.getOwned("owner", f.input.requestId)).toBeNull();
    } finally {
      release();
      await applying;
    }
  });
  test("persisted admission metadata cannot confirm a failed owner policy write or release creation provenance", async () => {
    const f = await fixture(),
      write = f.local.state.write.bind(f.local.state);
    f.local.state.write = async (key, value) => {
      if (key === "policy.json") throw new Error("Controlled owner policy fsync failure");
      return write(key, value);
    };
    const failed = await f.makeService().createRepository("owner", f.input);
    expect(failed.status).not.toBe("applied");
    const device = await f.devices.getActiveDevice("owner", f.deviceId),
      receipt = device.owner.local.control.repositoryAdmissions![0];
    expect(receipt).toBeDefined();
    expect(device.owner.local.policy.repositories).toEqual([]);
    await expect(
      f.devices.requestRepositoryAdmission("owner", f.deviceId, {
        ...receipt,
        expectedRevision: device.owner.local.control.revision,
      }),
    ).rejects.toThrow();
    expect(f.repository.getOwned("owner", f.input.requestId)?.reservationHeld).toBe(1);
    expect(f.state.posts).toBe(1);
  });
  test("changed credentials during preflight cannot reach POST", async () => {
    const f = await fixture();
    f.state.changedDuringInspection = true;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe(
      "setup_required",
    );
    expect(f.state.posts).toBe(0);
  });
  test("settings beyond the physical resource ceiling are refused before GitHub POST", async () => {
    const f = await fixture();
    await expect(
      f.devices.requestSettings("owner", f.deviceId, {
        requestId: createWorkspaceRequestId(),
        expectedGeneration: 1,
        expectedRevision: 1,
        settings: { ...f.settings, cpuCores: 5 },
      }),
    ).rejects.toThrow();
    expect(f.state.posts).toBe(0);
  });
  test("multiple unknown private creations retain independent identities without a repository quota", async () => {
    const f = await fixture();
    f.state.loseResponse = true;
    await f.makeService().createRepository("owner", f.input);
    await f
      .makeService()
      .createRepository("owner", { ...f.input, requestId: randomUUID(), repositoryName: "second" });
    const third = await f
      .makeService()
      .createRepository("owner", { ...f.input, requestId: randomUUID(), repositoryName: "third" });
    expect(third).toMatchObject({ status: "unknown" });
    expect(f.state.posts).toBe(3);
  });
  test("existing admissions remain available beside multiple unknown creation requests", async () => {
    const f = await fixture();
    const both = {
      ...f.settings,
      agentRepositoryManagement: {
        ...f.settings.agentRepositoryManagement!,
        allowExistingPrivate: true,
      },
    };
    await f.devices.requestSettings("owner", f.deviceId, {
      requestId: createWorkspaceRequestId(),
      expectedRevision: 1,
      expectedGeneration: 1,
      settings: both,
    });
    f.state.loseResponse = true;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("unknown");
    f.remote.set("existing", { id: 90, full_name: "owner/existing", private: true });
    expect(
      (
        await f.admission.addExistingRepository("owner", {
          deviceId: f.deviceId,
          repositoryId: "90",
          requestId: randomUUID(),
        })
      ).status,
    ).toBe("applied");
    const third = await f
      .makeService()
      .createRepository("owner", { ...f.input, requestId: randomUUID(), repositoryName: "third" });
    expect(third).toMatchObject({ status: "unknown" });
    expect(f.state.posts).toBe(2);
    f.remote.set("another", { id: 91, full_name: "owner/another", private: true });
    await expect(
      f.admission.addExistingRepository("owner", {
        deviceId: f.deviceId,
        repositoryId: "91",
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "applied" });
  });
  test("more than 64 confirmed refusals do not consume future admission capacity", async () => {
    const f = await fixture();
    f.state.rejectStatus = 422;
    for (let index = 0; index < 65; index++) {
      const result = await f.makeService().createRepository("owner", {
        ...f.input,
        requestId: randomUUID(),
        repositoryName: `refused-${index}`,
      });
      expect(result.status).toBe("rejected");
    }
    f.state.rejectStatus = 0;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("applied");
  });
  test("more than 64 existing grants admit another repository and preserve unknown creation provenance", async () => {
    const f = await fixture();
    const oldGrants = Array.from({ length: 65 }, (_, index) => ({
      id: randomUUID(),
      fullName: `owner/old-${index}`,
      private: true,
      allowPush: false,
      allowDelete: false,
    }));
    const fullSettings = {
      ...f.settings,
      repositories: oldGrants,
      agentRepositoryManagement: {
        ...f.settings.agentRepositoryManagement!,
        allowExistingPrivate: true,
      },
    };
    await f.devices.requestSettings("owner", f.deviceId, {
      requestId: createWorkspaceRequestId(),
      expectedRevision: 1,
      expectedGeneration: 1,
      settings: fullSettings,
    });
    const original = (await f.devices.getActiveDevice("owner", f.deviceId)).owner.local.policy;
    f.state.loseResponse = true;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("unknown");
    f.remote.set("unrelated", { id: 90, full_name: "owner/unrelated", private: true });
    await expect(
      f.admission.addExistingRepository("owner", {
        deviceId: f.deviceId,
        repositoryId: "90",
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(
      (await f.devices.getActiveDevice("owner", f.deviceId)).owner.local.policy.repositories,
    ).toHaveLength(66);
    expect(f.repository.getOwned("owner", f.input.requestId)!.reservationHeld).toBe(1);
    f.state.loseResponse = false;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("applied");
    expect(f.repository.getOwned("owner", f.input.requestId)!.reservationHeld).toBe(0);
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("applied");
    const completed = (await f.devices.getActiveDevice("owner", f.deviceId)).owner.local.policy;
    expect(completed.repositories).toHaveLength(67);
    expect(completed.repositories.slice(0, 65)).toEqual(original.repositories);
    expect(completed.repositories[66].fullName).toBe("owner/new-project");
    expect(completed.machine).toEqual(original.machine);
    expect(completed.enabled).toBe(original.enabled);
    expect(f.state.posts).toBe(1);
  });
  test("personal installation projection excludes organizations and stale connected accounts", async () => {
    const f = await fixture();
    const installations = personalGitHubInstallations(
      [
        {
          id: "8",
          accountId: "42",
          accountLogin: "Owner",
          targetType: "User",
          repositorySelection: "selected",
        },
        {
          id: "9",
          accountId: "42",
          accountLogin: "owner",
          targetType: "Organization",
          repositorySelection: "all",
        },
        {
          id: "10",
          accountId: "43",
          accountLogin: "other",
          targetType: "User",
          repositorySelection: "all",
        },
      ],
      f.authority,
    );
    const discovery = new LocalRepositoryAdmissionService({
      devices: f.devices,
      verifyAccount: async () => ({ githubUserId: "42", owner: "owner" }),
      verifyRepository: async () => {
        throw new Error("No repository verification during discovery");
      },
      listInstallations: async () =>
        installations.map((installation) => ({
          installation_id: installation.id,
          owner: installation.accountLogin,
          repository_selection: installation.repositorySelection,
        })),
    });
    expect((await discovery.listDevices("owner")).installations).toEqual([
      { installation_id: "8", owner: "Owner", repository_selection: "selected" },
    ]);
    const empty = new LocalRepositoryAdmissionService({
      devices: f.devices,
      verifyAccount: async () => ({ githubUserId: "42", owner: "owner" }),
      verifyRepository: async () => {
        throw new Error("No repository verification during discovery");
      },
      listInstallations: async () => [],
    });
    expect(await empty.listDevices("owner")).toMatchObject({
      github_setup_required: true,
      installations: [],
      devices: [{ device_id: f.deviceId }],
    });
  });
});
