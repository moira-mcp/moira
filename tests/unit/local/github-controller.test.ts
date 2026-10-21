import { afterEach, expect, jest, test } from "@jest/globals";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRecords } from "../../../packages/local/src/space-record.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalRelay } from "../../../packages/local/src/relay.js";
import { LocalRefusal } from "../../../packages/local/src/policy.js";
import type {
  GitHubAssignment,
  GitHubProvisionProof,
  GitHubProviderAction,
} from "../../../packages/shared/src/codespaces/local-controller-protocol.js";
import { githubPreparedCreateSchema } from "../../../packages/shared/src/codespaces/local-controller-protocol.js";
import type {
  provisionGitHubWorkspace,
  resumeGitHubWorkspaceEnrollment,
} from "../../../packages/local/src/github-provisioner.js";
import {
  prepareProcessCustody,
  inspectProcessCustody,
} from "../../../packages/local/src/process-custody.js";

const bootstrap = await import("../../../packages/workspace-service/src/bootstrap.mjs");
const toolchain = await import("../../../packages/local/src/github-toolchain.js");
const tools = jest.fn<typeof toolchain.githubToolchain>();
const payload = jest.fn<typeof bootstrap.loadWorkspacePayload>();
jest.unstable_mockModule("../../../packages/local/src/github-toolchain.js", () => ({
  ...toolchain,
  githubToolchain: tools,
}));
jest.unstable_mockModule("../../../packages/workspace-service/src/bootstrap.mjs", () => ({
  ...bootstrap,
  loadWorkspacePayload: payload,
}));
const { githubProvisioningReadiness } =
  await import("../../../packages/local/src/github-provisioner.js");
const { LocalController } = await import("../../../packages/local/src/controller.js");

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-gh-controller-")));
  directories.push(root);
  const records = new LocalRecords(await PrivateState.open(root));
  const identity = {
    userId: "owner",
    deviceId: randomUUID(),
    deviceGeneration: 1,
    connectionId: randomUUID(),
  };
  await records.state.write("connection.json", {
    ...identity,
    label: "neutral controller",
    origin: "https://moira.example",
    credential: "d".repeat(43),
    pairingId: randomUUID(),
  });
  const requestId = `ws1-${randomUUID()}`,
    resourceId = requestId.slice(4);
  const assignment: GitHubAssignment = {
    resourceId,
    resourceGeneration: 1,
    authorizationGeneration: 3,
    repositoryId: "123",
    repositoryFullName: "owner/repository",
    requestedRef: "main",
    operationMarker: `moira-${"a".repeat(24)}`,
    providerResourceName: null,
    retirement: "uncreated",
    state: "unknown",
    desiredState: "running",
    environmentIdentity: null,
    pendingRequestIds: [],
    observedAt: null,
    providerResource: null,
    billableOwnerId: "101",
    creationSettings: { autoStopEnabled: false, idleTimeoutMinutes: 30, retentionMinutes: 1440 },
  };
  const machine = {
    name: "owner-choice",
    displayName: "Owner choice",
    operatingSystem: "linux",
    cpuCores: 2,
    memoryBytes: 4096,
    storageBytes: 8192,
  };
  let createJournal: unknown;
  let assignmentRefused = false;
  let measuredLife = "c".repeat(64);
  let enrollment: ((proof: GitHubProvisionProof) => Promise<void>) | undefined;
  const enrollments: GitHubProvisionProof[] = [];
  let physicalState = "available",
    createLost = false,
    providerFound = false,
    deleted = false,
    registrationPending = false;
  const calls: Array<{ action: string; generation: number; retirement?: string }> = [];
  const securityCalls: string[] = [],
    credentialId = randomUUID();
  const securityFetch: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    securityCalls.push(path);
    if (path.includes("/requests/"))
      return Response.json({
        state: "live",
        credential: {
          credentialId,
          token: "ghu_fixture_child",
          expiresAt: Date.now() + 3600000,
          useUntil: Date.now() + 3600000,
          repositoryFullName: assignment.repositoryFullName,
        },
      });
    if (path.endsWith("/release")) return Response.json({ released: true });
    throw new Error("Unexpected security fixture endpoint");
  };
  class Relay extends LocalRelay {
    override async githubAssignment(
      _id?: string,
      _signal?: AbortSignal,
      purpose?: "adopt" | "retire",
    ) {
      if (assignmentRefused)
        throw new LocalRefusal(
          "CODESPACE_AUTHORIZATION_REQUIRED",
          "Current remote authority was refused.",
        );
      if (purpose === "adopt" && providerFound)
        return {
          ...assignment,
          providerResourceName: "fixed-resource",
          retirement: "owned" as const,
          providerResource: {
            name: "fixed-resource",
            repositoryId: assignment.repositoryId,
            repositoryFullName: assignment.repositoryFullName,
            state: physicalState,
          },
        };
      return assignment;
    }
    override async registerGitHubResource(
      _id: string,
      input: {
        resourceGeneration: number;
        retirement: GitHubAssignment["retirement"];
        authorizationGeneration: number;
        providerResourceName: string | null;
      },
    ) {
      calls.push({
        action: "register",
        generation: input.resourceGeneration,
        retirement: input.retirement,
      });
      if (registrationPending) {
        registrationPending = false;
        throw new LocalRefusal(
          "SCOPED_CREDENTIAL_DISPOSAL_PENDING",
          "Original child disposal is pending.",
        );
      }
      assignment.resourceGeneration = input.resourceGeneration;
      assignment.retirement = input.retirement;
      assignment.authorizationGeneration = input.authorizationGeneration;
      assignment.providerResourceName = input.providerResourceName;
    }
    override async githubProvider(_id: string, input: GitHubProviderAction) {
      calls.push({ action: input.action, generation: input.resourceGeneration });
      if (input.action === "preflight") return { billableOwnerId: assignment.billableOwnerId };
      if (input.action === "machines") return [machine];
      if (input.action === "create")
        createJournal = await records.state.read(
          `controller-operation-${input.requestId}.json`,
          (value) => value,
        );
      if (input.action === "create" && createLost) {
        assignment.retirement = "unknown";
        throw new LocalRefusal("WORKSPACE_OUTCOME_UNCONFIRMED", "Unconfirmed provider result.");
      }
      if (input.action === "get" && createLost && !providerFound) return null;
      if (input.action === "stop") physicalState = "shutdown";
      if (input.action === "start") physicalState = "available";
      if (input.action === "delete") {
        deleted = true;
        return "accepted";
      }
      if (input.action === "get" && deleted) return null;
      if (input.action === "start" || input.action === "stop") return "accepted";
      const resource = {
        name: "fixed-resource",
        repositoryId: "123",
        repositoryFullName: assignment.repositoryFullName,
        state: physicalState,
      };
      return input.action === "create"
        ? {
            outcome: "accepted",
            resource,
            providerReply: { status: 201, githubRequestId: "ABCD:1234" },
          }
        : resource;
    }
    override async enrollGitHubWorkspace(_id: string, proof: GitHubProvisionProof) {
      enrollments.push(proof);
      await enrollment?.(proof);
      return {
        version: 1 as const,
        origin: "https://moira.example",
        publicOrigin: "https://moira.example",
        resourceId,
        resourceGeneration: proof.resourceGeneration,
        authorizationGeneration: proof.authorizationGeneration,
        environmentIdentity: proof.environmentIdentity,
        credential: "e".repeat(43),
      };
    }
  }
  const helper = join(root, "process-group-helper");
  const relay = new Relay(records, securityFetch, (witness) =>
      inspectProcessCustody(witness, helper),
    ),
    manager = new LocalManager(records);
  const immediate: typeof provisionGitHubWorkspace = async (target, dependencies) => {
    const { resourceId: _resource, previousRepositoryFullName: _previous, ...original } = target;
    const proof = {
      ...original,
      root: "/workspaces/repository",
      rootDevice: "1",
      rootInode: "2",
      release: "b".repeat(64),
      environmentIdentity: measuredLife,
    };
    await dependencies.prepared(proof);
    const health = {
      releaseIdentity: proof.release,
      environmentIdentity: proof.environmentIdentity,
      remote: { state: "enrollment_unavailable" as const },
    };
    await dependencies.ready(health);
    return { proof, health };
  };
  const resume: typeof resumeGitHubWorkspaceEnrollment = async (_target, proof, dependencies) => {
    await dependencies.ready({
      releaseIdentity: proof.release,
      environmentIdentity: proof.environmentIdentity,
      remote: { state: "enrollment_unavailable" },
    });
    await dependencies.enroll(proof);
    return {
      proof,
      health: {
        releaseIdentity: proof.release,
        environmentIdentity: proof.environmentIdentity,
        remote: { state: "connected" },
      },
    };
  };
  const make = (
    provision = immediate,
    ready: boolean | typeof githubProvisioningReadiness = true,
  ) =>
    new LocalController(manager, identity, undefined, undefined, {
      relay,
      provision,
      resume,
      readiness:
        typeof ready === "function"
          ? ready
          : async () => ({ state: ready ? ("available" as const) : ("unavailable" as const) }),
    });
  const create = {
    requestId,
    expectedGeneration: 1,
    action: "create",
    repositoryId: assignment.repositoryId,
    repositoryFullName: assignment.repositoryFullName,
    ref: assignment.requestedRef,
    operationMarker: assignment.operationMarker,
    authorizationGeneration: 3,
  };
  return {
    records,
    manager,
    identity,
    requestId,
    resourceId,
    make,
    create,
    calls,
    securityCalls,
    credentialId,
    helper,
    assignment,
    machine,
    createJournal: () => createJournal,
    enrollments,
    setEnrollment: (value: typeof enrollment) => {
      enrollment = value;
    },
    refuseAssignments: () => {
      assignmentRefused = true;
    },
    immediate,
    setLife: (life: string) => {
      measuredLife = life;
    },
    failRegistration: () => {
      registrationPending = true;
    },
    reauthorize: () => {
      assignment.authorizationGeneration = 4;
      assignment.repositoryFullName = "owner/renamed";
    },
    loseCreate: () => {
      createLost = true;
    },
    revealCreated: () => {
      providerFound = true;
    },
    uncreatedObservation: () => {
      assignment.retirement = "uncreated";
    },
    existingStopped: () => {
      assignment.providerResourceName = "fixed-resource";
      assignment.retirement = "owned";
      physicalState = "shutdown";
    },
  };
}

test("lost GitHub creation keeps its original owner receipt and cannot create again after restart", async () => {
  const f = await fixture();
  f.loseCreate();
  const controller = f.make();
  const receipt = await controller.githubLifecycle(f.resourceId, f.create);
  expect(receipt).toMatchObject({
    requestId: f.requestId,
    outcome: { ok: false, error: { code: "WORKSPACE_OUTCOME_UNCONFIRMED" } },
  });
  const restarted = f.make();
  expect(await restarted.githubLifecycle(f.resourceId, f.create)).toEqual(receipt);
  expect(f.calls.filter((call) => call.action === "create")).toHaveLength(1);
  expect(f.calls[0]).toMatchObject({ action: "register", retirement: "uncreated" });
  expect((await restarted.snapshot()).github.resources[0]).toMatchObject({
    resourceGeneration: 2,
    state: "unknown",
    pendingRequestIds: [f.requestId],
  });
  expect(await f.records.policyOrNull()).toBeNull();
  expect(await f.records.list()).toEqual([]);
});

test("owner saves its exact machine and account settings before provider dispatch and retains that choice after lost reply", async () => {
  const f = await fixture();
  f.loseCreate();
  const original = await f.make().githubLifecycle(f.resourceId, f.create);
  const prepared = githubPreparedCreateSchema.parse(
    (f.createJournal() as { preparedCreate: unknown }).preparedCreate,
  );
  expect(prepared).toEqual({ machine: f.machine, idleTimeoutMinutes: 240, retentionMinutes: 1440 });
  const bytes = await readFile(
    join(f.records.state.root, `controller-operation-${f.requestId}.json`),
  );
  f.assignment.creationSettings.retentionMinutes = 2880;
  f.machine.name = "changed-offer";
  expect(await f.make().collectOperation(f.requestId)).toEqual(original);
  expect(
    await readFile(join(f.records.state.root, `controller-operation-${f.requestId}.json`)),
  ).toEqual(bytes);
  expect(f.calls.filter((row) => row.action === "create")).toHaveLength(1);
  expect(f.createJournal()).toMatchObject({
    phase: { name: "provider_create", resourceGeneration: 2 },
  });
});

test("explicit setup resume keeps original proof without host payloads or provider lifecycle replay while new installation still requires payloads", async () => {
  const f = await fixture();
  tools.mockImplementation(async (home) => ({
    gh: join(home, "gh"),
    ssh: "/usr/bin/ssh",
    version: "2.102.0",
  }));
  payload.mockImplementation(async (_directory, architecture) => {
    if (architecture !== "x64" && architecture !== "arm64")
      throw new Error("Unexpected host payload architecture");
    return {
      version: 1,
      architecture,
      libc: "glibc",
      release: "b".repeat(64),
      archiveSha256: "a".repeat(64),
      fileName: "fixture.tar.gz",
      path: "/controlled-host-payload",
      size: 1,
      identity: { dev: 1, ino: 2, size: 1, mtimeMs: 0, ctimeMs: 0 },
    };
  });
  const controller = f.make(undefined, githubProvisioningReadiness);
  const created = await controller.githubLifecycle(f.resourceId, f.create);
  expect(created).toMatchObject({
    outcome: {
      ok: true,
      result: { state: "running", remote: { state: "enrollment_unavailable" } },
    },
  });
  const originalKey = `controller-operation-${f.requestId}.json`;
  const bytes = await readFile(join(f.records.state.root, originalKey));
  const proof = await controller.state.githubSetupProof(f.resourceId, f.identity);
  expect((await controller.state.githubBinding(f.resourceId, f.identity))?.setupRequestId).toBe(
    f.requestId,
  );
  expect((await controller.snapshot()).github.resources[0]).not.toHaveProperty("setupRequestId");
  expect((await controller.snapshot()).github.resources[0]).not.toHaveProperty("creationSettings");
  payload.mockRejectedValue(new Error("The current host payload is unavailable after upgrade"));
  const fresh = await fixture();
  await expect(
    fresh
      .make(undefined, githubProvisioningReadiness)
      .githubLifecycle(fresh.resourceId, fresh.create),
  ).rejects.toMatchObject({ code: "GITHUB_PROVISIONING_UNAVAILABLE" });
  expect(await fresh.records.state.keys("controller-operation-")).toEqual([]);
  expect(fresh.calls).toEqual([]);
  payload.mockClear();
  const requestId = `ws1-${randomUUID()}`;
  const resumed = await f
    .make(undefined, githubProvisioningReadiness)
    .githubLifecycle(f.resourceId, { action: "resume_setup", requestId, expectedGeneration: 2 });
  expect(resumed).toMatchObject({
    outcome: {
      ok: true,
      result: { resourceGeneration: 2, state: "running", remote: { state: "connected" } },
    },
  });
  expect(f.enrollments).toEqual([proof]);
  expect(payload).not.toHaveBeenCalled();
  expect(await readFile(join(f.records.state.root, originalKey))).toEqual(bytes);
  expect(
    f.calls.filter((row) => ["create", "start", "stop", "delete"].includes(row.action)),
  ).toEqual([{ action: "create", generation: 2 }]);
  expect(await controller.collectOperation(f.requestId)).toEqual(created);
});

test("authority changed during a held setup enrollment cannot publish late ready configuration", async () => {
  const f = await fixture();
  const controller = f.make();
  await controller.githubLifecycle(f.resourceId, f.create);
  let entered!: () => void, release!: () => void;
  const pending = new Promise<void>((yes) => {
    entered = yes;
  });
  const held = new Promise<void>((yes) => {
    release = yes;
  });
  f.setEnrollment(async () => {
    entered();
    await held;
  });
  const requestId = `ws1-${randomUUID()}`;
  const work = controller.githubLifecycle(f.resourceId, {
    action: "resume_setup",
    requestId,
    expectedGeneration: 2,
  });
  await pending;
  expect((await controller.snapshot()).github.resources[0]).toMatchObject({
    state: "running",
    remote: { state: "enrollment_unavailable" },
    pendingRequestIds: [requestId],
  });
  f.reauthorize();
  release();
  expect(await work).toMatchObject({
    outcome: { ok: false, error: { code: "LOCAL_IDENTITY_CHANGED" } },
  });
  expect((await controller.snapshot()).github.resources[0]).toMatchObject({
    resourceGeneration: 2,
    remote: { state: "enrollment_unavailable" },
  });
  expect(f.enrollments[0].requestId).toBe(f.requestId);
});

test("confirmed remote refusal after verified Unix readiness does not turn approved local work into failed setup", async () => {
  const f = await fixture();
  const provision: typeof provisionGitHubWorkspace = async (target, deps) => {
    const result = await f.immediate(target, deps);
    f.refuseAssignments();
    return {
      ...result,
      health: {
        ...(result.health as object),
        releaseIdentity: result.proof.release,
        environmentIdentity: result.proof.environmentIdentity,
        remote: { state: "refused" },
      },
    };
  };
  const result = await f.make(provision).githubLifecycle(f.resourceId, f.create);
  expect(result).toMatchObject({
    outcome: { ok: true, result: { state: "running", remote: { state: "refused" } } },
  });
  expect((await f.make().snapshot()).github.resources[0]).toMatchObject({
    state: "running",
    remote: { state: "refused" },
    environmentIdentity: "c".repeat(64),
  });
  expect(f.calls.filter((row) => ["stop", "delete"].includes(row.action))).toEqual([]);
});

test("a stopped known GitHub VM starts with a newly measured life without inheriting old verification", async () => {
  const f = await fixture();
  const controller = f.make();
  await controller.githubLifecycle(f.resourceId, f.create);
  const originalProof = await controller.state.githubSetupProof(f.resourceId, f.identity);
  const originalBytes = await readFile(
    join(f.records.state.root, `controller-operation-${f.requestId}.json`),
  );
  expect(
    await controller.githubLifecycle(f.resourceId, {
      requestId: `ws1-${randomUUID()}`,
      expectedGeneration: 2,
      action: "stop",
    }),
  ).toMatchObject({
    outcome: {
      ok: true,
      result: { state: "stopped", environmentIdentity: originalProof.environmentIdentity },
    },
  });
  f.setLife("d".repeat(64));
  const startId = `ws1-${randomUUID()}`;
  const started = await controller.githubLifecycle(f.resourceId, {
    requestId: startId,
    expectedGeneration: 3,
    action: "start",
  });
  expect(started).toMatchObject({
    outcome: {
      ok: true,
      result: {
        state: "running",
        resourceGeneration: 4,
        environmentIdentity: "d".repeat(64),
        remote: { state: "enrollment_unavailable" },
      },
    },
  });
  expect(await controller.state.githubSetupProof(f.resourceId, f.identity)).toMatchObject({
    requestId: startId,
    resourceGeneration: 4,
    environmentIdentity: "d".repeat(64),
  });
  expect(
    await readFile(join(f.records.state.root, `controller-operation-${f.requestId}.json`)),
  ).toEqual(originalBytes);
  expect(f.calls.filter((row) => row.action === "create")).toHaveLength(1);
  expect(f.calls.filter((row) => row.action === "start")).toEqual([
    { action: "start", generation: 4 },
  ]);
});

test("original lost-create collection observes only its exact VM and reports incomplete provisioning without replay", async () => {
  const f = await fixture();
  f.loseCreate();
  let provisioning = 0;
  const provision: typeof provisionGitHubWorkspace = async () => {
    provisioning++;
    throw Error("Collection must not provision");
  };
  const controller = f.make(provision);
  const original = await controller.githubLifecycle(f.resourceId, f.create);
  const restarted = f.make(provision);
  expect(await restarted.collectOperation(f.requestId)).toEqual(original);
  f.uncreatedObservation();
  expect(await restarted.collectOperation(f.requestId)).toEqual(original);
  f.revealCreated();
  const observed = await restarted.collectOperation(f.requestId);
  expect(observed).toMatchObject({
    requestId: f.requestId,
    state: "completed",
    outcome: { ok: false, error: { code: "GITHUB_PROVISIONING_INCOMPLETE" } },
  });
  expect((await restarted.snapshot()).github.resources[0]).toMatchObject({
    resourceId: f.resourceId,
    resourceGeneration: 2,
    providerResourceName: "fixed-resource",
    retirement: "owned",
    state: "provisioning",
    pendingRequestIds: [],
  });
  expect(
    await f.records.state.read(`controller-operation-${f.requestId}.json`, (value) => value),
  ).toMatchObject({ originalOutcome: original.outcome });
  const count = f.calls.length;
  expect(await restarted.collectOperation(f.requestId)).toEqual(observed);
  expect(f.calls).toHaveLength(count);
  expect(f.calls.filter((call) => call.action === "create")).toHaveLength(1);
  expect(f.calls.some((call) => ["start", "stop", "delete"].includes(call.action))).toBe(false);
  expect(provisioning).toBe(0);
});

test.each([
  {
    kind: "http",
    phase: "request",
    status: 502,
    githubRequestId: "ABCD:1234",
    reason: "Service unavailable",
  },
  {
    kind: "authority_changed",
    phase: "publication",
    status: 201,
    githubRequestId: "ABCD:1234",
    resource: {
      name: "accepted-before-revocation",
      repositoryId: "123",
      repositoryFullName: "owner/repository",
      ownerId: "10",
      billableOwnerId: "10",
    },
  },
])(
  "typed provider $kind evidence survives the original durable owner failure without authorizing a resource",
  async (providerFailure) => {
    const f = await fixture();
    const relay = new LocalRelay(f.records, async (url) =>
      new URL(String(url)).pathname.endsWith("/heartbeat")
        ? Response.json({ success: true, data: { ...f.identity, status: "active" } })
        : Response.json(
            {
              error: {
                code: "WORKSPACE_OUTCOME_UNCONFIRMED",
                providerFailure,
                message: "private diagnostics must not escape",
              },
            },
            { status: 503 },
          ),
    );
    const controller = f.make();
    const receipt = await controller.state.run(
      f.requestId,
      f.identity,
      { resourceId: f.resourceId },
      () =>
        relay.githubProvider(f.resourceId, {
          requestId: f.requestId,
          resourceGeneration: 2,
          action: "create",
          prepared: { machine: f.machine, idleTimeoutMinutes: 240, retentionMinutes: 1440 },
        }),
    );
    expect(receipt).toMatchObject({
      outcome: {
        ok: false,
        error: {
          code: "WORKSPACE_OUTCOME_UNCONFIRMED",
          providerFailure,
        },
      },
    });
    expect(await f.make().state.inspect(f.requestId, f.identity)).toEqual(receipt);
    expect(JSON.stringify(receipt)).not.toContain("private diagnostics");
    expect(JSON.stringify(receipt)).not.toContain("d".repeat(43));
    expect(await f.records.state.keys("controller-github-")).toEqual([]);
  },
);

test("unconfirmed native SSH custody fences stop/delete and survives owner restart without releasing physical custody", async () => {
  const f = await fixture();
  const uncertain: typeof provisionGitHubWorkspace = async () => {
    throw new LocalRefusal(
      "LOCAL_CUSTODY_UNCONFIRMED",
      "Native process group closure is unconfirmed.",
    );
  };
  const controller = f.make(uncertain);
  const original = await controller.githubLifecycle(f.resourceId, f.create);
  expect(original).toMatchObject({
    outcome: { ok: false, error: { code: "LOCAL_CUSTODY_UNCONFIRMED" } },
  });
  expect((await controller.snapshot()).github.resources[0]).toMatchObject({
    state: "unknown",
    pendingRequestIds: [f.requestId],
    retirement: "owned",
  });
  await expect(controller.stopProvisioning()).rejects.toMatchObject({
    code: "LOCAL_CUSTODY_UNCONFIRMED",
  });
  for (const owner of [controller, f.make()]) {
    await expect(
      owner.githubLifecycle(f.resourceId, {
        requestId: `ws1-${randomUUID()}`,
        expectedGeneration: 2,
        action: "stop",
      }),
    ).rejects.toMatchObject({ code: "LOCAL_CUSTODY_UNCONFIRMED" });
    await expect(
      owner.githubLifecycle(f.resourceId, {
        requestId: `ws1-${randomUUID()}`,
        expectedGeneration: 2,
        action: "delete",
      }),
    ).rejects.toMatchObject({ code: "LOCAL_CUSTODY_UNCONFIRMED" });
    expect(await owner.state.inspect(f.requestId, f.identity)).toEqual(original);
  }
  expect(f.calls.filter((call) => ["stop", "delete"].includes(call.action))).toEqual([]);
  expect(await f.records.state.keys("controller-operation-")).toHaveLength(1);
});

test("original collect observes a durable native terminal witness and disposes only its captured child without replaying SSH", async () => {
  const f = await fixture(),
    securityRequestId = `ws1-${randomUUID()}`;
  const providerFailure = {
    kind: "transport",
    phase: "body",
    cause: "request_failed",
    status: 200,
    githubRequestId: "ABCD:1234",
  };
  await promisify(execFile)(process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc", [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "packages/local/src/process-group-helper.c",
    "-o",
    f.helper,
  ]);
  let held: Awaited<ReturnType<typeof prepareProcessCustody>> | undefined;
  const interrupted: typeof provisionGitHubWorkspace = async (_target, dependencies) => {
    await f.records.state.write(`credential-request-${securityRequestId}.json`, {
      requestId: securityRequestId,
      credentialId: f.credentialId,
      resourceId: f.resourceId,
      resourceGeneration: 2,
      action: "codespaces_provision",
      state: "live",
    });
    held = await prepareProcessCustody({
      directory: dependencies.custody.directory,
      prepared: (witness) => dependencies.custody.prepared(witness, securityRequestId),
    });
    throw Object.assign(
      new LocalRefusal("LOCAL_CUSTODY_UNCONFIRMED", "Controlled native guardian outcome."),
      { providerFailure },
    );
  };
  const controller = f.make(interrupted);
  try {
    const original = await controller.githubLifecycle(f.resourceId, f.create);
    const restarted = f.make();
    expect(await restarted.collectOperation(f.requestId)).toEqual(original);
    expect(f.securityCalls).toEqual([]);
    if (!held) throw new Error("Native witness fixture was not journaled");
    // Controlled native terminal fixture: the owner only observes the original
    // inode. Actual group-settlement production is covered by the native suite.
    const bytes = Buffer.from(`settled:${held.witness.nonce}\n`);
    await held.handle.write(bytes, 0, bytes.length, 0);
    await held.handle.truncate(bytes.length);
    await held.handle.sync();
    await held.parent!.sync();
    expect(await inspectProcessCustody(held.witness, f.helper)).toBe("settled");
    const closed = await restarted.collectOperation(f.requestId);
    expect(closed).toMatchObject({
      requestId: f.requestId,
      state: "completed",
      outcome: {
        ok: false,
        error: { code: "GITHUB_PROVISIONING_INCOMPLETE", securityRequestId, providerFailure },
      },
    });
    expect(
      await f.records.state.read(`controller-operation-${f.requestId}.json`, (value) => value),
    ).toMatchObject({ originalOutcome: original.outcome });
    expect(f.securityCalls).toEqual([
      `/api/codespaces/github/credentials/requests/${securityRequestId}`,
      `/api/codespaces/github/credentials/${f.credentialId}/release`,
    ]);
    expect(await restarted.collectOperation(f.requestId)).toEqual(closed);
    expect(f.securityCalls).toHaveLength(2);
    expect(f.calls.filter((call) => call.action === "create")).toHaveLength(1);
    expect((await restarted.snapshot()).github.resources[0].pendingRequestIds).toEqual([]);
    expect(JSON.stringify(closed)).not.toContain(held.witness.path);
    expect(JSON.stringify(closed)).not.toContain("ghu_fixture_child");
  } finally {
    await held?.handle.close();
    await held?.parent?.close();
  }
});

test("explicit restored-grant adoption closes the found original creation before advancing owner CAS without replaying it", async () => {
  const f = await fixture();
  f.loseCreate();
  const controller = f.make(),
    original = await controller.githubLifecycle(f.resourceId, f.create);
  f.reauthorize();
  f.revealCreated();
  expect(await controller.collectOperation(f.requestId)).toEqual(original);
  expect(f.calls.filter((call) => call.action === "create")).toHaveLength(1);
  const adopted = await controller.githubLifecycle(f.resourceId, {
    requestId: `ws1-${randomUUID()}`,
    expectedGeneration: 2,
    action: "adopt",
  });
  expect(adopted).toMatchObject({
    outcome: {
      ok: true,
      result: {
        resourceGeneration: 3,
        authorizationGeneration: 4,
        providerResourceName: "fixed-resource",
      },
    },
  });
  const observed = await controller.collectOperation(f.requestId);
  expect(observed).toMatchObject({
    requestId: f.requestId,
    outcome: {
      ok: false,
      error: {
        code: "GITHUB_PROVISIONING_INCOMPLETE",
      },
    },
  });
  expect(
    await f.records.state.read(`controller-operation-${f.requestId}.json`, (value) => value),
  ).toMatchObject({ originalOutcome: original.outcome });
  expect((await controller.snapshot()).github.resources[0].pendingRequestIds).toEqual([]);
  expect(f.calls.filter((call) => call.action === "create")).toHaveLength(1);
});

test("explicit adoption refreshes verified current OAuth epoch and canonical repository before new provisioning", async () => {
  const f = await fixture(),
    controller = f.make();
  await controller.githubLifecycle(f.resourceId, f.create);
  f.reauthorize();
  const adopted = await controller.githubLifecycle(f.resourceId, {
    requestId: `ws1-${randomUUID()}`,
    expectedGeneration: 2,
    action: "adopt",
  });
  expect(adopted).toMatchObject({
    outcome: {
      ok: true,
      result: {
        authorizationGeneration: 4,
        repositoryId: "123",
        repositoryFullName: "owner/renamed",
        resourceGeneration: 3,
      },
    },
  });
  expect(f.calls.filter((call) => call.action === "create")).toHaveLength(1);
});

test("explicit adopt preserves owner CAS while the cloud fence lags after child retirement failure", async () => {
  const f = await fixture();
  f.existingStopped();
  f.failRegistration();
  const targets: Parameters<typeof provisionGitHubWorkspace>[0][] = [];
  const provision: typeof provisionGitHubWorkspace = async (target, dependencies) => {
    targets.push(target);
    return f.immediate(target, dependencies);
  };
  const controller = f.make(provision),
    originalId = `ws1-${randomUUID()}`;
  const refused = await controller.githubLifecycle(f.resourceId, {
    requestId: originalId,
    expectedGeneration: 1,
    action: "adopt",
  });
  expect(refused).toMatchObject({
    outcome: { ok: false, error: { code: "SCOPED_CREDENTIAL_DISPOSAL_PENDING" } },
  });
  expect((await controller.snapshot()).github.resources[0].resourceGeneration).toBe(2);
  expect(targets).toEqual([]);
  f.reauthorize();
  const recovered = await controller.githubLifecycle(f.resourceId, {
    requestId: `ws1-${randomUUID()}`,
    expectedGeneration: 2,
    action: "adopt",
  });
  expect(recovered).toMatchObject({
    outcome: {
      ok: true,
      result: { resourceGeneration: 3, authorizationGeneration: 4, repositoryId: "123" },
    },
  });
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatchObject({
    resourceId: f.resourceId,
    repositoryId: "123",
    repositoryFullName: "owner/renamed",
    previousRepositoryFullName: "owner/repository",
  });
  expect(f.calls.filter((call) => call.action === "create")).toEqual([]);
  expect(f.calls.filter((call) => call.action === "start")).toEqual([
    { action: "start", generation: 3 },
  ]);
  expect(
    await controller.githubLifecycle(f.resourceId, {
      requestId: originalId,
      expectedGeneration: 1,
      action: "adopt",
    }),
  ).toEqual(refused);
  expect(targets).toHaveLength(1);
});

test("missing trusted provisioning dependencies refuse before owner admission or any billable provider effect", async () => {
  const f = await fixture();
  await expect(
    f.make(undefined, false).githubLifecycle(f.resourceId, f.create),
  ).rejects.toMatchObject({ code: "GITHUB_PROVISIONING_UNAVAILABLE" });
  expect(await f.records.state.keys("controller-operation-")).toEqual([]);
  expect(await f.records.state.keys("controller-github-")).toEqual([]);
  expect(f.calls).toEqual([]);
  expect(await f.records.policyOrNull()).toBeNull();
});

test("explicit stop retires held provisioning before it can publish readiness; stale CAS cannot delete", async () => {
  const f = await fixture();
  let admitted!: () => void;
  const started = new Promise<void>((resolve) => {
    admitted = resolve;
  });
  let physicallyClosed = false;
  const held: typeof provisionGitHubWorkspace = async (_target, dependencies) => {
    admitted();
    await new Promise<void>((resolve) =>
      dependencies.signal!.addEventListener(
        "abort",
        () => {
          physicallyClosed = true;
          resolve();
        },
        { once: true },
      ),
    );
    throw new LocalRefusal("LOCAL_OPERATION_RETIRED", "Explicit stop retired provisioning.");
  };
  const controller = f.make(held);
  const creation = controller.githubLifecycle(f.resourceId, f.create);
  await started;
  const stopId = `ws1-${randomUUID()}`;
  const stopped = await controller.githubLifecycle(f.resourceId, {
    requestId: stopId,
    expectedGeneration: 2,
    action: "stop",
  });
  expect(physicallyClosed).toBe(true);
  expect(stopped).toMatchObject({ outcome: { ok: true } });
  await creation;
  expect((await controller.snapshot()).github.resources[0]).toMatchObject({
    resourceGeneration: 3,
    state: "stopped",
    desiredState: "stopped",
    pendingRequestIds: [],
  });
  const stale = await controller.githubLifecycle(f.resourceId, {
    requestId: `ws1-${randomUUID()}`,
    expectedGeneration: 2,
    action: "delete",
  });
  expect(stale).toMatchObject({
    outcome: { ok: false, error: { code: "LOCAL_GENERATION_CONFLICT" } },
  });
  expect(f.calls.filter((call) => call.action === "delete")).toHaveLength(0);
  expect(await controller.state.inspect(stopId, f.identity)).toEqual(stopped);
});

test("adopting an existing stopped GitHub VM journals one start and preserves its identity without Local capability", async () => {
  const f = await fixture();
  f.existingStopped();
  const controller = f.make(),
    requestId = `ws1-${randomUUID()}`;
  const input = { requestId, expectedGeneration: 1, action: "adopt" };
  const receipt = await controller.githubLifecycle(f.resourceId, input);
  expect(receipt).toMatchObject({
    outcome: {
      ok: true,
      result: { providerResourceName: "fixed-resource", state: "running", resourceGeneration: 2 },
    },
  });
  expect(f.calls.filter((call) => call.action === "start")).toEqual([
    { action: "start", generation: 2 },
  ]);
  expect(f.calls.filter((call) => call.action === "create")).toEqual([]);
  expect(
    await f.records.state.read(`controller-operation-${requestId}.json`, (value) => value),
  ).toMatchObject({ state: "completed", phase: { name: "provision", resourceGeneration: 2 } });
  expect(await f.make().githubLifecycle(f.resourceId, input)).toEqual(receipt);
  expect(f.calls.filter((call) => call.action === "start")).toHaveLength(1);
  expect(await f.records.policyOrNull()).toBeNull();
  expect(await f.records.list()).toEqual([]);
});
