import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { RuntimeOwner } from "../../../packages/local/src/runtime-owner.js";
import type {
  LocalVmRuntime,
  FixedGuestEntrypoint,
} from "../../../packages/local/src/local-vm-runtime.js";
import { adaptSbxRuntime } from "../../../packages/local/src/local-vm-runtime-factory.js";
import { SbxRuntime } from "../../../packages/local/src/sbx-runtime.js";
import { installGuest } from "../../../packages/local/src/assets.js";
import { localFixture } from "./fixtures.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-local-runtime-port-")));
});
afterEach(async () => {
  jest.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

function inspection(local: Awaited<ReturnType<typeof localFixture>>, mounts: unknown[] = []) {
  return {
    name: local.space.name,
    agent: "shell",
    image: local.policy.runtime.template,
    image_digest: local.policy.runtime.template.split("@")[1],
    cpus: local.policy.runtime.cpuCores,
    memory: `${local.policy.runtime.memoryBytes / 1024 ** 2}m`,
    network: local.space.name,
    runtime_mounts: mounts,
    kits: [],
    daemon_version: "v0.46.0",
    mcp_gateway: false,
    network_policy: {},
  };
}

describe("portable local VM runtime port", () => {
  test("manager dispatch consumes a plain backend without SDK credentials or native methods", async () => {
    const local = await localFixture(await PrivateState.open(root));
    const identity = { name: local.space.name, runtimeId: local.space.runtimeId! };
    const inspect = jest.fn(async (_identity?: typeof identity) => ({
      id: identity.runtimeId,
      name: identity.name,
      status: "running" as const,
    }));
    const verify = jest.fn(
      async (_identity: typeof identity, _expectedNetworkDigest?: string | null) => {},
    );
    const backend: LocalVmRuntime = {
      boundary: {
        verifyConfiguration: async () => {},
        verify,
        configureNetwork: async () => local.space.networkPolicy!,
      },
      list: async () => [await inspect()],
      inspectExact: inspect,
      create: async () => identity,
      start: async () => {},
      stop: async () => {},
      remove: async () => {},
      runFixedGuest: async () => Buffer.from("portable-guest-result"),
    };
    const manager = new LocalManager(local.records, { runtime: () => backend });
    const dispatch = jest.fn(async () => "accepted");
    expect(await manager.dispatchGuest(local.space.id, dispatch)).toBe("accepted");
    expect(manager.runtime(local.policy)).toBe(backend);
    expect(inspect).toHaveBeenCalledWith(identity);
    expect(verify).toHaveBeenCalledWith(identity, local.space.networkPolicy);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await local.records.get(local.space.id)).toEqual(local.space);
  });

  test("SBX adaptation retains backend network receipt verification and refuses a changed receipt", async () => {
    const local = await localFixture(await PrivateState.open(root));
    const sdk = new SbxRuntime(local.policy);
    const configuration = jest.spyOn(sdk, "verifySettings").mockResolvedValue(undefined);
    const boundary = jest.spyOn(sdk, "verifyBoundary").mockResolvedValue(undefined);
    const policy = Buffer.from("externally enforced network policy");
    jest.spyOn(sdk, "networkPolicy").mockResolvedValue(policy);
    const runtime = adaptSbxRuntime(sdk);
    const identity = { name: local.space.name, runtimeId: local.space.runtimeId! };
    const digest = createHash("sha256").update(policy).digest("hex");
    await runtime.boundary.verify(identity, digest);
    expect(configuration).toHaveBeenCalledTimes(1);
    expect(boundary).toHaveBeenCalledWith(identity);
    await expect(runtime.boundary.verify(identity, "0".repeat(64))).rejects.toMatchObject({
      code: "LOCAL_NETWORK_CHANGED",
    });
  });

  test.each(["installer", "worker"] as const)(
    "%s entrypoint preserves exact identity, input and cancellation",
    async (entrypoint) => {
      const local = await localFixture(await PrivateState.open(root));
      const sdk = new SbxRuntime(local.policy);
      const bytes = Buffer.from([0, 255, 10, 13]);
      const output = Buffer.from("verified-result");
      const guest = jest.spyOn(sdk, "runFixedGuest").mockResolvedValue(output);
      const runtime = adaptSbxRuntime(sdk);
      const identity = { name: local.space.name, runtimeId: local.space.runtimeId! };
      const controller = new AbortController();
      expect(
        await runtime.runFixedGuest(identity, entrypoint, bytes, 3210, controller.signal),
      ).toBe(output);
      expect(guest).toHaveBeenCalledWith(
        identity,
        entrypoint,
        bytes,
        3210,
        controller.signal,
        undefined,
      );
      expect(guest.mock.calls[0][2]).toBe(bytes);
      await expect(
        runtime.runFixedGuest(identity, "host-command" as FixedGuestEntrypoint),
      ).rejects.toMatchObject({ code: "LOCAL_GUEST_COMMAND_INVALID" });
      expect(guest).toHaveBeenCalledTimes(1);
    },
  );

  test("guest asset installation uses the portable fixed installer and the original bytes", async () => {
    const local = await localFixture(await PrivateState.open(root));
    const sdk = new SbxRuntime(local.policy);
    const guest = jest.spyOn(sdk, "runFixedGuest").mockResolvedValue(Buffer.alloc(0));
    const worker = Buffer.from("installed worker bytes");
    const identity = { name: local.space.name, runtimeId: local.space.runtimeId! };
    await installGuest(adaptSbxRuntime(sdk), identity, { worker, proxy: "installed proxy" });
    expect(guest).toHaveBeenCalledWith(
      identity,
      "installer",
      worker,
      undefined,
      undefined,
      undefined,
    );
    expect(guest.mock.calls[0][2]).toBe(worker);
  });

  test.each(["success", "configuration", "identity", "mount", "digest", "revoked"] as const)(
    "one final owned backend dispatch distinguishes %s before attaching",
    async (outcome) => {
      const local = await localFixture(await PrivateState.open(root));
      const identity = { name: local.space.name, runtimeId: local.space.runtimeId! };
      const policyBytes = Buffer.from("one externally enforced network proof");
      const native = jest.fn(async () => ({
        stdout: Buffer.from("guest result"),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      }));
      const sdk = new SbxRuntime(local.policy, native, async () => {});
      const configuration = jest.spyOn(sdk, "verifySettings").mockImplementation(async () => {
        if (outcome === "configuration")
          throw Object.assign(new Error("Unsafe configuration"), { code: "LOCAL_RUNTIME_UNSAFE" });
      });
      const observations: string[] = [];
      jest.spyOn(sdk, "call").mockImplementation(async (argv) => {
        observations.push(argv[0]);
        if (argv[0] === "ls")
          return Buffer.from(
            JSON.stringify({
              sandboxes: [
                {
                  id: outcome === "identity" ? "replacement-vm" : identity.runtimeId,
                  name: identity.name,
                  agent: "shell",
                  status: "running",
                },
              ],
            }),
          );
        if (argv[0] === "policy") return policyBytes;
        if (argv[0] === "inspect")
          return Buffer.from(
            JSON.stringify(inspection(local, outcome === "mount" ? ["unapproved-host-mount"] : [])),
          );
        throw new Error("Unexpected SDK observation");
      });
      const confirm = jest.fn(async () => {
        if (outcome === "revoked")
          throw Object.assign(new Error("Local authority disabled during proof"), {
            code: "LOCAL_DISABLED",
          });
      });
      const expected =
        outcome === "digest"
          ? "0".repeat(64)
          : createHash("sha256").update(policyBytes).digest("hex");
      const dispatch = adaptSbxRuntime(sdk).runFixedGuest(
        identity,
        "worker",
        Buffer.from("input"),
        1000,
        undefined,
        { expectedNetworkDigest: expected, confirm },
      );
      if (outcome === "success") {
        expect((await dispatch).toString()).toBe("guest result");
        expect(observations).toEqual(["ls", "inspect", "policy"]);
        expect(native).toHaveBeenCalledTimes(1);
        expect(confirm).toHaveBeenCalledTimes(1);
      } else {
        const codes = {
          configuration: "LOCAL_RUNTIME_UNSAFE",
          identity: "LOCAL_IDENTITY_CHANGED",
          mount: "LOCAL_SANDBOX_UNSAFE",
          digest: "LOCAL_NETWORK_CHANGED",
          revoked: "LOCAL_DISABLED",
        };
        await expect(dispatch).rejects.toMatchObject({ code: codes[outcome] });
        expect(native).not.toHaveBeenCalled();
      }
      expect(configuration).toHaveBeenCalledTimes(1);
    },
  );

  test.each(["enabled", "disabled-during-proof"] as const)(
    "real manager and owner perform one backend proof with authority %s",
    async (authority) => {
      const local = await localFixture(await PrivateState.open(root));
      const identity = { name: local.space.name, runtimeId: local.space.runtimeId! };
      const network = Buffer.from("chain network policy");
      local.space.networkPolicy = createHash("sha256").update(network).digest("hex");
      await local.records.put(local.space);
      const native = jest.fn(async () => ({
        stdout: Buffer.from('{"ok":true,"result":{"state":"running"}}'),
        stderr: Buffer.alloc(0),
        exitCode: 0,
      }));
      const sdk = new SbxRuntime(local.policy, native, async () => {});
      const settings = jest.spyOn(sdk, "verifySettings").mockResolvedValue(undefined);
      const observed: string[] = [];
      jest.spyOn(sdk, "call").mockImplementation(async (argv) => {
        observed.push(argv[0]);
        if (argv[0] === "ls")
          return Buffer.from(
            JSON.stringify({
              sandboxes: [
                { id: identity.runtimeId, name: identity.name, agent: "shell", status: "running" },
              ],
            }),
          );
        if (argv[0] === "inspect") {
          if (authority === "disabled-during-proof")
            await local.records.state.write("policy.json", { ...local.policy, enabled: false });
          return Buffer.from(JSON.stringify(inspection(local)));
        }
        if (argv[0] === "policy") return network;
        throw new Error("Unexpected SDK observation");
      });
      const fixedDispatch = SbxRuntime.prototype.runFixedGuest;
      // Substitute only the external SDK endpoint; manager, owner, final admission and backend proof remain real.
      jest
        .spyOn(SbxRuntime.prototype, "runFixedGuest")
        .mockImplementation((...args) => fixedDispatch.apply(sdk, args));
      const owner = new RuntimeOwner(
        local.records,
        local.space.id,
        async () => {},
        async () => {},
      );
      await owner.admit();
      const validate = jest.fn(() => owner.validate());
      const manager = new LocalManager(local.records, {
        guard: async () => ({
          active: true,
          observe: async () => [],
          stop: async () => {},
          retire: async () => {},
          remove: async () => {},
          space: async () => ({
            active: true,
            prepare: () => owner.prepare(),
            validate,
            operation: (request) => owner.operation(request),
            stop: async () => {},
          }),
        }),
      });
      const request = {
        action: "inspect",
        remoteMarker: `moira-op-${"a".repeat(32)}`,
        repositoryFullName: local.policy.repositories[0].fullName,
      };
      const dispatch = manager.dispatchGuest(local.space.id, () =>
        manager.operation(local.space.id, request),
      );
      if (authority === "enabled") {
        expect(JSON.parse((await dispatch).toString())).toMatchObject({
          ok: true,
          result: { state: "running" },
        });
        expect(native).toHaveBeenCalledTimes(1);
      } else {
        await expect(dispatch).rejects.toMatchObject({ code: "LOCAL_DISABLED" });
        expect(native).not.toHaveBeenCalled();
      }
      expect(validate).not.toHaveBeenCalled();
      expect(settings).toHaveBeenCalledTimes(1);
      expect(observed).toEqual(["ls", "inspect", "policy"]);
      expect(await local.records.get(local.space.id)).toEqual(local.space);
    },
  );
});
