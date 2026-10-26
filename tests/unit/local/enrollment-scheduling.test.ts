import { expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRefusal, localRuntimeProfileHash } from "../../../packages/local/src/policy.js";
import { localFixture } from "../../integration/local/fixtures.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

test("one held VM enrollment neither duplicates its request nor blocks a peer retry or shutdown", async () => {
  const root = await realpath(await mkdtemp("/tmp/moira-enrollment-scheduling-"));
  const local = await localFixture(await PrivateState.open(root));
  const id = randomUUID();
  const peer = {
    ...local.space,
    id,
    name: "moira-" + id.replaceAll("-", ""),
    runtimeId: "peer-runtime",
    operationMarker: "moira-" + "c".repeat(24),
  };
  await local.records.put(peer);
  const entered = deferred(),
    held = deferred(),
    rejected = deferred(),
    retried = deferred();
  let firstAttempts = 0,
    peerAttempts = 0;
  const manager = new LocalManager(local.records, {
    storage: async () => {},
    brokerPorts: { http: 0, tunnel: 0 },
    guard: async () => ({
      active: true,
      observe: async () => [],
      stop: async () => {},
      release: async () => {},
      remove: async () => {},
      retire: async () => {},
      space: async (spaceId) => ({
        active: true,
        prepare: async () => {},
        validate: async () => {},
        stop: async () => {},
        refreshRemote: async () => {
          if (spaceId === local.space.id) {
            firstAttempts++;
            entered.resolve();
            await held.promise;
          } else {
            peerAttempts++;
            if (peerAttempts === 1) {
              rejected.resolve();
              throw new LocalRefusal("LOCAL_RELAY_UNAVAILABLE", "Controlled peer refusal");
            }
            retried.resolve();
          }
        },
      }),
    }),
  });
  try {
    await manager.open();
    await manager.refreshWorkspaceEnrollments();
    await Promise.all([entered.promise, rejected.promise]);
    const failures = await manager.refreshWorkspaceEnrollments();
    await retried.promise;
    expect(failures).toEqual([{ spaceId: peer.id, code: "LOCAL_RELAY_UNAVAILABLE" }]);
    expect(firstAttempts).toBe(1);
    expect(peerAttempts).toBe(2);
    await manager.close();
  } finally {
    held.resolve();
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["close", "release"] as const)(
  "%s retires enrollment admission throughout owner initialization",
  async (shutdown) => {
    for (const phase of [
      "native-admission",
      "policy",
      "runner",
      "old-guard",
      "new-guard",
    ] as const) {
      const root = await realpath(await mkdtemp("/tmp/moira-enrollment-retirement-"));
      const local = await localFixture(await PrivateState.open(root));
      const entered = deferred(),
        held = deferred();
      const guards: Array<{ active: boolean }> = [];
      let runnerHeld = false,
        runnerAdmissions = 0,
        guardStarts = 0,
        spaceAdmissions = 0;
      const barrier = async () => {
        entered.resolve();
        await held.promise;
      };
      const manager = new LocalManager(local.records, {
        guard: async () => {
          guardStarts++;
          if (phase === "new-guard") await barrier();
          const device = {
            active: true,
            stop: async () => {
              device.active = false;
            },
            release: async () => {
              device.active = false;
            },
            observe: async () => [],
            remove: async () => {},
            retire: async () => {},
            space: async () => {
              spaceAdmissions++;
              throw new Error("Retired admission reached a VM");
            },
          };
          guards.push(device);
          return device;
        },
      });
      // Control only host admission effects; run the production scheduler and
      // owner/retirement boundaries without a native SDK or a listener.
      Reflect.set(manager, "broker", { close: async () => {} });
      Reflect.set(manager, "tunnel", { close: async () => {} });
      manager.holdRunnerLock = async () => {
        runnerAdmissions++;
        if (phase === "runner") await barrier();
        runnerHeld = true;
        Reflect.set(manager, "releaseLock", async () => {
          runnerHeld = false;
        });
      };
      if (phase === "old-guard") {
        const old = {
          active: true,
          stop: async () => {
            await barrier();
            old.active = false;
            await local.records.state.write("runtime-owner.json", {
              owner: randomUUID(),
              profile: localRuntimeProfileHash(local.policy),
              settled: true,
            });
          },
          release: async () => {
            old.active = false;
          },
        };
        guards.push(old);
        Reflect.set(manager, "device", old);
        Reflect.set(manager, "cleanupOnlyOwner", true);
      }
      const read = local.records.state.read.bind(local.records.state);
      local.records.state.read = async function <T>(key: string, parse: (value: unknown) => T) {
        const result = await read(key, parse);
        if (phase === "native-admission" && key === "service-failure.json") await barrier();
        return result;
      };
      const policy = local.records.policy.bind(local.records);
      local.records.policy = async () => {
        const value = await policy();
        if (phase === "policy") await barrier();
        return value;
      };
      try {
        await manager.refreshWorkspaceEnrollments();
        await entered.promise;
        const retiring = manager[shutdown]();
        // Metadata reads cannot reopen admission after a completed shutdown.
        if (phase === "policy" || phase === "native-admission") await retiring;
        held.resolve();
        await retiring;
        await Promise.all(
          (Reflect.get(manager, "enrollments") as Map<string, Promise<void>>).values(),
        );
        expect(Reflect.get(manager, "device")).toBeUndefined();
        expect(runnerHeld).toBe(false);
        expect(guards.every((device) => !device.active)).toBe(true);
        expect(spaceAdmissions).toBe(0);
        expect(guardStarts).toBe(phase === "new-guard" ? 1 : 0);
        if (phase === "policy" || phase === "native-admission") expect(runnerAdmissions).toBe(0);
      } finally {
        held.resolve();
        await manager.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

test.each(["close", "release"] as const)(
  "%s retires an explicit open waiting on preflight instead of admitting a new owner",
  async (shutdown) => {
    for (const phase of ["policy", "storage"] as const) {
      const root = await realpath(await mkdtemp("/tmp/moira-open-retirement-"));
      const local = await localFixture(await PrivateState.open(root));
      const entered = deferred(),
        held = deferred();
      let guardStarts = 0,
        runnerHeld = false;
      const barrier = async () => {
        entered.resolve();
        await held.promise;
      };
      const manager = new LocalManager(local.records, {
        storage: async () => {
          if (phase === "storage") await barrier();
        },
        guard: async () => {
          guardStarts++;
          throw new Error("Retired preflight admitted a native owner");
        },
      });
      manager.holdRunnerLock = async () => {
        runnerHeld = true;
        Reflect.set(manager, "releaseLock", async () => {
          runnerHeld = false;
        });
      };
      const policy = local.records.policy.bind(local.records);
      local.records.policy = async () => {
        const value = await policy();
        if (phase === "policy") await barrier();
        return value;
      };
      const opening = manager.open().catch((error: unknown) => error);
      try {
        await entered.promise;
        const retiring = manager[shutdown]();
        held.resolve();
        await retiring;
        expect(await opening).toMatchObject({ code: "LOCAL_CANCELLED" });
        expect(guardStarts).toBe(0);
        expect(runnerHeld).toBe(false);
        expect(Reflect.get(manager, "device")).toBeUndefined();
      } finally {
        held.resolve();
        await opening;
        await manager.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

test.each(["close", "release"] as const)(
  "%s leaves the actual runner file lock available after an interrupted acquisition",
  async (shutdown) => {
    const root = await realpath(await mkdtemp("/tmp/moira-runner-retirement-"));
    const local = await localFixture(await PrivateState.open(root));
    const entered = deferred(),
      held = deferred();
    const lock = local.records.state.lock.bind(local.records.state);
    local.records.state.lock = async (...args) => {
      const release = await lock(...args);
      entered.resolve();
      await held.promise;
      return release;
    };
    const manager = new LocalManager(local.records);
    const acquiring = manager.holdRunnerLock().catch((error: unknown) => error);
    try {
      await entered.promise;
      const retiring = manager[shutdown]();
      held.resolve();
      await retiring;
      expect(await acquiring).toMatchObject({ code: "LOCAL_CANCELLED" });
      const release = await lock();
      await release();
      expect(Reflect.get(manager, "releaseLock")).toBeUndefined();
    } finally {
      held.resolve();
      await acquiring;
      await manager.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
