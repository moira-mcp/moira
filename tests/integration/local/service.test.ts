import { afterEach, expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as nextTurn } from "node:timers/promises";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRecords } from "../../../packages/local/src/space-record.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalDaemon } from "../../../packages/local/src/daemon.js";
import { LocalRefusal, localRuntimeProfileHash } from "../../../packages/local/src/policy.js";
import { LocalRelay, LocalDeviceAuthorityFailure } from "../../../packages/local/src/relay.js";
import {
  startLocalController,
  controllerRequest,
  LocalController,
} from "../../../packages/local/src/controller.js";
import { runProcess } from "../../../packages/local/src/process.js";
import {
  runLocalService,
  serviceRequest,
  collectServiceMaintenance,
  serviceFailure,
} from "../../../packages/local/src/service.js";
import { localFixture } from "./fixtures.js";

const release = "a".repeat(64),
  staged = "b".repeat(64);
const requestId = () => `ws1-${randomUUID()}`;
const cleanups = new Set<() => Promise<void>>();
afterEach(async () => {
  for (const cleanup of cleanups) await cleanup();
});

async function fixture(
  failStop = false,
  retained?: {
    requestId: string;
    phase: "settled" | "unconfirmed" | "selected" | "settling" | "resuming";
    pause?: true;
  },
  failOpen = false,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-service-")));
  const state = await PrivateState.open(root);
  const local = await localFixture(state);
  if (retained) {
    await local.records.put({
      ...local.space,
      desiredState: retained.phase === "selected" ? "running" : "stopped",
      phase: "stopped",
      generation: retained.phase === "selected" ? 3 : 2,
    });
    await state.write(`service-maintenance-${retained.requestId}.json`, {
      requestId: retained.requestId,
      release: retained.pause ? release : staged,
      phase: retained.phase,
      ...(retained.pause ? { pause: true } : {}),
      running: [
        {
          id: local.space.id,
          runtimeId: local.space.runtimeId,
          operationMarker: local.space.operationMarker,
          generation: local.space.generation,
        },
      ],
      interruption: true,
      priorCommandsReplayed: false,
    });
  }
  const abort = new AbortController();
  let unlock: (() => Promise<void>) | undefined;
  let active = retained?.phase === "selected" ? staged : release;
  let closed = false;
  const manager = {
    records: local.records,
    holdRunnerLock: async () => {
      if (unlock) return;
      unlock = await state.lock({ recoverStale: true });
    },
    open: async () => {
      if (failOpen)
        throw new LocalRefusal("LOCAL_DOCKER_LOGIN_REQUIRED", "Private fixture diagnostic");
      if (retained && retained.phase !== "selected")
        throw new Error("Pending maintenance admitted physical work");
    },
    restoreIntendedWork: async () => ({ restored: [local.space.id], unavailable: [] }),
    release: async () => {
      await unlock?.();
      unlock = undefined;
    },
    close: async (keepLock = false) => {
      if (!keepLock) {
        await unlock?.();
        unlock = undefined;
      }
    },
  } as unknown as LocalManager;
  const daemon = {
    status: { controlPlane: "offline", code: null },
    prepareMaintenance: async () => undefined,
    run: async (signal: AbortSignal, physicalStop: () => boolean, keepLock = false) => {
      await new Promise<void>((done) => {
        signal.addEventListener("abort", () => done(), { once: true });
        if (signal.aborted) done();
      });
      if (physicalStop()) {
        if (failStop)
          throw new LocalRefusal(
            "LOCAL_STOP_PENDING",
            "Controlled physical settlement remains unknown.",
          );
        const original = (await local.records.get(local.space.id))!;
        await local.records.put({
          ...original,
          desiredState: "stopped",
          phase: "stopped",
          generation: original.generation + 1,
        });
        await manager.close(keepLock);
      } else await manager.release();
    },
  } as unknown as LocalDaemon;
  const running = runLocalService(
    local.records,
    retained?.phase === "selected" ? staged : release,
    {
      manager,
      daemon,
      signal: abort.signal,
      installation: async () => ({ active, staged, launcher: join(root, "launch") }),
      promote: async (_state, target) => {
        active = target;
      },
      settle: async () => {
        if (retained && ["unconfirmed", "settling", "resuming"].includes(retained.phase))
          throw new Error("The original unknown physical stop was repeated");
        expect(await local.records.get(local.space.id)).toMatchObject({
          desiredState: "stopped",
          phase: "stopped",
          generation: 2,
        });
      },
    },
  );
  // Observe the actual socket; the runner watchdog, not a scheduling sleep, bounds failure.
  const observe = async () => {
    for (;;) {
      try {
        return await serviceRequest(state);
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
        await Promise.race([
          nextTurn(),
          running.then(() => {
            throw new Error("Owner exited before its endpoint opened");
          }),
        ]);
      }
    }
  };
  if (failOpen) {
    while (!((await observe()) as { failure: unknown }).failure) await nextTurn();
  } else if (retained && retained.phase !== "selected") await observe();
  else while (!((await observe()) as { ready: boolean }).ready) await nextTurn();
  const close = async () => {
    if (closed) return;
    closed = true;
    abort.abort();
    await running.catch(() => undefined);
    await manager.release();
    await rm((await state.ipcDirectory()).root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  };
  return {
    ...local,
    state,
    manager,
    daemon,
    abort,
    running,
    observe,
    close,
    get active() {
      return active;
    },
  };
}

test("a real CLI observer exits while the original owner endpoint and running intent remain", async () => {
  const f = await fixture();
  try {
    const before = await f.observe();
    const observed = await runProcess({
      binary: process.execPath,
      argv: [resolve("packages/local/dist/cli.js"), "service-status", "--state", f.state.root],
      cwd: f.state.root,
      env: {},
      timeoutMs: 15000,
      maxBytes: 65536,
    });
    expect(observed.exitCode).toBe(0);
    expect(JSON.parse(observed.stdout.toString())).toMatchObject({
      processId: process.pid,
      release,
    });
    expect(await f.observe()).toEqual(before);
    expect(await f.records.get(f.space.id)).toEqual(f.space);
    await expect(
      runLocalService(f.records, staged, { manager: f.manager, daemon: f.daemon }),
    ).rejects.toMatchObject({ code: "LOCAL_ALREADY_RUNNING" });
    expect(await f.observe()).toEqual(before);
  } finally {
    await f.close();
  }
});

test("a Local startup prerequisite failure remains inspectable and releases the standalone management gate", async () => {
  const f = await fixture(false, undefined, true);
  try {
    expect(await f.observe()).toMatchObject({
      ready: false,
      release,
      failure: { code: "LOCAL_DOCKER_LOGIN_REQUIRED" },
    });
    expect(JSON.stringify(await serviceFailure(f.state))).not.toContain(
      "Private fixture diagnostic",
    );
    const unlock = await f.state.lock({ recoverStale: true });
    try {
      expect(await f.observe()).toMatchObject({
        ready: false,
        failure: { code: "LOCAL_DOCKER_LOGIN_REQUIRED" },
      });
      expect(await f.records.get(f.space.id)).toEqual(f.space);
    } finally {
      await unlock();
    }
  } finally {
    await f.close();
  }
});

test("explicit maintenance retains its original identity, restores same-VM running intent and promotes only after settlement", async () => {
  const f = await fixture();
  const id = requestId();
  const originalReceipt = { requestId: requestId(), state: "unconfirmed", marker: "do not replay" };
  await f.state.write("controller-operation-retained.json", originalReceipt);
  try {
    await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
      requestId: id,
      release: staged,
    });
    await f.running;
    expect(await collectServiceMaintenance(f.state, id)).toMatchObject({
      requestId: id,
      release: staged,
      phase: "selected",
      interruption: true,
      priorCommandsReplayed: false,
    });
    expect(f.active).toBe(staged);
    expect(await f.records.get(f.space.id)).toMatchObject({
      id: f.space.id,
      runtimeId: f.space.runtimeId,
      operationMarker: f.space.operationMarker,
      desiredState: "running",
      phase: "stopped",
    });
    expect(await f.state.read("controller-operation-retained.json", (value) => value)).toEqual(
      originalReceipt,
    );
  } finally {
    await f.close();
  }
});

test("explicit pause releases only the physical mutation gate and original resume restores intent without replay", async () => {
  const f = await fixture(),
    id = requestId();
  const originalReceipt = { requestId: requestId(), state: "unconfirmed" };
  await f.state.write("controller-operation-retained.json", originalReceipt);
  try {
    await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
      requestId: id,
      release,
      action: "pause",
    });
    while ((await collectServiceMaintenance(f.state, id))?.phase !== "paused")
      await Promise.race([
        nextTurn(),
        f.running.then(() => {
          throw new Error("Paused owner lost its control endpoint");
        }),
      ]);
    expect(await f.observe()).toMatchObject({ ready: false, release });
    expect(await f.records.get(f.space.id)).toMatchObject({
      desiredState: "stopped",
      generation: 2,
    });
    // Official standalone management can take this gate, while a competing service cannot.
    const releaseManagement = await f.state.lock({ recoverStale: true });
    try {
      await expect(
        runLocalService(f.records, staged, { manager: f.manager, daemon: f.daemon }),
      ).rejects.toMatchObject({ code: "LOCAL_ALREADY_RUNNING" });
      expect(
        await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
          requestId: id,
          release,
          action: "pause",
        }),
      ).toMatchObject({ phase: "paused" });
      await expect(
        serviceRequest(f.state, "POST", "/v1/service/maintenance", {
          requestId: requestId(),
          release: staged,
        }),
      ).rejects.toMatchObject({ code: "LOCAL_MAINTENANCE_PENDING" });
    } finally {
      await releaseManagement();
    }
    await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
      requestId: id,
      release,
      action: "resume",
    });
    await f.running;
    expect(await collectServiceMaintenance(f.state, id)).toMatchObject({
      requestId: id,
      phase: "selected",
      pause: true,
    });
    expect(f.active).toBe(release);
    expect(await f.records.get(f.space.id)).toMatchObject({
      id: f.space.id,
      runtimeId: f.space.runtimeId,
      desiredState: "running",
      generation: 3,
    });
    expect(await f.state.read("controller-operation-retained.json", (value) => value)).toEqual(
      originalReceipt,
    );
  } finally {
    await f.close();
  }
});

test.each(["update", "pause"] as const)(
  "maintenance identity retains its original %s intent for the same release",
  async (originalAction) => {
    const f = await fixture(),
      id = requestId();
    try {
      const key = `service-maintenance-${id}.json`;
      await f.state.write(key, {
        requestId: id,
        release,
        phase: "unconfirmed",
        running: [],
        interruption: true,
        priorCommandsReplayed: false,
        ...(originalAction === "pause" ? { pause: true } : {}),
      });
      const before = await readFile(join(f.state.root, key));
      await expect(
        serviceRequest(f.state, "POST", "/v1/service/maintenance", {
          requestId: id,
          release,
          action: originalAction === "pause" ? "update" : "pause",
        }),
      ).rejects.toMatchObject({ code: "LOCAL_REPLAY_CONFLICT" });
      expect(await readFile(join(f.state.root, key))).toEqual(before);
      expect(await f.records.get(f.space.id)).toEqual(f.space);
      expect(f.active).toBe(release);
      expect(await f.observe()).toMatchObject({ ready: true });
    } finally {
      await f.close();
    }
  },
);

test("same-VM recovery reports one guest refusal, restores a healthy peer and preserves command receipts", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-recovery-")));
  const state = await PrivateState.open(root),
    f = await localFixture(state);
  const bad = { ...f.space, runtimeId: "refused-runtime", phase: "stopped" as const },
    id = randomUUID();
  const peer = {
    ...bad,
    id,
    name: `moira-${id.replaceAll("-", "")}`,
    runtimeId: "healthy-runtime",
  };
  await f.records.put(bad);
  await f.records.put(peer);
  const original = Buffer.from('{"requestId":"original","state":"unconfirmed"}');
  await state.write("retained-command.json", JSON.parse(original.toString()));
  const retained = await readFile(join(root, "retained-command.json"));
  const manager = new LocalManager(f.records, {
    guard: async () => ({
      active: true,
      release: async () => undefined,
      stop: async () => undefined,
      observe: async () =>
        [bad, peer].map((space) => ({
          id: space.runtimeId,
          name: space.name,
          status: "stopped" as const,
        })),
      space: async (spaceId) => ({
        active: true,
        validate: async () => undefined,
        stop: async () => undefined,
        prepare: async () => {
          if (spaceId === bad.id)
            throw new LocalRefusal("LOCAL_GUEST_FAILED", "Fixture guest refused initialization");
          await f.records.put({ ...peer, phase: "usable" });
        },
      }),
      retire: async () => undefined,
      remove: async () => undefined,
    }),
  });
  try {
    await manager.holdRunnerLock();
    expect(await manager.restoreIntendedWork()).toEqual({
      restored: [peer.id],
      unavailable: [{ spaceId: bad.id, code: "LOCAL_GUEST_FAILED" }],
    });
    expect(await f.records.get(peer.id)).toMatchObject({
      phase: "usable",
      runtimeId: peer.runtimeId,
      desiredState: "running",
    });
    expect(await f.records.get(bad.id)).toEqual(bad);
    expect(await readFile(join(root, "retained-command.json"))).toEqual(retained);
  } finally {
    await manager.release();
    await rm(root, { recursive: true, force: true });
  }
});

test("authority refusal detaches a real route while original work remains owned and explicit maintenance can drain it", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-revoked-route-")));
  const state = await PrivateState.open(root),
    f = await localFixture(state),
    manager = new LocalManager(f.records);
  const identity = {
    userId: "fixture-owner",
    deviceId: f.policy.deviceId,
    deviceGeneration: 1,
    connectionId: randomUUID(),
  };
  const connection = {
    ...identity,
    origin: "https://moira.example",
    credential: "a".repeat(43),
    pairingId: randomUUID(),
  };
  await state.write("connection.json", connection);
  let refused = false,
    owner: LocalController | undefined,
    socketPath = "",
    finish!: () => void,
    admitted!: () => void;
  const held = new Promise<void>((resolve) => {
      finish = resolve;
    }),
    admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
  const relay = {
    confirmed: async () => {
      if (refused) throw new LocalDeviceAuthorityFailure("LOCAL_UNAUTHORIZED");
      return connection;
    },
    isUnavailable: () => false,
  } as unknown as LocalRelay;
  const daemon = new LocalDaemon(manager, relay, {
    report: () => undefined,
    startController: async (controller) => {
      owner = controller;
      const endpoint = await startLocalController(controller);
      socketPath = endpoint.socketPath;
      return endpoint;
    },
    startRemote: () => ({ close: async () => undefined, whenConnected: async () => undefined }),
  });
  const originalStop = manager.stopWork.bind(manager);
  manager.stopWork = async () => {
    await originalStop();
    finish();
  };
  const id = requestId(),
    input = { action: "controlled-original" };
  let operation: Promise<unknown> | undefined,
    revocation: Promise<unknown> | undefined,
    closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    finish();
    await operation?.catch(() => undefined);
    await revocation?.catch(() => undefined);
    const abort = new AbortController();
    abort.abort();
    try {
      await daemon.run(abort.signal, () => false);
    } finally {
      await manager.release();
      await rm((await state.ipcDirectory()).root, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
      cleanups.delete(cleanup);
    }
  };
  cleanups.add(cleanup);
  try {
    expect(await daemon.cycle()).toBe(true);
    operation = owner!.state.run(id, identity, input, async () => {
      admitted();
      await held;
      await state.write("original-result.json", { id, result: "original" });
      return { result: "original" };
    });
    await admission;
    refused = true;
    revocation = daemon.cycle();
    await revocation;
    expect(daemon.status).toEqual({ controlPlane: "disabled", code: "LOCAL_UNAUTHORIZED" });
    expect(await owner!.state.inspect(id, identity)).toMatchObject({ state: "accepted" });
    await expect(
      controllerRequest(socketPath, "GET", `/v1/controller/operations/${id}`),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(ENOENT|ECONNREFUSED)$/) });
    expect(await daemon.cycle()).toBe(false);
    await daemon.prepareMaintenance();
    expect(await owner!.state.inspect(id, identity)).toMatchObject({ state: "accepted" });
    const abort = new AbortController();
    abort.abort();
    await daemon.run(abort.signal, () => true, true);
    expect(await operation).toMatchObject({
      requestId: id,
      state: "completed",
      outcome: { ok: true, result: { result: "original" } },
    });
    expect(
      await owner!.state.run(id, identity, input, async () => {
        throw new Error("Original operation replayed");
      }),
    ).toMatchObject({ state: "completed" });
    expect(await state.read("original-result.json", (value) => value)).toEqual({
      id,
      result: "original",
    });
    expect(await f.records.get(f.space.id)).toEqual(f.space);
  } finally {
    await cleanup();
  }
});

test("unconfirmed physical settlement retains the old active executable and original maintenance receipt", async () => {
  const f = await fixture(true);
  const id = requestId();
  try {
    const completed = f.running.catch((error) => error);
    await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
      requestId: id,
      release: staged,
    });
    expect(await completed).toMatchObject({ code: "LOCAL_STOP_PENDING" });
    expect(await serviceFailure(f.state)).toEqual({
      release,
      code: "LOCAL_STOP_PENDING",
      at: expect.any(Number),
    });
    expect(f.active).toBe(release);
    expect(await collectServiceMaintenance(f.state, id)).toMatchObject({
      requestId: id,
      phase: "unconfirmed",
      error: "LOCAL_STOP_PENDING",
    });
    expect(await f.records.get(f.space.id)).toEqual(f.space);
  } finally {
    await f.close();
  }
});

test("an interrupted maintenance shutdown cannot become a fresh update or start work", async () => {
  const f = await fixture();
  const id = requestId();
  try {
    await f.state.write(`service-maintenance-${id}.json`, {
      requestId: id,
      release: staged,
      phase: "unconfirmed",
      running: [],
      interruption: true,
      priorCommandsReplayed: false,
      error: "LOCAL_STOP_PENDING",
    });
    await expect(
      serviceRequest(f.state, "POST", "/v1/service/maintenance", {
        requestId: requestId(),
        release: staged,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_MAINTENANCE_PENDING" });
    expect(
      await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
        requestId: id,
        release: staged,
      }),
    ).toMatchObject({ phase: "unconfirmed", requestId: id });
    expect(f.active).toBe(release);
    expect(await f.records.get(f.space.id)).toEqual(f.space);
  } finally {
    await f.close();
  }
});

test("a restarted owner resumes only promotion after the original confirmed maintenance settlement", async () => {
  const id = requestId(),
    f = await fixture(false, { requestId: id, phase: "settled" });
  try {
    expect(await f.observe()).toMatchObject({ ready: false, release });
    await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
      requestId: id,
      release: staged,
    });
    await f.running;
    expect(f.active).toBe(staged);
    expect(await collectServiceMaintenance(f.state, id)).toMatchObject({
      phase: "selected",
      requestId: id,
    });
    expect(await f.records.get(f.space.id)).toMatchObject({
      runtimeId: f.space.runtimeId,
      desiredState: "running",
      generation: 3,
    });
  } finally {
    await f.close();
  }
});

test("a restarted owner leaves unconfirmed maintenance inspectable without starting the SDK", async () => {
  const id = requestId(),
    f = await fixture(false, { requestId: id, phase: "unconfirmed" });
  try {
    expect(await f.observe()).toMatchObject({ ready: false, release });
    expect(
      await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
        requestId: id,
        release: staged,
      }),
    ).toMatchObject({ phase: "unconfirmed", requestId: id });
    await expect(
      serviceRequest(f.state, "POST", "/v1/service/maintenance", {
        requestId: requestId(),
        release: staged,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_MAINTENANCE_PENDING" });
    expect(f.active).toBe(release);
    expect(await f.records.get(f.space.id)).toMatchObject({
      desiredState: "stopped",
      generation: 2,
    });
  } finally {
    await f.close();
  }
});

test.each(["unconfirmed", "settling", "resuming"] as const)(
  "original %s maintenance releases physical exclusion and selects only after a new exact recovery receipt",
  async (phase) => {
    const id = requestId(),
      paused = phase === "resuming",
      target = paused ? release : staged,
      action = paused ? "resume" : "update",
      f = await fixture(false, { requestId: id, phase, ...(paused ? { pause: true } : {}) });
    const profile = localRuntimeProfileHash(f.policy);
    const before = { owner: randomUUID(), profile, settled: false };
    const command = { requestId: requestId(), state: "unconfirmed", result: "retain original" };
    try {
      // Standalone confirmed recovery must be able to acquire the actual gate.
      const releaseRecovery = await f.state.lock({ recoverStale: true });
      try {
        await f.state.write("runtime-owner.json", before);
        await f.state.write("policy.json", { ...f.policy, enabled: false });
        await f.state.write("retained-command.json", command);
      } finally {
        await releaseRecovery();
      }
      const originalCommand = await readFile(join(f.state.root, "retained-command.json"));
      const key = `service-maintenance-${id}.json`;
      const initial = await readFile(join(f.state.root, key));
      await serviceRequest(f.state, "GET", `/v1/service/operations/${id}`);
      expect(await readFile(join(f.state.root, key))).toEqual(initial);

      // An older unknown receipt first records its baseline, never inferring that
      // an already retained settlement belongs to this maintenance interruption.
      expect(
        await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
          requestId: id,
          release: target,
          action,
        }),
      ).toMatchObject({ phase: "unconfirmed", settlementBefore: { owner: before.owner, profile } });
      for (const candidate of [
        { ...before, settled: true },
        { owner: randomUUID(), profile: "c".repeat(64), settled: true },
        { owner: randomUUID(), profile, settled: false },
      ]) {
        const releaseCandidate = await f.state.lock({ recoverStale: true });
        try {
          await f.state.write("runtime-owner.json", candidate);
        } finally {
          await releaseCandidate();
        }
        expect(
          await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
            requestId: id,
            release: target,
            action,
          }),
        ).toMatchObject({ phase: "unconfirmed", requestId: id });
        expect(f.active).toBe(release);
        expect(await f.records.get(f.space.id)).toMatchObject({
          desiredState: "stopped",
          generation: 2,
        });
      }

      // The existing explicit recovery path publishes a different settled owner
      // under this same gate. This fixture supplies that durable boundary only;
      // it does not claim a real SDK stop or credential recovery.
      const releaseRecovered = await f.state.lock({ recoverStale: true });
      try {
        await f.state.write("runtime-owner.json", { owner: randomUUID(), profile, settled: true });
      } finally {
        await releaseRecovered();
      }
      const retained = await readFile(join(f.state.root, key));
      await serviceRequest(f.state, "GET", `/v1/service/operations/${id}`);
      expect(await readFile(join(f.state.root, key))).toEqual(retained);
      expect(f.active).toBe(release);
      await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
        requestId: id,
        release: target,
        action,
      });
      await f.running;
      expect(f.active).toBe(target);
      expect(await collectServiceMaintenance(f.state, id)).toMatchObject({
        requestId: id,
        phase: "selected",
        settlementBefore: { owner: before.owner, profile },
        priorCommandsReplayed: false,
      });
      expect(await f.records.get(f.space.id)).toMatchObject({
        runtimeId: f.space.runtimeId,
        desiredState: "running",
        generation: 3,
      });
      expect(await readFile(join(f.state.root, "retained-command.json"))).toEqual(originalCommand);
    } finally {
      await f.close();
    }
  },
);

test("only the newly selected owner completes original maintenance with its actual recovery projection", async () => {
  const id = requestId(),
    f = await fixture(false, { requestId: id, phase: "selected" });
  try {
    expect(await f.observe()).toMatchObject({ release: staged, ready: true });
    expect(await collectServiceMaintenance(f.state, id)).toMatchObject({
      requestId: id,
      phase: "completed",
      release: staged,
      recovery: { restored: [f.space.id], unavailable: [] },
    });
    expect(await f.records.get(f.space.id)).toMatchObject({
      runtimeId: f.space.runtimeId,
      desiredState: "running",
      generation: 3,
    });
  } finally {
    await f.close();
  }
});

test("the original selected maintenance can explicitly restart failed startup without repeating settlement or claiming completion", async () => {
  const id = requestId(),
    f = await fixture(false, { requestId: id, phase: "selected" }, true);
  try {
    const before = await f.records.get(f.space.id);
    expect(await f.observe()).toMatchObject({
      ready: false,
      release: staged,
      failure: { code: "LOCAL_DOCKER_LOGIN_REQUIRED" },
    });
    expect(
      await serviceRequest(f.state, "POST", "/v1/service/maintenance", {
        requestId: id,
        release: staged,
      }),
    ).toMatchObject({ requestId: id, phase: "selected" });
    await f.running;
    expect(await collectServiceMaintenance(f.state, id)).toMatchObject({
      requestId: id,
      phase: "selected",
    });
    expect(await f.records.get(f.space.id)).toEqual(before);
    expect(f.active).toBe(staged);
  } finally {
    await f.close();
  }
});

test("the real persistent service exposes local control without a Local SDK configuration or cloud enrollment", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-controller-service-")));
  const state = await PrivateState.open(root),
    records = new LocalRecords(state),
    abort = new AbortController();
  const running = runLocalService(records, release, {
    signal: abort.signal,
    installation: async () => ({ active: release, staged: null, launcher: join(root, "launch") }),
  });
  try {
    let observed: unknown;
    for (;;) {
      try {
        observed = await serviceRequest(state);
        if ((observed as { ready: boolean }).ready) break;
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      await Promise.race([
        nextTurn(),
        running.then(() => {
          throw new Error("Service exited before control became ready");
        }),
      ]);
    }
    expect(observed).toMatchObject({ release, ready: true, processId: process.pid });
    expect(await records.policyOrNull()).toBeNull();
    expect(await state.read("runtime-owner.json", (value) => value)).toBeNull();
    expect(await records.list()).toEqual([]);
  } finally {
    abort.abort();
    await running;
    await rm((await state.ipcDirectory()).root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a paired GitHub-only controller acquires real owner admission without configuring a Local SDK", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-github-only-owner-")));
  const state = await PrivateState.open(root),
    records = new LocalRecords(state);
  const identity = {
    userId: "owner",
    deviceId: randomUUID(),
    deviceGeneration: 1,
    connectionId: randomUUID(),
  };
  await state.write("connection.json", {
    ...identity,
    origin: "https://moira.example",
    credential: "fixture-controller-credential",
  });
  const manager = new LocalManager(records);
  const controller = new LocalController(manager, identity);
  let endpoint: Awaited<ReturnType<typeof startLocalController>> | undefined;
  try {
    await controller.initialize();
    endpoint = await startLocalController(controller);
    expect(await controllerRequest(endpoint.socketPath, "GET", "/v1/controller")).toMatchObject({
      ...identity,
      local: { state: "unconfigured" },
      github: { resources: [] },
    });
    expect(await records.policyOrNull()).toBeNull();
    expect(await state.read("runtime-owner.json", (value) => value)).toBeNull();
    await endpoint.close();
    endpoint = undefined;
    await manager.release();
    await state.write("policy.json", { version: 2, enabled: true });
    await expect(new LocalManager(records).holdRunnerLock()).rejects.toThrow();
  } finally {
    await endpoint?.close();
    await manager.release();
    await rm((await state.ipcDirectory()).root, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
