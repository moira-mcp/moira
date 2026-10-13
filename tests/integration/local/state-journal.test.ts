import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { build } from "esbuild";
import {
  mkdtemp,
  rm,
  writeFile,
  chmod,
  symlink,
  readFile,
  realpath,
  copyFile,
  link,
  lstat,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { RequestJournal } from "../../../packages/local/src/journal.js";
import { LocalRecords } from "../../../packages/local/src/space-record.js";
import { localFixture } from "./fixtures.js";

const execute = promisify(execFile);

let root: string;
let state: PrivateState;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-local-state-")));
  state = await PrivateState.open(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("private local state", () => {
  test("shipping device recovery after a dead real lock owner retains journals and permits a later owner", async () => {
    const local = await localFixture(state);
    local.policy.enabled = false;
    await state.write("policy.json", local.policy);
    const module = join(root, "private-state.mjs");
    await build({
      entryPoints: ["packages/local/src/private-state.ts"],
      outfile: module,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
    });
    await copyFile(
      "packages/local/dist/runtime-control-helper",
      join(root, "runtime-control-helper"),
    );
    const owner = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {PrivateState} from ${JSON.stringify(`file://${module}`)};
      const state=await PrivateState.open(${JSON.stringify(root)});
      await state.lock();process.stdout.write('ready');process.stdin.resume();
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      await Promise.race([
        once(owner.stdout, "data"),
        once(owner, "close").then(() => {
          throw Error("Owner failed before ready");
        }),
      ]);
      const closed = once(owner, "close");
      owner.kill("SIGKILL");
      await closed;
      const job = { unknown: true, marker: "own-unknown-job" };
      await state.write("job-unknown.json", job);
      const spaces = await readFile(join(root, `space-${local.space.id}.json`));
      const result = await execute(process.execPath, [
        "packages/local/dist/cli.js",
        "recover",
        "--confirm",
        "--state",
        root,
      ]);
      expect(JSON.parse(result.stdout)).toMatchObject({
        recovered: true,
        enabled: false,
        priorJobsRetained: true,
        dataPreserved: true,
      });
      expect(await state.read("job-unknown.json", (value) => value)).toEqual(job);
      expect((await readFile(join(root, `space-${local.space.id}.json`))).equals(spaces)).toBe(
        true,
      );
      expect(await state.read("runtime-owner.json", (value) => value)).toMatchObject({
        settled: true,
      });
      const release = await state.lock();
      await release();
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) {
        const closed = once(owner, "close");
        owner.kill("SIGKILL");
        await closed;
      }
    }
  });
  test("explicit marker recovery refuses a live or unknown owner without changing bytes", async () => {
    await writeFile(join(root, "runner.lock"), String(process.pid), { mode: 0o600 });
    await expect(state.lock({ recoverStale: true })).rejects.toThrow("Another companion owns");
    expect(await readFile(join(root, "runner.lock"), "utf8")).toBe(String(process.pid));
    for (const marker of ["", "0", "no-pid", "2147483648", Buffer.from([0xb1, 0xb2])]) {
      await writeFile(join(root, "runner.lock"), marker, { mode: 0o600 });
      await expect(state.lock({ recoverStale: true })).rejects.toThrow(/Unsafe|Unknown/);
      expect(await readFile(join(root, "runner.lock"))).toEqual(Buffer.from(marker));
    }
  });
  test.each(["symlink", "hardlink", "permissions"] as const)(
    "explicit recovery refuses unsafe %s marker",
    async (kind) => {
      const target = join(root, "outside");
      await writeFile(target, "1", { mode: 0o600 });
      if (kind === "symlink") await symlink(target, join(root, "runner.lock"));
      else if (kind === "hardlink") await link(target, join(root, "runner.lock"));
      else await writeFile(join(root, "runner.lock"), "1", { mode: 0o644 });
      await expect(state.lock({ recoverStale: true })).rejects.toThrow(/Unsafe/);
      expect(await readFile(target, "utf8")).toBe("1");
    },
  );
  test.each(["runner.lock", "runner-gate.lock"])(
    "recovery refuses unsafe FIFO %s without opening a stream",
    async (name) => {
      await execute("/usr/bin/mkfifo", [join(root, name)]);
      await chmod(join(root, name), 0o600);
      await expect(state.lock({ recoverStale: true })).rejects.toThrow(
        /Unsafe|private kernel lock/,
      );
      expect((await lstat(join(root, name))).isFIFO()).toBe(true);
    },
  );
  test("concurrent explicit recovery never displaces the winning owner or changes the gate inode", async () => {
    const dead = spawn(process.execPath, ["-e", ""]);
    await once(dead, "close");
    await writeFile(join(root, "runner.lock"), String(dead.pid), { mode: 0o600 });
    const results = await Promise.allSettled([
      state.lock({ recoverStale: true }),
      state.lock({ recoverStale: true }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const gate = await lstat(join(root, "runner-gate.lock"));
    expect(await readFile(join(root, "runner.lock"), "utf8")).toBe(String(process.pid));
    for (const result of results) if (result.status === "fulfilled") await result.value();
    const release = await state.lock();
    const nextGate = await lstat(join(root, "runner-gate.lock"));
    expect([nextGate.dev, nextGate.ino]).toEqual([gate.dev, gate.ino]);
    await release();
  });
  test("explicit recovery reclaims a SIGKILL owner's marker without replaying its unknown job", async () => {
    const module = join(root, "private-state.mjs");
    await build({
      entryPoints: ["packages/local/src/private-state.ts"],
      outfile: module,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
    });
    await copyFile(
      "packages/local/dist/runtime-control-helper",
      join(root, "runtime-control-helper"),
    );
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {PrivateState} from ${JSON.stringify(`file://${module}`)};
      const state=await PrivateState.open(${JSON.stringify(root)});
      await state.lock(); process.stdout.write('ready'); process.stdin.resume();
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    try {
      await Promise.race([
        once(child.stdout, "data"),
        once(child, "close").then(() => {
          throw new Error("Lock owner exited before readiness");
        }),
      ]);
      const closed = once(child, "close");
      child.kill("SIGKILL");
      await closed;
      const job = { unknown: true, digest: "a".repeat(64) };
      await state.write("job-unknown.json", job);
      await expect(state.lock()).rejects.toThrow("Another companion owns");
      const release = await state.lock({ recoverStale: true });
      try {
        expect(await readFile(join(root, "runner.lock"), "utf8")).toBe(String(process.pid));
        expect(await state.read("job-unknown.json", (value) => value)).toEqual(job);
        await expect(state.lock()).rejects.toThrow("Another companion owns");
      } finally {
        await release();
      }
      const next = await state.lock();
      await release();
      await expect(state.lock()).rejects.toThrow("Another companion owns");
      await next();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
    }
  });
  test("persists complete large documents atomically without following links", async () => {
    const value = { data: "x".repeat(16 * 1024 * 1024 + 1) };
    await state.write("large.json", value);
    expect(await state.read("large.json", (item) => item)).toEqual(value);
    await writeFile(join(root, "outside"), "host-data", { mode: 0o600 });
    await symlink(join(root, "outside"), join(root, "link.json"));
    await expect(state.read("link.json", (item) => item)).rejects.toThrow();
    await expect(state.write("link.json", {})).rejects.toThrow("Unsafe local state replacement");
    expect(await readFile(join(root, "outside"), "utf8")).toBe("host-data");
    await expect(state.write("../outside.json", {})).rejects.toThrow("Invalid local state key");
  });
  test.each([
    ["same instance", "write"],
    ["another instance", "write"],
    ["same instance", "remove"],
    ["another instance", "remove"],
    ["another root", "write"],
    ["foreign filesystem", "foreign-unlink"],
  ] as const)(
    "a held reader precedes %s %s while another target progresses",
    async (instance, action) => {
      const module = join(root, "private-state.mjs");
      await build({
        entryPoints: ["packages/local/src/private-state.ts"],
        outfile: module,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
      });
      const result = await execute(process.execPath, [
        "--input-type=module",
        "-e",
        `
      import fs from 'node:fs/promises';
      import {constants} from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      import {AsyncLocalStorage} from 'node:async_hooks';
      const context=new AsyncLocalStorage();
      const originalOpen=fs.open, originalUnlink=fs.unlink;
      let readerEntered, releaseReader, mutationEntered=false;
      const entered=new Promise(resolve=>readerEntered=resolve);
      const released=new Promise(resolve=>releaseReader=resolve);
      fs.open=async function(path,flags,...args){
        if(context.getStore()==='mutation') mutationEntered=true;
        const handle=await originalOpen(path,flags,...args);
        if(context.getStore()==='reader' && flags===(constants.O_RDONLY|constants.O_NOFOLLOW)){
          const stat=handle.stat.bind(handle);
          handle.stat=async (...args)=>{readerEntered();await released;return stat(...args);};
        }
        return handle;
      };
      fs.unlink=async function(...args){
        if(context.getStore()==='mutation') mutationEntered=true;
        return originalUnlink(...args);
      };
      syncBuiltinESMExports();
      const {PrivateState}=await import(${JSON.stringify(`file://${module}`)});
      const state=await PrivateState.open(${JSON.stringify(root)});
      const instance=${JSON.stringify(instance)}, action=${JSON.stringify(action)};
      const writer=instance==='same instance'?state:await PrivateState.open(
        instance==='another root'?state.root+'/peer':state.root);
      await state.write('held.json',{edition:'old'});
      const read=context.run('reader',()=>state.read('held.json',value=>value));
      const readOutcome=read.then(value=>({value}),error=>({code:error.code}));
      await entered;
      let mutation, heldMutationEntered, independent;
      try {
        mutation=context.run('mutation',()=>action==='write'
          ?writer.write('held.json',{edition:'new'}):action==='foreign-unlink'
          ?fs.unlink(state.root+'/held.json'):writer.remove('held.json'));
        if(action==='foreign-unlink') await mutation;
        await context.run('independent',()=>writer.write('independent.json',{independent:true}));
        independent=await writer.read('independent.json',value=>value);
        heldMutationEntered=mutationEntered;
      } finally {releaseReader();}
      await mutation;
      const reader=await readOutcome;
      console.log(JSON.stringify({heldMutationEntered,independent,reader,
        stored:await writer.read('held.json',value=>value),
        temporary:(await fs.readdir(state.root)).filter(name=>name.startsWith('.write-'))}));
    `,
      ]);
      expect(JSON.parse(result.stdout)).toEqual({
        heldMutationEntered: instance === "another root" || action === "foreign-unlink",
        independent: { independent: true },
        reader:
          action === "foreign-unlink"
            ? { code: "LOCAL_STATE_UNSAFE" }
            : { value: { edition: "old" } },
        stored: action === "write" ? { edition: "new" } : null,
        temporary: [],
      });
    },
  );
  test.each(["writeFile", "sync", "close", "exclusive-open"] as const)(
    "a failed %s preserves prior bytes, cleans only owned temporary files and permits later work",
    async (phase) => {
      const module = join(root, "private-state.mjs");
      await build({
        entryPoints: ["packages/local/src/private-state.ts"],
        outfile: module,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
      });
      const result = await execute(process.execPath, [
        "--input-type=module",
        "-e",
        `
        import fs from 'node:fs/promises';
        import {syncBuiltinESMExports} from 'node:module';
        import {AsyncLocalStorage} from 'node:async_hooks';
        const context=new AsyncLocalStorage(), originalOpen=fs.open;
        const phase=${JSON.stringify(phase)}, root=${JSON.stringify(root)};
        let failed=false, foreign;
        fs.open=async function(path,flags,...args){
          if(context.getStore()==='failing' && !failed){
            failed=true;
            if(phase==='exclusive-open'){
              foreign=path;
              const handle=await originalOpen(path,flags,...args);
              await handle.writeFile('foreign-owned');await handle.close();
              return originalOpen(path,flags,...args);
            }
            const handle=await originalOpen(path,flags,...args);
            const original=handle[phase].bind(handle);
            handle[phase]=async (...args)=>{
              if(phase==='close') await original(...args);
              throw Object.assign(new Error('controlled '+phase),{code:'CONTROLLED_FAILURE'});
            };
            return handle;
          }
          return originalOpen(path,flags,...args);
        };
        syncBuiltinESMExports();
        const {PrivateState}=await import(${JSON.stringify(`file://${module}`)});
        const state=await PrivateState.open(root);
        await state.write('prior.json',{edition:'old'});
        let failure;
        try{await context.run('failing',()=>state.write('prior.json',{edition:'rejected'}));}
        catch(error){failure=error.code;}
        const prior=await fs.readFile(root+'/prior.json','utf8');
        const temporary=(await fs.readdir(root)).filter(name=>name.startsWith('.write-'));
        const foreignBytes=foreign?await fs.readFile(foreign,'utf8'):null;
        await state.write('prior.json',{edition:'later'});
        console.log(JSON.stringify({failure,prior,temporaryCount:temporary.length,foreignBytes,
          later:await state.read('prior.json',value=>value)}));
      `,
      ]);
      expect(JSON.parse(result.stdout)).toEqual({
        failure: phase === "exclusive-open" ? "EEXIST" : "CONTROLLED_FAILURE",
        prior: JSON.stringify({ edition: "old" }),
        temporaryCount: phase === "exclusive-open" ? 1 : 0,
        foreignBytes: phase === "exclusive-open" ? "foreign-owned" : null,
        later: { edition: "later" },
      });
    },
  );
  test("failed parsing releases the target and a reentrant parser can publish its next value", async () => {
    await state.write("parse.json", null);
    await expect(
      state.read("parse.json", () => {
        throw new Error("controlled parse");
      }),
    ).rejects.toThrow("controlled parse");
    expect(
      await state.read("parse.json", async (value) => {
        await state.write("parse.json", { parsed: value });
        return value;
      }),
    ).toBeNull();
    expect(await state.read("parse.json", (value) => value)).toEqual({ parsed: null });
    await state.remove("parse.json");
    expect(
      await state.read("parse.json", () => {
        throw new Error("absent must not parse");
      }),
    ).toBeNull();
  });
  test("inventory retains every owned resource beyond the former count ceiling", async () => {
    const local = await localFixture(state);
    const records = new LocalRecords(state);
    const ids = Array.from({ length: 129 }, () => randomUUID());
    await Promise.all(
      ids.map((id) =>
        records.put({
          ...local.space,
          id,
          name: `moira-${id.replaceAll("-", "")}`,
          runtimeId: `external-${id}`,
          operationMarker: `moira-${id.replaceAll("-", "").slice(0, 24)}`,
        }),
      ),
    );
    const inventory = await records.list();
    expect(new Set(inventory.map((space) => space.id))).toEqual(new Set([local.space.id, ...ids]));
  });
  test.each(["hardlink", "invalid-json"] as const)(
    "an unsafe %s read refuses its bytes and releases the target for later work",
    async (kind) => {
      const path = join(root, "unsafe.json");
      await writeFile(path, kind === "invalid-json" ? "{" : "{}", { mode: 0o600 });
      if (kind === "hardlink") await link(path, join(root, "foreign-link"));
      const before = await readFile(path);
      await expect(state.read("unsafe.json", (value) => value)).rejects.toThrow(
        kind === "invalid-json" ? /JSON/ : "Unsafe local state file",
      );
      expect(await readFile(path)).toEqual(before);
      await state.remove("unsafe.json");
      await state.write("unsafe.json", { recovered: true });
      expect(await state.read("unsafe.json", (value) => value)).toEqual({ recovered: true });
    },
  );
  test("refuses broad permissions and a second owner of the runner lock", async () => {
    await state.write("credential.json", { value: "sensitive" });
    await chmod(join(root, "credential.json"), 0o644);
    await expect(state.read("credential.json", (item) => item)).rejects.toThrow(
      "Unsafe local state file",
    );
    const release = await state.lock();
    await expect(state.lock()).rejects.toThrow("Another companion owns");
    await release();
    await (
      await state.lock()
    )();
  });
});

describe("replay and result lifetime", () => {
  test("a confirmed live receipt remains replayable only until its original admission expires", async () => {
    let now = 1000;
    const id = randomUUID();
    const input = { action: "write" };
    const journal = new RequestJournal(state, () => now);
    await journal.run(id, 2000, input, async () => ({ ok: true }));
    await journal.acknowledge(id, true);
    await expect(
      journal.run(id, 2000, input, async () => {
        throw new Error("must not repeat the effect");
      }),
    ).resolves.toEqual({ ok: true });
    now = 2000;
    await journal.expire();
    expect(await state.read(`lifecycle-result-${id}.json`, (value) => value)).toBeNull();
    expect(await journal.retained(id, 2000, input)).toBeUndefined();
  });
  test("an expired admission retains its completed receipt for collection without admitting another effect", async () => {
    let now = 1000;
    const id = randomUUID();
    const journal = new RequestJournal(state, () => now);
    await journal.run(id, 2000, { action: "write" }, async () => {
      await state.write("effect.json", { count: 1 });
      return { ok: true, value: "completed" };
    });
    now = 2001;
    await journal.expire();
    expect(await state.read(`lifecycle-result-${id}.json`, (value) => value)).toEqual({
      ok: true,
      value: "completed",
    });
    expect(
      await new RequestJournal(state, () => now).retained(id, 2000, { action: "write" }),
    ).toEqual({ ok: true, value: "completed" });
    await expect(journal.retained(id, 2000, { action: "delete" })).rejects.toThrow("cannot change");
    await expect(
      journal.run(id, 2000, { action: "write" }, async () => {
        await state.write("effect.json", { count: 2 });
      }),
    ).rejects.toThrow("expired");
    expect(await state.read("effect.json", (value) => value)).toEqual({ count: 1 });
  });
  test.each([
    ["at expiration", 1000],
    ["with a malformed expiration", Number.NaN],
  ])("refuses a request %s before any durable effect", async (_condition, expiresAt) => {
    const journal = new RequestJournal(state, () => 1000);
    await expect(
      journal.run(randomUUID(), expiresAt, { action: "write" }, async () => {
        await state.write("effect.json", { executed: true });
        return { ok: true };
      }),
    ).rejects.toThrow("expired or outside its time window");
    expect(await state.read("effect.json", (value) => value)).toBeNull();
  });
  test("new lifecycle admissions preserve legacy unknown archives and do not reserve command output", async () => {
    const legacy = [{ id: randomUUID(), state: "accepted", reservedBytes: 8388608 }];
    await state.write("requests.json", legacy);
    await state.write("result-legacy.json", { unknown: true });
    const before = await readFile(join(root, "requests.json"));
    const journal = new RequestJournal(state, () => 1000);
    const id = randomUUID();
    expect(
      await journal.run(id, 900000000, { action: "snapshot" }, async () => ({ ok: true })),
    ).toEqual({ ok: true });
    expect((await readFile(join(root, "requests.json"))).equals(before)).toBe(true);
    expect(await state.read("result-legacy.json", (value) => value)).toEqual({ unknown: true });
    const entries = (await state.read("lifecycle-receipts.json", (value) => value)) as Record<
      string,
      unknown
    >[];
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toHaveProperty("reservedBytes");
  });

  test("coalesces concurrent requests and returns the durable result after restart", async () => {
    const journal = new RequestJournal(state, () => 1000);
    const id = randomUUID();
    let performed = 0;
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const action = async () => {
      performed++;
      await gate;
      return { ok: true, bytes: "result" };
    };
    const first = journal.run(id, 2000, { action: "write" }, action);
    const duplicate = journal.run(id, 2000, { action: "write" }, action);
    finish();
    expect(await Promise.all([first, duplicate])).toEqual([
      { ok: true, bytes: "result" },
      { ok: true, bytes: "result" },
    ]);
    expect(performed).toBe(1);
    const restarted = new RequestJournal(state, () => 1000);
    expect(await restarted.run(id, 2000, { action: "write" }, action)).toEqual({
      ok: true,
      bytes: "result",
    });
    expect(performed).toBe(1);
    await expect(restarted.run(id, 2000, { action: "delete" }, action)).rejects.toThrow(
      "cannot change its contents",
    );
    await restarted.acknowledge(id);
    await expect(restarted.run(id, 2000, { action: "write" }, action)).rejects.toThrow(
      "acknowledged and removed",
    );
    expect(await state.keys("lifecycle-result-")).toEqual([]);
  });
  test("an accepted request with unknown outcome is never redispatched after a crash", async () => {
    const journal = new RequestJournal(state, () => 1000);
    const id = randomUUID();
    let performed = 0;
    await expect(
      journal.run(id, 2000, {}, async () => {
        performed++;
        throw new Error("crash after effect");
      }),
    ).rejects.toThrow("crash");
    const restarted = new RequestJournal(state, () => 1000);
    await expect(
      restarted.run(id, 2000, {}, async () => {
        performed++;
      }),
    ).rejects.toThrow("may have run");
    expect(performed).toBe(1);
  });
  test("separate concurrent requests retain separate receipts and expire without replay", async () => {
    let now = 1000;
    const journal = new RequestJournal(state, () => now);
    const ids = Array.from({ length: 4 }, () => randomUUID());
    const results = await Promise.all(
      ids.map((id, index) => journal.run(id, 2000, { index }, async () => ({ index }))),
    );
    expect(results).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }, { index: 3 }]);
    expect(await state.keys("lifecycle-result-")).toHaveLength(4);
    now = 2000 + 60 * 60_000;
    await journal.expire();
    expect(await state.keys("lifecycle-result-")).toEqual([]);
    await expect(journal.run(ids[0], 2000, {}, async () => null)).rejects.toThrow("expired");
  });
});
