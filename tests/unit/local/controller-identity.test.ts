import { afterEach, expect, test } from "@jest/globals";
import { mkdtemp, realpath, rm, readFile, lstat, rmdir, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRecords } from "../../../packages/local/src/space-record.js";
import { LocalRelay } from "../../../packages/local/src/relay.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalDaemon } from "../../../packages/local/src/daemon.js";
import {
  LocalController,
  startLocalController,
  controllerRequest,
} from "../../../packages/local/src/controller.js";
import { localFixture } from "../../integration/local/fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  for (const root of directories.splice(0)) await rm(root, { recursive: true, force: true });
});
async function state() {
  const root = await realpath(await mkdtemp("/tmp/mc-"));
  directories.push(root);
  return PrivateState.open(root);
}

test("neutral enrollment retains one device identity after a lost response without SDK policy or storage", async () => {
  const owner = await state(),
    records = new LocalRecords(owner),
    pairingId = randomUUID();
  let fail = true;
  const submitted: Array<{ deviceId: string; label: string }> = [];
  const fetcher: typeof fetch = async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    submitted.push({ deviceId: request.deviceId, label: request.label });
    if (fail) throw new Error("lost response");
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          userId: "owner",
          deviceId: request.deviceId,
          deviceGeneration: 1,
          connectionId: randomUUID(),
          status: "pending",
        },
      }),
    );
  };
  await expect(
    new LocalRelay(records, fetcher).enroll(
      "https://moira.example",
      pairingId,
      "p".repeat(43),
      "GH controller",
    ),
  ).rejects.toMatchObject({ code: "LOCAL_RELAY_UNAVAILABLE" });
  const first = await records.deviceIdentity();
  fail = false;
  const reopened = new LocalRecords(await PrivateState.open(owner.root));
  await new LocalRelay(reopened, fetcher).enroll(
    "https://moira.example",
    pairingId,
    "p".repeat(43),
    "another supplied label",
  );
  expect(submitted).toEqual([first, first]);
  expect(await reopened.policyOrNull()).toBeNull();
  expect((await owner.keys("")).sort()).toEqual(["connection.json"]);
  await expect(reopened.policy()).rejects.toMatchObject({ code: "LOCAL_NOT_CONFIGURED" });
});

test("pairing an existing Local capability preserves its device identity, grants and disk records", async () => {
  const owner = await state(),
    local = await localFixture(owner);
  const originalPolicy = await readFile(join(owner.root, "policy.json"));
  const originalSpace = await readFile(join(owner.root, `space-${local.space.id}.json`));
  const fetcher: typeof fetch = async (_url, options) => {
    const request = JSON.parse(String(options?.body));
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          userId: "owner",
          deviceId: request.deviceId,
          deviceGeneration: 1,
          connectionId: randomUUID(),
          status: "pending",
        },
      }),
    );
  };
  await new LocalRelay(local.records, fetcher).enroll(
    "https://moira.example",
    randomUUID(),
    "p".repeat(43),
    "ignored replacement",
  );
  expect(await local.records.deviceIdentity()).toEqual({
    deviceId: local.policy.deviceId,
    label: local.policy.label,
  });
  expect(await readFile(join(owner.root, "policy.json"))).toEqual(originalPolicy);
  expect(await readFile(join(owner.root, `space-${local.space.id}.json`))).toEqual(originalSpace);
});

test("a retained pairing cannot silently replace an existing Local device", async () => {
  const owner = await state(),
    local = await localFixture(owner);
  await owner.write("connection.json", { deviceId: randomUUID(), label: "foreign pairing" });
  await expect(local.records.deviceIdentity()).rejects.toMatchObject({
    code: "LOCAL_IDENTITY_CHANGED",
  });
  expect((await local.records.policy()).deviceId).toBe(local.policy.deviceId);
});

test("neutral private controller serves identity and original receipts while physical Local admission refuses without a journal effect", async () => {
  const owner = await state(),
    records = new LocalRecords(owner);
  const identity = {
    userId: "owner",
    deviceId: randomUUID(),
    deviceGeneration: 1,
    connectionId: randomUUID(),
  };
  await owner.write("connection.json", {
    ...identity,
    label: "neutral owner",
    origin: "https://moira.example",
    credential: "d".repeat(43),
    pairingId: randomUUID(),
  });
  const manager = new LocalManager(records),
    controller = new LocalController(manager, identity);
  const endpoint = await startLocalController(controller);
  try {
    expect(await controllerRequest(endpoint.socketPath, "GET", "/v1/controller")).toMatchObject({
      ...identity,
      local: { state: "unconfigured" },
      github: { resources: [] },
    });
    const requestId = `ws1-${randomUUID()}`;
    expect(
      await controllerRequest(endpoint.socketPath, "GET", `/v1/controller/operations/${requestId}`),
    ).toEqual({ requestId, state: "absent" });
    await expect(
      controller.lifecycle(randomUUID(), {
        requestId,
        expectedGeneration: 1,
        action: "create",
        repositoryId: randomUUID(),
        ref: "main",
        operationMarker: `moira-${"c".repeat(24)}`,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_NOT_CONFIGURED" });
    expect(await owner.keys("controller-operation-")).toEqual([]);
    expect(await records.policyOrNull()).toBeNull();
    expect(await records.list()).toEqual([]);
  } finally {
    await manager.close();
    await endpoint.close();
  }
});

test("neutral daemon and host clients share a short private endpoint for a long canonical state path", async () => {
  const base = await state();
  const owner = await PrivateState.open(join(base.root, "long-selected-state-".repeat(8)));
  expect(Buffer.byteLength(join(owner.root, "controller.sock"))).toBeGreaterThan(108);
  const records = new LocalRecords(owner),
    identity = {
      userId: "owner",
      deviceId: randomUUID(),
      deviceGeneration: 1,
      connectionId: randomUUID(),
    };
  const connection = {
    ...identity,
    label: "neutral owner",
    origin: "https://moira.example",
    credential: "d".repeat(43),
    pairingId: randomUUID(),
  };
  await owner.write("connection.json", connection);
  class Relay extends LocalRelay {
    override async confirmed() {
      return connection;
    }
  }
  const manager = new LocalManager(records),
    abort = new AbortController();
  let served = "";
  const reports: unknown[] = [];
  await new LocalDaemon(manager, new Relay(records), {
    report: (status) => reports.push(status),
    startRemote: (options) => {
      served = options.socketPath;
      return { close: async () => undefined, whenConnected: async () => undefined };
    },
    wait: async () => {
      expect(reports).toEqual([{ controlPlane: "connected", code: null }]);
      const directory = await owner.ipcDirectory();
      expect(served).toBe(join(directory.root, "controller.sock"));
      expect(Buffer.byteLength(served)).toBeLessThan(104);
      expect((await lstat(directory.root)).mode & 0o077).toBe(0);
      expect((await lstat(served)).mode & 0o077).toBe(0);
      expect(await controllerRequest(served, "GET", "/v1/controller")).toMatchObject({
        ...identity,
        local: { state: "unconfigured" },
      });
      abort.abort();
    },
  }).run(abort.signal);
  await expect(lstat(served)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await records.policyOrNull()).toBeNull();
  expect(await records.list()).toEqual([]);
});

test("private IPC namespaces separate exact states and refuse a substituted directory symlink", async () => {
  const first = await state(),
    second = await state();
  const a = await first.ipcDirectory(),
    b = await second.ipcDirectory();
  expect(a.root).not.toBe(b.root);
  await expect(
    (await PrivateState.open(first.root)).ipcDirectory().then((value) => value.root),
  ).resolves.toBe(a.root);
  await rmdir(a.root);
  await symlink(first.root, a.root);
  try {
    await expect(first.ipcDirectory()).rejects.toMatchObject({ code: "LOCAL_STATE_UNSAFE" });
  } finally {
    await unlink(a.root);
    await rmdir(b.root);
  }
  expect(await first.keys("")).toEqual([]);
});
