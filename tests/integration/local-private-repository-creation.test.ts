import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  LocalDeviceRepository,
  LocalDeviceService,
  RepositoryCreationRepository,
  LocalDeviceError,
  MAX_LOCAL_WORK_LEASE_MS,
  type LocalDeviceSettingsValue,
  type LocalPublicPolicy,
  type LocalControlCeiling,
  type RepositoryCreationAuthority,
  type CodespaceGitHubConfigStatus,
} from "@mcp-moira/shared";
import { LocalRepositoryAdmissionService } from "../../packages/web-backend/src/services/local-repository-admission.js";
import { LocalPrivateRepositoryCreationService } from "../../packages/web-backend/src/services/local-private-repository-creation.js";
import { HttpGitHubCodespaceClient } from "../../packages/web-backend/src/services/github-codespace-client.js";
import { personalGitHubInstallations } from "../../packages/web-backend/src/services/local-github-repository-authority.js";

let sqlite: Database.Database;
const now = 1791320400000,
  GiB = 1024 ** 3;
beforeEach(() => {
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
afterEach(() => {
  sqlite.close();
});

function fixture() {
  const devices = new LocalDeviceService(new LocalDeviceRepository(sqlite), () => now);
  const settings: LocalDeviceSettingsValue = {
    label: "Owned",
    enabled: true,
    leaseUntil: now + 3600000,
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
  const ceiling: LocalControlCeiling = {
    cpuCores: 2,
    memoryBytes: 4 * GiB,
    storageBytes: 32 * GiB,
    dockerBytes: 4 * GiB,
    maxLeaseMs: 3600000,
  };
  const pair = devices.beginEnrollment("owner"),
    deviceId = randomUUID(),
    credential = randomBytes(32).toString("base64url");
  const policy = (value = settings): LocalPublicPolicy => ({
    version: 1,
    deviceId,
    label: value.label,
    enabled: value.enabled,
    leaseUntil: value.leaseUntil,
    repositories: value.repositories,
    machine: {
      name: "local-approved",
      displayName: value.label,
      operatingSystem: "linux",
      cpuCores: value.cpuCores,
      memoryBytes: value.memoryBytes,
      storageBytes: value.storageBytes,
    },
  });
  devices.approveLocalEnrollment({
    pairingId: pair.pairingId,
    pairingToken: pair.pairingToken,
    credential,
    policy: policy(),
  });
  devices.confirmEnrollment("owner", pair.pairingId, 2);
  const auth = devices.authenticateDevice(credential);
  const opted = { ...settings, agentRepositoryManagement: null };
  devices.heartbeat(auth, policy(), { ceiling, settings: opted, appliedRevision: 0 });
  devices.requestSettings("owner", deviceId, {
    expectedRevision: 0,
    expectedGeneration: 1,
    settings,
  });
  devices.heartbeat(auth, policy(), { ceiling, settings, appliedRevision: 1 });
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
  const repository = new RepositoryCreationRepository(sqlite);
  const admission = new LocalRepositoryAdmissionService({
    devices,
    verifyAccount: async () => ({ githubUserId: "42", owner: "owner" }),
    verifyRepository: async (_user, repositoryId) => {
      const value = [...remote.values()].find((entry) => String(entry.id) === repositoryId)!;
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
  const acknowledge = () => {
    const current = devices.getActiveDevice("owner", deviceId).control!;
    devices.heartbeat(auth, policy(current.settings), {
      ceiling,
      settings: current.settings,
      appliedRevision: current.revision,
    });
  };
  return {
    devices,
    auth,
    settings,
    ceiling,
    policy,
    authority,
    remote,
    state,
    repository,
    admission,
    makeService,
    input,
    acknowledge,
    deviceId,
  };
}

describe("Private repository creation precedes local admission without repeating unknown effects", () => {
  test.each(["tenant", "device", "revoked", "account"])(
    "%s authority denial cannot reach repository POST",
    async (failure) => {
      const f = fixture();
      const userId = failure === "tenant" ? "other" : "owner";
      const input = failure === "device" ? { ...f.input, deviceId: randomUUID() } : f.input;
      if (failure === "revoked") f.devices.revokeOwned("owner", f.deviceId, 1);
      if (failure === "account") f.authority.githubUserId = "43";
      expect((await f.makeService().createRepository(userId, input)).status).toBe("setup_required");
      expect(f.state.posts).toBe(0);
      expect(f.repository.getOwned("owner", f.input.requestId)).toBeNull();
    },
  );
  test.each(["public", "malformed"] as const)(
    "%s provider success cannot confirm private identity or add a grant",
    async (mode) => {
      const f = fixture();
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
        f.devices.getActiveDevice("owner", f.deviceId).control!.repositoryAdmissions,
      ).toBeUndefined();
      expect(f.devices.getActiveDevice("owner", f.deviceId).policy.repositories).toEqual([]);
    },
  );
  test("two concurrent same-payload requests share one durable submitted claim and one POST", async () => {
    const f = fixture();
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
    expect((await first).status).toBe("pending");
    expect(f.state.posts).toBe(1);
  });
  test("private create and selected installation remain pending until companion ACK, then replay the same identity", async () => {
    const f = fixture();
    const pending = await f.makeService().createRepository("owner", f.input);
    expect(pending).toMatchObject({
      status: "pending",
      github_repository_id: "77",
      full_name: "owner/new-project",
      local_repository_id: null,
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
    expect(f.devices.getActiveDevice("owner", f.deviceId).policy.repositories).toEqual([]);
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("pending");
    f.acknowledge();
    const applied = await f.makeService().createRepository("owner", f.input);
    expect(applied.status).toBe("applied");
    expect(applied.local_repository_id).toMatch(/^local:/);
    expect(f.state.posts).toBe(1);
    expect(f.state.puts).toBe(1);
    expect(f.devices.getActiveDevice("owner", f.deviceId).deviceGeneration).toBe(1);
  });
  test("lost create response recovers only its exact marker after process reconstruction", async () => {
    const f = fixture();
    f.state.loseResponse = true;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("unknown");
    expect(f.repository.getOwned("owner", f.input.requestId)!.reservationHeld).toBe(1);
    f.state.loseResponse = false;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("pending");
    expect(f.state.posts).toBe(1);
    expect(f.state.puts).toBe(1);
  });
  test("same-name object without the persisted marker cannot resolve unknown or release its reservation", async () => {
    const f = fixture();
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
    const f = fixture();
    await f.makeService().createRepository("owner", f.input);
    await expect(
      f.makeService().createRepository("owner", { ...f.input, repositoryName: "changed" }),
    ).rejects.toThrow("identity changed");
    expect(f.state.posts).toBe(1);
  });
  test("installation setup preserves confirmed ID and continues without repeating create", async () => {
    const f = fixture();
    f.state.installationDenied = true;
    expect(await f.makeService().createRepository("owner", f.input)).toMatchObject({
      status: "setup_required",
      github_repository_id: "77",
      local_repository_id: null,
    });
    f.state.installationDenied = false;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("pending");
    expect(f.state.posts).toBe(1);
  });
  test("successful installation PUT alone never supplies local authority", async () => {
    const f = fixture();
    f.state.grantVisible = false;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe(
      "setup_required",
    );
    expect(
      f.devices.getActiveDevice("owner", f.deviceId).control!.repositoryAdmissions,
    ).toBeUndefined();
    f.state.grantVisible = true;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("pending");
    expect(f.state.posts).toBe(1);
  });
  test("requested new-private consent cannot reach POST", async () => {
    const f = fixture();
    f.devices.requestSettings("owner", f.deviceId, {
      expectedRevision: 1,
      expectedGeneration: 1,
      settings: {
        ...f.settings,
        agentRepositoryManagement: { ...f.settings.agentRepositoryManagement!, allowPush: false },
      },
    });
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe(
      "setup_required",
    );
    expect(f.state.posts).toBe(0);
    expect(f.repository.getOwned("owner", f.input.requestId)).toBeNull();
  });
  test("changed credentials during preflight cannot reach POST", async () => {
    const f = fixture();
    f.state.changedDuringInspection = true;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe(
      "setup_required",
    );
    expect(f.state.posts).toBe(0);
  });
  test("a reported work lease beyond the finite local contract cannot reach repository POST", async () => {
    const f = fixture();
    const unbounded = { ...f.settings, leaseUntil: now + MAX_LOCAL_WORK_LEASE_MS + 1 };
    f.devices.heartbeat(f.auth, f.policy(unbounded), {
      ceiling: f.ceiling,
      settings: unbounded,
      appliedRevision: 1,
    });
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe(
      "setup_required",
    );
    expect(f.state.posts).toBe(0);
    expect(f.repository.getOwned("owner", f.input.requestId)).toBeNull();
  });
  test("multiple unknown private creations retain independent identities without a repository quota", async () => {
    const f = fixture();
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
    const f = fixture();
    const both = {
      ...f.settings,
      agentRepositoryManagement: {
        ...f.settings.agentRepositoryManagement!,
        allowExistingPrivate: true,
      },
    };
    f.devices.requestSettings("owner", f.deviceId, {
      expectedRevision: 1,
      expectedGeneration: 1,
      settings: both,
    });
    f.devices.heartbeat(f.auth, f.policy(both), {
      ceiling: f.ceiling,
      settings: both,
      appliedRevision: 2,
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
    ).toBe("pending");
    f.acknowledge();
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
    ).resolves.toMatchObject({ status: "pending" });
  });
  test("more than 64 confirmed refusals do not consume future admission capacity", async () => {
    const f = fixture();
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
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("pending");
  });
  test("more than 64 existing grants admit another repository and preserve unknown creation provenance", async () => {
    const f = fixture();
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
    f.devices.requestSettings("owner", f.deviceId, {
      expectedRevision: 1,
      expectedGeneration: 1,
      settings: fullSettings,
    });
    f.devices.heartbeat(f.auth, f.policy(fullSettings), {
      ceiling: f.ceiling,
      settings: fullSettings,
      appliedRevision: 2,
    });
    const original = f.devices.getActiveDevice("owner", f.deviceId).policy;
    f.state.loseResponse = true;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("unknown");
    f.remote.set("unrelated", { id: 90, full_name: "owner/unrelated", private: true });
    await expect(
      f.admission.addExistingRepository("owner", {
        deviceId: f.deviceId,
        repositoryId: "90",
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "pending" });
    expect(f.devices.getActiveDevice("owner", f.deviceId).policy).toEqual(original);
    expect(f.repository.getOwned("owner", f.input.requestId)!.reservationHeld).toBe(1);
    f.acknowledge();
    f.state.loseResponse = false;
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("pending");
    expect(f.repository.getOwned("owner", f.input.requestId)!.reservationHeld).toBe(0);
    f.acknowledge();
    expect((await f.makeService().createRepository("owner", f.input)).status).toBe("applied");
    const completed = f.devices.getActiveDevice("owner", f.deviceId).policy;
    expect(completed.repositories).toHaveLength(67);
    expect(completed.repositories.slice(0, 65)).toEqual(original.repositories);
    expect(completed.repositories[66].fullName).toBe("owner/new-project");
    expect(completed.machine).toEqual(original.machine);
    expect(completed.leaseUntil).toBe(original.leaseUntil);
    expect(f.state.posts).toBe(1);
  });
  test("personal installation projection excludes organizations and stale connected accounts", async () => {
    const f = fixture();
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
