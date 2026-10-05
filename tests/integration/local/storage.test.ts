import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, realpath, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { defaultStorageMount, initializeStorage } from "../../../packages/local/src/storage.js";
import { GiB } from "../../../packages/local/src/policy.js";

let root: string;
let deviceId: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-local-storage-")));
  deviceId = randomUUID();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
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
});
