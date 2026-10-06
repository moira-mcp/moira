import { afterEach, beforeEach, describe, expect, test, jest } from "@jest/globals";
import { mkdtemp, realpath, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRelay, relayOrigin } from "../../../packages/local/src/relay.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalRpc } from "../../../packages/local/src/rpc.js";
import { SbxRuntime } from "../../../packages/local/src/sbx-runtime.js";
import { RuntimeDeviceOwner } from "../../../packages/local/src/runtime-device-owner.js";
import { RuntimeOwner } from "../../../packages/local/src/runtime-owner.js";
import { publicPolicy, LocalRefusal } from "../../../packages/local/src/policy.js";
import { setEnabled } from "../../../packages/local/src/config.js";
import { localFixture } from "./fixtures.js";
import { canonicalJson } from "../../../packages/shared/src/utils/canonical-json.js";

let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "ml-relay-")));
});
afterEach(async () => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const json = (data: unknown) => Response.json({ success: true, data });

async function fixture() {
  const state = await PrivateState.open(directory);
  const local = await localFixture(state);
  const connection = {
    origin: "https://moira.example/prefix",
    credential: randomBytes(32).toString("base64url"),
    deviceId: local.policy.deviceId,
    userId: "fixture-owner",
    deviceGeneration: 7,
    connectionId: randomUUID(),
    pairingId: randomUUID(),
  };
  await state.write("connection.json", connection);
  const device = { ...connection, status: "active", policy: publicPolicy(local.policy) };
  const resourceId = randomUUID();
  let message: unknown;
  let claim: Record<string, unknown>;
  let bytes: Buffer;
  const receipts: unknown[] = [];
  const uploaded = new Map<string, Buffer>();
  const gitIdentityRequests: string[] = [];
  let idleClaim = false;
  let enteredIdle!: () => void;
  const idleEntered = new Promise<void>((resolve) => {
    enteredIdle = resolve;
  });
  let maxPartBytes = 4 * 1024 * 1024;
  let loseAck = false;
  let refuseRenew = false;
  let renewals = 0;
  let renewed!: () => void;
  const renewal = new Promise<void>((done) => {
    renewed = done;
  });
  const transport: typeof globalThis.fetch = async (input, options) => {
    options?.signal?.throwIfAborted();
    const url = new URL(String(input));
    expect(url.origin).toBe("https://moira.example");
    expect(url.pathname.startsWith("/prefix/api/local-devices/")).toBe(true);
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("authorization")).toBe(
      `Bearer ${connection.credential}`,
    );
    if (url.pathname.endsWith("/heartbeat")) return json(device);
    if (url.pathname.endsWith("/identity")) {
      gitIdentityRequests.push(url.pathname);
      return json({ name: "Fixture Owner", email: "owner@example.test" });
    }
    if (url.pathname.endsWith("/relay/claim")) {
      if (idleClaim) {
        enteredIdle();
        return new Promise<Response>((_resolve, reject) =>
          options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), {
            once: true,
          }),
        );
      }
      return json({ requests: [claim], maxPartBytes });
    }
    if (url.pathname.endsWith("/renew")) {
      renewals++;
      renewed();
      expect(new Headers(options?.headers).get("X-Moira-Claim-Id")).toBe(claim.claimId);
      return refuseRenew
        ? new Response(null, { status: 401 })
        : json({ ...claim, claimExpiresAt: Date.now() + 30_000 });
    }
    if (url.pathname.includes("/payload/0")) {
      expect(new Headers(options?.headers).get("X-Moira-Claim-Id")).toBe(claim.claimId);
      const offset = Number(url.searchParams.get("offset")),
        length = Number(url.searchParams.get("length"));
      return new Response(Uint8Array.from(bytes.subarray(offset, offset + length)));
    }
    if (url.pathname.endsWith("/result-part")) {
      expect(new Headers(options?.headers).get("X-Moira-Claim-Id")).toBe(claim.claimId);
      const result = Buffer.from(options!.body as Uint8Array);
      expect(result.length).toBeLessThanOrEqual(maxPartBytes);
      const transferId = randomUUID();
      uploaded.set(transferId, result);
      return json({ transferId, size: result.length, sha256: hash(result) });
    }
    if (url.pathname.endsWith("/relay/ack")) {
      const ack = JSON.parse(String(options?.body));
      receipts.push(
        JSON.parse(
          Buffer.concat(
            ack.outcomeReference.parts.map((part: { transferId: string }) =>
              uploaded.get(part.transferId)!,
            ),
          ).toString("utf8"),
        ),
      );
      if (loseAck) {
        loseAck = false;
        throw new Error("Controlled response loss after receipt");
      }
      return json({
        requestId: claim.requestId,
        digest: claim.digest,
        status: "completed",
        outcomeReference: JSON.parse(String(options?.body)).outcomeReference,
      });
    }
    throw new Error(`Unexpected test transport path ${url.pathname}`);
  };
  const manager = new LocalManager(local.records);
  let creates = 0;
  manager.create = async (repositoryId, ref, operationMarker) => {
    creates++;
    local.space.repositoryId = repositoryId;
    local.space.ref = ref;
    local.space.operationMarker = operationMarker;
    await local.records.put(local.space);
    return local.space;
  };
  const rpc = new LocalRpc(manager);
  const relay = new LocalRelay(local.records, transport);
  const setRequest = (request: unknown, generation = 1) => {
    message = { version: 1, id: randomUUID(), expiresAt: Date.now() + 60_000, request };
    bytes = Buffer.from(canonicalJson(message));
    const envelope = message as { id: string; expiresAt: number };
    claim = {
      ...connection,
      requestId: envelope.id,
      resourceId,
      resourceGeneration: generation,
      digest: hash(bytes),
      payloadReference: {
        parts: [{ transferId: randomUUID(), sha256: hash(bytes), size: bytes.length }],
        sha256: hash(bytes),
        size: bytes.length,
      },
      deadlineAt: envelope.expiresAt,
      claimId: randomUUID(),
      claimExpiresAt: Date.now() + 30_000,
    };
    delete claim.origin;
    delete claim.credential;
    delete claim.pairingId;
  };
  setRequest({
    action: "create",
    repositoryId: local.space.repositoryId,
    ref: "main",
    operationMarker: `moira-${"a".repeat(24)}`,
  });
  return {
    ...local,
    state,
    connection,
    resourceId,
    manager,
    rpc,
    relay,
    receipts,
    setRequest,
    claim: () => claim,
    creates: () => creates,
    loseAck: () => {
      loseAck = true;
    },
    refuseRenew: () => {
      refuseRenew = true;
    },
    renewals: () => renewals,
    renewal,
    partLimit: (value: number) => {
      maxPartBytes = value;
    },
    uploaded,
    transport,
    gitIdentityRequests,
    idleEntered,
    idle: () => {
      idleClaim = true;
    },
    resume: () => {
      idleClaim = false;
      return new LocalRelay(local.records, transport);
    },
  };
}

describe("outbound companion authority and durable response replay", () => {
  test.each(["running", "stopped", "changed-network"])(
    "an active guard verifies the actual VM before accepting a %s start",
    async (state) => {
      const local = await fixture();
      let preparations = 0;
      local.manager.dependencies.storage = async () => {};
      local.manager.dependencies.brokerPorts = { http: 0, tunnel: 0 };
      const guard = {
        active: true,
        prepare: async () => {
          preparations++;
        },
        validate: async () => {
          if (state !== "running")
            throw new LocalRefusal(
              state === "stopped" ? "LOCAL_NOT_RUNNING" : "LOCAL_NETWORK_CHANGED",
              "Controlled observation",
            );
        },
        operation: async () => Buffer.from("{}"),
        stop: async () => {},
      };
      local.manager.dependencies.guard = async () => ({
        active: true,
        stop: async () => {},
        observe: async () => [],
        retire: async () => {},
        remove: async () => {},
        space: async () => guard,
      });
      await local.manager.open();
      try {
        await local.manager.operation(local.space.id, {});
        if (state === "changed-network")
          await expect(local.manager.start(local.space.id)).rejects.toMatchObject({
            code: "LOCAL_NETWORK_CHANGED",
          });
        else
          await expect(local.manager.start(local.space.id)).resolves.toMatchObject({
            runtimeId: local.space.runtimeId,
          });
        expect(preparations).toBe(state === "stopped" ? 1 : 0);
      } finally {
        await local.manager.close();
      }
    },
  );
  test.each([1, 2])(
    "a private restart uses its live start authority after observation generation %s",
    async (observedGeneration) => {
      const local = await fixture();
      local.policy.repositories[0].private = true;
      await local.state.write("policy.json", local.policy);
      await local.relay.poll(local.rpc);
      const network = Buffer.from("fixture-network-policy");
      Object.assign(local.space, {
        phase: "stopped",
        desiredState: "stopped",
        generation: 2,
        recoveryGeneration: 2,
        networkPolicy: hash(network),
      });
      await local.records.put(local.space);
      local.manager.snapshot = async () => ({ ...publicPolicy(local.policy), spaces: [] });
      local.setRequest({ action: "snapshot" }, observedGeneration);
      await local.relay.poll(local.rpc);
      jest.spyOn(globalThis, "fetch").mockImplementation(local.transport);
      jest.spyOn(SbxRuntime.prototype, "start").mockResolvedValue(undefined);
      jest.spyOn(SbxRuntime.prototype, "verifySettings").mockResolvedValue(undefined);
      jest.spyOn(SbxRuntime.prototype, "verifyBoundary").mockResolvedValue(undefined);
      jest.spyOn(SbxRuntime.prototype, "networkPolicy").mockResolvedValue(network);
      const bootstraps: unknown[] = [];
      jest
        .spyOn(SbxRuntime.prototype, "guest")
        .mockImplementation(async (_identity, _argv, stdin) => {
          if (stdin && stdin.toString().startsWith("{")) {
            bootstraps.push(JSON.parse(stdin.toString()));
            expect(await local.records.get(local.space.id)).toMatchObject({
              phase: "stopped",
              generation: 3,
            });
          }
          return Buffer.from(JSON.stringify({ ok: true, result: {} }));
        });
      const owner = new RuntimeOwner(
        local.records,
        local.space.id,
        async () => {},
        async () => {},
        async () => ({ worker: Buffer.from("worker"), proxy: "proxy" }),
      );
      local.manager.dependencies.storage = async () => {};
      local.manager.dependencies.brokerPorts = { http: 0, tunnel: 0 };
      local.manager.dependencies.guard = async () => ({
        active: true,
        stop: async () => {},
        observe: async () => [],
        retire: async () => {},
        remove: async () => {},
        space: async (_id, activate) => {
          await owner.admit(activate);
          return {
            active: true,
            prepare: () => owner.prepare(),
            validate: () => owner.validate(),
            operation: (request) => owner.operation(request),
            stop: async () => {
              await owner.quiesce();
              await owner.confirmStopped();
            },
          };
        },
      });
      await local.manager.open();
      try {
        local.setRequest({ action: "start", spaceId: local.space.id }, 2);
        await local.relay.poll(local.rpc);
        expect(local.receipts.at(-1)).toEqual({ ok: true, result: { accepted: true } });
        expect(local.gitIdentityRequests).toEqual([
          `/prefix/api/local-devices/github/${local.resourceId}/2/identity`,
        ]);
        expect(bootstraps).toEqual([
          expect.objectContaining({
            kind: "bootstrap",
            request: expect.objectContaining({
              clone: false,
              gitAuthor: { name: "Fixture Owner", email: "owner@example.test" },
            }),
          }),
        ]);
        expect(await local.records.get(local.space.id)).toMatchObject({
          generation: 3,
          phase: "usable",
          runtimeId: local.space.runtimeId,
        });
        expect(
          JSON.parse(
            await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8"),
          ),
        ).toMatchObject({ localGeneration: 3, serverGeneration: 2 });
      } finally {
        await local.manager.close();
      }
    },
  );

  test.each(["expired", "changed-space", "changed-digest", "changed-connection", "completed"])(
    "restart Git authority refuses a %s retained start intent",
    async (invalid) => {
      const local = await fixture();
      await local.relay.poll(local.rpc);
      local.manager.start = async () => {
        const current = await local.records.get(local.space.id);
        await local.records.put({
          ...current!,
          generation: 2,
          phase: "stopped",
          desiredState: "running",
        });
        const key = `relay-request-${local.claim().requestId}.json`;
        const intent = JSON.parse(await readFile(join(directory, key), "utf8"));
        if (invalid === "expired") intent.message.expiresAt = Date.now() - 1;
        if (invalid === "changed-space") intent.message.request.spaceId = randomUUID();
        if (invalid === "changed-digest") intent.digest = "f".repeat(64);
        if (invalid === "changed-connection") intent.connectionId = randomUUID();
        if (invalid === "completed") {
          const entries = JSON.parse(await readFile(join(directory, "requests.json"), "utf8"));
          entries.find((entry: { id: string }) => entry.id === intent.message.id).state =
            "complete";
          await local.state.write("requests.json", entries);
        }
        if (invalid !== "changed-digest")
          intent.digest = hash(Buffer.from(canonicalJson(intent.message)));
        await local.state.write(key, intent);
        await expect(
          local.relay.gitAuthority(local.space.id, 2, local.space.repositoryId),
        ).rejects.toMatchObject({ code: "LOCAL_GENERATION_CONFLICT" });
        return current!;
      };
      local.setRequest({ action: "start", spaceId: local.space.id }, 2);
      await local.relay.poll(local.rpc);
      expect(local.gitIdentityRequests).toEqual([]);
    },
  );
  test.each(["parent", "lease", "emergency"] as const)(
    "an idle %s shutdown preserves the same relay resource for reconnect without recovery acknowledgement",
    async (cause) => {
      const local = await fixture();
      await local.relay.poll(local.rpc);
      const identity = local.space.runtimeId;
      const owner = new RuntimeOwner(
        local.records,
        local.space.id,
        async () => {},
        async () => {},
      );
      await owner.admit();
      // Only physical SDK stop is substituted; owner generation/confirmation and manager closure are real.
      const stop = async () => {
        await owner.quiesce(cause !== "parent");
        await Promise.all([owner.confirmStopped(), owner.confirmStopped()]);
      };
      local.manager.dependencies.guard = async () => ({
        active: true,
        stop: async () => {},
        observe: async () => [],
        retire: async () => {},
        remove: async () => {},
        space: async () => ({
          active: true,
          prepare: async () => {},
          validate: async () => {},
          operation: async () => Buffer.from("{}"),
          stop,
        }),
      });
      await local.manager.operation(local.space.id, {});
      local.idle();
      const controller = new AbortController();
      const idle = local.relay.poll(local.rpc, controller.signal);
      const idleOutcome = idle.catch(() => undefined);
      await local.idleEntered;
      if (cause !== "parent") {
        await local.state.write(
          "policy.json",
          cause === "lease"
            ? { ...local.policy, leaseUntil: Date.now() - 1 }
            : { ...local.policy, enabled: false },
        );
        await stop();
      }
      controller.abort();
      await idleOutcome;
      await local.manager.close();
      expect(await local.records.get(local.space.id)).toMatchObject({
        generation: 2,
        phase: "stopped",
        failure: null,
        runtimeId: identity,
      });
      // The reconnect uses a new LocalRelay/LocalRpc, as the next CLI run does.
      const reconnect = local.resume();
      await reconnect.poll(new LocalRpc(local.manager));
      expect(local.receipts.at(-1)).toMatchObject({
        ok: false,
        error: { code: "LOCAL_GENERATION_CONFLICT" },
      });
      expect(local.creates()).toBe(1);
      local.setRequest({ action: "start", spaceId: local.space.id }, 1);
      await reconnect.poll(new LocalRpc(local.manager));
      expect(local.receipts.at(-1)).toMatchObject({
        ok: false,
        error: { code: "LOCAL_GENERATION_CONFLICT" },
      });
      class ObservedStopped extends SbxRuntime {
        override async list() {
          return [
            {
              id: identity!,
              name: local.space.name,
              agent: "shell" as const,
              status: "stopped" as const,
              workspaces: [],
              ports: [],
            },
          ];
        }
      }
      local.manager.dependencies.runtime = (policy) => new ObservedStopped(policy);
      local.setRequest({ action: "snapshot" }, 1);
      await reconnect.poll(new LocalRpc(local.manager));
      expect(local.receipts.at(-1)).toMatchObject({
        ok: true,
        result: { spaces: [{ id: local.space.id, state: "stopped", phase: "stopped" }] },
      });
      expect(
        JSON.parse(await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8")),
      ).toMatchObject({ localGeneration: 2, serverGeneration: 1 });
      // A cloud lifecycle request cannot renew a local lease; the operator does so before run.
      await setEnabled(local.records, true, 1);
      local.manager.dependencies.runtime = undefined;
      local.manager.dependencies.guard = async () => ({
        active: true,
        stop: async () => {},
        observe: async () => [],
        retire: async () => {},
        remove: async () => {},
        space: async (_id, activate) => {
          const resumedOwner = new RuntimeOwner(
            local.records,
            local.space.id,
            async () => {},
            async () => {},
          );
          await resumedOwner.admit(activate);
          return {
            active: true,
            prepare: async () => {
              const admitted = await local.records.get(local.space.id);
              await local.records.put({ ...admitted!, phase: "usable" });
            },
            validate: async () => {},
            operation: async () => Buffer.from("{}"),
            stop: async () => {},
          };
        },
      });
      local.manager.dependencies.storage = async () => {};
      local.manager.dependencies.brokerPorts = { http: 0, tunnel: 0 };
      await local.manager.open();
      try {
        local.setRequest({ action: "start", spaceId: local.space.id }, 2);
        await reconnect.poll(new LocalRpc(local.manager));
        expect(local.receipts.at(-1)).toEqual({ ok: true, result: { accepted: true } });
        expect(await local.records.get(local.space.id)).toMatchObject({
          generation: 3,
          recoveryGeneration: 2,
          runtimeId: identity,
          phase: "usable",
        });
        expect(
          JSON.parse(
            await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8"),
          ),
        ).toMatchObject({ localGeneration: 3, serverGeneration: 2 });
      } finally {
        await local.manager.close();
      }
    },
  );
  test("a failed physical idle stop cannot rebase a retained resource for reconnect", async () => {
    const local = await fixture();
    await local.relay.poll(local.rpc);
    const owner = new RuntimeOwner(
      local.records,
      local.space.id,
      async () => {},
      async () => {},
    );
    await owner.admit();
    local.manager.dependencies.guard = async () => ({
      active: true,
      stop: async () => {},
      observe: async () => [],
      retire: async () => {},
      remove: async () => {},
      space: async () => ({
        active: true,
        prepare: async () => {},
        validate: async () => {},
        operation: async () => Buffer.from("{}"),
        stop: async () => {
          await owner.quiesce();
          throw new Error("Controlled physical stop refusal");
        },
      }),
    });
    await local.manager.operation(local.space.id, {});
    await expect(local.manager.close()).rejects.toThrow("could not be confirmed stopped");
    expect((await local.records.get(local.space.id))?.recoveryGeneration).toBeUndefined();
    local.setRequest({ action: "snapshot" }, 2);
    await local.resume().poll(new LocalRpc(local.manager));
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_GENERATION_CONFLICT" },
    });
    expect(
      JSON.parse(await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8")),
    ).toMatchObject({ localGeneration: 1, serverGeneration: 1 });
  });
  test("an unsupported production worker platform refuses before any SDK home or VM startup", async () => {
    const state = await PrivateState.open(directory);
    const local = await localFixture(state);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const owner = new RuntimeDeviceOwner(local.records, local.policy);
      await expect(owner.open()).rejects.toMatchObject({
        code: "LOCAL_RUNTIME_WORKER_UNSUPPORTED",
      });
      await owner.stop();
      await expect(stat(owner.runtime.home)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await local.records.get(local.space.id)).toEqual(local.space);
    } finally {
      Object.defineProperty(process, "platform", descriptor);
    }
  });
  test("refuses credentials, query strings and non-HTTPS origins before transport", () => {
    for (const url of [
      "http://moira.example",
      "https://token@moira.example",
      "https://moira.example?token=x",
    ])
      expect(() => relayOrigin(url)).toThrow();
    expect(relayOrigin("https://moira.example/prefix/")).toBe("https://moira.example/prefix");
  });
  test("a lost enrollment response reuses the private credential and never sends local host paths", async () => {
    const state = await PrivateState.open(directory);
    const local = await localFixture(state);
    const requests: Array<Record<string, unknown>> = [];
    const relay = new LocalRelay(local.records, async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      requests.push(body);
      if (requests.length === 1) throw new Error("Controlled lost enrollment response");
      return json({
        deviceId: local.policy.deviceId,
        userId: "fixture-owner",
        deviceGeneration: 1,
        connectionId: randomUUID(),
        status: "pending",
        policy: publicPolicy(local.policy),
      });
    });
    const pairing = randomUUID();
    const pairingToken = randomBytes(32).toString("base64url");
    await expect(relay.enroll("https://moira.example", pairing, pairingToken)).rejects.toThrow(
      "Controlled",
    );
    await expect(
      relay.enroll("https://moira.example", pairing, pairingToken),
    ).resolves.toMatchObject({ status: "pending" });
    expect(requests[0].credential).toBe(requests[1].credential);
    expect(JSON.stringify(requests)).not.toContain(local.policy.runtime.binary);
    expect(JSON.stringify(requests)).not.toContain(local.policy.runtime.storageRoot);
    expect((await stat(join(directory, "connection.json"))).mode & 0o077).toBe(0);
  });
  test("a new claim after acknowledgement loss returns the cached real RPC receipt without repeating creation", async () => {
    const local = await fixture();
    local.loseAck();
    await expect(local.relay.poll(local.rpc)).rejects.toThrow("Controlled response loss");
    expect(local.creates()).toBe(1);
    local.claim().claimId = randomUUID();
    await expect(local.relay.poll(new LocalRpc(local.manager))).resolves.toBe(1);
    expect(local.creates()).toBe(1);
    expect(local.receipts).toEqual([
      { ok: true, result: { spaceId: local.space.id } },
      { ok: true, result: { spaceId: local.space.id } },
    ]);
    const binding = JSON.parse(
      await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8"),
    );
    expect(binding).toMatchObject({
      resourceId: local.resourceId,
      localSpaceId: local.space.id,
      serverGeneration: 1,
      localGeneration: local.space.generation,
    });
    expect(binding.resourceId).not.toBe(binding.localSpaceId);
  });
  test("changed claim owner is refused before downloading payload or invoking its RPC", async () => {
    const local = await fixture();
    local.claim().userId = "different-owner";
    await expect(local.relay.poll(local.rpc)).rejects.toMatchObject({
      code: "LOCAL_IDENTITY_CHANGED",
    });
    expect(local.creates()).toBe(0);
    expect(local.receipts).toEqual([]);
  });
  test("a real manager closure after lost ACK retains the cached receipt and its stopped local generation for a later read", async () => {
    const local = await fixture();
    // Explicit external-runtime ownership substitute; actual manager closure and durable records remain real.
    local.manager.dependencies.guard = async () => ({
      active: true,
      stop: async () => {},
      observe: async () => [],
      retire: async () => {},
      remove: async () => {},
      space: async () => ({
        active: true,
        prepare: async () => {},
        validate: async () => {},
        operation: async () => Buffer.from("{}"),
        stop: async () => {
          const space = await local.records.get(local.space.id);
          if (space)
            await local.records.put({
              ...space,
              desiredState: "stopped",
              phase: "stopped",
              generation: space.generation + 1,
            });
        },
      }),
    });
    await local.manager.operation(local.space.id, {});
    local.loseAck();
    await expect(local.relay.poll(local.rpc)).rejects.toThrow("Controlled response loss");
    expect(await local.records.get(local.space.id)).toMatchObject({
      phase: "stopped",
      generation: 2,
    });
    local.claim().claimId = randomUUID();
    await local.relay.poll(new LocalRpc(local.manager));
    expect(local.creates()).toBe(1);
    expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { spaceId: local.space.id } });
    local.manager.snapshot = async () => ({ ...publicPolicy(local.policy), spaces: [] });
    local.setRequest({ action: "snapshot" }, 3);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({ ok: true });
    expect(
      JSON.parse(await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8")),
    ).toMatchObject({ localGeneration: 2, serverGeneration: 3 });
  });
  test("result upload obeys the server's smaller effective chunk bound without changing the RPC result", async () => {
    const local = await fixture();
    local.partLimit(64);
    await expect(local.relay.poll(local.rpc)).resolves.toBe(1);
    expect(local.uploaded.size).toBeGreaterThan(1);
    expect([...local.uploaded.values()].every((part) => part.length <= 64)).toBe(true);
    expect(local.receipts).toEqual([{ ok: true, result: { spaceId: local.space.id } }]);
  });
  test("one persisted creation marker cannot alias another server resource to the same local VM", async () => {
    const local = await fixture();
    await local.relay.poll(local.rpc);
    local.setRequest({
      action: "create",
      repositoryId: local.space.repositoryId,
      ref: "main",
      operationMarker: local.space.operationMarker,
    });
    local.claim().resourceId = randomUUID();
    await expect(local.relay.poll(local.rpc)).resolves.toBe(1);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_REPLAY_CONFLICT" },
    });
    expect(local.creates()).toBe(1);
  });
  test("read-only snapshot never adopts an SDK UUID by the name of a pending creation manifest", async () => {
    const state = await PrivateState.open(directory);
    const local = await localFixture(state);
    local.space.runtimeId = null;
    local.space.phase = "creating";
    await local.records.put(local.space);
    class ExternalInventory extends SbxRuntime {
      override async list() {
        return [
          {
            id: randomUUID(),
            name: local.space.name,
            agent: "shell" as const,
            status: "running" as const,
            workspaces: [],
            ports: [],
          },
        ];
      }
    }
    const manager = new LocalManager(local.records, {
      runtime: (policy) => new ExternalInventory(policy),
    });
    expect((await manager.snapshot()).spaces).toEqual([
      expect.objectContaining({ id: local.space.id, state: "unknown", phase: "creating" }),
    ]);
    expect((await local.records.get(local.space.id))?.runtimeId).toBeNull();
    await expect(
      manager.create(local.space.repositoryId, "different-ref", local.space.operationMarker),
    ).rejects.toMatchObject({ code: "LOCAL_REPLAY_CONFLICT" });
  });
  test("server lifecycle generations are translated to the separately retained local deletion generation", async () => {
    const local = await fixture();
    await local.relay.poll(local.rpc);
    local.manager.start = async () => {
      local.space.generation += 3;
      await local.records.put(local.space);
      return local.space;
    };
    local.setRequest({ action: "start", spaceId: local.space.id }, 2);
    await local.relay.poll(local.rpc);
    let removed: number | undefined;
    local.manager.remove = async (_id, generation) => {
      removed = generation;
      local.space.generation++;
      await local.records.put(local.space);
    };
    local.setRequest({ action: "delete", spaceId: local.space.id, generation: 3 }, 3);
    await local.relay.poll(local.rpc);
    expect(removed).toBe(4);
    local.setRequest({ action: "operation", spaceId: local.space.id, job: {} }, 2);
    let closures = 0;
    local.manager.close = async () => {
      closures++;
    };
    await expect(local.relay.poll(local.rpc)).resolves.toBe(1);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_GENERATION_CONFLICT" },
    });
    expect(closures).toBe(0);
  });
  test("server observation ticks advance independently without clearing a changed local generation", async () => {
    const local = await fixture();
    await local.relay.poll(local.rpc);
    local.manager.snapshot = async () => ({ ...publicPolicy(local.policy), spaces: [] });
    local.setRequest({ action: "snapshot" }, 3);
    await local.relay.poll(local.rpc);
    const binding = JSON.parse(
      await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8"),
    );
    expect(binding).toMatchObject({ serverGeneration: 3, localGeneration: 1 });
    local.space.generation = 2;
    await local.records.put(local.space);
    local.setRequest({ action: "snapshot" }, 10);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_GENERATION_CONFLICT" },
    });
    expect(
      JSON.parse(await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8")),
    ).toMatchObject({ serverGeneration: 3, localGeneration: 1 });
  });
  test("local recovery rebases only a new server counter and never revives a retained pre-recovery request", async () => {
    const local = await fixture();
    await local.relay.poll(local.rpc);
    local.manager.snapshot = async () => ({ ...publicPolicy(local.policy), spaces: [] });
    local.setRequest({ action: "snapshot" }, 3);
    await local.relay.poll(local.rpc);
    const oldClaim = { ...local.claim() };
    Object.assign(local.space, {
      generation: 2,
      recoveryGeneration: 2,
      failure: null,
      desiredState: "stopped",
      phase: "stopped",
    });
    await local.records.put(local.space);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_GENERATION_CONFLICT" },
    });
    local.setRequest({ action: "start", spaceId: local.space.id }, 3);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_GENERATION_CONFLICT" },
    });
    local.manager.start = async () => {
      local.space.generation++;
      local.space.desiredState = "running";
      local.space.phase = "usable";
      await local.records.put(local.space);
      return local.space;
    };
    local.setRequest({ action: "start", spaceId: local.space.id }, 4);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { accepted: true } });
    expect(
      JSON.parse(await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8")),
    ).toMatchObject({ localGeneration: 3, serverGeneration: 4 });
    // A stale counter remains rejected even after the local tuple was rebased.
    local.setRequest({ action: "snapshot" }, oldClaim.resourceGeneration as number);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_GENERATION_CONFLICT" },
    });
    const result = await local.rpc.handle({
      version: 1,
      id: randomUUID(),
      expiresAt: Date.now() + 60000,
      request: { action: "recover", spaceId: local.space.id },
    });
    expect(result.ok).toBe(false);
  });
  test.each([false, true])(
    "in-flight renewal keeps the same claim and revocation requests existing manager closure (refused: %s)",
    async (refused) => {
      const local = await fixture();
      let entered!: () => void, finish!: () => void;
      const admitted = new Promise<void>((done) => {
        entered = done;
      });
      const held = new Promise<void>((done) => {
        finish = done;
      });
      local.manager.create = async () => {
        entered();
        await held;
        return local.space;
      };
      let closures = 0;
      local.manager.close = async () => {
        closures++;
        finish();
      };
      if (refused) local.refuseRenew();
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      const work = local.relay.poll(local.rpc);
      const outcome = work.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await admitted;
      await jest.advanceTimersByTimeAsync(10_000);
      await local.renewal;
      if (!refused) finish();
      const result = await outcome;
      expect(local.renewals()).toBe(1);
      if (refused) {
        expect(result).toMatchObject({ error: { code: "LOCAL_UNAUTHORIZED" } });
        expect(closures).toBe(1);
        expect(local.receipts).toEqual([]);
      } else {
        expect(result).toEqual({ value: 1 });
        expect(closures).toBe(0);
        expect(local.receipts).toHaveLength(1);
      }
    },
  );
});
