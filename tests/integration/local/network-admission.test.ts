import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { NetworkBudget } from "../../../packages/local/src/network-budget.js";
import { startBroker } from "../../../packages/local/src/broker.js";
import { localFixture } from "./fixtures.js";

let directory: string;
let state: PrivateState;
const budgets: NetworkBudget[] = [];
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "moira-network-admission-")));
  state = await PrivateState.open(directory);
});
afterEach(async () => {
  for (const budget of budgets.splice(0)) {
    budget.closeAdmission();
    await budget.settle();
  }
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const local = await localFixture(state);
  await state.write("policy.json", local.policy);
  const budget = new NetworkBudget(1);
  budgets.push(budget);
  return { ...local, budget };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("network scheduling independent of VM lifetime", () => {
  test("a busy connection waits in FIFO order instead of returning a security refusal", async () => {
    const f = await fixture();
    const held = await f.budget.reserve(f.policy);
    const order: number[] = [];
    const second = f.budget.reserve(f.policy).then((reservation) => {
      order.push(2);
      return reservation;
    });
    const third = f.budget.reserve(f.policy).then((reservation) => {
      order.push(3);
      return reservation;
    });
    await turn();
    expect(order).toEqual([]);
    await held.release();
    const next = await second;
    expect(order).toEqual([2]);
    await next.release();
    await (await third).release();
    expect(order).toEqual([2, 3]);
    expect(await state.read("network-budget.json", (value) => value)).toBeNull();
  });

  test("a disconnected queued consumer does not hold credit or block the next connection", async () => {
    const f = await fixture();
    const held = await f.budget.reserve(f.policy);
    const controller = new AbortController();
    const cancelled = expect(
      f.budget.reserve(f.policy, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "LOCAL_NETWORK_CANCELLED" });
    const next = f.budget.reserve(f.policy);
    controller.abort();
    await cancelled;
    await held.release();
    await (await next).release();
    expect(await state.read("network-budget.json", (value) => value)).toBeNull();
  });

  test("authority is checked after waiting and revoked permission cannot consume credit", async () => {
    const f = await fixture();
    const held = await f.budget.reserve(f.policy);
    const waiting = expect(
      f.budget.reserve(f.policy, { refreshPolicy: () => f.records.policy() }),
    ).rejects.toMatchObject({ code: "LOCAL_NETWORK_DENIED" });
    f.policy.enabled = false;
    await state.write("policy.json", f.policy);
    await held.release();
    await waiting;
    expect(await state.read("network-budget.json", (value) => value)).toBeNull();
  });

  test("shutdown cancels waiting consumers and settles their accounting", async () => {
    const f = await fixture();
    const held = await f.budget.reserve(f.policy);
    const waiting = expect(f.budget.reserve(f.policy)).rejects.toMatchObject({
      code: "LOCAL_NETWORK_CANCELLED",
    });
    f.budget.closeAdmission();
    await waiting;
    await held.release();
    await f.budget.settle();
    await expect(f.budget.reserve(f.policy)).rejects.toMatchObject({
      code: "LOCAL_NETWORK_CANCELLED",
    });
    expect(await state.read("network-budget.json", (value) => value)).toBeNull();
  });

  test("an exhausted old traffic ledger cannot block development downloads", async () => {
    const f = await fixture();
    await state.write("network-budget.json", {
      leaseUntil: f.policy.leaseUntil,
      spent: Number.MAX_SAFE_INTEGER,
    });
    for (let index = 0; index < 3; index++) {
      const reservation = await f.budget.reserve(f.policy);
      await reservation.release();
    }
    expect(await state.read("network-budget.json", (value) => value)).toEqual({
      leaseUntil: f.policy.leaseUntil,
      spent: Number.MAX_SAFE_INTEGER,
    });
  });

  test("releasing twice cannot admit more sockets than the broker can hold", async () => {
    const f = await fixture();
    const held = await f.budget.reserve(f.policy);
    const next = f.budget.reserve(f.policy);
    await held.release();
    const second = await next;
    await held.release();
    let admitted = false;
    const third = f.budget.reserve(f.policy).then((reservation) => {
      admitted = true;
      return reservation;
    });
    await turn();
    expect(admitted).toBe(false);
    await second.release();
    await (await third).release();
    expect(admitted).toBe(true);
  });

  test("queued authenticated CONNECT cannot dial after its bound authority is revoked", async () => {
    const f = await fixture();
    const held = await f.budget.reserve(f.policy);
    let refreshed!: () => void;
    const queued = new Promise<void>((resolve) => {
      refreshed = resolve;
    });
    let authorizations = 0;
    let lookups = 0;
    const broker = await startBroker({
      authorize: async (credential) => {
        const grant = await f.records.authorize(credential);
        if (++authorizations === 2) refreshed();
        return grant;
      },
      budget: f.budget,
      resolve: async () => {
        lookups++;
        return [{ address: "93.184.216.34", family: 4 }];
      },
      git: async (_request, response) => {
        response.end();
      },
      onFault: () => {},
    });
    const client = connect({ host: "127.0.0.1", port: broker.port });
    client.on("error", () => {});
    let bytes = "";
    client.on("data", (chunk) => {
      bytes += chunk.toString();
    });
    const closed = new Promise<void>((resolve) => client.once("close", resolve));
    try {
      await new Promise<void>((resolve) => client.once("connect", resolve));
      client.write(
        `CONNECT packages.example.com:443 HTTP/1.1\r\nHost: packages.example.com\r\nProxy-Authorization: ${f.authorization}\r\n\r\n`,
      );
      await queued;
      await turn();
      expect(bytes).toBe("");
      f.policy.enabled = false;
      await state.write("policy.json", f.policy);
      await held.release();
      await closed;
      expect(bytes).toContain("403 Forbidden");
      expect(lookups).toBe(0);
    } finally {
      client.destroy();
      await held.release();
      await broker.close();
    }
  });
});
