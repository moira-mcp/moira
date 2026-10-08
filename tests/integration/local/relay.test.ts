import { afterEach, beforeEach, describe, expect, test, jest } from "@jest/globals";
import { mkdtemp, realpath, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRelay, relayOrigin } from "../../../packages/local/src/relay.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalRpc } from "../../../packages/local/src/rpc.js";
import { LocalDaemon } from "../../../packages/local/src/daemon.js";
import { SbxRuntime } from "../../../packages/local/src/sbx-runtime.js";
import { adaptSbxRuntime } from "../../../packages/local/src/local-vm-runtime-factory.js";
import { RuntimeDeviceOwner } from "../../../packages/local/src/runtime-device-owner.js";
import { RuntimeOwner } from "../../../packages/local/src/runtime-owner.js";
import { DeviceRuntimeControl } from "../../../packages/local/src/runtime-control.js";
import { publicPolicy, LocalRefusal } from "../../../packages/local/src/policy.js";
import { setEnabled } from "../../../packages/local/src/config.js";
import { localFixture } from "./fixtures.js";
import { canonicalJson } from "../../../packages/shared/src/utils/canonical-json.js";
import {
  LocalCompanion,
  LocalWebControl,
  controlSettings,
} from "../../../packages/local/src/web-control.js";
import { GiB } from "../../../packages/local/src/policy.js";
import {
  MAX_LOCAL_WORK_LEASE_MS,
  type LocalDeviceControlView,
} from "../../../packages/shared/src/codespaces/local-management-types.js";

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
const brokenResponse = (status: number) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError("Controlled HTTP error body loss"));
      },
    }),
    { status },
  );

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
  const device: typeof connection & {
    status: string;
    policy: ReturnType<typeof publicPolicy>;
    control?: LocalDeviceControlView;
  } = { ...connection, status: "active", policy: publicPolicy(local.policy) };
  const resourceId = randomUUID();
  let message: unknown;
  let claim: Record<string, unknown>;
  let bytes: Buffer;
  const claims = new Map<string, Record<string, unknown>>();
  const payloads = new Map<string, Buffer>();
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
  let refusedRenewStatus: number | undefined;
  let nextRenewFailure: "network" | "server" | undefined;
  let nextPartFailure: "network" | "server" | "body" | "unauthorized" | undefined;
  let payloadReads = 0;
  let heartbeatFailure = false;
  let brokenHeartbeatStatus: number | undefined;
  let brokenRenewStatus: number | undefined;
  let brokenIdentityStatus: number | undefined;
  let identityRefusal: { status: number; body: unknown } | undefined;
  let renewals = 0;
  let renewed!: () => void;
  const renewal = new Promise<void>((done) => {
    renewed = done;
  });
  const transport: typeof globalThis.fetch = async (input, options) => {
    options?.signal?.throwIfAborted();
    const url = new URL(String(input));
    const requestId = /\/relay\/([a-f0-9-]{36})\//.exec(url.pathname)?.[1];
    const scopedClaim = requestId ? claims.get(requestId)! : claim;
    expect(url.origin).toBe("https://moira.example");
    expect(url.pathname.startsWith("/prefix/api/local-devices/")).toBe(true);
    expect(options?.redirect).toBe("error");
    expect(new Headers(options?.headers).get("authorization")).toBe(
      `Bearer ${connection.credential}`,
    );
    if (url.pathname.endsWith("/heartbeat")) {
      if (brokenHeartbeatStatus) return brokenResponse(brokenHeartbeatStatus);
      if (heartbeatFailure) {
        heartbeatFailure = false;
        throw new TypeError("Controlled device connection loss");
      }
      return json(device);
    }
    if (url.pathname.endsWith("/identity")) {
      gitIdentityRequests.push(url.pathname);
      if (brokenIdentityStatus) return brokenResponse(brokenIdentityStatus);
      if (identityRefusal)
        return Response.json(identityRefusal.body, { status: identityRefusal.status });
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
      if (brokenRenewStatus) return brokenResponse(brokenRenewStatus);
      const failure = nextRenewFailure;
      nextRenewFailure = undefined;
      if (failure === "network") throw new TypeError("Controlled relay transport failure");
      if (failure === "server") return new Response(null, { status: 503 });
      expect(new Headers(options?.headers).get("X-Moira-Claim-Id")).toBe(scopedClaim.claimId);
      return refusedRenewStatus
        ? new Response(null, { status: refusedRenewStatus })
        : json({ ...scopedClaim, claimExpiresAt: Date.now() + 30_000 });
    }
    if (url.pathname.includes("/payload/0")) {
      payloadReads++;
      expect(new Headers(options?.headers).get("X-Moira-Claim-Id")).toBe(scopedClaim.claimId);
      const offset = Number(url.searchParams.get("offset")),
        length = Number(url.searchParams.get("length"));
      return new Response(
        Uint8Array.from(payloads.get(requestId!)!.subarray(offset, offset + length)),
      );
    }
    if (url.pathname.endsWith("/result-part")) {
      const failure = nextPartFailure;
      nextPartFailure = undefined;
      if (failure === "network") throw new TypeError("Controlled relay transport failure");
      if (failure === "server") return new Response(null, { status: 503 });
      if (failure === "unauthorized") return new Response(null, { status: 401 });
      if (failure === "body")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("Controlled response body loss"));
            },
          }),
        );
      expect(new Headers(options?.headers).get("X-Moira-Claim-Id")).toBe(scopedClaim.claimId);
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
        requestId: ack.requestId,
        digest: ack.digest,
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
  const setRequest = (request: unknown, generation = 1, authority?: "owner-delete") => {
    message = {
      version: 1,
      id: randomUUID(),
      expiresAt: Date.now() + 60_000,
      request,
      ...(authority ? { authority } : {}),
    };
    bytes = Buffer.from(canonicalJson(message));
    const envelope = message as { id: string; expiresAt: number };
    claim = {
      ...connection,
      requestId: envelope.id,
      resourceId,
      resourceGeneration: generation,
      ...(authority ? { authority } : {}),
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
    claims.set(envelope.id, claim);
    payloads.set(envelope.id, bytes);
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
    device,
    message: () => message,
    optIn: async () => {
      const ceiling = {
        cpuCores: 4,
        memoryBytes: 8 * GiB,
        storageBytes: 64 * GiB,
        dockerBytes: 8 * GiB,
        maxLeaseMs: MAX_LOCAL_WORK_LEASE_MS,
      };
      await new LocalWebControl(local.records).optIn(connection, ceiling, true);
      device.control = {
        optedIn: true,
        revision: 0,
        appliedRevision: 0,
        status: "applied",
        settings: controlSettings(local.policy),
        ceiling,
        error: null,
      };
    },
    setRequest,
    claim: () => claim,
    creates: () => creates,
    loseAck: () => {
      loseAck = true;
    },
    refuseRenew: (status = 401) => {
      refusedRenewStatus = status;
    },
    failNextRenew: (kind: "network" | "server") => {
      nextRenewFailure = kind;
    },
    failNextPart: (kind: "network" | "server" | "body" | "unauthorized") => {
      nextPartFailure = kind;
    },
    failNextHeartbeat: () => {
      heartbeatFailure = true;
    },
    revokeDevice: () => {
      device.status = "revoked";
    },
    breakHeartbeatBody: (status: number) => {
      brokenHeartbeatStatus = status;
    },
    breakRenewBody: (status: number) => {
      brokenRenewStatus = status;
    },
    breakIdentityBody: (status: number) => {
      brokenIdentityStatus = status;
    },
    refuseIdentity: (status: number, body: unknown) => {
      identityRefusal = { status, body };
    },
    renewals: () => renewals,
    renewal,
    partLimit: (value: number) => {
      maxPartBytes = value;
    },
    uploaded,
    payloadReads: () => payloadReads,
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
  async function ownerCleanupFixture() {
    const local = await fixture();
    await local.relay.poll(local.rpc);
    await local.optIn();
    const peer = {
      ...local.space,
      id: randomUUID(),
      name: `moira-${randomUUID().replaceAll("-", "")}`,
      runtimeId: "peer-runtime",
      operationMarker: `moira-${"c".repeat(24)}`,
    };
    await local.records.put(peer);
    const inventory = new Map(
      [local.space, peer].map((space) => [
        space.runtimeId!,
        {
          id: space.runtimeId!,
          name: space.name,
          status: "stopped" as const,
          agent: "shell" as const,
        },
      ]),
    );
    let removals = 0;
    class ExternalInventory extends SbxRuntime {
      override async list() {
        return [...inventory.values()];
      }
      override async exact(identity: { name: string; runtimeId: string }) {
        const item = inventory.get(identity.runtimeId);
        if (item && item.name !== identity.name) throw new Error("Fixture identity mismatch");
        return item ?? null;
      }
      override async remove(identity: { name: string; runtimeId: string }) {
        await this.exact(identity);
        removals++;
        inventory.delete(identity.runtimeId);
      }
    }
    local.manager.dependencies.runtime = (policy) => adaptSbxRuntime(new ExternalInventory(policy));
    return { ...local, peer, inventory, removals: () => removals };
  }

  test("owner cleanup deletes only its bound VM and replays a lost ACK without a second physical removal or grant change", async () => {
    const local = await ownerCleanupFixture();
    const policy = await readFile(join(directory, "policy.json"));
    const peer = await local.records.get(local.peer.id);
    local.setRequest(
      { action: "delete", spaceId: local.resourceId, generation: 2 },
      2,
      "owner-delete",
    );
    local.loseAck();
    await expect(local.relay.poll(local.rpc)).rejects.toThrow("Controlled response loss");
    expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { accepted: true } });
    expect(local.inventory.has(local.space.runtimeId!)).toBe(false);
    expect(local.removals()).toBe(1);
    const requestId = local.claim().requestId;
    expect(
      await local.state.read(`relay-request-${requestId}.json`, (value) => value),
    ).toMatchObject({
      authority: "owner-delete",
      message: { authority: "owner-delete", request: { generation: 1, spaceId: local.space.id } },
      sourceMessage: {
        authority: "owner-delete",
        request: { generation: 2, spaceId: local.resourceId },
      },
    });
    local.claim().claimId = randomUUID();
    await new LocalRelay(local.records, local.transport).poll(new LocalRpc(local.manager));
    expect(local.removals()).toBe(1);
    expect(local.receipts.at(-1)).toEqual(local.receipts.at(-2));
    expect(await local.records.get(local.space.id)).toMatchObject({
      phase: "deleted",
      desiredState: "deleted",
    });
    expect(await local.records.get(local.peer.id)).toEqual(peer);
    expect(local.inventory.has(local.peer.runtimeId!)).toBe(true);
    expect(await readFile(join(directory, "policy.json"))).toEqual(policy);
    const retained = await local.state.read(
      `relay-request-${requestId}.json`,
      (value) => value as { message: Record<string, unknown> },
    );
    const changedAuthority = { ...retained!.message };
    delete changedAuthority.authority;
    expect(await new LocalRpc(local.manager).replay(changedAuthority)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_REPLAY_CONFLICT" },
    });
    delete local.claim().authority;
    await local.relay.poll(new LocalRpc(local.manager));
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_REPLAY_CONFLICT" },
    });
    expect(local.removals()).toBe(1);
    await local.manager.close();
  });

  test.each([
    "missing-local",
    "revoked-server",
    "wrong-owner",
    "wrong-device",
    "wrong-connection",
    "wrong-origin",
    "wrong-generation",
    "wrong-target",
    "changed-local-generation",
    "mismatched-authority",
  ] as const)(
    "owner cleanup refuses %s without deleting either VM or changing its binding",
    async (invalid) => {
      const local = await ownerCleanupFixture();
      const key = `relay-space-${local.resourceId}.json`;
      const binding = await local.state.read(key, (value) => value);
      local.setRequest(
        {
          action: "delete",
          spaceId: invalid === "wrong-target" ? local.peer.id : local.resourceId,
          generation: 2,
        },
        2,
        "owner-delete",
      );
      if (invalid === "missing-local") await local.state.remove("web-control.json");
      if (invalid === "revoked-server") local.device.control!.optedIn = false;
      if (
        [
          "wrong-owner",
          "wrong-device",
          "wrong-connection",
          "wrong-origin",
          "wrong-generation",
        ].includes(invalid)
      ) {
        const approval = await local.state.read(
          "web-control.json",
          (value) => value as Record<string, unknown>,
        );
        const fields: Record<string, string> = {
          "wrong-owner": "userId",
          "wrong-device": "deviceId",
          "wrong-connection": "connectionId",
          "wrong-origin": "origin",
          "wrong-generation": "deviceGeneration",
        };
        const field = fields[invalid];
        await local.state.write("web-control.json", {
          ...approval,
          [field]:
            field === "deviceGeneration"
              ? 8
              : field === "origin"
                ? "https://another.example"
                : randomUUID(),
        });
      }
      if (invalid === "changed-local-generation")
        await local.records.put({ ...local.space, generation: 2 });
      if (invalid === "mismatched-authority") delete local.claim().authority;
      const outcome = await local.relay.poll(local.rpc).catch((error: unknown) => error);
      if (invalid.startsWith("wrong-") && invalid !== "wrong-target")
        expect(outcome).toMatchObject({ code: "LOCAL_IDENTITY_CHANGED" });
      else
        expect(local.receipts.at(-1)).toMatchObject({
          ok: false,
          error: {
            code:
              invalid === "wrong-target"
                ? "LOCAL_IDENTITY_CHANGED"
                : invalid === "changed-local-generation"
                  ? "LOCAL_GENERATION_CONFLICT"
                  : invalid === "mismatched-authority"
                    ? "LOCAL_PAYLOAD_CHANGED"
                    : "LOCAL_UNAUTHORIZED",
          },
        });
      expect(local.removals()).toBe(0);
      expect(local.inventory.size).toBe(2);
      expect(await local.state.read(key, (value) => value)).toEqual(binding);
      await local.manager.close();
    },
  );

  test.each(["local", "server"] as const)(
    "cached owner cleanup outcome still requires current %s web-control approval",
    async (side) => {
      const local = await ownerCleanupFixture();
      local.setRequest(
        { action: "delete", spaceId: local.resourceId, generation: 2 },
        2,
        "owner-delete",
      );
      await local.relay.poll(local.rpc);
      expect(local.receipts.at(-1)).toMatchObject({ ok: true });
      if (side === "local") await local.state.remove("web-control.json");
      else local.device.control!.optedIn = false;
      local.claim().claimId = randomUUID();
      await new LocalRelay(local.records, local.transport).poll(new LocalRpc(local.manager));
      expect(local.receipts.at(-1)).toMatchObject({
        ok: false,
        error: { code: "LOCAL_UNAUTHORIZED" },
      });
      expect(local.removals()).toBe(1);
      expect(local.inventory.has(local.peer.runtimeId!)).toBe(true);
      await local.manager.close();
    },
  );

  test("bare RPC owner flag cannot grant deletion and an ordinary agent refusal leaves no deletion phase", async () => {
    const local = await ownerCleanupFixture();
    local.setRequest(
      { action: "delete", spaceId: local.space.id, generation: 1 },
      2,
      "owner-delete",
    );
    expect(await local.rpc.handle(local.message())).toMatchObject({
      ok: false,
      error: { code: "LOCAL_UNAUTHORIZED" },
    });
    local.setRequest({ action: "delete", spaceId: local.resourceId, generation: 2 }, 2);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_DELETE_APPROVAL_REQUIRED" },
    });
    expect(await local.records.get(local.space.id)).toMatchObject({
      phase: "usable",
      desiredState: "running",
      generation: 1,
    });
    expect(local.removals()).toBe(0);
    await local.manager.close();
  });

  test.each(["create", "start", "stop", "operation"] as const)(
    "owner deletion authority cannot admit %s",
    async (action) => {
      const local = await ownerCleanupFixture();
      const request =
        action === "create"
          ? {
              action,
              repositoryId: local.space.repositoryId,
              ref: "main",
              operationMarker: `moira-${"d".repeat(24)}`,
            }
          : {
              action,
              spaceId: local.resourceId,
              ...(action === "operation"
                ? {
                    job: {
                      version: 1,
                      action: "execute",
                      remoteMarker: `moira-op-${"e".repeat(32)}`,
                      argv: ["node", "-e", "process.stdout.write('guest-only-value')"],
                      stdin: "",
                      timeoutMs: 1000,
                      maxStdoutBytes: 1024,
                      maxStderrBytes: 1024,
                      maxRetainedBytes: 1024,
                    },
                  }
                : {}),
            };
      local.setRequest(request, 2, "owner-delete");
      await local.relay.poll(local.rpc);
      expect(local.receipts.at(-1)).toMatchObject({
        ok: false,
        error: { code: "LOCAL_REQUEST_INVALID" },
      });
      expect(local.creates()).toBe(1);
      expect(local.removals()).toBe(0);
      expect(await local.records.get(local.space.id)).toMatchObject({
        generation: 1,
        desiredState: "running",
        phase: "usable",
      });
      await local.manager.close();
    },
  );

  test.each(["disabled", "expired"] as const)(
    "%s companion performs exact owner observation and cleanup without opening work",
    async (mode) => {
      const local = await ownerCleanupFixture();
      await local.state.write("policy.json", {
        ...local.policy,
        ...(mode === "disabled" ? { enabled: false } : { leaseUntil: Date.now() - 1 }),
      });
      const policy = await readFile(join(directory, "policy.json"));
      const open = jest.spyOn(local.manager, "open").mockImplementation(async () => {
        throw new Error("Management must not open brokers");
      });
      const companion = new LocalCompanion(local.manager, local.relay);
      local.setRequest({ action: "snapshot" }, 2, "owner-delete");
      try {
        expect(await companion.cycle()).toBe(false);
        expect(local.receipts.at(-1)).toMatchObject({
          ok: true,
          result: { spaces: [{ id: local.space.id, state: "stopped" }] },
        });
        for (const request of [
          { action: "start", spaceId: local.resourceId },
          {
            action: "operation",
            spaceId: local.resourceId,
            job: { version: 1, action: "execute", remoteMarker: `moira-op-${"e".repeat(32)}` },
          },
        ]) {
          local.setRequest(request, 3);
          expect(await companion.cycle()).toBe(false);
          expect(local.receipts.at(-1)).toMatchObject({
            ok: false,
            error: { code: mode === "disabled" ? "LOCAL_DISABLED" : "LOCAL_LEASE_EXPIRED" },
          });
        }
        local.setRequest(
          { action: "delete", spaceId: local.resourceId, generation: 3 },
          3,
          "owner-delete",
        );
        expect(await companion.cycle()).toBe(false);
        expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { accepted: true } });
        expect(local.removals()).toBe(1);
        expect(local.inventory.has(local.peer.runtimeId!)).toBe(true);
        expect(open).not.toHaveBeenCalled();
        expect(await readFile(join(directory, "policy.json"))).toEqual(policy);
        await expect(local.state.read("broker.json", (value) => value)).resolves.toBeNull();
      } finally {
        await local.manager.close();
      }
    },
  );

  test.each([2, 3])(
    "incomplete bootstrap snapshot at server intent %s reports its own failure without rebinding or admitting work",
    async (generation) => {
      const local = await fixture();
      await local.relay.poll(local.rpc);
      const key = `relay-space-${local.resourceId}.json`;
      const binding = await local.state.read(key, (value) => value as Record<string, unknown>);
      await local.state.write(key, { ...binding, serverGeneration: 2 });
      const before = await local.state.read(key, (value) => value);
      Object.assign(local.space, {
        generation: 2,
        phase: "failed",
        desiredState: "stopped",
        failure: "LOCAL_UNAUTHORIZED",
        lastStartedAt: null,
      });
      await local.records.put(local.space);
      const snapshot = jest.spyOn(local.manager, "snapshot").mockResolvedValue({
        ...publicPolicy(local.policy),
        spaces: [{ ...local.space, state: "stopped", nativeStopConfirmed: true }],
      });
      const start = jest.spyOn(local.manager, "start");
      const dispatch = jest.spyOn(local.rpc.jobs, "dispatch");
      local.setRequest({ action: "snapshot" }, generation);
      await local.relay.poll(local.rpc);
      expect(local.receipts.at(-1)).toMatchObject({
        ok: true,
        result: {
          spaces: [
            {
              id: local.space.id,
              generation: 2,
              failure: "LOCAL_UNAUTHORIZED",
              lastStartedAt: null,
            },
          ],
        },
      });
      expect(snapshot).toHaveBeenCalledWith(local.space.id);
      expect(await local.state.read(key, (value) => value)).toEqual(before);
      for (const request of [
        { action: "start", spaceId: local.space.id },
        { action: "operation", spaceId: local.space.id, job: {} },
      ]) {
        local.setRequest(request, generation);
        await local.relay.poll(local.rpc);
        expect(local.receipts.at(-1)).toMatchObject({
          ok: false,
          error: {
            code: request.action === "operation" ? "LOCAL_NOT_RUNNING" : "LOCAL_SETUP_INCOMPLETE",
          },
        });
      }
      expect(start).toHaveBeenCalledTimes(1);
      expect(dispatch).not.toHaveBeenCalled();
      expect(await local.state.read(key, (value) => value)).toEqual(before);
    },
  );

  test.each(["stale", "foreign-manifest", "foreign-authority", "running", "initialized"] as const)(
    "read-only observation reports current state or refuses foreign identity (%s)",
    async (variant) => {
      const local = await fixture();
      await local.relay.poll(local.rpc);
      const key = `relay-space-${local.resourceId}.json`;
      const binding = await local.state.read(key, (value) => value as Record<string, unknown>);
      await local.state.write(key, { ...binding, serverGeneration: 2 });
      const before = await local.state.read(key, (value) => value);
      Object.assign(local.space, {
        generation: 2,
        phase: variant === "running" ? "usable" : "failed",
        desiredState: variant === "running" ? "running" : "stopped",
        failure: "LOCAL_UNAUTHORIZED",
        lastStartedAt: variant === "initialized" ? Date.now() : null,
      });
      if (variant === "foreign-manifest") local.space.operationMarker = `moira-${"f".repeat(24)}`;
      await local.records.put(local.space);
      const snapshot = jest.spyOn(local.manager, "snapshot");
      local.setRequest({ action: "snapshot" }, variant === "stale" ? 1 : 2);
      if (variant === "foreign-authority") local.claim().connectionId = randomUUID();
      if (variant === "foreign-authority")
        await expect(local.relay.poll(local.rpc)).rejects.toMatchObject({
          code: "LOCAL_IDENTITY_CHANGED",
        });
      else if (variant === "foreign-manifest") {
        await local.relay.poll(local.rpc);
        expect(local.receipts.at(-1)).toMatchObject({
          ok: false,
          error: {
            code:
              variant === "foreign-manifest"
                ? "LOCAL_IDENTITY_CHANGED"
                : "LOCAL_GENERATION_CONFLICT",
          },
        });
      } else {
        await local.relay.poll(local.rpc);
        expect(local.receipts.at(-1)).toMatchObject({ ok: true });
      }
      expect(snapshot).toHaveBeenCalledTimes(
        ["foreign-authority", "foreign-manifest"].includes(variant) ? 0 : 1,
      );
      expect(await local.state.read(key, (value) => value)).toEqual(before);
    },
  );

  test.each([401, 403])(
    "Git identity HTTP %s preserves only allowlisted owner advice",
    async (status) => {
      const local = await fixture();
      await local.relay.poll(local.rpc);
      for (const message of [
        "Refresh GitHub repository access in Settings.",
        "Add this repository to the Moira GitHub App installation in Settings.",
        "Reconnect GitHub to restore the verified commit identity.",
      ]) {
        local.refuseIdentity(status, {
          success: false,
          error: { code: "LOCAL_UNAUTHORIZED", message },
        });
        await expect(
          local.relay.gitIdentity(local.space.id, local.space.repositoryId),
        ).rejects.toMatchObject({ code: "LOCAL_UNAUTHORIZED", message });
      }
      for (const body of [
        {
          success: false,
          error: { code: "LOCAL_UNAUTHORIZED", message: "Private token and host path" },
        },
        {
          success: false,
          error: { code: "UNRELATED", message: "Refresh GitHub repository access in Settings." },
        },
        {
          success: false,
          error: {
            code: "LOCAL_UNAUTHORIZED",
            message: "Refresh GitHub repository access in Settings.",
            private: "secret",
          },
        },
      ]) {
        local.refuseIdentity(status, body);
        await expect(
          local.relay.gitIdentity(local.space.id, local.space.repositoryId),
        ).rejects.toMatchObject({
          code: status === 401 ? "LOCAL_UNAUTHORIZED" : "LOCAL_RELAY_REFUSED",
          message: "Moira refused the current local connection or relay claim.",
        });
      }
    },
  );

  test("legacy stopped record without first usability timestamp refuses work but retains exact cleanup", async () => {
    const local = await fixture();
    await local.relay.poll(local.rpc);
    Object.assign(local.space, {
      generation: 2,
      desiredState: "stopped",
      phase: "stopped",
      failure: null,
      lastStartedAt: null,
    });
    await local.records.put(local.space);
    local.manager.dependencies.storage = async () => {};
    const protect = jest.fn(async () => {});
    const owner = new RuntimeOwner(local.records, local.space.id, protect, async () => {});
    await expect(owner.admit(true)).rejects.toMatchObject({ code: "LOCAL_SETUP_INCOMPLETE" });
    await expect(local.manager.start(local.space.id)).rejects.toMatchObject({
      code: "LOCAL_SETUP_INCOMPLETE",
    });
    expect(protect).not.toHaveBeenCalled();
    expect(await local.records.get(local.space.id)).toMatchObject({
      generation: 2,
      desiredState: "stopped",
      phase: "stopped",
      lastStartedAt: null,
    });
    const key = `relay-space-${local.resourceId}.json`;
    const before = await local.state.read(key, (value) => value);
    jest.spyOn(local.manager, "snapshot").mockImplementation(async () => ({
      ...publicPolicy(local.policy),
      spaces: [{ ...local.space, state: "stopped", nativeStopConfirmed: true }],
    }));
    local.setRequest({ action: "snapshot" }, 3);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: true,
      result: { spaces: [{ generation: 2, lastStartedAt: null }] },
    });
    expect(await local.state.read(key, (value) => value)).toEqual(before);
    const remove = jest
      .spyOn(local.manager, "remove")
      .mockImplementation(async (_id, generation) => {
        expect(generation).toBe(2);
        const current = (await local.records.get(local.space.id))!;
        Object.assign(current, { generation: 4, desiredState: "deleted", phase: "deleted" });
        await local.records.put(current);
      });
    local.setRequest({ action: "delete", spaceId: local.space.id, generation: 3 }, 3);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { accepted: true } });
    expect(remove).toHaveBeenCalledTimes(1);
  });
  test.each(["manager-read", "owner-ready"] as const)(
    "stop expected generation remains fenced at native admission after %s changes it",
    async (boundary) => {
      const local = await fixture();
      local.space.generation = 2;
      await local.records.put(local.space);
      const owner = new RuntimeOwner(
        local.records,
        local.space.id,
        async () => {
          throw new Error("No stale native effect may reach custody");
        },
        async () => {},
      );
      const retire = jest.fn(async (_id: string, generation: number) =>
        owner.manage(generation, false),
      );
      const actualGet = local.records.get.bind(local.records);
      let reads = 0;
      jest.spyOn(local.records, "get").mockImplementation(async (id) => {
        if (boundary === "manager-read" && ++reads === 2) {
          const space = (await actualGet(id))!;
          space.generation = 3;
          await local.records.put(space);
        }
        return actualGet(id);
      });
      local.manager.dependencies.guard = async () => {
        if (boundary === "owner-ready") {
          const space = (await actualGet(local.space.id))!;
          space.generation = 3;
          await local.records.put(space);
        }
        return {
          active: true,
          stop: async () => {},
          observe: async () => [],
          remove: async () => {},
          retire,
          space: async () => {
            throw new Error("Stop must not admit guest work");
          },
        };
      };
      const result = await local.rpc.handle({
        version: 1,
        id: randomUUID(),
        expiresAt: Date.now() + 60000,
        request: { action: "stop", spaceId: local.space.id, generation: 2 },
      });
      expect(result).toMatchObject({ ok: false, error: { code: "LOCAL_GENERATION_CONFLICT" } });
      expect(await actualGet(local.space.id)).toMatchObject({
        generation: 3,
        desiredState: "running",
        phase: "usable",
      });
      if (boundary === "manager-read") expect(retire).not.toHaveBeenCalled();
      else expect(retire).toHaveBeenCalledWith(local.space.id, 2);
    },
  );

  test.each([null, "LOCAL_NETWORK_CHANGED"] as const)(
    "injected runtime closure preserves creating-origin readiness and failure (%s)",
    async (failure) => {
      const local = await fixture();
      Object.assign(local.space, { phase: "creating", lastStartedAt: null, failure });
      await local.records.put(local.space);
      class ClosedRuntime extends SbxRuntime {
        override async stop() {}
        override async exact(identity: { name: string; runtimeId: string }) {
          return {
            id: identity.runtimeId,
            name: identity.name,
            agent: "shell",
            status: "stopped" as const,
          };
        }
      }
      local.manager.dependencies.runtime = (policy) => adaptSbxRuntime(new ClosedRuntime(policy));
      expect(await local.manager.stop(local.space.id)).toMatchObject({
        phase: "failed",
        desiredState: "stopped",
        generation: 2,
        failure: failure ?? "LOCAL_SETUP_INCOMPLETE",
      });
      await expect(local.manager.start(local.space.id)).rejects.toMatchObject({
        code: "LOCAL_SETUP_INCOMPLETE",
      });
    },
  );

  test.each([null, "LOCAL_NETWORK_CHANGED"] as const)(
    "creating-origin confirmed stop preserves incomplete guest readiness and original failure (%s)",
    async (failure) => {
      const local = await fixture();
      Object.assign(local.space, { phase: "creating", lastStartedAt: null, failure });
      await local.records.put(local.space);
      const owner = new RuntimeOwner(
        local.records,
        local.space.id,
        async () => {},
        async () => {},
      );
      await owner.admit();
      await owner.quiesce();
      // This isolated boundary substitutes physical completion, not bootstrap readiness.
      await owner.confirmStopped();
      const stopped = (await local.records.get(local.space.id))!;
      expect(stopped).toMatchObject({
        desiredState: "stopped",
        phase: "failed",
        generation: 2,
        lastStartedAt: null,
        failure: failure ?? "LOCAL_SETUP_INCOMPLETE",
      });
      await expect(local.manager.start(local.space.id)).rejects.toMatchObject({
        code: "LOCAL_SETUP_INCOMPLETE",
      });
      await expect(
        new RuntimeOwner(
          local.records,
          local.space.id,
          async () => {},
          async () => {},
        ).admit(true),
      ).rejects.toMatchObject({ code: "LOCAL_SETUP_INCOMPLETE" });
      expect(stopped.recoveryGeneration).toBeUndefined();
    },
  );
  test("ordinary work and Git remain usable when lifecycle counters disagree", async () => {
    const local = await fixture();
    await local.relay.poll(local.rpc);
    const key = `relay-space-${local.resourceId}.json`;
    const previous = await local.state.read(key, (value) => value as Record<string, unknown>);
    await local.state.write(key, { ...previous, serverGeneration: 2 });
    let authority: unknown;
    const dispatch = jest.spyOn(local.rpc.jobs, "dispatch").mockImplementation(async () => {
      authority = await local.relay.gitAuthority(local.space.id, local.space.repositoryId);
      return { state: "complete" };
    });
    await local.records.put({ ...local.space, generation: 34 });
    local.setRequest({ action: "operation", spaceId: local.space.id, job: { kind: "git" } }, 3);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { state: "complete" } });
    expect(authority).toMatchObject({ resourceId: local.resourceId });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await local.state.read(key, (value) => value)).toMatchObject({
      serverGeneration: 2,
      localGeneration: 1,
    });
  });

  test("stop cancels a downloaded command before native admission even after a subsequent start", async () => {
    const local = await fixture();
    await local.relay.poll(local.rpc);
    const native: string[] = [];
    local.manager.dependencies.guard = async () => ({
      active: true,
      stop: async () => {},
      observe: async () => [],
      remove: async () => {},
      retire: async () => {
        const space = (await local.records.get(local.space.id))!;
        await local.records.put({
          ...space,
          generation: space.generation + 1,
          desiredState: "stopped",
          phase: "stopped",
        });
      },
      space: async () => ({
        active: true,
        prepare: async () => {},
        validate: async () => {},
        stop: async () => {},
        operation: async (request) => {
          native.push((request as { remoteMarker: string }).remoteMarker);
          return Buffer.from(JSON.stringify({ ok: true, result: { state: "running" } }));
        },
      }),
    });
    let enter!: () => void;
    const entered = new Promise<void>((done) => {
      enter = done;
    });
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    const original = local.manager.dispatchGuest.bind(local.manager);
    let first = true;
    jest.spyOn(local.manager, "dispatchGuest").mockImplementation(async (id, work, signal) => {
      if (first) {
        first = false;
        enter();
        await held;
      }
      return original(id, work, signal);
    });
    const job = (remoteMarker: string) => ({
      version: 1,
      action: "execute",
      remoteMarker,
      argv: ["echo", "accepted"],
      stdin: "",
      timeoutMs: 1000,
      maxStdoutBytes: 1024,
      maxStderrBytes: 1024,
      maxRetainedBytes: 2048,
    });
    const oldMarker = `moira-op-${"7a".repeat(16)}`;
    local.setRequest({ action: "operation", spaceId: local.space.id, job: job(oldMarker) });
    await local.relay.poll(local.rpc, undefined, true);
    await entered;
    try {
      local.setRequest({ action: "stop", spaceId: local.space.id }, 2);
      await local.relay.poll(local.rpc);
      expect(local.receipts.at(-1)).toMatchObject({ ok: true });
      local.manager.start = async () => {
        const space = (await local.records.get(local.space.id))!;
        const started = {
          ...space,
          generation: space.generation + 1,
          desiredState: "running" as const,
          phase: "usable" as const,
        };
        await local.records.put(started);
        return started;
      };
      local.setRequest({ action: "start", spaceId: local.space.id }, 3);
      await local.relay.poll(local.rpc);
      expect(local.receipts.at(-1)).toMatchObject({ ok: true });
      const freshMarker = `moira-op-${"7b".repeat(16)}`;
      local.setRequest({ action: "operation", spaceId: local.space.id, job: job(freshMarker) }, 3);
      await local.relay.poll(local.rpc);
      expect(native).toEqual([freshMarker]);
    } finally {
      release();
      await local.relay.drain();
      await local.manager.close();
    }
    expect(native).not.toContain(oldMarker);
  });

  test.each(["stop", "delete"] as const)(
    "fresh %s cleans a failed creation's own newer stopped generation without admitting work",
    async (action) => {
      const local = await fixture();
      await local.relay.poll(local.rpc);
      const key = `relay-space-${local.resourceId}.json`;
      const binding = await local.state.read(key, (value) => value as Record<string, unknown>);
      await local.state.write(key, { ...binding, serverGeneration: 2 });
      Object.assign(local.space, {
        generation: 2,
        phase: "failed",
        desiredState: "stopped",
        failure: "LOCAL_SETUP_INCOMPLETE",
        lastStartedAt: null,
      });
      delete local.space.recoveryGeneration;
      await local.records.put(local.space);
      await local.state.write(`result-${binding!.createRequestId}.json`, {
        ok: false,
        error: { code: "LOCAL_SETUP_INCOMPLETE", message: "Bootstrap stopped after adoption" },
      });
      const start = jest.spyOn(local.manager, "start");
      const work = jest.spyOn(local.rpc.jobs, "dispatch");
      local.setRequest({ action: "start", spaceId: local.space.id }, 3);
      await local.relay.poll(local.rpc);
      expect(local.receipts.at(-1)).toMatchObject({
        ok: false,
        error: { code: "LOCAL_SETUP_INCOMPLETE" },
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(work).not.toHaveBeenCalled();
      local.setRequest({ action: "operation", spaceId: local.space.id, job: { kind: "git" } }, 3);
      await local.relay.poll(local.rpc);
      expect(local.receipts.at(-1)).toMatchObject({
        ok: false,
        error: { code: "LOCAL_NOT_RUNNING" },
      });
      const cleanup =
        action === "stop"
          ? jest.spyOn(local.manager, "stop").mockImplementation(async () => {
              const space = (await local.records.get(local.space.id))!;
              space.generation++;
              await local.records.put(space);
              return space;
            })
          : jest.spyOn(local.manager, "remove").mockImplementation(async (_id, generation) => {
              expect(generation).toBe(2);
              const space = (await local.records.get(local.space.id))!;
              Object.assign(space, { generation: 4, phase: "deleted", desiredState: "deleted" });
              await local.records.put(space);
            });
      local.setRequest(
        action === "stop"
          ? { action, spaceId: local.space.id }
          : { action, spaceId: local.space.id, generation: 3 },
        3,
      );
      await local.relay.poll(local.rpc);
      expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { accepted: true } });
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(await local.state.read(key, (value) => value)).toMatchObject({
        serverGeneration: 3,
        localGeneration: action === "stop" ? 3 : 4,
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(work).not.toHaveBeenCalled();
    },
  );

  test("held peer Engine metadata does not serialize healthy protection or scoped observation", async () => {
    const local = await fixture();
    local.space.runtimeId = randomUUID();
    await local.records.put(local.space);
    const peer = {
      ...local.space,
      id: randomUUID(),
      name: `moira-${randomUUID().replaceAll("-", "")}`,
      runtimeId: randomUUID(),
    };
    await local.records.put(peer);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((done) => {
      entered = done;
    });
    const held = new Promise<void>((done) => {
      release = done;
    });
    const native = jest
      .spyOn(DeviceRuntimeControl.prototype, "protect")
      .mockResolvedValue(undefined);
    jest.spyOn(DeviceRuntimeControl.prototype, "assertDockerHeld").mockResolvedValue(undefined);
    jest.spyOn(DeviceRuntimeControl.prototype, "holdsWorker").mockReturnValue(true);
    jest.spyOn(DeviceRuntimeControl.prototype, "hasUnindexedWorkers").mockReturnValue(false);
    jest.spyOn(SbxRuntime.prototype, "list").mockResolvedValue([
      { id: local.space.runtimeId!, name: local.space.name, status: "running", agent: "shell" },
      { id: peer.runtimeId!, name: peer.name, status: "running", agent: "shell" },
    ]);
    jest.spyOn(SbxRuntime.prototype, "verifySettings").mockResolvedValue(undefined);
    jest.spyOn(SbxRuntime.prototype, "verifyGlobalNetworkPolicy").mockResolvedValue(undefined);
    jest.spyOn(SbxRuntime.prototype, "containerIdentity").mockImplementation(async (name) => {
      if (name === peer.name) {
        entered();
        await held;
      }
      return {
        name,
        containerId: createHash("sha256").update(name).digest("hex"),
        state: "running",
      };
    });
    const owner = new RuntimeDeviceOwner(local.records, local.policy);
    const bad = owner.observe(peer.id);
    try {
      await Promise.race([
        waiting,
        bad.then(() => {
          throw new Error("Peer observation unexpectedly completed before barrier");
        }),
      ]);
      await owner.protect(local.space.id);
      const healthy = await owner.observe(local.space.id);
      expect(healthy).toEqual([
        { id: local.space.runtimeId, name: local.space.name, status: "running" },
      ]);
      expect(native).toHaveBeenCalled();
    } finally {
      release();
      await bad;
    }
  });

  test.each(["matching", "foreign-generation", "missing-tuple"] as const)(
    "completed management outcome repairs a crashed binding only with exact receipt (%s)",
    async (variant) => {
      const local = await fixture();
      await local.relay.poll(local.rpc);
      const key = `relay-space-${local.resourceId}.json`;
      const original = await local.state.read(key, (value) => value as Record<string, unknown>);
      const stop = jest.spyOn(local.manager, "stop").mockImplementation(async () => {
        const space = (await local.records.get(local.space.id))!;
        space.desiredState = "stopped";
        space.phase = "stopped";
        space.generation++;
        await local.records.put(space);
        return space;
      });
      local.setRequest({ action: "stop", spaceId: local.space.id }, 4);
      const normal = local.state.write.bind(local.state);
      const gate = jest.spyOn(local.state, "write").mockImplementation(async (name, value) => {
        if (name === key && (value as { serverGeneration?: number }).serverGeneration === 4)
          throw new Error("Controlled crash after RPC completion");
        await normal(name, value);
      });
      await expect(local.relay.poll(local.rpc)).rejects.toThrow(
        "Controlled crash after RPC completion",
      );
      gate.mockRestore();
      expect(stop).toHaveBeenCalledTimes(1);
      if (variant === "foreign-generation") {
        const space = (await local.records.get(local.space.id))!;
        space.generation++;
        await local.records.put(space);
      } else if (variant === "missing-tuple") {
        await local.state.write(`result-${local.claim().requestId}.json`, {
          ok: true,
          result: { accepted: true },
        });
      }
      const reads = local.payloadReads();
      await local.relay.poll(local.rpc);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(local.payloadReads()).toBe(reads);
      expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { accepted: true } });
      expect(await local.state.read(key, (value) => value)).toMatchObject(
        variant === "matching" ? { serverGeneration: 4, localGeneration: 2 } : original!,
      );
      if (variant === "matching") {
        local.setRequest({ action: "stop", spaceId: local.space.id }, 5);
        await local.relay.poll(local.rpc);
        expect(stop).toHaveBeenCalledTimes(2);
      }
    },
  );
  test("retained completed outcome skips strict input after resource generation advances without rerunning work", async () => {
    const local = await fixture();
    await local.relay.poll(local.rpc);
    const key = `relay-space-${local.resourceId}.json`;
    const binding = await local.state.read(key, (value) => value as Record<string, unknown>);
    await local.state.write(key, { ...binding, serverGeneration: 3 });
    const reads = local.payloadReads();
    await local.relay.poll(local.rpc);
    expect(local.creates()).toBe(1);
    expect(local.payloadReads()).toBe(reads);
    expect(local.receipts).toHaveLength(2);
    expect(local.receipts[1]).toEqual(local.receipts[0]);
    expect(await local.state.read(key, (value) => value)).toMatchObject({ serverGeneration: 3 });
    local.claim().digest = "b".repeat(64);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_REPLAY_CONFLICT" },
    });
    expect(local.creates()).toBe(1);
    expect(local.payloadReads()).toBe(reads);
    local.claim().userId = "another-owner";
    await expect(local.relay.poll(local.rpc)).rejects.toMatchObject({
      code: "LOCAL_IDENTITY_CHANGED",
    });
    expect(local.creates()).toBe(1);
  });

  test("request-scoped result refusal with confirmed device does not fault the next background claim", async () => {
    const local = await fixture();
    local.failNextPart("unauthorized");
    await local.relay.poll(local.rpc, undefined, true);
    await local.relay.drain();
    expect(local.receipts).toEqual([]);
    const reads = local.payloadReads();
    await local.relay.poll(local.rpc, undefined, true);
    await local.relay.drain();
    expect(local.receipts).toHaveLength(1);
    expect(local.creates()).toBe(1);
    expect(local.payloadReads()).toBe(reads);
    const snapshot = jest.spyOn(local.manager, "snapshot").mockResolvedValue({
      ...publicPolicy(local.policy),
      spaces: [],
    });
    // A fresh claim proves the refused delivery did not put the whole poller into backoff.
    local.setRequest({ action: "snapshot" }, 2);
    await local.relay.poll(local.rpc, undefined, true);
    await local.relay.drain();
    expect(local.receipts).toHaveLength(2);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });
  test.each(["valid", "completed", "expired", "other-resource", "changed-source"] as const)(
    "private bootstrap after scoped creation observation accepts only its own live accepted intent (%s)",
    async (variant) => {
      const local = await fixture();
      local.policy.repositories[0].private = true;
      local.policy.repositories[0].allowPush = true;
      await local.state.write("policy.json", local.policy);
      let entered!: () => void, release!: () => void;
      const preparing = new Promise<void>((done) => {
        entered = done;
      });
      const held = new Promise<void>((done) => {
        release = done;
      });
      local.manager.create = async (repositoryId, ref, operationMarker, onAdmitted) => {
        Object.assign(local.space, { repositoryId, ref, operationMarker, phase: "creating" });
        await local.records.put(local.space);
        onAdmitted?.();
        entered();
        await held;
        local.space.phase = "usable";
        await local.records.put(local.space);
        return local.space;
      };
      const createId = String(local.claim().requestId);
      await local.relay.poll(local.rpc, undefined, true);
      await preparing;
      local.manager.snapshot = async () => ({ ...publicPolicy(local.policy), spaces: [] });
      local.setRequest({ action: "snapshot" }, 2);
      try {
        await local.relay.poll(local.rpc);
        const binding = JSON.parse(
          await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8"),
        );
        expect(binding).toMatchObject({
          localSpaceId: local.space.id,
          localGeneration: 1,
          serverGeneration: 2,
        });
        const key = `relay-request-${createId}.json`;
        if (variant === "completed") {
          const journal = JSON.parse(await readFile(join(directory, "requests.json"), "utf8"));
          journal.find((entry: { id: string }) => entry.id === createId).state = "complete";
          await local.state.write("requests.json", journal);
        } else if (variant !== "valid") {
          const intent = JSON.parse(await readFile(join(directory, key), "utf8"));
          if (variant === "expired") intent.message.expiresAt = Date.now() - 1;
          if (variant === "other-resource") intent.resourceId = randomUUID();
          if (variant === "changed-source") intent.message.request.ref = "another-branch";
          await local.state.write(key, intent);
        }
        if (variant === "valid") {
          expect(await local.relay.gitIdentity(local.space.id, local.space.repositoryId)).toEqual({
            name: "Fixture Owner",
            email: "owner@example.test",
          });
          expect(local.gitIdentityRequests).toEqual([
            `/prefix/api/local-devices/github/${local.resourceId}/2/identity`,
          ]);
        } else {
          await expect(
            local.relay.gitIdentity(local.space.id, local.space.repositoryId),
          ).rejects.toMatchObject({ code: "LOCAL_CREATE_UNKNOWN" });
          expect(local.gitIdentityRequests).toEqual([]);
        }
      } finally {
        release();
        await local.relay.drain();
      }
    },
  );

  test("native remove refusal returns the exact fenced generation through RPC and permits a fresh same-VM retry", async () => {
    const local = await fixture();
    local.policy.repositories[0].allowDelete = true;
    await local.state.write("policy.json", local.policy);
    await local.relay.poll(local.rpc);
    let removed = false;
    let fail = true;
    jest.spyOn(SbxRuntime.prototype, "stop").mockResolvedValue(undefined);
    jest.spyOn(SbxRuntime.prototype, "exact").mockImplementation(async () =>
      removed
        ? null
        : {
            id: local.space.runtimeId!,
            name: local.space.name,
            status: "stopped",
            agent: "shell",
          },
    );
    jest.spyOn(SbxRuntime.prototype, "remove").mockImplementation(async () => {
      if (fail)
        throw new LocalRefusal("LOCAL_COMMAND_TIMEOUT", "Controlled exact deletion refusal");
      removed = true;
    });
    const owner = new RuntimeOwner(
      local.records,
      local.space.id,
      async () => {},
      async () => {},
    );
    local.manager.dependencies.guard = async () => ({
      active: true,
      stop: async () => {},
      observe: async () => [],
      retire: async (_id, generation) => owner.manage(generation, false),
      remove: async (_id, generation, approval) => owner.manage(generation, true, approval),
      space: async () => {
        throw new Error("Deletion must use native management");
      },
    });
    local.setRequest({ action: "delete", spaceId: local.space.id, generation: 2 }, 2);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: {
        code: "LOCAL_COMMAND_TIMEOUT",
        management: {
          spaceId: local.space.id,
          originGeneration: 1,
          generation: 2,
          action: "delete",
        },
      },
    });
    expect(await local.records.get(local.space.id)).toMatchObject({
      phase: "deleting",
      desiredState: "deleted",
      generation: 2,
    });
    fail = false;
    local.setRequest({ action: "delete", spaceId: local.space.id, generation: 3 }, 3);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { accepted: true } });
    const tombstone = await local.records.get(local.space.id);
    expect(tombstone).toMatchObject({
      phase: "deleted",
      desiredState: "deleted",
      runtimeId: local.space.runtimeId,
    });
    local.setRequest({ action: "delete", spaceId: local.space.id, generation: 4 }, 4);
    await local.relay.poll(local.rpc);
    expect(await local.records.get(local.space.id)).toEqual(tombstone);
    await local.manager.close();
  });

  test("an admitted native create does not block another VM's work or the short repository-policy append", async () => {
    const local = await fixture();
    let entered!: () => void, cancel!: () => void;
    const preparing = new Promise<void>((done) => {
      entered = done;
    });
    const held = new Promise<void>((done) => {
      cancel = done;
    });
    let creatingId = "";
    const manager = new LocalManager(local.records, {
      storage: async () => {},
      brokerPorts: { http: 0, tunnel: 0 },
      guard: async () => ({
        active: true,
        stop: async () => {},
        observe: async () => [],
        remove: async () => {},
        retire: async (id, generation) => {
          const space = await local.records.get(id);
          await local.records.put({
            ...space!,
            generation: generation + 1,
            desiredState: "stopped",
            phase: "stopped",
          });
          cancel();
        },
        space: async (id) => ({
          active: true,
          validate: async () => {},
          operation: async () => Buffer.from("{}"),
          stop: async () => {},
          prepare: async () => {
            creatingId = id;
            entered();
            await held;
            throw new LocalRefusal("LOCAL_CANCELLED", "Own creation interrupted");
          },
        }),
      }),
    });
    await manager.open();
    const create = manager
      .create(local.space.repositoryId, "main", `moira-${"d".repeat(24)}`)
      .catch((error: unknown) => error);
    try {
      await preparing;
      expect(await manager.dispatchGuest(local.space.id, async () => "peer work completed")).toBe(
        "peer work completed",
      );
      const next = {
        ...local.policy,
        repositories: [
          ...local.policy.repositories,
          { ...local.policy.repositories[0], id: randomUUID(), fullName: "owner/another" },
        ],
      };
      await manager.appendRepositoryPolicy(local.policy, next);
      expect((await local.records.policy()).repositories).toEqual(next.repositories);
      expect(await manager.stop(creatingId)).toMatchObject({
        desiredState: "stopped",
        phase: "stopped",
      });
      expect(await create).toMatchObject({ code: "LOCAL_CANCELLED" });
      expect(await local.records.get(local.space.id)).toMatchObject({
        desiredState: "running",
        generation: 1,
      });
    } finally {
      cancel();
      await create;
      await manager.close();
    }
  });

  test("background relay delivers a long claim while a second claim and device confirmation remain available", async () => {
    const local = await fixture();
    let entered!: () => void, release!: () => void;
    const accepted = new Promise<void>((done) => {
      entered = done;
    });
    const held = new Promise<void>((done) => {
      release = done;
    });
    local.manager.create = async (repositoryId, ref, operationMarker, onAdmitted) => {
      Object.assign(local.space, { repositoryId, ref, operationMarker });
      await local.records.put(local.space);
      onAdmitted?.();
      entered();
      await held;
      return local.space;
    };
    expect(await local.relay.poll(local.rpc, undefined, true)).toBe(1);
    await accepted;
    expect(local.receipts).toEqual([]);
    expect(await local.relay.confirmed()).toMatchObject({ deviceId: local.policy.deviceId });
    local.manager.snapshot = async () => ({ ...publicPolicy(local.policy), spaces: [] });
    local.setRequest({ action: "snapshot" }, 2);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: true,
      result: { creation: { state: "manifest", spaceId: local.space.id } },
    });
    release();
    await local.relay.drain();
    const binding = JSON.parse(
      await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8"),
    );
    expect(binding).toMatchObject({ serverGeneration: 2, localSpaceId: local.space.id });
  });

  async function loseCreationReceipt(local: Awaited<ReturnType<typeof fixture>>) {
    await local.relay.poll(local.rpc);
    const key = `relay-space-${local.resourceId}.json`;
    const binding = JSON.parse(await readFile(join(directory, key), "utf8"));
    await local.state.write(key, { ...binding, localSpaceId: null, localGeneration: null });
    await local.state.remove(`relay-request-${binding.createRequestId}.json`);
    await local.state.remove("requests.json");
  }

  test("expired creation receipt recovers the own manifest and observes only that resource despite a stale peer", async () => {
    const local = await fixture();
    await loseCreationReceipt(local);
    const peerId = randomUUID();
    await local.records.put({
      ...local.space,
      id: peerId,
      name: `moira-${peerId.replaceAll("-", "")}`,
      operationMarker: `moira-${"c".repeat(24)}`,
      runtimeId: "stale-peer",
    });
    local.manager.dependencies.guard = async () => ({
      active: true,
      stop: async () => {},
      retire: async () => {},
      remove: async () => {},
      space: async () => {
        throw new Error("No work admission during observation");
      },
      observe: async () => [
        { id: local.space.runtimeId!, name: local.space.name, status: "running" },
        { id: "foreign-peer", name: `moira-${peerId.replaceAll("-", "")}`, status: "running" },
      ],
    });
    local.setRequest({ action: "snapshot" }, 2);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: true,
      result: {
        creation: { state: "manifest", spaceId: local.space.id },
        spaces: [{ id: local.space.id, state: "running" }],
      },
    });
    expect(local.creates()).toBe(1);
    expect(await local.records.get(peerId)).toMatchObject({
      runtimeId: "stale-peer",
      desiredState: "running",
    });
    await local.manager.close();
  });

  test("native observation failure preserves recovered manifest identity as unknown instead of false absence", async () => {
    const local = await fixture();
    await loseCreationReceipt(local);
    local.manager.dependencies.guard = async () => ({
      active: true,
      stop: async () => {},
      retire: async () => {},
      remove: async () => {},
      space: async () => {
        throw new Error("No work admission during observation");
      },
      observe: async () => {
        throw new LocalRefusal("LOCAL_GUARD_UNAVAILABLE", "Controlled owner loss");
      },
    });
    local.setRequest({ action: "snapshot" }, 2);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: true,
      result: {
        creation: { state: "manifest", spaceId: local.space.id },
        spaces: [
          {
            id: local.space.id,
            state: "unknown",
            failure: "LOCAL_GUARD_UNAVAILABLE",
            nativeStopConfirmed: false,
          },
        ],
      },
    });
    expect(local.creates()).toBe(1);
    await local.manager.close();
  });

  test("settled creation without a manifest proves absence and fences a stale accepted create", async () => {
    const local = await fixture();
    await loseCreationReceipt(local);
    await local.state.remove(`space-${local.space.id}.json`);
    local.setRequest({ action: "snapshot" }, 2);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: true,
      result: { creation: { state: "absent" }, spaces: [] },
    });
    local.setRequest(
      {
        action: "create",
        repositoryId: local.space.repositoryId,
        ref: "main",
        operationMarker: local.space.operationMarker,
      },
      1,
    );
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_GENERATION_CONFLICT" },
    });
    expect(local.creates()).toBe(1);
    expect(await local.records.get(local.space.id)).toBeNull();
  });

  test("confirmed never-created intent fences a delayed journal create at the same generation after restart", async () => {
    const local = await fixture();
    await loseCreationReceipt(local);
    await local.state.remove(`space-${local.space.id}.json`);
    const manager = new LocalManager(local.records);
    const rpc = new LocalRpc(manager);
    let release!: () => void;
    let entered!: () => void;
    const delayed = new Promise<void>((done) => {
      release = done;
    });
    const accepted = new Promise<void>((done) => {
      entered = done;
    });
    const request = {
      action: "create" as const,
      repositoryId: local.space.repositoryId,
      ref: "main",
      operationMarker: local.space.operationMarker,
    };
    const pending = rpc.journal
      .run(randomUUID(), Date.now() + 60_000, request, async () => {
        entered();
        await delayed;
        return manager.create(request.repositoryId, request.ref, request.operationMarker);
      })
      .catch((error: unknown) => error);
    await accepted;
    local.setRequest({ action: "snapshot" }, 1);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: true,
      result: { creation: { state: "absent" } },
    });
    release();
    expect(await pending).toMatchObject({ code: "LOCAL_CREATE_UNKNOWN" });
    // The existing retained binding carries closure across manager restart, without a second journal.
    await expect(
      new LocalManager(local.records).create(
        request.repositoryId,
        request.ref,
        request.operationMarker,
      ),
    ).rejects.toMatchObject({ code: "LOCAL_CREATE_UNKNOWN" });
    expect(await local.records.list()).toEqual([]);
  });

  test("ambiguous durable manifests refuse recovery without observing or adopting a VM", async () => {
    const local = await fixture();
    await loseCreationReceipt(local);
    const otherId = randomUUID();
    await local.records.put({
      ...local.space,
      id: otherId,
      name: `moira-${otherId.replaceAll("-", "")}`,
    });
    local.setRequest({ action: "snapshot" }, 2);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_IDENTITY_CHANGED" },
    });
    expect(local.creates()).toBe(1);
  });

  test.each(["absent", "occupied", "inventory-error"] as const)(
    "pending manifest deletion handles %s without name adoption or effects on peers",
    async (observation) => {
      const local = await fixture();
      Object.assign(local.space, { runtimeId: null, phase: "creating", networkPolicy: null });
      await local.records.put(local.space);
      local.policy.repositories[0].allowDelete = true;
      await local.state.write("policy.json", local.policy);
      const peer = {
        id: randomUUID(),
        name: `moira-${"e".repeat(32)}`,
        status: "running" as const,
        agent: "shell" as const,
        workspaces: [],
        ports: [],
      };
      const inventory =
        observation === "occupied"
          ? [peer, { ...peer, id: randomUUID(), name: local.space.name }]
          : [peer];
      jest.spyOn(SbxRuntime.prototype, "list").mockImplementation(async () => {
        if (observation === "inventory-error")
          throw new LocalRefusal("LOCAL_COMMAND_TIMEOUT", "Controlled inventory failure");
        return inventory;
      });
      jest.spyOn(SbxRuntime.prototype, "stop").mockImplementation(async () => {
        throw new Error("No UUID: never stop by name");
      });
      jest.spyOn(SbxRuntime.prototype, "remove").mockImplementation(async () => {
        throw new Error("No UUID: never delete by name");
      });
      const owner = new RuntimeOwner(
        local.records,
        local.space.id,
        async () => {},
        async () => {},
      );
      if (observation === "absent") {
        await owner.manage(1, true);
        const deleted = await local.records.get(local.space.id);
        expect(deleted).toMatchObject({
          runtimeId: null,
          desiredState: "deleted",
          phase: "deleted",
        });
        await owner.manage(deleted!.generation, true);
        expect(await local.records.get(local.space.id)).toEqual(deleted);
      } else {
        await expect(owner.manage(1, true)).rejects.toMatchObject({
          code: observation === "occupied" ? "LOCAL_CREATE_UNKNOWN" : "LOCAL_COMMAND_TIMEOUT",
        });
        expect(await local.records.get(local.space.id)).toMatchObject({
          runtimeId: null,
          phase: "failed",
        });
      }
      expect(inventory[0]).toEqual(peer);
    },
  );

  test("failed pending deletion retains its concrete cause and can retry the same owned manifest after absence is verified", async () => {
    const local = await fixture();
    Object.assign(local.space, { runtimeId: null, phase: "creating", networkPolicy: null });
    await local.records.put(local.space);
    local.policy.repositories[0].allowDelete = true;
    await local.state.write("policy.json", local.policy);
    await local.relay.poll(local.rpc);
    let occupied = true;
    jest.spyOn(SbxRuntime.prototype, "list").mockImplementation(async () =>
      occupied
        ? [
            {
              id: randomUUID(),
              name: local.space.name,
              status: "running",
              agent: "shell",
              workspaces: [],
              ports: [],
            },
          ]
        : [],
    );
    const owner = new RuntimeOwner(
      local.records,
      local.space.id,
      async () => {},
      async () => {},
    );
    local.manager.dependencies.guard = async () => ({
      active: true,
      stop: async () => {},
      observe: async () => [],
      retire: async (_id, generation) => owner.manage(generation, false),
      remove: async (_id, generation, approval) => owner.manage(generation, true, approval),
      space: async () => {
        throw new Error("Deletion must not re-admit pending SDK creation");
      },
    });
    local.setRequest({ action: "delete", spaceId: local.space.id, generation: 2 }, 2);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_CREATE_UNKNOWN" },
    });
    expect(await local.records.get(local.space.id)).toMatchObject({
      runtimeId: null,
      generation: 2,
      phase: "failed",
      desiredState: "stopped",
    });
    occupied = false;
    local.setRequest({ action: "delete", spaceId: local.space.id, generation: 3 }, 3);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { accepted: true } });
    const deleted = await local.records.get(local.space.id);
    expect(deleted).toMatchObject({ runtimeId: null, desiredState: "deleted", phase: "deleted" });
    local.setRequest({ action: "delete", spaceId: local.space.id, generation: 4 }, 4);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { accepted: true } });
    expect(await local.records.get(local.space.id)).toEqual(deleted);
    await local.manager.close();
  });

  test("a foreign generation change during failed deletion cannot become an owned management receipt", async () => {
    const local = await fixture();
    await local.relay.poll(local.rpc);
    local.manager.remove = async () => {
      await local.records.put({
        ...local.space,
        generation: 2,
        desiredState: "stopped",
        phase: "failed",
        failure: "LOCAL_CREATE_UNKNOWN",
      });
      throw new LocalRefusal("LOCAL_CREATE_UNKNOWN", "Unrelated local actor changed the record");
    };
    local.setRequest({ action: "delete", spaceId: local.space.id, generation: 2 }, 2);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_GENERATION_CONFLICT" },
    });
    const binding = JSON.parse(
      await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8"),
    );
    expect(binding).toMatchObject({ localGeneration: 1, serverGeneration: 1 });
  });

  test.each([401, 403, 503])(
    "broken Git identity HTTP %s body preserves its known scoped status",
    async (status) => {
      const local = await fixture();
      await local.relay.poll(local.rpc);
      local.breakIdentityBody(status);
      const error = await local.relay
        .gitIdentity(local.space.id, local.space.repositoryId)
        .catch((failure: unknown) => failure);
      expect(error).toMatchObject({
        code:
          status === 401
            ? "LOCAL_UNAUTHORIZED"
            : status === 503
              ? "LOCAL_RELAY_UNAVAILABLE"
              : "LOCAL_RELAY_REFUSED",
      });
      expect(local.relay.isUnavailable(error)).toBe(status === 503);
      expect(await local.records.get(local.space.id)).toMatchObject({
        phase: "usable",
        generation: 1,
      });
    },
  );
  test("daemon reconnect keeps real manager admission; validated device revocation settles it", async () => {
    const local = await fixture();
    await local.relay.poll(local.rpc);
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
          await local.records.put({
            ...space!,
            phase: "stopped",
            desiredState: "stopped",
            generation: space!.generation + 1,
          });
        },
      }),
    });
    await local.manager.operation(local.space.id, {});
    jest.spyOn(local.manager, "open").mockResolvedValue(undefined);
    const daemon = new LocalDaemon(local.manager, local.relay, { report: () => {} });
    try {
      expect(await daemon.cycle()).toBe(true);
      local.failNextHeartbeat();
      expect(await daemon.cycle()).toBe(false);
      expect(daemon.status.controlPlane).toBe("offline");
      expect(await local.records.get(local.space.id)).toMatchObject({
        phase: "usable",
        desiredState: "running",
        generation: 1,
      });
      expect(await daemon.cycle()).toBe(true);
      expect(local.creates()).toBe(1);
      local.revokeDevice();
      expect(await daemon.cycle()).toBe(false);
      expect(daemon.status).toEqual({ controlPlane: "disabled", code: "LOCAL_IDENTITY_CHANGED" });
      expect(await local.records.get(local.space.id)).toMatchObject({
        phase: "stopped",
        desiredState: "stopped",
        generation: 2,
      });
    } finally {
      await local.manager.close();
    }
  });
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
        .spyOn(SbxRuntime.prototype, "runFixedGuest")
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
          `/prefix/api/local-devices/github/${local.resourceId}/1/identity`,
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
    "Git authority uses current resource rights despite a %s old lifecycle intent",
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
          local.relay.gitAuthority(local.space.id, local.space.repositoryId),
        ).resolves.toMatchObject({ resourceId: local.resourceId });
        return current!;
      };
      local.setRequest({ action: "start", spaceId: local.space.id }, 2);
      await local.relay.poll(local.rpc);
      expect(local.receipts.at(-1)).toMatchObject({ ok: true });
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
      expect(local.receipts.at(-1)).toMatchObject(
        cause === "parent"
          ? { ok: true, result: { spaceId: local.space.id } }
          : {
              ok: false,
              error: { code: cause === "lease" ? "LOCAL_LEASE_EXPIRED" : "LOCAL_DISABLED" },
            },
      );
      expect(
        await local.state.read(`relay-space-${local.resourceId}.json`, (value) => value),
      ).toMatchObject({ serverGeneration: 1, localGeneration: 1 });
      expect(local.creates()).toBe(1);
      local.manager.dependencies.storage = async () => {};
      local.setRequest({ action: "start", spaceId: local.space.id }, 1);
      await reconnect.poll(new LocalRpc(local.manager));
      expect(local.receipts.at(-1)).toMatchObject({
        ok: false,
        error: {
          code:
            cause === "parent"
              ? "LOCAL_NOT_RUNNING"
              : cause === "lease"
                ? "LOCAL_LEASE_EXPIRED"
                : "LOCAL_DISABLED",
        },
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
      local.manager.dependencies.runtime = (policy) => adaptSbxRuntime(new ObservedStopped(policy));
      local.setRequest({ action: "snapshot" }, 1);
      await reconnect.poll(new LocalRpc(local.manager));
      expect(local.receipts.at(-1)).toMatchObject({
        ok: true,
        result: { spaces: [{ id: local.space.id, state: "stopped", phase: "stopped" }] },
      });
      expect(
        JSON.parse(await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8")),
      ).toMatchObject({ localGeneration: 1, serverGeneration: 1 });
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
    expect(local.receipts.at(-1)).toMatchObject({ ok: true });
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
  test("lost ACK preserves real manager admission and its cached receipt for a later claim", async () => {
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
      phase: "usable",
      desiredState: "running",
      generation: 1,
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
    ).toMatchObject({ localGeneration: 1, serverGeneration: 1 });
    await local.manager.close();
  });
  test.each(["network", "server", "body"] as const)(
    "transient %s result upload preserves a running operation and reclaims its cached result without redispatch",
    async (kind) => {
      const local = await fixture();
      await local.relay.poll(local.rpc);
      const lease = local.policy.leaseUntil;
      const dispatch = jest
        .spyOn(local.rpc.jobs, "dispatch")
        .mockResolvedValue({ state: "running" });
      const close = jest.spyOn(local.manager, "close").mockResolvedValue(undefined);
      local.setRequest({ action: "operation", spaceId: local.space.id, job: {} });
      local.failNextPart(kind);
      await expect(local.relay.poll(local.rpc)).rejects.toBeDefined();
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
      expect(await local.records.get(local.space.id)).toMatchObject({
        phase: "usable",
        desiredState: "running",
        generation: 1,
      });
      expect((await local.records.policy()).leaseUntil).toBe(lease);
      const reconnect = new LocalRpc(local.manager);
      const redispatch = jest.spyOn(reconnect.jobs, "dispatch");
      local.claim().claimId = randomUUID();
      await expect(local.relay.poll(reconnect)).resolves.toBe(1);
      expect(redispatch).not.toHaveBeenCalled();
      expect(local.receipts.at(-1)).toEqual({ ok: true, result: { state: "running" } });
    },
  );
  test.each(["network", "server"] as const)(
    "transient %s renewal drains its claim without closing admission or repeating a completed side effect",
    async (kind) => {
      const local = await fixture();
      let entered!: () => void, finish!: () => void;
      const admitted = new Promise<void>((done) => {
        entered = done;
      });
      const held = new Promise<void>((done) => {
        finish = done;
      });
      let creates = 0;
      local.manager.create = async (repositoryId, ref, operationMarker) => {
        creates++;
        Object.assign(local.space, { repositoryId, ref, operationMarker });
        await local.records.put(local.space);
        entered();
        await held;
        return local.space;
      };
      const close = jest.spyOn(local.manager, "close").mockResolvedValue(undefined);
      local.failNextRenew(kind);
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      const outcome = local.relay.poll(local.rpc).catch((error: unknown) => error);
      await admitted;
      await jest.advanceTimersByTimeAsync(10_000);
      await local.renewal;
      finish();
      const failure = await outcome;
      expect(local.relay.isUnavailable(failure)).toBe(true);
      expect(close).not.toHaveBeenCalled();
      expect(local.receipts).toEqual([]);
      expect(await local.records.get(local.space.id)).toMatchObject({
        phase: "usable",
        desiredState: "running",
        generation: 1,
      });
      local.claim().claimId = randomUUID();
      await expect(local.relay.poll(new LocalRpc(local.manager))).resolves.toBe(1);
      expect(creates).toBe(1);
      expect(local.receipts).toEqual([{ ok: true, result: { spaceId: local.space.id } }]);
    },
  );
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
      runtime: (policy) => adaptSbxRuntime(new ExternalInventory(policy)),
    });
    expect((await manager.snapshot()).spaces).toEqual([
      expect.objectContaining({
        id: local.space.id,
        state: "unknown",
        phase: "creating",
        nativeStopConfirmed: false,
      }),
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
    jest.spyOn(local.rpc.jobs, "dispatch").mockResolvedValue({ state: "running" });
    let closures = 0;
    local.manager.close = async () => {
      closures++;
    };
    await expect(local.relay.poll(local.rpc)).resolves.toBe(1);
    expect(local.receipts.at(-1)).toMatchObject({ ok: true, result: { state: "running" } });
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
    expect(binding).toMatchObject({ serverGeneration: 1, localGeneration: 1 });
    local.space.generation = 2;
    await local.records.put(local.space);
    local.setRequest({ action: "snapshot" }, 10);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({ ok: true });
    expect(
      JSON.parse(await readFile(join(directory, `relay-space-${local.resourceId}.json`), "utf8")),
    ).toMatchObject({ serverGeneration: 1, localGeneration: 1 });
  });
  test("local recovery permits read-only completed replay and rebases only a new server counter", async () => {
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
    expect(local.receipts.at(-1)).toMatchObject({ ok: true });
    expect(
      await local.state.read(`relay-space-${local.resourceId}.json`, (value) => value),
    ).toMatchObject({ serverGeneration: 1, localGeneration: 1 });
    local.manager.dependencies.storage = async () => {};
    local.setRequest({ action: "start", spaceId: local.space.id }, 1);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_NOT_RUNNING" },
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
    // Read-only observation remains available without rebinding lifecycle counters.
    local.setRequest({ action: "snapshot" }, oldClaim.resourceGeneration as number);
    await local.relay.poll(local.rpc);
    expect(local.receipts.at(-1)).toMatchObject({ ok: true });
    const result = await local.rpc.handle({
      version: 1,
      id: randomUUID(),
      expiresAt: Date.now() + 60000,
      request: { action: "recover", spaceId: local.space.id },
    });
    expect(result.ok).toBe(false);
  });
  test.each([200, 401, 410, "broken401"] as const)(
    "request-scoped renewal status %s never owns VM shutdown",
    async (status) => {
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
      if (status === "broken401") local.breakRenewBody(401);
      else if (status !== 200) local.refuseRenew(status);
      jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
      const work = local.relay.poll(local.rpc);
      const outcome = work.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await admitted;
      await jest.advanceTimersByTimeAsync(10_000);
      await local.renewal;
      finish();
      const result = await outcome;
      expect(local.renewals()).toBe(1);
      if (status !== 200) {
        expect(result).toMatchObject({
          error: {
            code:
              status === 401 || status === "broken401"
                ? "LOCAL_UNAUTHORIZED"
                : "LOCAL_RELAY_REFUSED",
          },
        });
        expect(closures).toBe(0);
        expect(local.receipts).toEqual([]);
      } else {
        expect(result).toEqual({ value: 1 });
        expect(closures).toBe(0);
        expect(local.receipts).toHaveLength(1);
      }
    },
  );
  test.each([401, 503])(
    "broken heartbeat HTTP %s body preserves device refusal versus offline status",
    async (status) => {
      const local = await fixture();
      const pause = jest.spyOn(local.manager, "stopWork").mockResolvedValue(undefined);
      const close = jest.spyOn(local.manager, "close").mockResolvedValue(undefined);
      local.breakHeartbeatBody(status);
      const daemon = new LocalDaemon(local.manager, local.relay, { report: () => {} });
      expect(await daemon.cycle()).toBe(false);
      expect(daemon.status).toEqual(
        status === 401
          ? { controlPlane: "disabled", code: "LOCAL_UNAUTHORIZED" }
          : { controlPlane: "offline", code: "LOCAL_RELAY_UNAVAILABLE" },
      );
      expect(pause).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
      expect(close).not.toHaveBeenCalled();
      close.mockRestore();
      await local.manager.close();
    },
  );
  test("device revocation during an in-flight claim reaches the daemon without waiting for guest work", async () => {
    const local = await fixture();
    // Observe the whole admitted delivery, including persistence after rpc.handle().
    const delivery = local.relay as unknown as {
      holdClaim(
        connection: unknown,
        claim: unknown,
        work: (signal: AbortSignal) => Promise<void>,
        signal?: AbortSignal,
      ): Promise<void>;
    };
    const holdClaim = delivery.holdClaim.bind(local.relay);
    let settled: Promise<void> | undefined;
    jest.spyOn(delivery, "holdClaim").mockImplementation((connection, claim, execute, signal) =>
      holdClaim(
        connection,
        claim,
        (scope) => {
          const executing = execute(scope);
          settled = executing.then(
            () => undefined,
            () => undefined,
          );
          return executing;
        },
        signal,
      ),
    );
    let entered!: () => void, finish!: () => void;
    const admitted = new Promise<void>((done) => {
      entered = done;
    });
    const held = new Promise<void>((done) => {
      finish = done;
    });
    let guestFinished = false;
    local.manager.create = async () => {
      entered();
      await held;
      guestFinished = true;
      return local.space;
    };
    jest.spyOn(local.manager, "open").mockResolvedValue(undefined);
    const stop = jest.spyOn(local.manager, "stopWork").mockResolvedValue(undefined);
    const close = jest.spyOn(local.manager, "close").mockResolvedValue(undefined);
    const daemon = new LocalDaemon(local.manager, local.relay, { report: () => {} });
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    try {
      const initialCycle = daemon.cycle();
      await admitted;
      // Control returns after background admission; the native request remains held.
      expect(await initialCycle).toBe(true);
      expect(daemon.status).toEqual({ controlPlane: "connected", code: null });
      local.revokeDevice();
      await jest.advanceTimersByTimeAsync(10_000);
      // The next control confirmation must settle authority before the held guest finishes.
      expect(await daemon.cycle()).toBe(false);
      expect(guestFinished).toBe(false);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(close).not.toHaveBeenCalled();
      expect(daemon.status).toEqual({ controlPlane: "disabled", code: "LOCAL_IDENTITY_CHANGED" });
      expect(settled).toBeDefined();
    } finally {
      finish();
      await settled;
      close.mockRestore();
      await local.manager.close();
    }
    expect(local.receipts).toEqual([]);
  });
});
