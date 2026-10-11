import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalRpc } from "../../../packages/local/src/rpc.js";
import { LocalRelay } from "../../../packages/local/src/relay.js";
import { publicPolicy } from "../../../packages/local/src/policy.js";
import { canonicalJson } from "../../../packages/shared/src/utils/canonical-json.js";
import { LOCAL_RESULT_SETTLEMENT_RETENTION_MS } from "../../../packages/shared/src/codespaces/local-protocol.js";
import { localFixture } from "./fixtures.js";

let root: string;
let state: PrivateState;
let now: number;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-late-receipt-")));
  state = await PrivateState.open(root);
  now = Date.now();
  jest.spyOn(Date, "now").mockImplementation(() => now);
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function fixture(unknown = false, receiptState = "succeeded", jobAction = "execute") {
  const local = await localFixture(state);
  const manager = new LocalManager(local.records, { now: () => now });
  const rpc = new LocalRpc(manager);
  const resourceId = randomUUID();
  const requestId = randomUUID();
  const connectionId = randomUUID();
  const expiresAt = now + 1000;
  const sourceMessage = {
    version: 1 as const,
    id: requestId,
    expiresAt,
    request: {
      action: "operation" as const,
      spaceId: resourceId,
      job: { version: 1, action: jobAction, remoteMarker: `moira-op-${"a".repeat(32)}` },
    },
  };
  const message = {
    ...sourceMessage,
    request: { ...sourceMessage.request, spaceId: local.space.id },
  };
  const hash = digest(Buffer.from(canonicalJson(sourceMessage)));
  const claim = {
    requestId,
    resourceId,
    digest: hash,
    deviceId: local.policy.deviceId,
    userId: "owner",
    deviceGeneration: 1,
    connectionId,
    resourceGeneration: 1,
    deadlineAt: expiresAt,
    claimId: randomUUID(),
    claimExpiresAt: now + 30000,
    payloadReference: {
      parts: [{ transferId: randomUUID(), size: 0, sha256: digest(Buffer.alloc(0)) }],
      size: 0,
      sha256: digest(Buffer.alloc(0)),
    },
  };
  await state.write("connection.json", {
    origin: "https://moira.example.test",
    credential: "s".repeat(43),
    pairingId: randomUUID(),
    deviceId: local.policy.deviceId,
    userId: "owner",
    deviceGeneration: 1,
    connectionId,
  });
  await state.write(`relay-space-${resourceId}.json`, {
    resourceId,
    deviceId: local.policy.deviceId,
    userId: "owner",
    connectionId,
    deviceGeneration: 1,
    serverGeneration: 1,
    localSpaceId: local.space.id,
    localGeneration: local.space.generation,
    createMarker: local.space.operationMarker,
    repositoryId: local.space.repositoryId,
    createRequestId: randomUUID(),
    createDigest: "b".repeat(64),
  });
  await state.write(`relay-request-${requestId}.json`, {
    digest: hash,
    resourceId,
    deviceGeneration: 1,
    connectionId,
    serverGeneration: 1,
    message,
    sourceMessage,
    settlementClaim: claim,
  });
  const terminal =
    receiptState === "rpc_error"
      ? {
          ok: false as const,
          error: { code: "LOCAL_OUTCOME_UNKNOWN", message: "No terminal proof" },
        }
      : {
          ok: true as const,
          result:
            receiptState === "output"
              ? {
                  action: "output",
                  stream: "stdout",
                  offset: 0,
                  totalBytes: 5,
                  bytesBase64: Buffer.from("bytes").toString("base64"),
                }
              : { state: receiptState, exitCode: 0, startedAt: now, requestDigest: "c".repeat(64) },
        };
  const accepted = rpc.journal.run(requestId, expiresAt, message.request, async () => {
    await state.write("effect.json", { count: 1 });
    if (unknown) throw new Error("lost observer after accepted effect");
    return terminal;
  });
  if (unknown) await expect(accepted).rejects.toThrow("lost observer");
  else await accepted;
  now = expiresAt + 1;
  local.policy.enabled = false;
  local.policy.leaseUntil = now - 1;
  await state.write("policy.json", local.policy);
  const uploaded = new Map<string, Buffer>();
  let completed: unknown;
  let loseAck = false;
  const fetch = (async (input: string | URL | Request, options?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const reply = (data: unknown) =>
      new Response(JSON.stringify({ success: true, data }), { status: 200 });
    if (path.endsWith("/heartbeat"))
      return reply({
        deviceId: local.policy.deviceId,
        userId: "owner",
        connectionId,
        deviceGeneration: 1,
        status: "active",
        policy: publicPolicy(local.policy),
      });
    if (path.endsWith("/relay/claim"))
      return reply({ requests: [], maxPartBytes: 4 * 1024 * 1024 });
    if (path.endsWith("/result-part")) {
      expect(new Headers(options?.headers).get("X-Moira-Claim-Id")).toBe(claim.claimId);
      const bytes = Buffer.from(options?.body as Uint8Array);
      const transferId = randomUUID();
      uploaded.set(transferId, bytes);
      return reply({ transferId, size: bytes.length, sha256: digest(bytes) });
    }
    if (path.endsWith("/relay/ack")) {
      const body = JSON.parse(String(options?.body));
      expect(body.claimId).toBe(claim.claimId);
      expect(body.digest).toBe(hash);
      if (completed !== undefined) expect(body).toEqual(completed);
      completed = body;
      if (loseAck) {
        loseAck = false;
        throw new Error("lost terminal acknowledgement response");
      }
      return reply({ status: "completed" });
    }
    throw new Error(`Unexpected late receipt route: ${path}`);
  }) as typeof globalThis.fetch;
  return {
    local,
    rpc,
    terminal,
    claim,
    message,
    uploaded,
    fetch,
    completed: () => completed,
    loseNextAck: () => {
      loseAck = true;
    },
  };
}

describe("result-only Local relay settlement", () => {
  test.each(["running", "outcome_unknown", "absent", "rpc_error"])(
    "a cached %s receipt cannot become late terminal settlement",
    async (receiptState) => {
      const value = await fixture(false, receiptState);
      const relay = new LocalRelay(value.local.records, value.fetch);
      await relay.poll(value.rpc);
      await relay.drain();
      expect(value.completed()).toBeUndefined();
      expect(value.uploaded.size).toBe(0);
      expect(await value.rpc.retained(value.message)).toEqual(value.terminal);
      expect(await state.read("effect.json", (item) => item)).toEqual({ count: 1 });
    },
  );
  test("a completed pure output read remains collectible after its delivery admission expires", async () => {
    const value = await fixture(false, "output", "output");
    const relay = new LocalRelay(value.local.records, value.fetch);
    await relay.poll(value.rpc);
    await relay.drain();
    expect(value.completed()).toMatchObject({ status: "completed" });
    expect(JSON.parse(Buffer.concat([...value.uploaded.values()]).toString())).toEqual(
      value.terminal,
    );
    expect(await value.rpc.retained(value.message)).toBeUndefined();
    expect(await state.read("effect.json", (item) => item)).toEqual({ count: 1 });
  });
  test("reconnect collects an expired admission's cached result after work lease closure without dispatch", async () => {
    const value = await fixture();
    const relay = new LocalRelay(value.local.records, value.fetch);
    expect(await relay.poll(value.rpc)).toBe(0);
    await relay.drain();
    expect(value.completed()).toMatchObject({
      requestId: value.claim.requestId,
      status: "completed",
    });
    const bytes = Buffer.concat([...value.uploaded.values()]);
    expect(JSON.parse(bytes.toString())).toEqual(value.terminal);
    expect(await state.read("effect.json", (item) => item)).toEqual({ count: 1 });
    expect(await value.rpc.retained(value.message)).toBeUndefined();
    expect(await value.rpc.handle(value.message)).toMatchObject({
      ok: false,
      error: { code: "LOCAL_REQUEST_EXPIRED" },
    });
  });

  test("a lost acknowledgement response reuses the exact retained outcome reference", async () => {
    const value = await fixture();
    value.loseNextAck();
    const first = new LocalRelay(value.local.records, value.fetch);
    await first.poll(value.rpc);
    await first.drain();
    const firstReceipt = value.completed();
    const firstObjects = [...value.uploaded.entries()];
    const reconnected = new LocalRelay(value.local.records, value.fetch);
    await reconnected.poll(value.rpc);
    await reconnected.drain();
    expect(value.completed()).toEqual(firstReceipt);
    expect([...value.uploaded.entries()]).toEqual(firstObjects);
    expect(await state.read("effect.json", (item) => item)).toEqual({ count: 1 });
    expect(await value.rpc.retained(value.message)).toBeUndefined();
  });

  test.each(["unknown", "expired retention", "repository revoked"] as const)(
    "%s cannot turn result collection into another launch",
    async (reason) => {
      const value = await fixture(reason === "unknown");
      if (reason === "expired retention")
        now = value.claim.deadlineAt + LOCAL_RESULT_SETTLEMENT_RETENTION_MS;
      if (reason === "repository revoked") {
        value.local.policy.repositories = [];
        await state.write("policy.json", value.local.policy);
      }
      const relay = new LocalRelay(value.local.records, value.fetch);
      await relay.poll(value.rpc);
      await relay.drain();
      expect(value.completed()).toBeUndefined();
      expect([...value.uploaded.values()]).toEqual([]);
      expect(await state.read("effect.json", (item) => item)).toEqual({ count: 1 });
    },
  );
});
