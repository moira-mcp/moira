import { fork } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { PrivateState } from "./private-state.js";
import { LocalRecords } from "./space-record.js";
import { RuntimeOwner } from "./runtime-owner.js";
import { DeviceRuntimeControl } from "./runtime-control.js";
import { RuntimeDeviceOwner } from "./runtime-device-owner.js";
import type { LocalVmObservation } from "./local-vm-runtime.js";
import { LocalRefusal, MAX_MESSAGE_BYTES, localPolicySchema, type LocalPolicy } from "./policy.js";

const receiptSchema = z
  .object({
    owner: z.string().uuid(),
    profile: z.string().regex(/^[a-f0-9]{64}$/),
    settled: z.boolean(),
    ownerPID: z.number().int().min(1).max(2147483647).optional(),
  })
  .strict();
const profile = (policy: LocalPolicy) =>
  createHash("sha256")
    .update(JSON.stringify({ deviceId: policy.deviceId, runtime: policy.runtime }))
    .digest("hex");

async function settlePrivateRuntime(policy: LocalPolicy): Promise<void> {
  // Stop the captured daemon first, then refresh kernel-only coverage for a late worker birth.
  for (let pass = 0; pass < 2; pass++) {
    const control = new DeviceRuntimeControl(policy);
    try {
      await control.captureForShutdown();
      await control.stop();
    } catch (error) {
      if (!(error instanceof LocalRefusal) || error.code !== "LOCAL_CONTROL_ABSENT") throw error;
    }
  }
}

/** Called only by the locally opted-in controller while it holds the runner gate. */
export async function replaceStoppedPolicy(
  records: LocalRecords,
  next: LocalPolicy,
): Promise<void> {
  next = localPolicySchema.parse(next);
  const previous = await records.policy();
  const receipt = await records.state.read("runtime-owner.json", receiptSchema.parse);
  const transitionSchema = z
    .object({
      previous: localPolicySchema,
      next: localPolicySchema,
      before: receiptSchema.nullable(),
      after: receiptSchema.extend({ settled: z.literal(true) }),
      intermediate: localPolicySchema.optional(),
    })
    .strict();
  let transition = await records.state.read("policy-transition.json", transitionSchema.parse);
  const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const withoutLease = (policy: LocalPolicy) => ({ ...policy, enabled: false, leaseUntil: 0 });
  if (!transition && receipt && (!receipt.settled || receipt.profile !== profile(previous)))
    throw new LocalRefusal(
      "LOCAL_STOP_PENDING",
      "The previous runtime owner has not settled this profile.",
    );
  if (
    next.deviceId !== previous.deviceId ||
    next.runtime.binary !== previous.runtime.binary ||
    next.runtime.template !== previous.runtime.template ||
    next.runtime.storageRoot !== previous.runtime.storageRoot
  )
    throw new LocalRefusal(
      "LOCAL_RUNTIME_CHANGED",
      "Web control cannot choose another runtime or host path.",
    );
  if (transition) {
    const states = [
      transition.previous,
      { ...transition.previous, enabled: false },
      transition.next,
      { ...transition.next, enabled: false },
      transition.intermediate,
    ];
    if (
      !states.some((state) => state && equal(state, previous)) ||
      (!equal(receipt, transition.before) && !equal(receipt, transition.after)) ||
      (transition.before &&
        (!transition.before.settled ||
          transition.before.profile !== profile(transition.previous))) ||
      transition.after.profile !== profile(transition.next) ||
      !equal(withoutLease(next), withoutLease(transition.next)) ||
      (transition.intermediate &&
        !equal(withoutLease(transition.intermediate), withoutLease(transition.previous)) &&
        !equal(withoutLease(transition.intermediate), withoutLease(transition.next)))
    )
      throw new LocalRefusal(
        "LOCAL_RUNTIME_CHANGED",
        "The retained policy transition changed its exact local states.",
      );
    if (
      transition.previous.deviceId !== previous.deviceId ||
      transition.previous.runtime.binary !== previous.runtime.binary ||
      transition.previous.runtime.template !== previous.runtime.template ||
      transition.previous.runtime.storageRoot !== previous.runtime.storageRoot
    )
      throw new LocalRefusal(
        "LOCAL_RUNTIME_CHANGED",
        "The retained transition names another runtime.",
      );
    transition.intermediate = previous;
    transition.next = next;
  } else
    transition = {
      previous,
      next,
      before: receipt,
      after: { owner: randomUUID(), profile: profile(next), settled: true },
    };
  await records.state.write("policy-transition.json", transition);
  await settlePrivateRuntime(previous);
  if (
    JSON.stringify(await records.policy()) !== JSON.stringify(previous) ||
    JSON.stringify(await records.state.read("runtime-owner.json", receiptSchema.parse)) !==
      JSON.stringify(receipt)
  )
    throw new LocalRefusal(
      "LOCAL_RUNTIME_CHANGED",
      "Local policy changed during control settlement.",
    );
  await records.state.write("policy.json", { ...next, enabled: false });
  await records.state.write("runtime-owner.json", transition.after);
  await records.state.write("policy.json", next);
  await records.state.remove("policy-transition.json");
}

function refuseLiveRecoveryOwner(receipt: z.infer<typeof receiptSchema> | null): void {
  if (!receipt?.ownerPID) return;
  try {
    process.kill(receipt.ownerPID, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
  }
  // PID is only a conservative refusal signal, never adopted or used to terminate work.
  throw new LocalRefusal(
    "LOCAL_OWNER_ACTIVE",
    "The recorded owner PID is still present; wait for its exit before acknowledging shutdown.",
  );
}

async function recoveryAdmission(records: LocalRecords) {
  const policy = await records.policy();
  if (policy.enabled)
    throw new LocalRefusal(
      "LOCAL_DISABLED_REQUIRED",
      "Disable work before acknowledging an orphan device owner.",
    );
  const receipt = await records.state.read("runtime-owner.json", receiptSchema.parse);
  if (receipt && receipt.profile !== profile(policy))
    throw new LocalRefusal(
      "LOCAL_RUNTIME_CHANGED",
      "The previous owner belongs to another locally selected runtime profile.",
    );
  refuseLiveRecoveryOwner(receipt);
  return { policy, receipt };
}

/** Explicit local acknowledgement only; no cloud request can reset an orphan owner receipt. */
export async function recoverLocalDevice(records: LocalRecords, confirmed: boolean): Promise<void> {
  if (!confirmed)
    throw new LocalRefusal(
      "LOCAL_RECOVERY_CONFIRM",
      "Pass --confirm to acknowledge this device owner's unknown shutdown locally.",
    );
  await recoveryAdmission(records);
  const release = await records.state.lock({ recoverStale: true });
  try {
    const { policy, receipt } = await recoveryAdmission(records);
    await settlePrivateRuntime(policy);
    const current = await records.policy();
    const currentReceipt = await records.state.read("runtime-owner.json", receiptSchema.parse);
    if (
      current.enabled ||
      JSON.stringify(current) !== JSON.stringify(policy) ||
      JSON.stringify(currentReceipt) !== JSON.stringify(receipt)
    )
      throw new LocalRefusal(
        "LOCAL_RUNTIME_CHANGED",
        "The local policy or owner receipt changed during physical recovery.",
      );
    refuseLiveRecoveryOwner(receipt);
    await records.state.write("runtime-owner.json", {
      owner: randomUUID(),
      profile: profile(policy),
      settled: true,
    });
  } finally {
    await release();
  }
}

/** Disable first; an active owner must settle its tracked calls before physical shutdown is acknowledged. */
export async function stopLocalDevice(records: LocalRecords): Promise<void> {
  const policy = await records.policy();
  if (policy.enabled)
    throw new LocalRefusal(
      "LOCAL_DISABLED_REQUIRED",
      "Disable local work before emergency shutdown.",
    );
  const expected = profile(policy);
  const deadline = Date.now() + 40_000;
  let receipt = await records.state.read("runtime-owner.json", receiptSchema.parse);
  while (receipt && !receipt.settled) {
    if (receipt.profile !== expected)
      throw new LocalRefusal(
        "LOCAL_RUNTIME_CHANGED",
        "The active local owner uses a different profile.",
      );
    if (Date.now() >= deadline)
      throw new LocalRefusal(
        "LOCAL_STOP_PENDING",
        "The independent device owner has not confirmed shutdown.",
      );
    await pause(25);
    receipt = await records.state.read("runtime-owner.json", receiptSchema.parse);
    if (!receipt)
      throw new LocalRefusal("LOCAL_STOP_PENDING", "The local shutdown receipt disappeared.");
  }
  if (receipt) {
    if (receipt.profile !== expected)
      throw new LocalRefusal(
        "LOCAL_RUNTIME_CHANGED",
        "The shutdown receipt belongs to another profile.",
      );
    return;
  }
  const control = new DeviceRuntimeControl(policy);
  await control.captureForShutdown();
  await control.stop();
}

/** The CLI holds runner.lock; a fresh peer observation fences explicit credential recovery. */
export async function prepareLocalCredentialRecovery(records: LocalRecords): Promise<void> {
  const policy = await records.policy();
  if (policy.enabled)
    throw new LocalRefusal(
      "LOCAL_DISABLED_REQUIRED",
      "Disable local work before changing the credential store.",
    );
  const receipt = await records.state.read("runtime-owner.json", receiptSchema.parse);
  if (receipt && !receipt.settled) await stopLocalDevice(records);
  if (receipt && receipt.profile !== profile(policy))
    throw new LocalRefusal(
      "LOCAL_RUNTIME_CHANGED",
      "The previous SDK owner used another profile; inspect it locally.",
    );
  await settlePrivateRuntime(policy);
  const current = await records.policy();
  if (current.enabled || profile(current) !== profile(policy))
    throw new LocalRefusal(
      "LOCAL_RUNTIME_CHANGED",
      "The local policy changed during credential recovery.",
    );
  await records.state.write("runtime-owner.json", {
    owner: randomUUID(),
    profile: profile(policy),
    settled: true,
  });
}

export interface SpaceGuard {
  readonly active: boolean;
  prepare(): Promise<void>;
  operation(request: unknown): Promise<Buffer>;
  validate(): Promise<void>;
  stop(): Promise<void>;
}
export interface DeviceGuard {
  readonly active: boolean;
  space(id: string, activate?: boolean): Promise<SpaceGuard>;
  observe(): Promise<LocalVmObservation[]>;
  retire(id: string, generation: number): Promise<void>;
  remove(id: string, generation: number, localApproval: boolean): Promise<void>;
  recover?(id: string, generation: number): Promise<number>;
  stop(): Promise<void>;
}
export type StartGuard = (root: string) => Promise<DeviceGuard>;
const scope = { id: z.number().int().positive(), spaceId: z.string().uuid() };
const admittedScope = { ...scope, generation: z.number().int().positive() };
const callSchema = z.discriminatedUnion("action", [
  z.object({ id: z.number().int().positive(), action: z.literal("observe") }).strict(),
  z.object({ ...scope, action: z.literal("admit") }).strict(),
  z.object({ ...scope, action: z.literal("start-space") }).strict(),
  z.object({ ...admittedScope, action: z.literal("prepare") }).strict(),
  z.object({ ...admittedScope, action: z.literal("validate") }).strict(),
  z.object({ ...admittedScope, action: z.literal("operation"), request: z.unknown() }).strict(),
  z.object({ ...admittedScope, action: z.literal("stop-space") }).strict(),
  z.object({ ...admittedScope, action: z.literal("retire-space") }).strict(),
  z.object({ ...admittedScope, action: z.literal("recover-space") }).strict(),
  z
    .object({ ...admittedScope, action: z.literal("remove-space"), localApproval: z.boolean() })
    .strict(),
]);

/** One independent process owns all spaces of this private device, not a cloud RPC surface. */
export const startGuard: StartGuard = (root) =>
  new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL("./guard.js", import.meta.url)), [root], {
      execArgv: [],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    });
    let ready = false,
      closed = false,
      sequence = 0;
    let exitCode: number | null = null;
    let startupError: LocalRefusal | undefined;
    let shutdown: Promise<void> | undefined;
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    const scopes = new Map<string, Set<{ active: boolean }>>();
    const unavailable = () =>
      new LocalRefusal(
        "LOCAL_GUARD_UNAVAILABLE",
        "The independent local device owner is unavailable.",
      );
    const timer = setTimeout(() => {
      if (child.connected) child.disconnect();
      reject(unavailable());
    }, 45_000);
    const fail = () => {
      for (const call of pending.values()) call.reject(unavailable());
      pending.clear();
    };
    child.once("error", () => {
      clearTimeout(timer);
      fail();
      reject(unavailable());
    });
    child.once("exit", (code) => {
      closed = true;
      exitCode = code;
      clearTimeout(timer);
      fail();
      if (!ready) reject(startupError ?? unavailable());
    });
    const request = (
      spaceId: string | undefined,
      action:
        | "admit"
        | "start-space"
        | "prepare"
        | "validate"
        | "operation"
        | "stop-space"
        | "observe"
        | "retire-space"
        | "recover-space"
        | "remove-space",
      value?: unknown,
      generation?: number,
    ): Promise<unknown> =>
      new Promise((done, failed) => {
        if (closed || shutdown || !child.connected) {
          failed(unavailable());
          return;
        }
        const id = ++sequence;
        pending.set(id, { resolve: done, reject: failed });
        const message =
          action === "observe"
            ? { id, action }
            : action === "remove-space"
              ? { id, action, spaceId, generation, localApproval: value }
              : action === "operation"
                ? { id, action, spaceId, generation, request: value }
                : action === "admit" || action === "start-space"
                  ? { id, action, spaceId }
                  : { id, action, spaceId, generation };
        child.send(message, (error) => {
          if (error) {
            pending.delete(id);
            failed(unavailable());
          }
        });
      });
    const stop = (): Promise<void> => {
      shutdown ??= new Promise<void>((done, failed) => {
        if (closed) {
          if (exitCode === 0) done();
          else failed(unavailable());
          return;
        }
        const deadline = setTimeout(
          () => failed(new LocalRefusal("LOCAL_STOP_PENDING", "Device shutdown is still pending.")),
          40_000,
        );
        child.once("exit", (code) => {
          clearTimeout(deadline);
          if (code === 0) done();
          else
            failed(
              new LocalRefusal("LOCAL_STOP_PENDING", "Device shutdown could not be confirmed."),
            );
        });
        if (child.connected) child.send("stop");
      });
      return shutdown;
    };
    child.on("message", (value: unknown) => {
      if (!ready) {
        const failed = z
          .object({
            localError: z
              .object({
                code: z.string().regex(/^LOCAL_[A-Z_]+$/),
                message: z.string().min(1).max(500),
              })
              .strict(),
          })
          .strict()
          .safeParse(value);
        if (failed.success) {
          startupError = new LocalRefusal(
            failed.data.localError.code,
            failed.data.localError.message,
          );
          return;
        }
      }
      if (value === "ready" && !ready) {
        ready = true;
        clearTimeout(timer);
        resolve({
          get active() {
            return !closed && !shutdown && child.connected;
          },
          stop,
          observe: async () => (await request(undefined, "observe")) as LocalVmObservation[],
          retire: async (id, generation) => {
            await request(id, "retire-space", undefined, generation);
          },
          remove: async (id, generation, localApproval) => {
            await request(id, "remove-space", localApproval, generation);
          },
          recover: async (id, generation) =>
            z
              .number()
              .int()
              .positive()
              .parse(await request(id, "recover-space", undefined, generation)),
          space: async (spaceId, activate = false) => {
            const generation = z
              .number()
              .int()
              .positive()
              .parse(await request(spaceId, activate ? "start-space" : "admit"));
            const scope = { active: true };
            const existing = scopes.get(spaceId) ?? new Set();
            existing.add(scope);
            scopes.set(spaceId, existing);
            let stopped = false;
            return {
              get active() {
                return scope.active && !stopped && !closed && !shutdown && child.connected;
              },
              prepare: async () => {
                if (stopped) throw unavailable();
                await request(spaceId, "prepare", undefined, generation);
              },
              operation: async (value) => {
                if (stopped) throw unavailable();
                const result = await request(spaceId, "operation", value, generation);
                if (!Buffer.isBuffer(result)) throw unavailable();
                return result;
              },
              validate: async () => {
                await request(spaceId, "validate", undefined, generation);
              },
              stop: async () => {
                if (stopped) return;
                if (closed) {
                  await stop();
                  stopped = true;
                  return;
                }
                try {
                  await request(spaceId, "stop-space", undefined, generation);
                } catch (error) {
                  if (!closed) throw error;
                  await stop();
                }
                stopped = true;
              },
            };
          },
        });
        return;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        "retired" in value &&
        typeof value.retired === "string"
      ) {
        for (const scope of scopes.get(value.retired) ?? []) scope.active = false;
        scopes.delete(value.retired);
        return;
      }
      if (typeof value !== "object" || value === null || !("id" in value)) return;
      const response = value as {
        id: number;
        ok: boolean;
        result?: unknown;
        code?: string;
        message?: string;
      };
      const call = pending.get(response.id);
      if (!call) return;
      pending.delete(response.id);
      if (response.ok) call.resolve(response.result);
      else
        call.reject(
          new LocalRefusal(
            response.code ?? "LOCAL_GUARD_REFUSED",
            response.message ?? "The device owner refused work.",
          ),
        );
    });
  });

/** Fixed local diagnostics/initializer; it never accepts a runtime, argv or cloud exception. */
export async function withLocalRuntimeOwner(
  records: LocalRecords,
  action: "doctor" | "setup",
): Promise<{ sandboxes: number }> {
  const release = await records.state.lock();
  try {
    return await new Promise<{ sandboxes: number }>((resolve, reject) => {
      const child = fork(
        fileURLToPath(new URL("./guard.js", import.meta.url)),
        [records.state.root, action],
        {
          execArgv: [],
          env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          serialization: "advanced",
        },
      );
      let result: { sandboxes: number } | undefined;
      let failure: LocalRefusal | undefined;
      child.on("message", (value: unknown) => {
        const parsed = z
          .object({
            localResult: z.object({ sandboxes: z.number().int().min(0).max(128) }).strict(),
          })
          .strict()
          .safeParse(value);
        if (parsed.success) result = parsed.data.localResult;
        const refused = z
          .object({
            localError: z
              .object({
                code: z.string().regex(/^LOCAL_[A-Z_]+$/),
                message: z.string().min(1).max(500),
              })
              .strict(),
          })
          .strict()
          .safeParse(value);
        if (refused.success)
          failure = new LocalRefusal(refused.data.localError.code, refused.data.localError.message);
      });
      child.once("error", () =>
        reject(
          new LocalRefusal(
            "LOCAL_GUARD_UNAVAILABLE",
            "The local diagnostic owner could not start.",
          ),
        ),
      );
      child.once("exit", (code) => {
        if (code === 0 && result) resolve(result);
        else
          reject(
            failure ??
              new LocalRefusal(
                "LOCAL_GUARD_REFUSED",
                "Local diagnostics or setup did not settle safely.",
              ),
          );
      });
    });
  } finally {
    await release();
  }
}

async function runGuard(root: string, action: "work" | "doctor" | "setup" = "work"): Promise<void> {
  const records = new LocalRecords(await PrivateState.open(root));
  const initial = await records.policy();
  const control = new RuntimeDeviceOwner(records, initial, action === "setup");
  const receipt = {
    owner: randomUUID(),
    ownerPID: process.pid,
    profile: profile(initial),
    settled: false,
  };
  await records.state.write("runtime-owner.json", receipt);
  const settle = async () => {
    await control.stop();
    await records.state.write("runtime-owner.json", { ...receipt, settled: true });
  };
  const earlyStop = () => {
    void settle().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("disconnect", earlyStop);
  process.once("SIGTERM", earlyStop);
  process.once("SIGINT", earlyStop);
  try {
    if (!process.connected)
      throw new LocalRefusal("LOCAL_GUARD_UNAVAILABLE", "The local parent disconnected.");
    await control.open();
  } catch (error) {
    await settle().catch(() => undefined);
    throw error;
  }
  if (action !== "work") {
    const deadline = setTimeout(earlyStop, 300_000);
    try {
      if (action === "setup") await control.runtime.initialize();
      const sandboxes = action === "doctor" ? (await control.observe()).length : 0;
      await control.stop();
      await records.state.write("runtime-owner.json", { ...receipt, settled: true });
      process.send?.({ localResult: { sandboxes } }, () => process.exit(0));
    } finally {
      clearTimeout(deadline);
      await control.stop();
      await records.state.write("runtime-owner.json", { ...receipt, settled: true });
    }
    return;
  }
  const owners = new Map<string, RuntimeOwner>();
  let stopping: Promise<void> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let admissionTail: Promise<unknown> = Promise.resolve();
  const shutdown = (): Promise<void> => {
    if (poll) clearTimeout(poll);
    if (leaseTimer) clearTimeout(leaseTimer);
    stopping ??= (async () => {
      control.revoke();
      // All aborts are initiated before awaiting any space; no peer can restart the shared daemon.
      const results = await Promise.allSettled(
        [...owners.values()].map((owner) => owner.quiesce(true)),
      );
      await Promise.allSettled([...owners.values()].map((owner) => owner.settleManagement()));
      await control.stop();
      if (results.some((result) => result.status === "rejected"))
        throw new LocalRefusal("LOCAL_STOP_PENDING", "Device shutdown did not settle cleanly.");
      await Promise.all([...owners.values()].map((owner) => owner.confirmStopped()));
      await records.state.write("runtime-owner.json", { ...receipt, settled: true });
    })();
    return stopping;
  };
  const emergency = () => {
    void shutdown().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once("disconnect", emergency);
  process.once("SIGTERM", emergency);
  process.once("SIGINT", emergency);
  process.removeListener("disconnect", earlyStop);
  process.removeListener("SIGTERM", earlyStop);
  process.removeListener("SIGINT", earlyStop);
  const reply = (id: number, result: unknown, error?: unknown, exit = false) => {
    if (!process.connected) return;
    process.send?.(
      error
        ? {
            id,
            ok: false,
            code: error instanceof LocalRefusal ? error.code : "LOCAL_GUARD_REFUSED",
            message:
              error instanceof LocalRefusal
                ? error.message
                : "The locally owned operation was refused.",
          }
        : { id, ok: true, result },
      () => {
        if (exit) process.exit(0);
      },
    );
  };
  process.on("message", (value: unknown) => {
    if (value === "stop") {
      emergency();
      return;
    }
    if (stopping || !process.connected) return;
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) {
      emergency();
      return;
    }
    const parsed = callSchema.safeParse(value);
    if (!parsed.success) {
      emergency();
      return;
    }
    const call = parsed.data;
    void (async () => {
      if (call.action === "observe") return control.observe();
      if (
        call.action === "retire-space" ||
        call.action === "remove-space" ||
        call.action === "recover-space"
      ) {
        let owner = owners.get(call.spaceId);
        if (!owner) {
          owner = new RuntimeOwner(
            records,
            call.spaceId,
            () => control.protect(),
            () => control.prepareCredentials(),
          );
          owners.set(call.spaceId, owner);
        }
        if (call.action === "recover-space") {
          const generation = await owner.recover(call.generation);
          process.send?.({ retired: call.spaceId });
          return generation;
        }
        await owner.manage(
          call.generation,
          call.action === "remove-space",
          call.action === "remove-space" && call.localApproval,
        );
        process.send?.({ retired: call.spaceId });
        return;
      }
      if (call.action === "admit" || call.action === "start-space") {
        const admitted = admissionTail.then(async () => {
          if (stopping)
            throw new LocalRefusal("LOCAL_NOT_RUNNING", "The device owner is stopping.");
          let owner = owners.get(call.spaceId);
          if (!owner?.active) {
            await owner?.stop();
            if (stopping)
              throw new LocalRefusal("LOCAL_NOT_RUNNING", "The device admission was revoked.");
            owner = new RuntimeOwner(
              records,
              call.spaceId,
              () => control.protect(),
              () => control.prepareCredentials(),
            );
            owners.set(call.spaceId, owner);
            await owner.admit(call.action === "start-space");
          }
          if (stopping)
            throw new LocalRefusal("LOCAL_NOT_RUNNING", "The device admission was revoked.");
          return owner.generation;
        });
        admissionTail = admitted.catch(() => undefined);
        return admitted;
      }
      const owner = owners.get(call.spaceId);
      if (!owner)
        throw new LocalRefusal(
          "LOCAL_NOT_RUNNING",
          "This space has no independent local admission.",
        );
      if (
        call.generation !== owner.generation &&
        (call.action !== "stop-space" || call.generation !== owner.admittedGeneration)
      )
        throw new LocalRefusal(
          "LOCAL_GENERATION_CONFLICT",
          "The independent space admission changed.",
        );
      if (call.action === "prepare" || call.action === "operation") {
        try {
          return call.action === "prepare"
            ? await owner.prepare()
            : await owner.operation(call.request);
        } catch (error) {
          if (error instanceof LocalRefusal && error.code === "LOCAL_GUEST_SETTLEMENT_UNKNOWN")
            process.send?.({ retired: call.spaceId });
          else if (error instanceof LocalRefusal && error.code === "LOCAL_STOP_PENDING")
            await shutdown();
          throw error;
        }
      }
      if (call.action === "validate") return owner.validate();
      try {
        await owner.stop();
      } catch (error) {
        await shutdown();
        throw error;
      }
      process.send?.({ retired: call.spaceId });
      if (owner.unknownIdentity) {
        await shutdown();
      }
    })().then(
      (result) => {
        reply(call.id, result, undefined, Boolean(stopping));
      },
      (error) => {
        if (
          error instanceof LocalRefusal &&
          /^(LOCAL_KEYCHAIN_|LOCAL_CONTROL_|LOCAL_DAEMON_|LOCAL_STATE_|LOCAL_(?:RUNTIME_(?:UNSAFE|CHANGED|VERSION|UNAVAILABLE)|SANDBOX_UNSAFE|NETWORK_(?:UNSAFE|CHANGED)|IDENTITY_CHANGED|BINARY_UNSAFE|DOCKER_LOGIN_REQUIRED)$)/.test(
            error.code,
          )
        ) {
          void shutdown().then(
            () => reply(call.id, undefined, error, true),
            (failure) => reply(call.id, undefined, failure),
          );
        } else reply(call.id, undefined, error);
      },
    );
  });
  // Recovered running records are observed by the same owner; unknown pending creation is not adopted.
  let refused = false;
  for (const space of await records.list()) {
    if (space.desiredState !== "running") continue;
    const owner = new RuntimeOwner(
      records,
      space.id,
      () => control.protect(),
      () => control.prepareCredentials(),
    );
    owners.set(space.id, owner);
    try {
      await owner.admit();
    } catch {
      refused = true;
    }
    if (!space.runtimeId) refused = true;
  }
  if (refused) {
    await shutdown();
    throw new LocalRefusal(
      "LOCAL_CREATE_UNKNOWN",
      "Previous local work could not be safely recovered.",
    );
  }
  const check = async () => {
    try {
      const policy = await records.policy();
      if (leaseTimer) clearTimeout(leaseTimer);
      leaseTimer = setTimeout(emergency, Math.max(1, policy.leaseUntil - Date.now()));
      if (
        !process.connected ||
        !policy.enabled ||
        policy.leaseUntil <= Date.now() ||
        policy.deviceId !== initial.deviceId ||
        JSON.stringify(policy.runtime) !== JSON.stringify(initial.runtime)
      ) {
        emergency();
        return;
      }
      for (const owner of owners.values())
        if (owner.active) {
          try {
            await owner.check();
          } catch {
            await owner.stop();
            process.send?.({ retired: owner.id });
            if (owner.unknownIdentity) {
              emergency();
              return;
            }
          }
        }
      if (!stopping)
        poll = setTimeout(
          () => {
            void check();
          },
          Math.max(1, Math.min(1000, policy.leaseUntil - Date.now())),
        );
    } catch {
      emergency();
    }
  };
  await check();
  if (!stopping && process.connected) process.send?.("ready");
}
if (
  process.argv[1] &&
  new URL(import.meta.url).pathname.endsWith("/guard.js") &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const action = process.argv[3];
  if (action !== undefined && action !== "doctor" && action !== "setup") process.exit(1);
  void runGuard(process.argv[2], action).catch((error) => {
    if (process.connected)
      process.send?.(
        {
          localError: {
            code: error instanceof LocalRefusal ? error.code : "LOCAL_GUARD_REFUSED",
            message:
              error instanceof LocalRefusal ? error.message : "Local setup or diagnostics failed.",
          },
        },
        () => process.exit(1),
      );
    else process.exit(1);
  });
}
