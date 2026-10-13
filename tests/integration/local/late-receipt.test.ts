import { test, expect } from "@jest/globals";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalRpc } from "../../../packages/local/src/rpc.js";
import { LocalRelay } from "../../../packages/local/src/relay.js";
import { publicPolicy } from "../../../packages/local/src/policy.js";
import { localFixture } from "./fixtures.js";

test("lifecycle reconnect leaves historical command intents and unknown receipts unchanged", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "moira-archive-")));
  try {
    const state = await PrivateState.open(root);
    const local = await localFixture(state);
    const connectionId = randomUUID();
    await state.write("connection.json", {
      origin: "https://moira.example.test",
      credential: "s".repeat(43),
      pairingId: randomUUID(),
      deviceId: local.policy.deviceId,
      userId: "owner",
      deviceGeneration: 1,
      connectionId,
    });
    const key = `relay-request-${randomUUID()}.json`;
    await state.write(key, { unknown: true, message: { request: { action: "operation" } } });
    await state.write("requests.json", [{ state: "accepted", reservedBytes: 8388608 }]);
    const before = await readFile(join(root, key));
    const requests = await readFile(join(root, "requests.json"));
    const paths: string[] = [];
    const fetch = (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      const data = path.endsWith("/heartbeat")
        ? {
            deviceId: local.policy.deviceId,
            userId: "owner",
            connectionId,
            deviceGeneration: 1,
            status: "active",
            policy: publicPolicy(local.policy),
          }
        : path.endsWith("/relay/claim")
          ? { requests: [] }
          : (() => {
              throw new Error("Unexpected command transport");
            })();
      return new Response(JSON.stringify({ success: true, data }), { status: 200 });
    }) as typeof globalThis.fetch;
    const rpc = new LocalRpc(new LocalManager(local.records));
    const relay = new LocalRelay(local.records, fetch);
    expect(await relay.poll(rpc)).toBe(0);
    await relay.drain();
    expect(
      paths.every((path) => path.endsWith("/heartbeat") || path.endsWith("/relay/claim")),
    ).toBe(true);
    expect((await readFile(join(root, key))).equals(before)).toBe(true);
    expect((await readFile(join(root, "requests.json"))).equals(requests)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
