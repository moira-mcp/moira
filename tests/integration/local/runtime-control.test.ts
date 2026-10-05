import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { watch as watchDirectory } from "node:fs";
import {
  chmod,
  copyFile,
  mkdtemp,
  realpath,
  rm,
  writeFile,
  readFile,
  mkdir,
  symlink,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const vmTest = process.platform === "darwin" ? test : test.skip;
const unsupportedVmTest = process.platform === "darwin" ? test.skip : test;
let root: string;
let helper: string;
let executable: string;
let children: ChildProcess[];
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ml-watch-")));
  await chmod(root, 0o700);
  helper = join(root, "control");
  executable = join(root, "owned-node");
  children = [];
  await copyFile(process.execPath, executable);
  await chmod(executable, 0o700);
  await execute(process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "packages/local/src/runtime-control-helper.c",
    ...(process.platform === "darwin" ? ["-lbsm"] : []),
    "-o",
    helper,
  ]);
});
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close");
      if (child.spawnfile === helper && child.stdin && !child.stdin.destroyed)
        child.stdin.end("stop\n");
      else child.kill("SIGKILL");
      await closed;
    }
  }
  await rm(root, { recursive: true, force: true });
});

async function socketProcess(name: string, ignoresTerm = false) {
  const socket = join(root, name);
  const child = spawn(
    executable,
    [
      "-e",
      `const n=require('node:net');${ignoresTerm ? "process.on('SIGTERM',()=>{});" : ""}n.createServer(c=>c.on('error',()=>{})).listen(process.argv[1],()=>process.stdout.write('ready\\n'));`,
      socket,
    ],
    { env: {}, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  expect(await nextOutput(child)).toBe("ready\n");
  return { socket, child };
}

function nextOutput(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const output = child.stdout!;
    const cleanup = () => {
      output.removeListener("data", received);
      output.removeListener("error", failed);
      child.removeListener("error", failed);
      child.removeListener("close", closed);
    };
    const received = (bytes: Buffer) => {
      cleanup();
      resolve(bytes.toString());
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        Object.assign(new Error(`Controlled process closed before output: ${code}/${signal}`), {
          code,
          signal,
        }),
      );
    };
    output.once("data", received);
    output.once("error", failed);
    child.once("error", failed);
    child.once("close", closed);
    if (output.destroyed && (child.exitCode !== null || child.signalCode !== null))
      closed(child.exitCode, child.signalCode);
  });
}

async function vmProcess(foreign = false) {
  const sdk = join(root, "Sbx.app", "Contents", "MacOS", "sbx");
  const worker = join(root, "Sbx.app", "Contents", "Helpers", "containerd-shim-nerdbox-v1");
  await mkdir(join(root, "Sbx.app", "Contents", "MacOS"), { recursive: true, mode: 0o700 });
  await mkdir(join(root, "Sbx.app", "Contents", "Helpers"), { recursive: true, mode: 0o700 });
  await copyFile(executable, sdk);
  const source = join(root, "worker.c");
  await writeFile(
    source,
    `
    #include <sys/socket.h>
    #include <sys/un.h>
    #include <stdio.h>
    #include <string.h>
    #include <unistd.h>
    int main(int argc,char **argv){if(argc!=6)return 2;struct sockaddr_un address={.sun_family=AF_UNIX};if(strlen(argv[1])>=sizeof(address.sun_path))return 2;strcpy(address.sun_path,argv[1]);int fd=socket(AF_UNIX,SOCK_DGRAM,0);if(bind(fd,(struct sockaddr*)&address,sizeof(address)))return 2;puts("ready");fflush(stdout);for(;;)pause();}
  `,
  );
  await execute(process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc", [
    source,
    "-o",
    worker,
  ]);
  const socket = join(root, "aaaaaaaaaaaa-vm.sock");
  const activeBinary = foreign ? join(root, "foreign-worker") : worker;
  if (foreign) await copyFile(worker, activeBinary);
  const child = spawn(activeBinary, [socket, "-namespace", "docker", "-id", "a".repeat(64)], {
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  expect(await nextOutput(child)).toBe("ready\n");
  return { sdk, worker, socket, child };
}

describe("credential-independent captured process shutdown", () => {
  unsupportedVmTest(
    "fixed VM mode refuses unproven Linux transport without signalling its worker",
    async () => {
      const vm = await vmProcess();
      await expect(execute(helper, ["--vm", root, vm.sdk, vm.socket])).rejects.toMatchObject({
        code: 2,
      });
      expect(vm.child.exitCode).toBeNull();
      expect(vm.child.signalCode).toBeNull();
    },
  );
  vmTest("fixed VM mode captures the derived Darwin SDK datagram worker", async () => {
    const vm = await vmProcess();
    const watch = spawn(helper, ["--vm", root, vm.sdk, vm.socket], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(watch);
    const closed = once(watch, "close");
    expect(JSON.parse(await nextOutput(watch))).toEqual({
      ready: true,
      containerId: "a".repeat(64),
    });
    const checked = nextOutput(watch);
    watch.stdin!.write("check\n");
    expect(JSON.parse(await checked)).toEqual({ held: true });
    const exited = once(vm.child, "close");
    watch.stdin!.end("stop\n");
    expect((await exited)[1]).toBe("SIGTERM");
    expect((await closed)[0]).toBe(0);
  });
  test.each(["symlink", "writable", "different-sdk", "foreign-peer"] as const)(
    "VM capture refuses %s identity without signalling its process",
    async (variant) => {
      const vm = await vmProcess(variant === "foreign-peer");
      let sdk = vm.sdk;
      if (variant === "symlink") {
        const target = join(root, "moved-worker");
        await copyFile(vm.worker, target);
        await unlink(vm.worker);
        await symlink(target, vm.worker);
      } else if (variant === "writable") await chmod(vm.worker, 0o777);
      else if (variant === "different-sdk") sdk = executable;
      await expect(execute(helper, ["--vm", root, sdk, vm.socket])).rejects.toMatchObject({
        code: 2,
      });
      expect(vm.child.exitCode).toBeNull();
      expect(vm.child.signalCode).toBeNull();
    },
  );
  test("fixed check acknowledgements confirm kernel ownership repeatedly then refuse a retired incarnation", async () => {
    const owned = await socketProcess("owned.sock");
    const watch = spawn(helper, [root, executable, owned.socket], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(watch);
    const closed = once(watch, "close");
    expect(JSON.parse(await nextOutput(watch))).toEqual({ ready: true });
    for (let index = 0; index < 100; index++) {
      const response = nextOutput(watch);
      watch.stdin!.write("check\n");
      expect(JSON.parse(await response)).toEqual({ held: true });
    }
    const retired = nextOutput(watch);
    const ownedExit = once(owned.child, "close");
    owned.child.kill("SIGKILL");
    await ownedExit;
    watch.stdin!.write("check\n");
    const response = await retired;
    expect(response).toContain('{"retired":true}');
    expect(response).not.toContain('{"held":true}');
    expect((await closed)[0]).toBe(0);
  });
  test("captures a short private SDK link whose canonical socket path exceeds sockaddr capacity", async () => {
    const directory = join(root, "Library", "Application Support", "sandboxes", "x".repeat(60));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await symlink(directory, join(root, "d"));
    const owned = await socketProcess("d/owned.sock");
    expect((await realpath(owned.socket)).length).toBeGreaterThan(108);
    const watch = spawn(helper, [root, executable, owned.socket], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(watch);
    const closed = once(watch, "close");
    const ready = JSON.parse(await nextOutput(watch));
    expect(ready).toEqual({ ready: true });
    const ownedExit = once(owned.child, "close");
    watch.stdin!.end("stop\n");
    expect((await ownedExit)[1]).toBe("SIGTERM");
    expect((await closed)[0]).toBe(0);
  });
  test.each([false, true])(
    "stops the exact private-socket incarnation and preserves a peer (ignores TERM: %s)",
    async (ignoresTerm) => {
      const owned = await socketProcess("owned.sock", ignoresTerm);
      const peer = await socketProcess("peer.sock");
      const watch = spawn(helper, [root, executable, owned.socket], {
        env: {},
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(watch);
      const watchExit = once(watch, "close");
      expect(JSON.parse(await nextOutput(watch))).toEqual({
        ready: true,
      });
      const ownedExit = once(owned.child, "close");
      watch.stdin!.end("stop\n");
      expect((await ownedExit)[1]).toBe(ignoresTerm ? "SIGKILL" : "SIGTERM");
      expect((await watchExit)[0]).toBe(0);
      expect(peer.child.exitCode).toBeNull();
      expect(peer.child.signalCode).toBeNull();
    },
  );

  test("parent pipe loss stops the captured process without any SDK or credential call", async () => {
    const owned = await socketProcess("owned.sock");
    const watch = spawn(helper, [root, executable, owned.socket], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(watch);
    const watchExit = once(watch, "close");
    expect(JSON.parse(await nextOutput(watch))).toEqual({ ready: true });
    const ownedExit = once(owned.child, "close");
    watch.stdin!.end();
    expect((await ownedExit)[1]).toBe("SIGTERM");
    expect((await watchExit)[0]).toBe(0);
  });

  test("an executable mismatch refuses capture and leaves the socket owner alive", async () => {
    const owned = await socketProcess("owned.sock");
    const watch = spawn(helper, [root, helper, owned.socket], {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(watch);
    await expect(nextOutput(watch)).rejects.toMatchObject({ code: 2 });
    expect(owned.child.exitCode).toBeNull();
    expect(owned.child.signalCode).toBeNull();
  });

  test("a later missing socket refuses capture only after already captured peers exit", async () => {
    const owned = await socketProcess("owned.sock");
    const peer = await socketProcess("peer.sock");
    const closed = once(owned.child, "close");
    await expect(
      execute(helper, [root, executable, owned.socket, join(root, "missing.sock")]),
    ).rejects.toMatchObject({ code: 4 });
    expect((await closed)[1]).toBe("SIGTERM");
    expect(peer.child.signalCode).toBeNull();
  });

  test.each([false, true])(
    "fixed foreground launch owns its child before any SDK control socket exists (initialize: %s)",
    async (initialize) => {
      await writeFile(
        join(root, "daemon"),
        `const f=require('node:fs');f.writeFileSync('child.pending',JSON.stringify({pid:process.pid,args:[require('node:path').basename(process.argv[1]),...process.argv.slice(2)]}));f.renameSync('child.pending','child.json');setInterval(()=>{},1000);`,
      );
      let enter!: (value: { pid: number; args: string[] }) => void;
      let refuse!: (error: unknown) => void;
      const entered = new Promise<{ pid: number; args: string[] }>((resolve, reject) => {
        enter = resolve;
        refuse = reject;
      });
      const observer = watchDirectory(root, () => {
        void readFile(join(root, "child.json"), "utf8").then(
          (bytes) => {
            try {
              enter(JSON.parse(bytes));
            } catch (error) {
              refuse(error);
            }
          },
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") refuse(error);
          },
        );
      });
      observer.on("error", refuse);
      const watch = spawn(helper, [initialize ? "--initialize" : "--launch", root, executable], {
        cwd: root,
        env: { HOME: root, DOCKER_SANDBOXES_APP_NAME: `moira-${"a".repeat(14)}` },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(watch);
      const closed = once(watch, "close");
      try {
        expect(JSON.parse(await nextOutput(watch))).toEqual({
          ready: true,
        });
        const child = await Promise.race([
          entered,
          closed.then(([code]) => {
            throw new Error(`Owned fixed daemon exited before its script marker: ${code}`);
          }),
        ]);
        expect(child.args).toEqual([
          "daemon",
          "start",
          ...(initialize ? ["--policy", "deny-all"] : []),
        ]);
        process.kill(child.pid, 0);
        watch.stdin!.end("stop\n");
        expect((await closed)[0]).toBe(0);
        expect(() => process.kill(child.pid, 0)).toThrow();
      } finally {
        observer.close();
      }
    },
  );
});
