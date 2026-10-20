import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import {
  stageLocalService,
  serviceInstallation,
  serviceBundleIdentity,
  promoteLocalService,
  ensureLocalServiceStarted,
  serviceSocketPath,
} from "../../../packages/local/src/service-install.js";

const execute = promisify(execFile);
let root: string;
let state: PrivateState;
const children: ChildProcess[] = [];
async function writableDirectories(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
  await chmod(path, 0o700);
  for (const name of await readdir(path)) await writableDirectories(join(path, name));
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ml-installer-")));
  state = await PrivateState.open(join(root, "state"));
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "close");
      child.kill("SIGTERM");
      await ended;
    }
  }
  await rm((await state.ipcDirectory()).root, { recursive: true, force: true });
  await writableDirectories(root);
  await rm(root, { recursive: true, force: true });
});
/** Package fixtures use the actual copied Node; no SDK, launchd or VM is involved. */
async function bundle(name: string) {
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  await copyFile(process.execPath, join(directory, "node"));
  await chmod(join(directory, "node"), 0o700);
  for (const file of [
    "guard.js",
    "runtime-api.js",
    "config.js",
    "github-provisioner.js",
    "process-group-helper",
    "runtime-control-helper",
    ...(process.platform === "darwin" ? ["keychain-helper"] : []),
  ])
    await writeFile(join(directory, file), "owned fixture", {
      mode: file.endsWith(".js") ? 0o600 : 0o700,
    });
  for (const folder of ["workspace-payload", "github-toolchain", "owner-runtime"]) {
    await mkdir(join(directory, folder), { mode: 0o700 });
    await writeFile(join(directory, folder, "asset"), name, { mode: 0o600 });
  }
  await mkdir(join(directory, "owner-runtime", "fonts", "ttf"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(join(directory, "owner-runtime", "fonts", "ttf", "font"), name, {
    mode: 0o600,
  });
  await writeFile(
    join(directory, "cli.js"),
    `console.log(JSON.stringify({edition:${JSON.stringify(name)},executable:process.execPath,arguments:process.argv.slice(2)}));if(process.env.HOLD_OWNER==='1')setInterval(()=>{},1000);`,
    { mode: 0o600 },
  );
  return directory;
}
const absent = () => Object.assign(new Error("No registered service"), { code: 113 });

describe("Local service installation preserves the physical owner selection", () => {
  test("the staged closure runs its own Node after the build directory disappears", async () => {
    const source = await bundle("first"),
      staged = await stageLocalService(state, source);
    expect(await serviceInstallation(state)).toMatchObject({
      active: null,
      staged: staged.release,
    });
    expect(await serviceBundleIdentity(staged.releaseDirectory)).toMatchObject({
      release: staged.release,
    });
    expect((await lstat(join(staged.releaseDirectory, "node"))).ino).not.toBe(
      (await lstat(join(source, "node"))).ino,
    );
    await promoteLocalService(state, staged.release);
    await rm(source, { recursive: true });
    const installation = await serviceInstallation(state);
    const result = await execute(installation.launcher, [], { env: { PATH: "/usr/bin:/bin" } });
    expect(JSON.parse(result.stdout)).toEqual({
      edition: "first",
      executable: join(staged.releaseDirectory, "node"),
      arguments: ["service", "--state", state.root],
    });
    expect(await readFile(join(staged.releaseDirectory, "owner-runtime", "asset"), "utf8")).toBe(
      "first",
    );
    expect((await lstat(staged.releaseDirectory)).mode & 0o222).toBe(0);
    const nested = join(staged.releaseDirectory, "owner-runtime", "fonts", "ttf");
    expect(await readFile(join(nested, "font"), "utf8")).toBe("first");
    for (const directory of [nested, join(nested, ".."), join(nested, "..", "..")])
      expect((await lstat(directory)).mode & 0o222).toBe(0);
    const manifest = JSON.parse(
      await readFile(join(staged.releaseDirectory, "service-release.json"), "utf8"),
    );
    expect(manifest.files).toContainEqual(
      expect.objectContaining({ path: "owner-runtime/fonts/ttf/font" }),
    );
  });
  test("a routine update stages a new release while the original owner executable keeps running", async () => {
    const first = await stageLocalService(state, await bundle("first"));
    await promoteLocalService(state, first.release);
    const launcher = (await serviceInstallation(state)).launcher;
    const child = spawn(launcher, [], {
      env: { PATH: "/usr/bin:/bin", HOLD_OWNER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    const [initial] = await once(child.stdout!, "data");
    expect(JSON.parse(String(initial)).executable).toBe(join(first.releaseDirectory, "node"));
    const second = await stageLocalService(state, await bundle("second"));
    expect(second.release).not.toBe(first.release);
    expect(await serviceInstallation(state)).toMatchObject({
      active: first.release,
      staged: second.release,
    });
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
    const result = await execute(launcher, [], { env: { PATH: "/usr/bin:/bin" } });
    expect(JSON.parse(result.stdout).edition).toBe("first");
    await expect(stageLocalService(state, join(root, "second"))).resolves.toEqual(second);
    expect(await serviceInstallation(state)).toMatchObject({
      active: first.release,
      staged: second.release,
    });
  });
  test("unsafe source links and changed installed bytes refuse without replacing selection", async () => {
    const source = await bundle("first"),
      first = await stageLocalService(state, source);
    await promoteLocalService(state, first.release);
    const bad = await bundle("bad");
    await symlink(join(source, "cli.js"), join(bad, "owner-runtime", "foreign-link"));
    await expect(stageLocalService(state, bad)).rejects.toThrow();
    expect((await serviceInstallation(state)).active).toBe(first.release);
    const cli = join(first.releaseDirectory, "cli.js");
    await chmod(cli, 0o600);
    await writeFile(cli, "changed after publication");
    await expect(serviceBundleIdentity(first.releaseDirectory)).rejects.toMatchObject({
      code: "LOCAL_SERVICE_INSTALL_UNSAFE",
    });
    await expect(stageLocalService(state, source)).rejects.toMatchObject({
      code: "LOCAL_SERVICE_INSTALL_UNSAFE",
    });
    expect((await serviceInstallation(state)).active).toBe(first.release);
  });
  test("first launchd registration selects the staged release but an ordinary update never reloads registration", async () => {
    const first = await stageLocalService(state, await bundle("first"));
    const calls: string[][] = [],
      home = join(root, "home");
    const launchctl = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "print") throw absent();
      return { stdout: "" };
    };
    await ensureLocalServiceStarted(state, { platform: "darwin", home, launchctl });
    expect(calls.map((args) => args[0])).toEqual(["print", "print", "bootstrap"]);
    expect((await serviceInstallation(state)).active).toBe(first.release);
    const plist = calls[2][2],
      original = await readFile(plist, "utf8");
    expect(original).toContain("<key>SessionCreate</key><true/>");
    const second = await stageLocalService(state, await bundle("second"));
    const registeredCalls: string[][] = [];
    await ensureLocalServiceStarted(state, {
      platform: "darwin",
      home,
      launchctl: async (args) => {
        registeredCalls.push(args);
        return { stdout: `program = ${(await serviceInstallation(state)).launcher}` };
      },
    });
    expect(registeredCalls.map((args) => args[0])).toEqual(["print"]);
    expect(await readFile(plist, "utf8")).toBe(original);
    expect(await serviceInstallation(state)).toMatchObject({
      active: first.release,
      staged: second.release,
    });
  });
  test("first registration excludes a competing physical runner and releases its gate before bootstrap", async () => {
    const staged = await stageLocalService(state, await bundle("first"));
    let inspections = 0;
    let competingRunnerRefused = false;
    let bootstrapAcquired = false;
    await ensureLocalServiceStarted(state, {
      platform: "darwin",
      home: join(root, "home"),
      launchctl: async (args) => {
        if (args[0] === "print") {
          if (++inspections === 2) {
            const before = await readFile(join(state.root, "runner.lock"));
            let competitor: (() => Promise<void>) | undefined;
            try {
              competitor = await state.lock();
            } catch (error) {
              expect(error).toMatchObject({ code: "LOCAL_ALREADY_RUNNING" });
              competingRunnerRefused = true;
            } finally {
              await competitor?.();
            }
            expect(await readFile(join(state.root, "runner.lock"))).toEqual(before);
            expect((await serviceInstallation(state)).active).toBeNull();
          }
          throw absent();
        }
        expect(competingRunnerRefused).toBe(true);
        // Exercise the real native runner gate the launchd child must acquire.
        const release = await state.lock();
        try {
          bootstrapAcquired = true;
          expect((await serviceInstallation(state)).active).toBe(staged.release);
          expect(await readFile(args[2], "utf8")).toContain("<key>RunAtLoad</key>");
        } finally {
          await release();
        }
        return { stdout: "" };
      },
    });
    expect(competingRunnerRefused).toBe(true);
    expect(bootstrapAcquired).toBe(true);
    await expect(lstat(join(state.root, "runner.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  test("an unknown owner endpoint or foreign launchd registration cannot authorize initial promotion", async () => {
    const staged = await stageLocalService(state, await bundle("first")),
      endpoint = await serviceSocketPath(state);
    await writeFile(endpoint, "unknown owner marker", { mode: 0o600 });
    const calls: string[][] = [];
    await expect(
      ensureLocalServiceStarted(state, {
        platform: "darwin",
        home: join(root, "home"),
        launchctl: async (args) => {
          calls.push(args);
          throw absent();
        },
      }),
    ).rejects.toMatchObject({ code: "LOCAL_SERVICE_RECOVERY_REQUIRED" });
    expect(calls.map((args) => args[0])).toEqual(["print", "print"]);
    expect(await serviceInstallation(state)).toMatchObject({
      active: null,
      staged: staged.release,
    });
    await expect(
      ensureLocalServiceStarted(state, {
        platform: "darwin",
        launchctl: async () => ({ stdout: "program = /foreign/owner" }),
      }),
    ).rejects.toMatchObject({ code: "LOCAL_SERVICE_INSTALL_UNSAFE" });
    expect(await readFile(endpoint, "utf8")).toBe("unknown owner marker");
    await rm(endpoint);
  });
  test.each(["runner.lock", "controller.sock", "private-controller"])(
    "first registration preserves an existing legacy %s without promoting or starting a competitor",
    async (marker) => {
      const staged = await stageLocalService(state, await bundle("first"));
      const path =
        marker === "private-controller"
          ? join((await state.ipcDirectory()).root, "controller.sock")
          : join(state.root, marker);
      const original = Buffer.from("legacy-owner: retained uncertain custody\n");
      await writeFile(path, original, { mode: 0o600 });
      const calls: string[][] = [];
      await expect(
        ensureLocalServiceStarted(state, {
          platform: "darwin",
          home: join(root, "home"),
          launchctl: async (args) => {
            calls.push(args);
            throw absent();
          },
        }),
      ).rejects.toMatchObject({ code: "LOCAL_SERVICE_RECOVERY_REQUIRED" });
      expect(await readFile(path)).toEqual(original);
      expect(await serviceInstallation(state)).toMatchObject({
        active: null,
        staged: staged.release,
      });
      expect(calls.map((args) => args[0])).toEqual(
        marker === "runner.lock" ? ["print"] : ["print", "print"],
      );
      await rm(path);
    },
  );
});
