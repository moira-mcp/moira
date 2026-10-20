import { afterEach, beforeEach, expect, jest, test } from "@jest/globals";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RuntimeDeviceOwner } from "../../../packages/local/src/runtime-device-owner.js";
import { RuntimeOwner } from "../../../packages/local/src/runtime-owner.js";
import { DeviceRuntimeControl } from "../../../packages/local/src/runtime-control.js";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalRefusal, SUPPORTED_SBX_VERSION } from "../../../packages/local/src/policy.js";
import { runtimeApiAsset } from "../../../packages/local/src/assets.js";
import type { ProcessRequest, RunProcess } from "../../../packages/local/src/process.js";
import { localFixture } from "../../integration/local/fixtures.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-observation-")));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
const result = (value: unknown) => ({
  exitCode: 0,
  stdout: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)),
  stderr: Buffer.alloc(0),
});
async function fixture() {
  const state = await PrivateState.open(root);
  const f = await localFixture(state);
  f.policy.runtime.binary = join(root, "sdk-fixture");
  await writeFile(f.policy.runtime.binary, "never executed", { mode: 0o700 });
  await state.write("policy.json", f.policy);
  f.space.runtimeId = randomUUID();
  await f.records.put(f.space);
  let held = true,
    inventoryAvailable = true;
  jest.spyOn(DeviceRuntimeControl.prototype, "assertDockerHeld").mockImplementation(async () => {
    if (!held) throw new LocalRefusal("LOCAL_CONTROL_RETIRED", "Fixture custody retired.");
  });
  jest.spyOn(DeviceRuntimeControl.prototype, "protect").mockImplementation(async () => {
    if (!held) throw new LocalRefusal("LOCAL_CONTROL_RETIRED", "Fixture custody retired.");
    if (!inventoryAvailable)
      throw new LocalRefusal("LOCAL_OBSERVATION_UNKNOWN", "Other inventory unavailable.");
  });
  const calls: ProcessRequest[] = [];
  let onRead: (() => Promise<void>) | undefined;
  const execute: RunProcess = async (request) => {
    calls.push(request);
    await onRead?.();
    const args = request.argv;
    if (request.binary === process.execPath && args[3] === "container-identity")
      return result({ containerId: "c".repeat(64), name: f.space.name, state: "exited" });
    if (args[0] === "version") return result(`sbx version: v${SUPPORTED_SBX_VERSION} fixture`);
    if (args[0] === "ls")
      return result({
        sandboxes: [
          {
            id: f.space.runtimeId,
            name: f.space.name,
            agent: "shell",
            status: "stopped",
          },
        ],
      });
    if (args[0] === "daemon")
      return result({
        status: "running",
        socket: join(
          device.runtime.home,
          ".sbx",
          `run_${device.runtime.environment.DOCKER_SANDBOXES_APP_NAME}`,
          "d",
          "sandboxd.sock",
        ),
      });
    if (args[0] === "inspect")
      return result({
        name: f.space.name,
        agent: "shell",
        image: f.policy.runtime.template,
        image_digest: f.policy.runtime.template.split("@")[1],
        cpus: f.policy.runtime.cpuCores,
        memory: `${f.policy.runtime.memoryBytes / 1024 ** 2}m`,
        network: f.space.name,
        runtime_mounts: [],
        daemon_version: `v${SUPPORTED_SBX_VERSION}`,
        kits: [],
        mcp_gateway: false,
        network_policy: {},
      });
    throw new Error("Unexpected fixture runtime invocation");
  };
  const device = new RuntimeDeviceOwner(f.records, f.policy, "work", execute);
  device.runtime.prepareCredentials = async () => undefined;
  await mkdir(
    join(
      device.runtime.home,
      ".sbx",
      `run_${device.runtime.environment.DOCKER_SANDBOXES_APP_NAME}`,
      "d",
    ),
    { recursive: true, mode: 0o700 },
  );
  const metadata = (argv: string[]): ProcessRequest => ({
    binary: f.policy.runtime.binary,
    argv,
    cwd: device.runtime.home,
    env: device.runtime.environment,
    timeoutMs: 1000,
    maxBytes: 8192,
  });
  return {
    ...f,
    state,
    device,
    calls,
    metadata,
    setHeld: (value: boolean) => {
      held = value;
    },
    setInventoryAvailable: (value: boolean) => {
      inventoryAvailable = value;
    },
    afterRead: (callback: () => Promise<void>) => {
      onRead = callback;
    },
  };
}

test("fixed metadata stays observable while unrelated inventory cannot be refreshed", async () => {
  const f = await fixture();
  f.setInventoryAvailable(false);
  const observed = await f.device.readRuntime(f.space, f.metadata(["version"]));
  expect(observed?.stdout.toString()).toContain(`v${SUPPORTED_SBX_VERSION}`);
  // This is an observed result under unavailable inventory, not just fewer subprocesses.
  expect(f.calls.map((call) => call.argv)).toEqual([["version"]]);
});

test.each(["grant", "generation", "custody"] as const)(
  "a %s change during metadata observation prevents returning it as current evidence",
  async (change) => {
    const f = await fixture();
    f.afterRead(async () => {
      if (change === "grant") await f.state.write("policy.json", { ...f.policy, repositories: [] });
      if (change === "generation")
        await f.records.put({ ...f.space, generation: f.space.generation + 1 });
      if (change === "custody") f.setHeld(false);
    });
    await expect(f.device.readRuntime(f.space, f.metadata(["version"]))).rejects.toMatchObject({
      code:
        change === "grant"
          ? "LOCAL_REPOSITORY_DENIED"
          : change === "generation"
            ? "LOCAL_GENERATION_CONFLICT"
            : "LOCAL_CONTROL_RETIRED",
    });
  },
);

test("observation custody does not admit another VM, an input payload, or a runtime effect", async () => {
  const f = await fixture();
  for (const request of [
    f.metadata(["inspect", "--json", `moira-${"f".repeat(32)}`]),
    { ...f.metadata(["version"]), stdin: Buffer.from("input") },
    f.metadata(["policy", "allow", "network", "**"]),
    {
      ...f.metadata([]),
      binary: process.execPath,
      argv: [
        runtimeApiAsset(),
        f.device.runtime.home,
        f.device.runtime.environment.DOCKER_SANDBOXES_APP_NAME,
        f.space.name,
        "absent",
      ],
    },
  ])
    expect(await f.device.readRuntime(f.space, request)).toBeUndefined();
  expect(f.calls).toEqual([]);
});

test.each(["grant", "generation", "custody"] as const)(
  "a %s change after the last metadata read still fences actual VM start",
  async (change) => {
    const f = await fixture();
    const owner = new RuntimeOwner(
      f.records,
      f.space.id,
      (closure) => f.device.protect(f.space.id, closure),
      async () => undefined,
      undefined,
      async (space, request) => {
        const observed = await f.device.readRuntime(space, request);
        if (request.argv[0] === "inspect" && observed) {
          if (change === "grant")
            await f.state.write("policy.json", { ...f.policy, repositories: [] });
          if (change === "generation")
            await f.records.put({ ...f.space, generation: f.space.generation + 1 });
          if (change === "custody") f.setHeld(false);
        }
        return observed;
      },
    );
    await owner.admit();
    await expect(owner.prepare()).rejects.toMatchObject({
      code:
        change === "grant"
          ? "LOCAL_REPOSITORY_DENIED"
          : change === "generation"
            ? "LOCAL_GENERATION_CONFLICT"
            : "LOCAL_CONTROL_RETIRED",
    });
    expect(f.calls.some((call) => call.argv[0] === "inspect")).toBe(true);
    expect(
      f.calls.every(
        (call) => call.binary === f.policy.runtime.binary || call.argv[3] === "container-identity",
      ),
    ).toBe(true);
  },
);
