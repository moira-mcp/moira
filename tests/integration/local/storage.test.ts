import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, rmdir, realpath, mkdir, writeFile, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import {
  admitStorage,
  defaultStorageMount,
  initializeStorage,
  resizeStorage,
} from "../../../packages/local/src/storage.js";
import { GiB } from "../../../packages/local/src/policy.js";
import { runProcess } from "../../../packages/local/src/process.js";
import { localPolicy } from "./fixtures.js";

let root: string;
let deviceId: string;
let preserveNativeImage: boolean;
beforeEach(async () => {
  preserveNativeImage = false;
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-local-storage-")));
  deviceId = randomUUID();
});
afterEach(async () => {
  if (!preserveNativeImage) await rm(root, { recursive: true, force: true });
});

describe("bounded runtime storage mount", () => {
  test("Darwin's default mount keeps native socket paths short independently of the state path", () => {
    const mount = defaultStorageMount(
      `/private/var/${"long-state-directory/".repeat(20)}`,
      deviceId,
      "darwin",
    );
    expect(mount).toBe(join("/private/tmp", `ml-${deviceId.replaceAll("-", "").slice(0, 12)}`));
    expect(
      Buffer.byteLength(join(mount, "runtime", ".sbx", "run_moira-123456789abcde", "network.sock")),
    ).toBeLessThan(104);
  });

  test("a supplied ordinary directory is not treated as a bounded volume or rewritten", async () => {
    const state = await PrivateState.open(root);
    const directory = join(root, "manual-mount");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(join(directory, "preserved.txt"), "original", { mode: 0o600 });
    await expect(initializeStorage(state, deviceId, 8 * GiB, directory)).rejects.toMatchObject({
      code: "LOCAL_STORAGE_UNSAFE",
    });
    expect(await readFile(join(directory, "preserved.txt"), "utf8")).toBe("original");
  });

  const darwinTest = process.platform === "darwin" ? test : test.skip;
  darwinTest("resize refuses a caller-selected mount without invoking native tools", async () => {
    const state = await PrivateState.open(root);
    const policy = localPolicy(root);
    let called = false;
    await expect(
      resizeStorage(state, policy, 16 * GiB, async () => {
        called = true;
        throw new Error("A caller-selected path must never reach a disk command");
      }),
    ).rejects.toMatchObject({ code: "LOCAL_STORAGE_OWNER" });
    expect(called).toBe(false);
  });

  const nativeTest =
    process.platform === "darwin" && process.env.MOIRA_LOCAL_NATIVE_STORAGE_TESTS === "1"
      ? test
      : test.skip;
  nativeTest(
    "owned APFS growth and shrink preserve data and actual finite filesystem capacity",
    async () => {
      const state = await PrivateState.open(root);
      const policy = localPolicy(root);
      policy.deviceId = deviceId;
      policy.runtime.maxStorageBytes = 8 * GiB;
      const mount = await initializeStorage(state, deviceId, 8 * GiB);
      policy.runtime.storageRoot = mount;
      let failure: unknown;
      try {
        const sentinel = join(mount, "preserved.txt");
        await writeFile(sentinel, "persistent user data", { mode: 0o600 });
        const before = await statfs(mount, { bigint: true });
        await resizeStorage(state, policy, 12 * GiB);
        policy.runtime.maxStorageBytes = 12 * GiB;
        await state.write("policy.json", policy);
        await admitStorage(policy);
        const grown = await statfs(mount, { bigint: true });
        expect(grown.blocks * grown.bsize).toBeGreaterThan(
          before.blocks * before.bsize + BigInt(3 * GiB),
        );
        expect(grown.blocks * grown.bsize).toBeLessThanOrEqual(BigInt(12 * GiB));
        expect(await readFile(sentinel, "utf8")).toBe("persistent user data");
        await resizeStorage(state, policy, 8 * GiB);
        policy.runtime.maxStorageBytes = 8 * GiB;
        await state.write("policy.json", policy);
        await admitStorage(policy);
        const shrunk = await statfs(mount, { bigint: true });
        expect(shrunk.blocks * shrunk.bsize).toBeLessThanOrEqual(BigInt(8 * GiB));
        expect(shrunk.blocks * shrunk.bsize).toBeGreaterThan(BigInt(7 * GiB));
        expect(await readFile(sentinel, "utf8")).toBe("persistent user data");
      } catch (error) {
        failure = error;
        const info = await runProcess({
          binary: "/usr/bin/hdiutil",
          argv: ["info", "-plist"],
          cwd: root,
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          timeoutMs: 10_000,
          maxBytes: 1024 * 1024,
        });
        const decoded = await runProcess({
          binary: "/usr/bin/plutil",
          argv: ["-convert", "json", "-o", "-", "-"],
          stdin: info.stdout,
          cwd: root,
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          timeoutMs: 10_000,
          maxBytes: 1024 * 1024,
        });
        const images = JSON.parse(decoded.stdout.toString("utf8")).images as {
          "image-path": string;
          "system-entities": unknown;
        }[];
        console.info(
          "Failed test image native bindings",
          images
            .filter((image) => image["image-path"] === join(root, "storage.sparsebundle"))
            .map((image) => image["system-entities"]),
        );
      } finally {
        const result = await runProcess({
          binary: "/usr/bin/hdiutil",
          argv: ["detach", mount],
          cwd: root,
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          timeoutMs: 120_000,
          maxBytes: 64 * 1024,
        });
        if (result.exitCode !== 0) {
          preserveNativeImage = true;
          failure ??= new Error("Test image could not detach normally; preserve it for inspection");
        } else await rmdir(mount);
      }
      if (failure) throw failure;
    },
    180_000,
  );
});
