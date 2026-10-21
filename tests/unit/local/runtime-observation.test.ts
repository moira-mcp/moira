import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mkdir, mkdtemp, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeDeviceOwner } from "../../../packages/local/src/runtime-device-owner.js";
import { RuntimeOwner } from "../../../packages/local/src/runtime-owner.js";
import { DeviceRuntimeControl } from "../../../packages/local/src/runtime-control.js";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRefusal, SUPPORTED_SBX_VERSION } from "../../../packages/local/src/policy.js";
import { runtimeApiAsset } from "../../../packages/local/src/assets.js";
import type { ProcessRequest, RunProcess } from "../../../packages/local/src/process.js";
import { localFixture } from "../../integration/local/fixtures.js";
import { SbxRuntime } from "../../../packages/local/src/sbx-runtime.js";
import { createHash } from "node:crypto";
import type { LocalVmRuntime } from "../../../packages/local/src/local-vm-runtime.js";
import type { GuestAssets } from "../../../packages/local/src/assets.js";
import { LocalRelay } from "../../../packages/local/src/relay.js";

function pending<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

/** Portable runtime boundary; state and owner admission use their production implementations. */
async function preparationFixture() {
  const f = await localFixture(await PrivateState.open(root));
  Object.assign(f.space, {
    phase: "failed",
    lastStartedAt: null,
    desiredState: "stopped",
    failure: "LOCAL_SETUP_INCOMPLETE",
    networkPolicy: createHash("sha256").update("[]").digest("hex"),
    admittedMachine: {
      cpuCores: 1,
      memoryBytes: f.policy.runtime.memoryBytes,
      dockerBytes: f.policy.runtime.dockerBytes,
    },
  });
  await f.records.put(f.space);
  await f.records.state.write("broker.json", { port: 42500 });
  let status: "running" | "stopped" = "stopped";
  let remote = { state: "unconfigured" };
  let life = "e".repeat(64);
  let configuration: Record<string, unknown> | undefined;
  let serving = false;
  const configured: Record<string, unknown>[] = [];
  const runtime: LocalVmRuntime = {
    boundary: {
      verifyConfiguration: async () => undefined,
      verify: async () => undefined,
      configureNetwork: async () => "a".repeat(64),
    },
    list: async () => [{ id: f.space.runtimeId!, name: f.space.name, status }],
    inspectExact: async () => ({ id: f.space.runtimeId!, name: f.space.name, status }),
    create: async () => {
      throw new Error("Same-VM preparation must not create");
    },
    start: async () => {
      status = "running";
    },
    stop: async () => {
      status = "stopped";
      serving = false;
    },
    remove: async () => {
      throw new Error("Preparation must not delete");
    },
    runFixedGuest: async (_identity, entrypoint, input) => {
      if (entrypoint === "probe")
        return Buffer.from(JSON.stringify({ environmentIdentity: life, architecture: "aarch64" }));
      if (entrypoint === "bootstrap") return Buffer.from(JSON.stringify({ ok: true, result: {} }));
      if (entrypoint === "configure") {
        const config = JSON.parse(Buffer.from(input as Uint8Array).toString()) as Record<
          string,
          unknown
        >;
        configured.push(config);
        configuration = config;
        remote = { state: config.remote ? "connected" : String(config.remoteState) };
      }
      // The Local daemon cannot renew its fixed proxy binding after a cold
      // guest life change; the host must configure that life before startup.
      if (entrypoint === "start-service") {
        if (configuration?.environmentIdentity !== life)
          throw new LocalRefusal(
            "LOCAL_GUEST_FAILED",
            "Local workspace life changed; refresh the fixed binding.",
          );
        serving = true;
      }
      if (entrypoint === "health")
        if (!serving || configuration?.environmentIdentity !== life)
          throw new LocalRefusal("LOCAL_GUEST_FAILED", "No current Unix owner.");
      if (entrypoint === "health")
        return Buffer.from(
          JSON.stringify({
            environmentIdentity: life,
            releaseIdentity: "f".repeat(64),
            remote,
          }),
        );
      return Buffer.alloc(0);
    },
  };
  jest.spyOn(SbxRuntime.prototype, "verifySettings").mockResolvedValue(undefined);
  jest.spyOn(SbxRuntime.prototype, "verifyBoundary").mockResolvedValue(undefined);
  jest.spyOn(SbxRuntime.prototype, "networkPolicy").mockResolvedValue(Buffer.from("[]"));
  jest.spyOn(SbxRuntime.prototype, "start").mockImplementation(runtime.start);
  jest.spyOn(SbxRuntime.prototype, "stop").mockImplementation(runtime.stop);
  jest.spyOn(SbxRuntime.prototype, "exact").mockImplementation(async () => ({
    id: f.space.runtimeId!,
    name: f.space.name,
    agent: "shell",
    status,
  }));
  jest.spyOn(SbxRuntime.prototype, "runFixedGuest").mockImplementation(runtime.runFixedGuest);
  const assets = { proxy: "fixture", payload: { release: "f".repeat(64) } } as GuestAssets;
  const owner = new RuntimeOwner(
    f.records,
    f.space.id,
    async () => undefined,
    async () => undefined,
    async () => assets,
  );
  return {
    ...f,
    owner,
    configured,
    runtime,
    setLife(value: string) {
      life = value;
    },
    configuration: () => configuration,
  };
}

test.each(["same-life", "cold-life"] as const)(
  "same-release %s preparation preserves the VM and selects the correct Local binding",
  async (mode) => {
    const f = await preparationFixture();
    jest
      .spyOn(LocalRelay.prototype, "workspaceCredential")
      .mockResolvedValue({ origin: "https://workspace.invalid", credential: "fixture" } as Awaited<
        ReturnType<LocalRelay["workspaceCredential"]>
      >);
    await f.owner.admit("resume-setup");
    await f.owner.prepare();
    await f.owner.refreshRemote();
    const prior = (await f.records.get(f.space.id))!;
    expect(prior).toMatchObject({ phase: "usable", remote: { state: "connected" } });
    const configuration = JSON.stringify(f.configuration());
    if (mode === "cold-life") {
      await f.owner.stop();
      f.setLife("d".repeat(64));
    } else await f.owner.release();
    const next = new RuntimeOwner(
      f.records,
      f.space.id,
      async () => undefined,
      async () => undefined,
      async () => ({ proxy: "fixture", payload: { release: "f".repeat(64) } }) as GuestAssets,
    );
    try {
      await next.admit(mode === "cold-life");
      await next.prepare();
      const ready = (await f.records.get(f.space.id))!;
      expect(ready).toMatchObject({
        runtimeId: prior.runtimeId,
        operationMarker: prior.operationMarker,
        phase: "usable",
        failure: null,
        remote: { state: mode === "cold-life" ? "unconfigured" : "connected" },
      });
      if (mode === "same-life") expect(JSON.stringify(f.configuration())).toBe(configuration);
      else
        expect(f.configuration()).toMatchObject({
          environmentIdentity: "d".repeat(64),
          mode: "local-only",
        });
    } finally {
      await next.release();
    }
  },
);

test("local preparation becomes usable without waiting for optional workspace enrollment", async () => {
  const f = await preparationFixture();
  f.policy.repositories[0].allowPush = true;
  f.policy.repositories[0].allowPullRequests = true;
  await f.records.state.write("policy.json", f.policy);
  await f.records.state.write("connection.json", {
    origin: "https://workspace.invalid",
    deviceId: f.policy.deviceId,
    credential: "f".repeat(43),
    pairingId: randomUUID(),
  });
  const entered = pending();
  const author = pending<{ name: string; email: string }>();
  jest.spyOn(LocalRelay.prototype, "gitIdentity").mockImplementation(async () => {
    entered.resolve();
    return author.promise;
  });
  const credential = pending<Awaited<ReturnType<LocalRelay["workspaceCredential"]>>>();
  jest.spyOn(LocalRelay.prototype, "workspaceCredential").mockImplementation(async () => {
    entered.resolve();
    return credential.promise;
  });
  await f.owner.admit("resume-setup");
  const preparing = f.owner.prepare();
  try {
    expect(
      await Promise.race([preparing.then(() => "ready"), entered.promise.then(() => "cloud")]),
    ).toBe("ready");
    expect(await f.records.get(f.space.id)).toMatchObject({
      phase: "usable",
      failure: null,
      remote: { state: "unconfigured" },
    });
  } finally {
    author.resolve({ name: "Fixture", email: "fixture@example.invalid" });
    credential.resolve({ origin: "https://workspace.invalid", credential: "fixture" } as Awaited<
      ReturnType<LocalRelay["workspaceCredential"]>
    >);
    await preparing.catch(() => undefined);
    await f.owner.release();
  }
});

test("custody acknowledgement of interrupted initial setup preserves incompleteness and resumes the same VM", async () => {
  const f = await preparationFixture();
  const original = Buffer.from('{"state":"unconfirmed","request":"original-create"}');
  await writeFile(join(root, "original-create.json"), original);
  await f.records.put({ ...f.space, failure: "LOCAL_GUEST_SETTLEMENT_UNKNOWN" });
  await f.owner.recover(1);
  const recovered = (await f.records.get(f.space.id))!;
  expect(recovered).toMatchObject({
    runtimeId: f.space.runtimeId,
    lastStartedAt: null,
    phase: "failed",
    failure: "LOCAL_SETUP_INCOMPLETE",
    generation: 2,
  });
  const next = new RuntimeOwner(
    f.records,
    f.space.id,
    async () => undefined,
    async () => undefined,
    async () => ({ proxy: "fixture", payload: { release: "f".repeat(64) } }) as GuestAssets,
  );
  await next.admit("resume-setup");
  await next.prepare();
  expect(await f.records.get(f.space.id)).toMatchObject({
    runtimeId: f.space.runtimeId,
    operationMarker: f.space.operationMarker,
    phase: "usable",
    generation: 3,
    failure: null,
  });
  expect(await readFile(join(root, "original-create.json"))).toEqual(original);
  await next.release();
});

test.each(["complete", "generation", "authority", "revocation", "stop", "release"] as const)(
  "held workspace enrollment leaves validation free and fences %s completion",
  async (change) => {
    const f = await preparationFixture();
    await f.owner.admit("resume-setup");
    await f.owner.prepare();
    const entered = pending();
    const credential = pending<Awaited<ReturnType<LocalRelay["workspaceCredential"]>>>();
    const connection = {
      origin: "https://workspace.invalid",
      deviceId: f.policy.deviceId,
      credential: "f".repeat(43),
      pairingId: randomUUID(),
      userId: randomUUID(),
      deviceGeneration: 1,
      connectionId: randomUUID(),
    };
    await f.records.state.write("connection.json", connection);
    const network = jest
      .spyOn(LocalRelay.prototype, "workspaceCredential")
      .mockImplementation(async () => {
        entered.resolve();
        return credential.promise;
      });
    const refreshing = f.owner.refreshRemote();
    const outcome = refreshing.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    await entered.promise;
    // This must settle while the authority response is still held. The normal
    // test watchdog detects a lane held across the external await.
    await f.owner.validate();
    expect(f.owner.refreshRemote()).toBe(refreshing);
    const before = (await f.records.get(f.space.id))!;
    const configurations = f.configured.length;
    if (change === "generation")
      await f.records.put({ ...before, generation: before.generation + 1 });
    if (change === "authority")
      await f.records.state.write("connection.json", {
        origin: "https://workspace.invalid",
        deviceId: f.policy.deviceId,
        credential: "r".repeat(43),
        pairingId: randomUUID(),
        userId: randomUUID(),
        deviceGeneration: 2,
        connectionId: randomUUID(),
      });
    if (change === "revocation")
      await f.records.state.write("connection.json", { ...connection, authorityRefused: true });
    if (change === "stop") {
      await f.owner.stop();
      expect(await f.records.get(f.space.id)).toMatchObject({
        desiredState: "stopped",
        phase: "stopped",
      });
    }
    if (change === "release") {
      await f.owner.release();
      expect(await f.records.get(f.space.id)).toMatchObject({
        desiredState: "running",
        phase: "usable",
      });
    }
    credential.resolve({ origin: "https://workspace.invalid", credential: "fixture" } as Awaited<
      ReturnType<LocalRelay["workspaceCredential"]>
    >);
    const result = await outcome;
    if (change === "complete") {
      expect(result).toEqual({ ok: true });
      expect(await f.records.get(f.space.id)).toMatchObject({
        runtimeId: f.space.runtimeId,
        phase: "usable",
        remote: { state: "connected" },
      });
    } else {
      expect(result).toMatchObject({
        ok: false,
        error: {
          code:
            change === "generation"
              ? "LOCAL_GENERATION_CONFLICT"
              : change === "authority" || change === "revocation"
                ? "LOCAL_IDENTITY_CHANGED"
                : "LOCAL_NOT_RUNNING",
        },
      });
      expect(f.configured).toHaveLength(configurations);
    }
    expect(network).toHaveBeenCalledTimes(1);
    await f.owner.release();
  },
);

test("a warm push-enabled repository uses its bound Git author without waiting for cloud identity", async () => {
  const f = await preparationFixture();
  f.policy.repositories[0].allowPush = true;
  await f.records.state.write("policy.json", f.policy);
  const ready = { ...f.space, phase: "stopped" as const, failure: null, lastStartedAt: Date.now() };
  await f.records.put(ready);
  await f.records.state.write(`controller-git-identity-${ready.id}.json`, {
    repositoryId: ready.repositoryId,
    runtimeId: ready.runtimeId,
    author: { name: "Retained", email: "retained@example.invalid" },
  });
  // Valid local connection metadata makes the old warm path attempt remote identity.
  await f.records.state.write("connection.json", {
    origin: "https://workspace.invalid",
    deviceId: f.policy.deviceId,
    credential: "f".repeat(43),
    pairingId: randomUUID(),
  });
  const cloud = pending();
  const response = pending<{ name: string; email: string }>();
  jest.spyOn(LocalRelay.prototype, "gitIdentity").mockImplementation(async () => {
    cloud.resolve();
    return response.promise;
  });
  await f.owner.admit(true);
  const preparing = f.owner.prepare();
  try {
    expect(
      await Promise.race([preparing.then(() => "ready"), cloud.promise.then(() => "cloud")]),
    ).toBe("ready");
    expect(await f.records.get(ready.id)).toMatchObject({
      phase: "usable",
      failure: null,
      runtimeId: ready.runtimeId,
    });
  } finally {
    response.resolve({ name: "Retained", email: "retained@example.invalid" });
    await preparing.catch(() => undefined);
    await f.owner.release();
  }
});

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-observation-")));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const result = (value: unknown) => ({
  exitCode: 0,
  stdout: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
  stderr: Buffer.alloc(0),
});
async function fixture() {
  const state = await PrivateState.open(root);
  const f = await localFixture(state);
  f.policy.runtime.binary = join(root, "sdk-fixture");
  await writeFile(f.policy.runtime.binary, "never executed", { mode: 0o700 });
  await state.write("policy.json", f.policy);
  f.space.runtimeId = randomUUID();
  await f.records.put(f.space);
  let held = true,
    inventoryAvailable = true;
  jest.spyOn(DeviceRuntimeControl.prototype, "assertDockerHeld").mockImplementation(async () => {
    if (!held) throw new LocalRefusal("LOCAL_CONTROL_RETIRED", "Fixture custody retired.");
  });
  jest.spyOn(DeviceRuntimeControl.prototype, "protect").mockImplementation(async () => {
    if (!held) throw new LocalRefusal("LOCAL_CONTROL_RETIRED", "Fixture custody retired.");
    if (!inventoryAvailable)
      throw new LocalRefusal("LOCAL_OBSERVATION_UNKNOWN", "Other inventory unavailable.");
  });
  const calls: ProcessRequest[] = [];
  let onRead: (() => Promise<void>) | undefined;
  const execute: RunProcess = async (request) => {
    calls.push(request);
    await onRead?.();
    const args = request.argv;
    if (request.binary === process.execPath && args[3] === "container-identity")
      return result({ containerId: "c".repeat(64), name: f.space.name, state: "exited" });
    if (args[0] === "version") return result(`sbx version: v${SUPPORTED_SBX_VERSION} fixture`);
    if (args[0] === "ls")
      return result({
        sandboxes: [
          {
            id: f.space.runtimeId,
            name: f.space.name,
            agent: "shell",
            status: "stopped",
          },
        ],
      });
    if (args[0] === "daemon")
      return result({
        status: "running",
        socket: join(
          device.runtime.home,
          ".sbx",
          `run_${device.runtime.environment.DOCKER_SANDBOXES_APP_NAME}`,
          "d",
          "sandboxd.sock",
        ),
      });
    if (args[0] === "inspect")
      return result({
        name: f.space.name,
        agent: "shell",
        image: f.policy.runtime.template,
        image_digest: f.policy.runtime.template.split("@")[1],
        cpus: f.policy.runtime.cpuCores,
        memory: `${f.policy.runtime.memoryBytes / 1024 ** 2}m`,
        network: f.space.name,
        runtime_mounts: [],
        daemon_version: `v${SUPPORTED_SBX_VERSION}`,
        kits: [],
        mcp_gateway: false,
        network_policy: {},
      });
    throw new Error("Unexpected fixture runtime invocation");
  };
  const device = new RuntimeDeviceOwner(f.records, f.policy, "work", execute);
  device.runtime.prepareCredentials = async () => undefined;
  await mkdir(
    join(
      device.runtime.home,
      ".sbx",
      `run_${device.runtime.environment.DOCKER_SANDBOXES_APP_NAME}`,
      "d",
    ),
    { recursive: true, mode: 0o700 },
  );
  const metadata = (argv: string[]): ProcessRequest => ({
    binary: f.policy.runtime.binary,
    argv,
    cwd: device.runtime.home,
    env: device.runtime.environment,
    timeoutMs: 1000,
    maxBytes: 8192,
  });
  return {
    ...f,
    state,
    device,
    calls,
    metadata,
    setHeld: (value: boolean) => {
      held = value;
    },
    setInventoryAvailable: (value: boolean) => {
      inventoryAvailable = value;
    },
    afterRead: (callback: () => Promise<void>) => {
      onRead = callback;
    },
  };
}

test("fixed metadata stays observable while unrelated inventory cannot be refreshed", async () => {
  const f = await fixture();
  f.setInventoryAvailable(false);
  const observed = await f.device.readRuntime(f.space, f.metadata(["version"]));
  expect(observed?.stdout.toString()).toContain(`v${SUPPORTED_SBX_VERSION}`);
  // This is an observed result under unavailable inventory, not just fewer subprocesses.
  expect(f.calls.map((call) => call.argv)).toEqual([["version"]]);
});

test.each(["grant", "generation", "custody"] as const)(
  "a %s change during metadata observation prevents returning it as current evidence",
  async (change) => {
    const f = await fixture();
    f.afterRead(async () => {
      if (change === "grant") await f.state.write("policy.json", { ...f.policy, repositories: [] });
      if (change === "generation")
        await f.records.put({ ...f.space, generation: f.space.generation + 1 });
      if (change === "custody") f.setHeld(false);
    });
    await expect(f.device.readRuntime(f.space, f.metadata(["version"]))).rejects.toMatchObject({
      code:
        change === "grant"
          ? "LOCAL_REPOSITORY_DENIED"
          : change === "generation"
            ? "LOCAL_GENERATION_CONFLICT"
            : "LOCAL_CONTROL_RETIRED",
    });
  },
);

test("observation custody does not admit another VM, an input payload, or a runtime effect", async () => {
  const f = await fixture();
  for (const request of [
    f.metadata(["inspect", "--json", `moira-${"f".repeat(32)}`]),
    { ...f.metadata(["version"]), stdin: Buffer.from("input") },
    f.metadata(["policy", "allow", "network", "**"]),
    {
      ...f.metadata([]),
      binary: process.execPath,
      argv: [
        runtimeApiAsset(),
        f.device.runtime.home,
        f.device.runtime.environment.DOCKER_SANDBOXES_APP_NAME,
        f.space.name,
        "absent",
      ],
    },
  ])
    expect(await f.device.readRuntime(f.space, request)).toBeUndefined();
  expect(f.calls).toEqual([]);
});

test.each(["grant", "generation", "custody"] as const)(
  "a %s change after the last metadata read still fences actual VM start",
  async (change) => {
    const f = await fixture();
    const owner = new RuntimeOwner(
      f.records,
      f.space.id,
      (closure) => f.device.protect(f.space.id, closure),
      async () => undefined,
      undefined,
      async (space, request) => {
        const observed = await f.device.readRuntime(space, request);
        if (request.argv[0] === "inspect" && observed) {
          if (change === "grant")
            await f.state.write("policy.json", { ...f.policy, repositories: [] });
          if (change === "generation")
            await f.records.put({ ...f.space, generation: f.space.generation + 1 });
          if (change === "custody") f.setHeld(false);
        }
        return observed;
      },
    );
    await owner.admit();
    await expect(owner.prepare()).rejects.toMatchObject({
      code:
        change === "grant"
          ? "LOCAL_REPOSITORY_DENIED"
          : change === "generation"
            ? "LOCAL_GENERATION_CONFLICT"
            : "LOCAL_CONTROL_RETIRED",
    });
    expect(f.calls.some((call) => call.argv[0] === "inspect")).toBe(true);
    expect(
      f.calls.every(
        (call) => call.binary === f.policy.runtime.binary || call.argv[3] === "container-identity",
      ),
    ).toBe(true);
  },
);
