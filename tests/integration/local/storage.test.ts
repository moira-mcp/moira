import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import {
  mkdtemp,
  rm,
  rmdir,
  realpath,
  mkdir,
  writeFile,
  readFile,
  statfs,
  lstat,
  symlink,
  chmod,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import {
  admitStorage,
  defaultStorageMount,
  initializeStorage,
  resizeStorage,
  ensureStorageMounted,
} from "../../../packages/local/src/storage.js";
import { GiB, LocalRefusal } from "../../../packages/local/src/policy.js";
import { runProcess, type RunProcess } from "../../../packages/local/src/process.js";
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

async function remountFixture() {
  const state = await PrivateState.open(root);
  const policy = localPolicy(root);
  policy.deviceId = deviceId;
  policy.runtime.storageRoot = join(root, "fixture-mount");
  await expect(lstat(policy.runtime.storageRoot)).rejects.toMatchObject({ code: "ENOENT" });
  const image = join(root, "storage.sparsebundle");
  await mkdir(image, { mode: 0o755 });
  await writeFile(join(image, "retained-data"), "saved image bytes", { mode: 0o600 });
  let attached = false;
  let loseAttachResponse = false;
  let admissionError: LocalRefusal | undefined;
  let admissionCalls = 0;
  let extraImages: object[] = [];
  const calls: string[][] = [];
  const run: RunProcess = async (request) => {
    calls.push([request.binary, ...request.argv]);
    let stdout = Buffer.alloc(0);
    if (request.binary === "/usr/bin/plutil") stdout = Buffer.from(request.stdin!);
    else if (request.argv[0] === "info")
      stdout = Buffer.from(
        JSON.stringify({
          images: [
            ...extraImages,
            ...(attached
              ? [
                  {
                    "image-path": image,
                    "system-entities": [{ "mount-point": policy.runtime.storageRoot }],
                  },
                ]
              : []),
          ],
        }),
      );
    else if (request.binary === "/usr/bin/hdiutil" && request.argv[0] === "attach") {
      attached = true;
      if (loseAttachResponse) throw new Error("Fixture response lost after attachment");
    } else throw new Error("Unexpected native command");
    return { stdout, stderr: Buffer.alloc(0), exitCode: 0 };
  };
  const admit = async () => {
    admissionCalls++;
    if (!attached) throw new LocalRefusal("LOCAL_STORAGE_NOT_MOUNTED", "Fixture volume absent");
    if (admissionError) throw admissionError;
  };
  return {
    state,
    policy,
    image,
    calls,
    dependencies: {
      run,
      admit,
      platform: "darwin" as const,
      defaultMount: () => join(root, "fixture-mount"),
    },
    get admissionCalls() {
      return admissionCalls;
    },
    loseResponse() {
      loseAttachResponse = true;
    },
    refuseAdmission(error: LocalRefusal) {
      admissionError = error;
    },
    setBindings(images: object[]) {
      extraImages = images;
    },
  };
}

describe("bounded runtime storage mount", () => {
  const darwinTest = process.platform === "darwin" ? test : test.skip;
  test("an absent approved volume reports LOCAL_STORAGE_NOT_MOUNTED", async () => {
    const policy = localPolicy(root);
    policy.runtime.storageRoot = join(root, "missing-volume");
    await expect(admitStorage(policy)).rejects.toMatchObject({ code: "LOCAL_STORAGE_NOT_MOUNTED" });
  });

  test.each([false, true])(
    "startup restores the saved image once with lost attach response=%s",
    async (lost) => {
      const fixture = await remountFixture();
      if (lost) fixture.loseResponse();
      const before = JSON.stringify(fixture.policy);
      await ensureStorageMounted(fixture.state, fixture.policy, fixture.dependencies);
      expect(fixture.admissionCalls).toBe(2);
      expect(fixture.calls.filter((call) => call[1] === "attach")).toEqual([
        [
          "/usr/bin/hdiutil",
          "attach",
          "-nobrowse",
          "-mountpoint",
          fixture.policy.runtime.storageRoot,
          fixture.image,
        ],
      ]);
      expect(await readFile(join(fixture.image, "retained-data"), "utf8")).toBe(
        "saved image bytes",
      );
      expect(JSON.stringify(fixture.policy)).toBe(before);
      const afterFirst = fixture.calls.length;
      await ensureStorageMounted(fixture.state, fixture.policy, fixture.dependencies);
      expect(fixture.calls).toHaveLength(afterFirst);
      expect(fixture.admissionCalls).toBe(3);
    },
  );

  test.each(["LOCAL_STORAGE_OWNER", "LOCAL_STORAGE_UNBOUNDED", "LOCAL_STORAGE_FULL"])(
    "startup requires ordinary admission after attach: %s",
    async (code) => {
      const fixture = await remountFixture();
      fixture.refuseAdmission(new LocalRefusal(code, "Fixture admission refusal"));
      await expect(
        ensureStorageMounted(fixture.state, fixture.policy, fixture.dependencies),
      ).rejects.toMatchObject({ code });
      expect(fixture.admissionCalls).toBe(2);
      expect(await readFile(join(fixture.image, "retained-data"), "utf8")).toBe(
        "saved image bytes",
      );
    },
  );

  test.each(["other-image", "other-mount"])(
    "startup refuses conflicting native binding: %s",
    async (kind) => {
      const fixture = await remountFixture();
      fixture.setBindings([
        {
          "image-path": kind === "other-image" ? "/other/image" : fixture.image,
          "system-entities": [
            {
              "mount-point":
                kind === "other-image" ? fixture.policy.runtime.storageRoot : "/other/mount",
            },
          ],
        },
      ]);
      await expect(
        ensureStorageMounted(fixture.state, fixture.policy, fixture.dependencies),
      ).rejects.toMatchObject({ code: "LOCAL_STORAGE_OWNER" });
      expect(fixture.calls.filter((call) => call[1] === "attach")).toEqual([]);
      expect(fixture.admissionCalls).toBe(1);
    },
  );

  test.each(["entities", "images"])("startup refuses duplicate native %s", async (kind) => {
    const fixture = await remountFixture();
    const entity = { "mount-point": fixture.policy.runtime.storageRoot };
    const image = {
      "image-path": fixture.image,
      "system-entities": kind === "entities" ? [entity, entity] : [entity],
    };
    fixture.setBindings(kind === "images" ? [image, image] : [image]);
    await expect(
      ensureStorageMounted(fixture.state, fixture.policy, fixture.dependencies),
    ).rejects.toMatchObject({ code: "LOCAL_STORAGE_OWNER" });
    expect(fixture.calls.filter((call) => call[1] === "attach")).toEqual([]);
    expect(fixture.admissionCalls).toBe(1);
  });

  test.each(["custom", "linux"])("startup does not attach a %s mount", async (kind) => {
    const fixture = await remountFixture();
    if (kind === "custom") fixture.policy.runtime.storageRoot = join(root, "custom-volume");
    const dependencies = {
      ...fixture.dependencies,
      platform: kind === "linux" ? ("linux" as const) : ("darwin" as const),
    };
    await expect(
      ensureStorageMounted(fixture.state, fixture.policy, dependencies),
    ).rejects.toMatchObject({ code: "LOCAL_STORAGE_NOT_MOUNTED" });
    expect(fixture.calls).toEqual([]);
    expect(await readFile(join(fixture.image, "retained-data"), "utf8")).toBe("saved image bytes");
  });

  test.each(["symlink", "writable", "missing"])(
    "startup refuses an unsafe saved image: %s",
    async (kind) => {
      const fixture = await remountFixture();
      if (kind === "symlink") {
        await rm(fixture.image, { recursive: true });
        await symlink(root, fixture.image);
      } else if (kind === "writable") await chmod(fixture.image, 0o777);
      else await rm(fixture.image, { recursive: true });
      await expect(
        ensureStorageMounted(fixture.state, fixture.policy, fixture.dependencies),
      ).rejects.toMatchObject({
        code: kind === "missing" ? "LOCAL_STORAGE_NOT_MOUNTED" : "LOCAL_STORAGE_OWNER",
      });
      expect(fixture.calls).toEqual([]);
    },
  );

  test("startup refuses a nonempty mount point without hiding existing files", async () => {
    const fixture = await remountFixture();
    await mkdir(fixture.policy.runtime.storageRoot, { mode: 0o700 });
    await writeFile(join(fixture.policy.runtime.storageRoot, "preserved"), "host file", {
      mode: 0o600,
    });
    await expect(
      ensureStorageMounted(fixture.state, fixture.policy, fixture.dependencies),
    ).rejects.toMatchObject({ code: "LOCAL_STORAGE_OWNER" });
    expect(fixture.calls.filter((call) => call[1] === "attach")).toEqual([]);
    expect(await readFile(join(fixture.policy.runtime.storageRoot, "preserved"), "utf8")).toBe(
      "host file",
    );
  });

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
