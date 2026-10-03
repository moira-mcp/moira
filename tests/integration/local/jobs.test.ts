import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PrivateState } from "../../../packages/local/src/private-state.js";
import { LocalManager } from "../../../packages/local/src/manager.js";
import { LocalJobs } from "../../../packages/local/src/jobs.js";
import {
  SbxRuntime,
  type SandboxIdentity,
  type SandboxObservation,
} from "../../../packages/local/src/sbx-runtime.js";
import { localFixture } from "./fixtures.js";

let root: string;
let state: PrivateState;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "moira-local-jobs-"));
  state = await PrivateState.open(root);
});
afterEach(async () => {
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

async function fixture() {
  const local = await localFixture(state);
  local.space.networkPolicy = createHash("sha256").update(policyBytes).digest("hex");
  await local.records.put(local.space);
  const requests: Array<Record<string, unknown>> = [];
  let respond: (request: Record<string, unknown>) => Promise<unknown> = async () => ({
    state: "running",
  });
  class ExternalRuntime extends SbxRuntime {
    override async verifySettings() {}
    override async verifyBoundary() {}
    override async networkPolicy() {
      return policyBytes;
    }
    override async exact(identity: SandboxIdentity): Promise<SandboxObservation> {
      return {
        id: identity.runtimeId,
        name: identity.name,
        agent: "shell",
        status: "running",
        workspaces: [],
        ports: [],
      };
    }
    override async guest(_identity: SandboxIdentity, argv: readonly string[], input?: Uint8Array) {
      expect(argv).toEqual(["node", "/tmp/moira-local-runtime/worker.mjs"]);
      const body = JSON.parse(Buffer.from(input!).toString());
      expect(body.kind).toBe("operation");
      requests.push(body.request);
      return Buffer.from(JSON.stringify({ ok: true, result: await respond(body.request) }));
    }
  }
  const runtime = new ExternalRuntime(local.policy);
  const manager = new LocalManager(local.records, { runtime: () => runtime });
  return {
    ...local,
    manager,
    requests,
    jobs: new LocalJobs(manager),
    response: (next: typeof respond) => {
      respond = next;
    },
  };
}

describe("local operation dispatch with an external-runtime substitute", () => {
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
  test("cloud fields cannot override repository authority, work time or retained output", async () => {
    const local = await fixture();
    await expect(
      local.jobs.dispatch(local.space.id, { ...command(), repositoryFullName: "other/private" }),
    ).rejects.toMatchObject({ code: "LOCAL_REPOSITORY_DENIED" });
    await expect(
      local.jobs.dispatch(local.space.id, { ...command(), timeoutMs: 3_600_000 }),
    ).rejects.toThrow();
    await expect(
      local.jobs.dispatch(local.space.id, { ...command(), maxRetainedBytes: 2 * 1024 * 1024 }),
    ).rejects.toThrow();
    local.policy.enabled = false;
    await state.write("policy.json", local.policy);
    await expect(local.jobs.dispatch(local.space.id, command())).rejects.toMatchObject({
      code: "LOCAL_DISABLED",
    });
    expect(local.requests).toEqual([]);
  });
  test("local concurrency and restart generations hold even when the server ignores them", async () => {
    const local = await fixture();
    const first = command();
    await local.jobs.dispatch(local.space.id, first);
    for (let index = 1; index < local.policy.limits.maxConcurrent; index++)
      await local.jobs.dispatch(local.space.id, command());
    await expect(local.jobs.dispatch(local.space.id, command())).rejects.toMatchObject({
      code: "LOCAL_JOB_CAPACITY",
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
