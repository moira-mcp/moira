import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { NetworkBudget } from "../../../packages/local/src/network-budget.js";
import { startBroker } from "../../../packages/local/src/broker.js";
import { resolvePublicTarget } from "../../../packages/local/src/network.js";
import { localFixture } from "./fixtures.js";

let directory: string;
let state: PrivateState;
const budgets: NetworkBudget[] = [];
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "moira-network-admission-")));
  state = await PrivateState.open(directory);
});
afterEach(async () => {
  jest.restoreAllMocks();
  for (const budget of budgets.splice(0)) {
    budget.closeAdmission();
    await budget.settle();
  }
  await rm(directory, { recursive: true, force: true });
});
async function fixture() {
  const local = await localFixture(state);
  await state.write("policy.json", local.policy);
  const budget = new NetworkBudget();
  budgets.push(budget);
  return { ...local, budget };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("network admission independent of workload quotas", () => {
  test("DNS answer cardinality does not replace checking every public destination", async () => {
    const answers = Array.from({ length: 129 }, (_, index) => ({
      address: `93.184.216.${index + 1}`,
      family: 4 as const,
    }));
    await expect(resolvePublicTarget("packages.example.com", async () => answers)).resolves.toEqual(
      answers[0],
    );
    await expect(
      resolvePublicTarget("packages.example.com", async () => [
        ...answers,
        { address: "10.0.0.1", family: 4 as const },
      ]),
    ).rejects.toMatchObject({ code: "LOCAL_NETWORK_DENIED" });
  });
  test("more than the former socket capacity admits independently without reservations or a traffic ledger", async () => {
    const f = await fixture();
    const reservations = await Promise.all(
      Array.from({ length: 256 }, () => f.budget.reserve(f.policy)),
    );
    expect(reservations).toHaveLength(256);
    await Promise.all(reservations.map((reservation) => reservation.release()));
    expect(await state.read("network-budget.json", (value) => value)).toBeNull();
  });
  test.each(["consumer", "shutdown"] as const)(
    "%s cancellation settles a held authority read without blocking independent admission",
    async (cause) => {
      const f = await fixture();
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>((done) => {
        enter = done;
      });
      const held = new Promise<void>((done) => {
        release = done;
      });
      const controller = new AbortController();
      const pending = f.budget.reserve(f.policy, {
        signal: controller.signal,
        refreshPolicy: async () => {
          enter();
          await held;
          return f.policy;
        },
      });
      const outcome = expect(pending).rejects.toMatchObject({ code: "LOCAL_NETWORK_CANCELLED" });
      await entered;
      expect(await f.budget.reserve(f.policy)).toHaveProperty("release");
      if (cause === "consumer") controller.abort();
      else f.budget.closeAdmission();
      await outcome;
      await f.budget.settle();
      release();
    },
  );
  test("fresh bound policy is checked immediately before network authority returns", async () => {
    const f = await fixture();
    f.policy.enabled = false;
    await state.write("policy.json", f.policy);
    await expect(
      f.budget.reserve({ ...f.policy, enabled: true }, { refreshPolicy: () => f.records.policy() }),
    ).rejects.toMatchObject({ code: "LOCAL_NETWORK_DENIED" });
  });

  test("persistent permission still admits fresh network work beyond the former maximum window", async () => {
    const f = await fixture();
    const future = Date.now() + 8 * 24 * 60 * 60_000;
    jest.spyOn(Date, "now").mockReturnValue(future);
    const reservation = await f.budget.reserve(f.policy, {
      refreshPolicy: () => f.records.policy(),
    });
    expect(await f.records.authorize(f.authorization)).not.toBeNull();
    await reservation.release();
    await state.write("policy.json", { ...f.policy, enabled: false });
    await expect(
      f.budget.reserve(f.policy, { refreshPolicy: () => f.records.policy() }),
    ).rejects.toMatchObject({ code: "LOCAL_NETWORK_DENIED" });
  });

  test("an exhausted old traffic ledger cannot block development downloads", async () => {
    const f = await fixture();
    await state.write("network-budget.json", {
      leaseUntil: 1,
      spent: Number.MAX_SAFE_INTEGER,
    });
    for (let index = 0; index < 3; index++) {
      const reservation = await f.budget.reserve(f.policy);
      await reservation.release();
    }
    expect(await state.read("network-budget.json", (value) => value)).toEqual({
      leaseUntil: 1,
      spent: Number.MAX_SAFE_INTEGER,
    });
  });

  test("held authenticated CONNECT cannot dial after its bound authority is revoked", async () => {
    const f = await fixture();
    let refreshed!: () => void;
    const queued = new Promise<void>((resolve) => {
      refreshed = resolve;
    });
    let release!: () => void;
    const authorityGate = new Promise<void>((done) => {
      release = done;
    });
    let authorizations = 0;
    let lookups = 0;
    const broker = await startBroker({
      authorize: async (credential) => {
        if (++authorizations === 2) {
          refreshed();
          await authorityGate;
        }
        return f.records.authorize(credential);
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
      release();
      await closed;
      expect(bytes).toContain("403 Forbidden");
      expect(lookups).toBe(0);
    } finally {
      client.destroy();
      release();
      await broker.close();
    }
  });
});
