import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { mkdtemp, rm, readFile, realpath } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalJobs } from "../../../packages/local/src/jobs.js";
import { LocalRefusal } from "../../../packages/local/src/policy.js";
import { SbxRuntime, type SandboxObservation } from "../../../packages/local/src/sbx-runtime.js";
import type { LocalVmIdentity as SandboxIdentity } from "../../../packages/local/src/local-vm-runtime.js";
import { adaptSbxRuntime } from "../../../packages/local/src/local-vm-runtime-factory.js";
import { localFixture } from "./fixtures.js";

let root: string;
let state: PrivateState;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moira-local-jobs-")));
  state = await PrivateState.open(root);
});
afterEach(async () => {
  jest.useRealTimers();
  await rm(root, { recursive: true, force: true });
});
const policyBytes = Buffer.from("fixed externally-enforced sandbox policy");
const command = () => ({
  version: 1,
  action: "execute",
  remoteMarker: `moira-op-${randomBytes(16).toString("hex")}`,
  argv: ["node", "-e", "process.stdout.write('guest-only-value')"],
  stdin: "",
  timeoutMs: 1000,
  maxStdoutBytes: 1024,
  maxStderrBytes: 1024,
  maxRetainedBytes: 1024,
});

async function fixture(now: () => number = Date.now) {
  const local = await localFixture(state);
  local.space.networkPolicy = createHash("sha256").update(policyBytes).digest("hex");
  await local.records.put(local.space);
  const requests: Array<Record<string, unknown>> = [];
  let status: SandboxObservation["status"] = "running";
  let guestContact: Promise<Buffer> | undefined;
  let checkBoundary = async () => {};
  let respond: (request: Record<string, unknown>) => Promise<unknown> = async () => ({
    state: "running",
  });
  class ExternalRuntime extends SbxRuntime {
    override async verifySettings() {}
    override async verifyBoundary() {
      await checkBoundary();
    }
    override async networkPolicy() {
      return policyBytes;
    }
    override async exact(identity: SandboxIdentity): Promise<SandboxObservation> {
      return {
        id: identity.runtimeId,
        name: identity.name,
        agent: "shell",
        status,
        workspaces: [],
        ports: [],
      };
    }
    override async guest(_identity: SandboxIdentity, argv: readonly string[], input?: Uint8Array) {
      expect(argv).toEqual(["node", "/tmp/moira-local-runtime/worker.mjs"]);
      const body = JSON.parse(Buffer.from(input!).toString());
      expect(body.kind).toBe("operation");
      requests.push(body.request);
      const result = await respond(body.request);
      // sbx exec can start a stopped sandbox at actual contact, not only at preflight.
      status = "running";
      return Buffer.from(JSON.stringify({ ok: true, result }));
    }
    override async stop() {
      status = "stopped";
    }
  }
  const runtime = new ExternalRuntime(local.policy);
  const manager = new LocalManager(local.records, {
    runtime: () => adaptSbxRuntime(runtime),
    now,
    // This suite explicitly substitutes external runtime ownership, not native guard IPC.
    guard: async () => ({
      active: true,
      stop: async () => {},
      observe: async () => [],
      retire: async () => {},
      remove: async () => {},
      space: async () => ({
        active: true,
        prepare: async () => {},
        validate: async () => {},
        operation: (request) => {
          guestContact = runtime.guest(
            { name: local.space.name, runtimeId: local.space.runtimeId! },
            ["node", "/tmp/moira-local-runtime/worker.mjs"],
            Buffer.from(JSON.stringify({ kind: "operation", request })),
          );
          return guestContact;
        },
        stop: async () => {
          // The substituted owner has the same child-settlement obligation as RuntimeOwner:
          // no guest contact may restart the VM after its physical stop receipt.
          await guestContact?.catch(() => undefined);
          await runtime.stop();
          const current = await local.records.get(local.space.id);
          if (current)
            await local.records.put({
              ...current,
              desiredState: "stopped",
              phase: "stopped",
              generation: current.generation + 1,
            });
        },
      }),
    }),
  });
  return {
    ...local,
    manager,
    requests,
    jobs: new LocalJobs(manager),
    runtime,
    boundary: (next: typeof checkBoundary) => {
      checkBoundary = next;
    },
    response: (next: typeof respond) => {
      respond = next;
    },
  };
}

describe("local operation dispatch with an external-runtime substitute", () => {
  test("combined encoded stdout and stderr are refused before ledger acceptance or guest effects", async () => {
    const local = await fixture();
    await expect(
      local.jobs.dispatch(local.space.id, {
        ...command(),
        maxStdoutBytes: 4 * 1024 * 1024,
        maxStderrBytes: 4 * 1024 * 1024,
      }),
    ).rejects.toMatchObject({ code: "LOCAL_OUTPUT_LIMIT" });
    expect(await state.keys("job-")).toEqual([]);
    expect(local.requests).toEqual([]);
  });
  test("one four-MiB stream remains admissible within the combined encoded response budget", async () => {
    const local = await fixture();
    const request = { ...command(), maxStdoutBytes: 4 * 1024 * 1024, maxStderrBytes: 1024 };
    await expect(local.jobs.dispatch(local.space.id, request)).resolves.toEqual({
      state: "running",
    });
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0].maxStdoutBytes).toBe(4 * 1024 * 1024);
    expect(await state.keys("job-")).toHaveLength(1);
  });
  test("an unknown guest receipt is persisted and never redispatched after the local job reader restarts", async () => {
    const local = await fixture();
    local.response(async () => {
      throw new LocalRefusal("LOCAL_GUEST_SETTLEMENT_UNKNOWN", "Guest exit was not observed.");
    });
    const request = command();
    await expect(local.jobs.dispatch(local.space.id, request)).rejects.toMatchObject({
      code: "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
    });
    const ledger = JSON.parse(await readFile(join(root, (await state.keys("job-"))[0]), "utf8"));
    expect(ledger).toMatchObject({ unknown: true, terminal: false, marker: request.remoteMarker });
    await expect(
      new LocalJobs(local.manager).dispatch(local.space.id, request),
    ).rejects.toMatchObject({
      code: "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
    });
    expect(local.requests).toHaveLength(1);
  });
  test("a local policy revocation during boundary validation prevents guest dispatch", async () => {
    const local = await fixture();
    local.boundary(async () => {
      local.policy.enabled = false;
      await state.write("policy.json", local.policy);
    });
    await expect(local.jobs.dispatch(local.space.id, command())).rejects.toMatchObject({
      code: "LOCAL_DISABLED",
    });
    expect(await local.records.policy()).toMatchObject({ enabled: false });
    expect(local.requests).toEqual([]);
  });
  test("a shortened local lease bounds the dispatched request and durable deadline", async () => {
    const acceptedAt = Date.now();
    const local = await fixture(() => acceptedAt);
    local.boundary(async () => {
      local.policy.leaseUntil = local.manager.now() + 500;
      await state.write("policy.json", local.policy);
    });
    expect(await local.jobs.dispatch(local.space.id, { ...command(), timeoutMs: 6000 })).toEqual({
      state: "running",
    });
    expect(local.requests[0].timeoutMs).toBeGreaterThan(0);
    expect(local.requests[0].timeoutMs).toBeLessThanOrEqual(500);
    const ledger = JSON.parse(await readFile(join(root, (await state.keys("job-"))[0]), "utf8"));
    expect(ledger.deadlineAt).toBeLessThanOrEqual(local.policy.leaseUntil);
  });
  test("retained output above the guest protocol bound is refused before dispatch", async () => {
    const local = await fixture();
    await expect(
      local.jobs.dispatch(local.space.id, { ...command(), maxRetainedBytes: 4 * 1024 ** 3 + 1 }),
    ).rejects.toThrow();
    expect(local.requests).toEqual([]);
  });
  test("a stop queued during guest contact leaves the persisted sandbox stopped after dispatch", async () => {
    const local = await fixture();
    // Keep persistence real, with deterministic promise scheduling instead of filesystem delays.
    const path = join(root, `space-${local.space.id}.json`);
    local.records.get = async () => JSON.parse(await readFile(path, "utf8"));
    local.manager.require = async () => JSON.parse(JSON.stringify(local.space));
    local.records.policy = async () => local.policy;
    local.records.put = async (space) => {
      Object.assign(local.space, space);
      writeFileSync(path, JSON.stringify(space), { mode: 0o600 });
    };
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    local.response(async () => {
      entered();
      await gate;
      return { state: "running", accepted: "guest-only-value" };
    });
    const operation = local.jobs.dispatch(local.space.id, command());
    await started;
    jest.useFakeTimers();
    const stopped = local.manager.stop(local.space.id);
    await jest.advanceTimersByTimeAsync(0);
    finish();
    expect(await operation).toMatchObject({ state: "running", accepted: "guest-only-value" });
    await stopped;
    expect(await local.records.get(local.space.id)).toMatchObject({
      desiredState: "stopped",
      phase: "stopped",
    });
    expect((await local.runtime.exact(local.manager.identity(local.space)))?.status).toBe(
      "stopped",
    );
  });
  test("persists acceptance before dispatch and inspects, rather than reexecutes, after restart", async () => {
    const local = await fixture();
    const request = command();
    expect(await local.jobs.dispatch(local.space.id, request)).toEqual({ state: "running" });
    const restarted = new LocalJobs(local.manager);
    await restarted.dispatch(local.space.id, request);
    expect(local.requests.map((item) => item.action)).toEqual(["execute", "inspect"]);
    expect(local.requests[0].repositoryFullName).toBe("owner/project");
    const ledger = await readFile(join(root, (await state.keys("job-"))[0]), "utf8");
    expect(ledger).not.toContain("guest-only-value");
    await expect(
      restarted.dispatch(local.space.id, { ...request, argv: ["different"] }),
    ).rejects.toMatchObject({ code: "LOCAL_REPLAY_CONFLICT" });
  });
  test("concurrent replay does not inspect a guest before the original dispatch is established", async () => {
    const local = await fixture();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    local.response(async () => {
      entered();
      await gate;
      return { state: "running" };
    });
    const request = command();
    const first = local.jobs.dispatch(local.space.id, request);
    await started;
    expect(await local.jobs.dispatch(local.space.id, request)).toEqual({ state: "running" });
    expect(local.requests).toHaveLength(1);
    finish();
    await first;
  });
  test("requests choose execution bounds independently of owner settings while repository and enabled authority remain fenced", async () => {
    const local = await fixture();
    await expect(
      local.jobs.dispatch(local.space.id, { ...command(), repositoryFullName: "other/private" }),
    ).rejects.toMatchObject({ code: "LOCAL_REPOSITORY_DENIED" });
    await expect(
      local.jobs.dispatch(local.space.id, { ...command(), timeoutMs: 3_600_000 }),
    ).resolves.toEqual({ state: "running" });
    await expect(
      local.jobs.dispatch(local.space.id, { ...command(), maxRetainedBytes: 2 * 1024 * 1024 }),
    ).resolves.toEqual({ state: "running" });
    local.policy.enabled = false;
    await state.write("policy.json", local.policy);
    await expect(local.jobs.dispatch(local.space.id, command())).rejects.toMatchObject({
      code: "LOCAL_DISABLED",
    });
    expect(local.requests).toHaveLength(2);
  });
  test("multiple active jobs are admitted without an owner concurrency quota and old generations cannot execute", async () => {
    const local = await fixture();
    const first = command();
    await local.jobs.dispatch(local.space.id, first);
    for (let index = 1; index < 5; index++) await local.jobs.dispatch(local.space.id, command());
    await expect(local.jobs.dispatch(local.space.id, command())).resolves.toEqual({
      state: "running",
    });
    const count = local.requests.length;
    local.space.generation++;
    await local.records.put(local.space);
    expect(
      await local.jobs.dispatch(local.space.id, {
        version: 1,
        action: "inspect",
        remoteMarker: first.remoteMarker,
      }),
    ).toEqual({ state: "interrupted" });
    expect(local.requests).toHaveLength(count);
  });
});
