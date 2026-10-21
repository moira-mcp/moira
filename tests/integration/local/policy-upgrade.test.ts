import { afterEach, beforeEach, expect, test } from "@jest/globals";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { upgradeLocalPolicyState } from "../../../packages/local/src/guard.js";
import { localRuntimeProfileHash } from "../../../packages/local/src/policy.js";
import { setEnabled } from "../../../packages/local/src/config.js";
import { controlSettings } from "../../../packages/local/src/web-control.js";
import { localFixture } from "./fixtures.js";
import { controllerFixture } from "../../fixtures/local-controller.js";
import { createWorkspaceRequestId } from "../../../packages/shared/src/codespaces/workspace-request-id.js";

let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "ml-permission-upgrade-")));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function fixture(enabled = true, leaseUntil = Date.now() + 3_600_000) {
  const state = await PrivateState.open(directory);
  const f = await localFixture(state);
  const {
    appliedRevision: _revision,
    agentRepositoryManagement: _delegation,
    ...oldFields
  } = f.policy;
  const previous = { ...oldFields, version: 1 as const, enabled, leaseUntil };
  const receipt = {
    owner: randomUUID(),
    profile: createHash("sha256")
      .update(JSON.stringify({ deviceId: previous.deviceId, runtime: previous.runtime }))
      .digest("hex"),
    settled: true,
  };
  const approval = {
    origin: "https://moira.example",
    userId: "owner",
    deviceId: previous.deviceId,
    deviceGeneration: 1,
    connectionId: randomUUID(),
    ceiling: {
      cpuCores: previous.runtime.cpuCores,
      memoryBytes: previous.runtime.memoryBytes,
      storageBytes: previous.runtime.maxStorageBytes,
      dockerBytes: previous.runtime.dockerBytes,
      maxLeaseMs: 3_600_000,
    },
    appliedRevision: 3,
    agentRepositoryManagement: null,
    repositoryRequests: [],
  };
  await state.write("policy.json", previous);
  await state.write("runtime-owner.json", receipt);
  await state.write("web-control.json", approval);
  await state.write("controller-operation-retained.json", {
    state: "unconfirmed",
    digest: "original-input-digest",
    outcome: { policy: previous },
  });
  const retained = await readFile(join(directory, "controller-operation-retained.json"));
  return {
    ...f,
    policy: { ...f.policy, appliedRevision: 3 },
    state,
    previous,
    receipt,
    approval,
    retained,
  };
}

test.each([
  { enabled: false, offset: 3_600_000, expected: false },
  { enabled: true, offset: -1, expected: false },
  { enabled: true, offset: 8 * 24 * 3_600_000, expected: false },
  { enabled: true, offset: 3_600_000, expected: true },
])(
  "old permission $enabled at offset $offset converts conservatively to $expected",
  async ({ enabled, offset, expected }) => {
    const f = await fixture(enabled, Date.now() + offset);
    const release = await f.state.lock();
    try {
      await upgradeLocalPolicyState(f.records);
      const policy = await f.records.policy();
      expect(policy).toEqual({ ...f.policy, enabled: expected });
      expect(await f.state.read("runtime-owner.json", (value) => value)).toEqual({
        ...f.receipt,
        profile: localRuntimeProfileHash(policy),
      });
      expect(await f.state.read("web-control.json", (value) => value)).toEqual({
        origin: f.approval.origin,
        userId: f.approval.userId,
        deviceId: f.approval.deviceId,
        deviceGeneration: f.approval.deviceGeneration,
        connectionId: f.approval.connectionId,
        repositoryRequests: [],
        ceiling: {
          cpuCores: f.approval.ceiling.cpuCores,
          memoryBytes: f.approval.ceiling.memoryBytes,
          storageBytes: f.approval.ceiling.storageBytes,
          dockerBytes: f.approval.ceiling.dockerBytes,
        },
      });
      expect(await f.records.get(f.space.id)).toEqual(f.space);
      expect(await readFile(join(directory, "controller-operation-retained.json"))).toEqual(
        f.retained,
      );
      const bytes = await readFile(join(directory, "policy.json"));
      await upgradeLocalPolicyState(f.records);
      expect(await readFile(join(directory, "policy.json"))).toEqual(bytes);
    } finally {
      await release();
    }
  },
);

test.each(["policy.json", "web-control.json"])(
  "an interruption before %s resumes the exact active-document conversion without replay",
  async (interruptedKey) => {
    const f = await fixture();
    const write = f.state.write.bind(f.state);
    let interrupt = true;
    f.state.write = async (key, value) => {
      if (key === interruptedKey && interrupt) {
        interrupt = false;
        throw new Error("Controlled active-document publication failure");
      }
      await write(key, value);
    };
    const release = await f.state.lock();
    try {
      await expect(upgradeLocalPolicyState(f.records)).rejects.toThrow(
        "Controlled active-document publication failure",
      );
      f.state.write = write;
      await upgradeLocalPolicyState(f.records);
      expect(await f.records.policy()).toEqual(f.policy);
      expect(await f.state.read("runtime-owner.json", (value) => value)).toEqual({
        ...f.receipt,
        profile: localRuntimeProfileHash(f.policy),
      });
      expect(await f.records.get(f.space.id)).toEqual(f.space);
      expect(await readFile(join(directory, "controller-operation-retained.json"))).toEqual(
        f.retained,
      );
    } finally {
      f.state.write = write;
      await release();
    }
  },
);

test.each(["unsettled owner", "wrong profile", "physical transition", "invalid approval"])(
  "%s refuses conversion before changing active state or original uncertainty",
  async (reason) => {
    const f = await fixture();
    if (reason === "unsettled owner")
      await f.state.write("runtime-owner.json", { ...f.receipt, settled: false });
    if (reason === "wrong profile")
      await f.state.write("runtime-owner.json", { ...f.receipt, profile: "f".repeat(64) });
    if (reason === "physical transition")
      await f.state.write("policy-transition.json", { previous: f.previous, unknown: true });
    if (reason === "invalid approval")
      await f.state.write("web-control.json", { ...f.approval, unexpectedAuthority: true });
    const keys = ["policy.json", "runtime-owner.json", "web-control.json"];
    const before = await Promise.all(keys.map((key) => readFile(join(directory, key))));
    const release = await f.state.lock();
    try {
      await expect(upgradeLocalPolicyState(f.records)).rejects.toThrow();
      expect(await Promise.all(keys.map((key) => readFile(join(directory, key))))).toEqual(before);
      expect(await readFile(join(directory, "controller-operation-retained.json"))).toEqual(
        f.retained,
      );
      expect(await f.records.get(f.space.id)).toEqual(f.space);
    } finally {
      await release();
    }
  },
);

test("explicit legacy disable preserves its original shape while enable requires the owner transition", async () => {
  const f = await fixture();
  const before = await readFile(join(directory, "policy.json"));
  await expect(setEnabled(f.records, true)).rejects.toMatchObject({
    code: "LOCAL_SERVICE_MAINTENANCE_REQUIRED",
  });
  expect(await readFile(join(directory, "policy.json"))).toEqual(before);
  await setEnabled(f.records, false);
  expect(await f.state.read("policy.json", (value) => value)).toEqual({
    ...f.previous,
    enabled: false,
  });
  const release = await f.state.lock();
  try {
    await upgradeLocalPolicyState(f.records);
    expect(await f.records.policy()).toEqual({ ...f.policy, enabled: false });
    expect(await readFile(join(directory, "controller-operation-retained.json"))).toEqual(
      f.retained,
    );
  } finally {
    await release();
  }
});

test("an original live-settings uncertainty survives conversion without blocking unrelated VM intent", async () => {
  const f = await fixture();
  await f.state.write("control-intent.json", {
    revision: 4,
    settings: { ...controlSettings(f.policy), leaseUntil: f.previous.leaseUntil },
    livePrevious: f.previous,
  });
  const original = await readFile(join(directory, "control-intent.json"));
  const release = await f.state.lock();
  try {
    await upgradeLocalPolicyState(f.records);
    expect(await f.records.policy()).toEqual(f.policy);
    expect(await f.records.get(f.space.id)).toEqual(f.space);
    expect(await readFile(join(directory, "control-intent.json"))).toEqual(original);
  } finally {
    await release();
  }
});

test("a separate CLI writer cannot overwrite an owner settings transaction and stale web settings cannot erase its later approval", async () => {
  const identity = {
    userId: "owner",
    deviceId: randomUUID(),
    deviceGeneration: 1,
    connectionId: randomUUID(),
  };
  const f = await controllerFixture(directory, identity);
  const execute = promisify(execFile);
  const cli = fileURLToPath(new URL("../../../packages/local/dist/cli.js", import.meta.url));
  const argv = [cli, "approve", "owner/another", "--state", directory];
  const before = await readFile(join(directory, "policy.json"));
  try {
    await f.records.withSettingsChange(async () => {
      const busy: unknown = await execute(process.execPath, argv).catch((error: unknown) => error);
      if (
        typeof busy !== "object" ||
        busy === null ||
        !("stderr" in busy) ||
        typeof busy.stderr !== "string"
      )
        throw new Error("The CLI writer did not return its structured refusal.");
      expect(busy).toMatchObject({ code: 1 });
      expect(JSON.parse(busy.stderr)).toEqual({
        error: {
          code: "LOCAL_ALREADY_RUNNING",
          message:
            "Another settings change is in progress; inspect its result before submitting a new change.",
        },
      });
      expect(await readFile(join(directory, "policy.json"))).toEqual(before);
    });
    await execute(process.execPath, argv);
    const actual = await f.records.policy();
    expect(actual.repositories.map((repository) => repository.fullName)).toEqual([
      "owner/project",
      "owner/another",
    ]);
    expect(actual.appliedRevision).toBe(1);
    expect(
      (await f.control.report({ ...identity, origin: "https://moira.example" }))?.appliedRevision,
    ).toBe(1);
    expect(
      await f.controller.settings({
        requestId: createWorkspaceRequestId(),
        expectedGeneration: 1,
        expectedRevision: 0,
        settings: { ...controlSettings(f.policy), label: "Stale browser draft" },
      }),
    ).toMatchObject({ outcome: { ok: false, error: { code: "LOCAL_CONTROL_CONFLICT" } } });
    expect(await f.records.policy()).toEqual(actual);
    expect((await f.records.get(f.space.id))?.desiredState).toBe("running");
  } finally {
    await f.close();
  }
});

test("legacy conversion cannot overwrite a separate CLI disable admitted after its policy read", async () => {
  const f = await fixture();
  const read = f.state.read.bind(f.state);
  let reached!: () => void, resume!: () => void;
  const captured = new Promise<void>((done) => {
    reached = done;
  });
  const paused = new Promise<void>((done) => {
    resume = done;
  });
  let first = true;
  f.state.read = async (key, parse) => {
    const value = await read(key, parse);
    if (key === "policy.json" && first) {
      first = false;
      reached();
      await paused;
    }
    return value;
  };
  const release = await f.state.lock();
  const converting = upgradeLocalPolicyState(f.records);
  try {
    await captured;
    const cli = fileURLToPath(new URL("../../../packages/local/dist/cli.js", import.meta.url));
    let refusal: unknown;
    await promisify(execFile)(process.execPath, [cli, "disable", "--state", directory]).catch(
      (error) => {
        refusal = error;
      },
    );
    const disabled = !(await read("policy.json", (value) => value as { enabled: boolean }))!
      .enabled;
    resume();
    await converting;
    expect((await f.records.policy()).enabled).toBe(!disabled);
    if (!disabled)
      expect(refusal).toMatchObject({ stderr: expect.stringContaining("LOCAL_ALREADY_RUNNING") });
  } finally {
    resume();
    await converting.catch(() => undefined);
    f.state.read = read;
    await release();
  }
});
