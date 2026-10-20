import { afterEach, expect, test } from "@jest/globals";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runProcess } from "../../../packages/local/src/process.js";

const execute = promisify(execFile);
const nativeTest = process.platform === "darwin" ? test : test.skip;
let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

nativeTest("owned machine keychain disables the actual native idle timer", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-keychain-native-")));
  const helper = join(root, "helper");
  const home = join(root, "home");
  await mkdir(join(home, "Library", "Keychains"), { recursive: true, mode: 0o700 });
  await mkdir(join(home, "Library", "Preferences"), { recursive: true, mode: 0o700 });
  await execute("/usr/bin/clang", [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wno-deprecated-declarations",
    "-framework",
    "Security",
    "-framework",
    "CoreFoundation",
    "packages/local/src/keychain-helper.c",
    "-o",
    helper,
  ]);
  const fixture = join(root, "legacy-policy");
  const fixtureSource = join(root, "legacy-policy.c");
  await writeFile(
    fixtureSource,
    `
    #include <Security/Security.h>
    int main(int argc, char **argv) {
      if (argc != 2 || SecKeychainSetUserInteractionAllowed(false)) return 2;
      SecKeychainRef keychain = NULL;
      OSStatus status = SecKeychainOpen(argv[1], &keychain);
      SecKeychainSettings settings = {SEC_KEYCHAIN_SETTINGS_VERS1, false, true, 300};
      if (!status) status = SecKeychainSetSettings(keychain, &settings);
      if (!status) status = SecKeychainLock(keychain);
      if (keychain) CFRelease(keychain);
      return status ? 1 : 0;
    }
  `,
  );
  await execute("/usr/bin/clang", [
    "-Wno-deprecated-declarations",
    "-framework",
    "Security",
    "-framework",
    "CoreFoundation",
    fixtureSource,
    "-o",
    fixture,
  ]);
  const invoke = async (argv: string[], stdin?: Buffer, context = home) => {
    const result = await runProcess({
      binary: helper,
      argv,
      cwd: root!,
      env: { HOME: context, PATH: "/usr/bin:/bin" },
      stdin,
      timeoutMs: 30_000,
      maxBytes: 16_384,
    });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
  };
  const personalBefore = await invoke(["metadata"], undefined, userInfo().homedir);
  const path = join(home, "Library", "Keychains", "machine.keychain-db");
  const password = Buffer.from("0123456789abcdef".repeat(4));
  try {
    await invoke(["create", path], password);
    const policy = await invoke(["probe", path]);
    expect(policy).toMatchObject({
      unlocked: true,
      settingsStatus: 0,
      lockOnSleep: false,
      useLockInterval: false,
      lockInterval: 2_147_483_647,
    });
    await execute(fixture, [path], { env: { HOME: home, PATH: "/usr/bin:/bin" } });
    // Existing machine stores must recover their original password and policy;
    // fixing only newly created stores leaves installed devices broken.
    await invoke(["unlock-machine", path], password);
    expect(await invoke(["probe", path])).toEqual(policy);
  } finally {
    password.fill(0);
    expect(await invoke(["metadata"], undefined, userInfo().homedir)).toEqual(personalBefore);
  }
});
