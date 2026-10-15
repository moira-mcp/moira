import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, realpath, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { runProcess } from "../../../packages/local/src/process.js";
import {
  inspectProcessCustody,
  type ProcessCustodyWitness,
} from "../../../packages/local/src/process-custody.js";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-local-process-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const request = () => ({
  binary: process.execPath,
  cwd: root,
  env: { PATH: "/usr/bin:/bin", ONLY_ALLOWED: "yes" },
  timeoutMs: 3000,
  maxBytes: 1024,
});

describe("bounded local subprocess boundary", () => {
  test("a lost host response leaves restart-readable native settlement without replaying its command", async () => {
    const helper = join(root, "process-group-helper");
    await promisify(execFile)(process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "packages/local/src/process-group-helper.c",
      "-o",
      helper,
    ]);
    const socketRoot = await mkdtemp("/tmp/moira-custody-");
    const socket = join(socketRoot, "held.sock");
    const descendant = `require('node:net').createServer().listen(${JSON.stringify(socket)},()=>process.send('ready'));`;
    const leader = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{process.stdout.write(String(child.pid));setInterval(()=>{},1000)});`;
    const module = pathToFileURL(resolve("packages/local/src/process.ts")).href;
    const original = join(root, "original.json");
    const script = `import {runProcess} from ${JSON.stringify(module)};import {open} from 'node:fs/promises';runProcess({binary:process.execPath,argv:['-e',${JSON.stringify(leader)}],cwd:${JSON.stringify(root)},env:{PATH:'/usr/bin:/bin'},timeoutMs:null,maxBytes:1024,settleGroup:true,groupHelper:${JSON.stringify(helper)},custody:{directory:${JSON.stringify(root)},prepared:async witness=>{const receipt=await open(${JSON.stringify(original)},'wx',0o600);await receipt.writeFile(JSON.stringify(witness));await receipt.sync();await receipt.close();const directory=await open(${JSON.stringify(root)},'r');await directory.sync();await directory.close();process.send({witness});}},onStdout:bytes=>process.send({ready:true,pid:Number(bytes.toString())})}).then(()=>process.exit(0),()=>process.exit(1));`;
    const host = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let witness!: ProcessCustodyWitness;
    let descendantPid: number | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      host.on("message", (message: unknown) => {
        const value = message as { witness?: ProcessCustodyWitness; ready?: boolean; pid?: number };
        if (value.witness) witness = value.witness;
        if (value.ready) {
          descendantPid = value.pid;
          resolve();
        }
      });
      host.once("exit", () =>
        reject(new Error("The test host exited before its owned command was ready.")),
      );
    });
    try {
      await ready;
      expect(await inspectProcessCustody(witness, helper)).toBe("pending");
      let settled!: () => void;
      let failed!: (error: unknown) => void;
      const settlement = new Promise<void>((resolve, reject) => {
        settled = resolve;
        failed = reject;
      });
      const inspect = () => {
        void inspectProcessCustody(witness, helper).then((state) => {
          if (state === "settled") settled();
        }, failed);
      };
      // macOS may report the same held inode's durable write as "rename".
      // Every notification triggers identity inspection; the event name is never proof.
      const observation = watch(witness.path, inspect);
      observation.once("error", failed);
      try {
        inspect();
        host.kill("SIGKILL");
        await settlement;
      } finally {
        observation.close();
      }
      // An owner restarted after response loss reads this same original witness, never execs again.
      expect(
        await inspectProcessCustody(JSON.parse(await readFile(original, "utf8")), helper),
      ).toBe("settled");
      const closed = await new Promise<boolean>((resolve) => {
        const peer = connect(socket);
        peer.once("connect", () => {
          peer.destroy();
          resolve(false);
        });
        peer.once("error", () => resolve(true));
      });
      expect(closed).toBe(true);
    } finally {
      host.kill("SIGKILL");
      if (descendantPid) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* Already settled. */
        }
      }
      await rm(socketRoot, { recursive: true, force: true });
    }
  });
  test("an abruptly killed supervisor leaves pending custody even after its leader later exits", async () => {
    const helper = join(root, "process-group-helper");
    await promisify(execFile)(process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "packages/local/src/process-group-helper.c",
      "-o",
      helper,
    ]);
    const socketRoot = await mkdtemp("/tmp/moira-custody-");
    const socket = join(socketRoot, "held.sock");
    let witness!: ProcessCustodyWitness;
    let processIdentity: { leader: number; supervisor: number } | undefined;
    let ready!: () => void;
    const readiness = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const work = runProcess({
      ...request(),
      timeoutMs: null,
      settleGroup: true,
      groupHelper: helper,
      custody: {
        directory: root,
        prepared: async (value) => {
          witness = value;
        },
      },
      argv: [
        "-e",
        `require('node:net').createServer().listen(${JSON.stringify(socket)},()=>process.stdout.write(JSON.stringify({leader:process.pid,supervisor:process.ppid})));`,
      ],
      onStdout: (bytes) => {
        processIdentity = JSON.parse(bytes.toString());
        ready();
      },
    });
    const outcome = work.catch((error: unknown) => error);
    try {
      await readiness;
      process.kill(processIdentity!.supervisor, "SIGKILL");
      expect(await inspectProcessCustody(witness)).toBe("pending");
      const stillExecuting = await new Promise<boolean>((resolve) => {
        const peer = connect(socket);
        peer.once("connect", () => {
          peer.destroy();
          resolve(true);
        });
        peer.once("error", () => resolve(false));
      });
      expect(stillExecuting).toBe(true);
      process.kill(-processIdentity!.leader, "SIGKILL");
      expect(await outcome).toMatchObject({ code: "LOCAL_CUSTODY_UNCONFIRMED" });
      // An absent process is not the original supervisor's terminal physical proof.
      expect(await inspectProcessCustody(witness)).toBe("pending");
    } finally {
      if (processIdentity) {
        try {
          process.kill(-processIdentity.leader, "SIGKILL");
        } catch {
          /* Test process already exited. */
        }
      }
      await outcome;
      await rm(socketRoot, { recursive: true, force: true });
    }
  });
  (process.platform === "linux" ? test : test.skip)(
    "a zombie main thread cannot prove settlement while its worker still serves a transport",
    async () => {
      const fixture = join(root, "process-group-thread");
      await promisify(execFile)("/usr/bin/cc", [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-pthread",
        "tests/fixtures/local/process-group-thread.c",
        "-o",
        fixture,
      ]);
      const result = await promisify(execFile)(fixture, {
        timeout: 10_000,
        killSignal: "SIGTERM",
      });
      expect(JSON.parse(result.stdout)).toEqual({
        mainThreadState: "Z",
        liveGroup: 1,
        connected: true,
        challengeEchoed: true,
        settledGroup: 0,
        reaped: true,
      });
    },
  );
  test("fixed provisioning closes a surviving descendant transport before returning to credential release", async () => {
    const helper = join(root, "process-group-helper");
    await promisify(execFile)(process.platform === "darwin" ? "/usr/bin/clang" : "/usr/bin/cc", [
      "-std=c11",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Werror",
      "packages/local/src/process-group-helper.c",
      "-o",
      helper,
    ]);
    const socket = join(await mkdtemp("/tmp/moira-group-"), "held.sock");
    const descendant = `const server=require('node:net').createServer();server.listen(${JSON.stringify(socket)},()=>process.send('ready'));`;
    const leader = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',()=>{process.stdout.write(String(child.pid));process.exit(0)});`;
    let pid: number | undefined;
    let quiescent = false;
    try {
      const result = await runProcess({
        ...request(),
        argv: ["-e", leader],
        settleGroup: true,
        groupHelper: helper,
      });
      pid = Number(result.stdout.toString());
      expect(result.exitCode).toBe(0);
      expect(Number.isInteger(pid) && pid > 1).toBe(true);
      // This callback is where the lease could be released. The owned live socket must already refuse.
      const transport = await new Promise<{
        connected: boolean;
        code?: string;
        syscall?: string;
        message?: string;
      }>((done) => {
        const peer = connect(socket);
        peer.once("connect", () => {
          peer.destroy();
          done({ connected: true });
        });
        peer.once("error", (error: NodeJS.ErrnoException) => {
          done({
            connected: false,
            code: error.code,
            syscall: error.syscall,
            message: error.message,
          });
        });
      });
      // Keep unexpected errors distinct from an actual surviving listener in CI diagnostics.
      expect({
        ...transport,
        root,
        socket,
        socketPathBytes: Buffer.byteLength(socket),
      }).toMatchObject({
        connected: false,
        code: expect.stringMatching(/^(ECONNREFUSED|ENOENT)$/),
      });
      quiescent = true;
    } finally {
      if (pid && !quiescent)
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* Failure assertions above retain the original custody defect. */
        }
      await rm(socket.substring(0, socket.lastIndexOf("/")), { recursive: true, force: true });
    }
  });
  test("persistent companion streams keep only bounded tails while observing every response", async () => {
    let observed = 0;
    const result = await runProcess({
      ...request(),
      retainOutput: true,
      argv: [
        "-e",
        "process.stdout.write('x'.repeat(65536)+'end');process.stderr.write('y'.repeat(65536)+'err')",
      ],
      onStdout: (chunk) => {
        observed += chunk.length;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(observed).toBe(65539);
    expect(result.stdout.length).toBe(1024);
    expect(result.stderr.length).toBe(1024);
    expect(result.stdout.toString().endsWith("end")).toBe(true);
    expect(result.stderr.toString().endsWith("err")).toBe(true);
  });
  test("arguments are literal, stdin is separate and the host environment is not inherited", async () => {
    const result = await runProcess({
      ...request(),
      argv: [
        "-e",
        "process.stdout.write(JSON.stringify({arg:process.argv[1],env:process.env,input:require('node:fs').readFileSync(0,'utf8')}))",
        "$(echo unexpected); & literal",
      ],
      stdin: Buffer.from("payload"),
    });
    expect(result.exitCode).toBe(0);
    const value = JSON.parse(result.stdout.toString());
    expect(value.arg).toBe("$(echo unexpected); & literal");
    expect(value.input).toBe("payload");
    // macOS adds this text-encoding metadata even to an explicitly empty child environment.
    // It is not inherited application configuration; keep the exact assertion for other keys.
    const { __CF_USER_TEXT_ENCODING, ...environment } = value.env;
    expect(__CF_USER_TEXT_ENCODING).toEqual(
      process.platform === "darwin"
        ? expect.stringMatching(/^0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+$/)
        : undefined,
    );
    expect(environment).toEqual({ PATH: "/usr/bin:/bin", ONLY_ALLOWED: "yes" });
  });
  test("output and lifetime are bounded independently of child cooperation", async () => {
    await expect(
      runProcess({
        ...request(),
        argv: ["-e", "process.stdout.write('x'.repeat(65536));setInterval(()=>{},1000)"],
      }),
    ).rejects.toMatchObject({ code: "LOCAL_OUTPUT_LIMIT" });
    await expect(
      runProcess({ ...request(), timeoutMs: 100, argv: ["-e", "setInterval(()=>{},1000)"] }),
    ).rejects.toMatchObject({ code: "LOCAL_COMMAND_TIMEOUT" });
  });
  test("a local abort kills the runtime command instead of waiting for its normal deadline", async () => {
    const controller = new AbortController();
    const work = runProcess({
      ...request(),
      signal: controller.signal,
      argv: ["-e", "setInterval(()=>{},1000)"],
    });
    controller.abort();
    await expect(work).rejects.toMatchObject({ code: "LOCAL_CANCELLED" });
  });
});
