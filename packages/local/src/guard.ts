import { fork } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { PrivateState, hostBootIdentity } from "./private-state.js";
import { LocalRecords, requireSetupRecovery } from "./space-record.js";
import { RuntimeOwner } from "./runtime-owner.js";
import { DeviceRuntimeControl } from "./runtime-control.js";
import { RuntimeDeviceOwner } from "./runtime-device-owner.js";
import type { LocalVmObservation } from "./local-vm-runtime.js";
import {
  LocalRefusal,
  localPolicySchema,
  legacyLocalPolicySchema,
  localRuntimeProfileHash,
  physicalRuntimeProfile,
  type LocalPolicy,
} from "./policy.js";
import { prepareControlApprovalUpgrade } from "./control-approval.js";
import {
  localManagementOutcomeSchema,
  type LocalManagementOutcome,
  localSetupDiagnosticSchema,
  type LocalSetupDiagnostic,
} from "../../shared/src/codespaces/local-protocol.js";

const receiptSchema = z
  .object({
    owner: z.string().uuid(),
    profile: z.string().regex(/^[a-f0-9]{64}$/),
    settled: z.boolean(),
    ownerPID: z.number().int().min(1).max(2147483647).optional(),
    boot: z.string().uuid().optional(),
    released: z.literal(true).optional(),
  })
  .strict();
const profile = localRuntimeProfileHash;

/** Caller holds the physical runner gate; this is not a public compatibility decoder. */
export async function upgradeLocalPolicyState(
  records: LocalRecords,
  options: { recoverLegacy?: boolean } = {},
): Promise<boolean> {
  return records.withSettingsChange(() => upgradeLocalPolicyStateLocked(records, options));
}

async function upgradeLocalPolicyStateLocked(
  records: LocalRecords,
  options: { recoverLegacy?: boolean },
): Promise<boolean> {
  await requireRuntimeOwnerAbsent(records);
  const raw = await records.state.read("policy.json", (value) => value);
  const approvalRaw = await records.state.read("web-control.json", (value) => value);
  const approval = approvalRaw === null ? null : prepareControlApprovalUpgrade(approvalRaw);
  if (raw === null) {
    if (approval?.changed) await records.state.write("web-control.json", approval.approval);
    return false;
  }
  const current = localPolicySchema.safeParse(raw);
  if (current.success) {
    if (approval && approval.approval.deviceId !== current.data.deviceId)
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The retained approval names another device.",
      );
    const receipt = await readRuntimeSettlement(records);
    if (receipt && receipt.profile !== profile(current.data))
      throw new LocalRefusal(
        "LOCAL_RUNTIME_CHANGED",
        "The retained owner belongs to another physical profile.",
      );
    if (
      approval?.legacySettings &&
      (approval.legacySettings.appliedRevision !== current.data.appliedRevision ||
        JSON.stringify(approval.legacySettings.agentRepositoryManagement) !==
          JSON.stringify(current.data.agentRepositoryManagement))
    )
      throw new LocalRefusal(
        "LOCAL_CONTROL_CONFLICT",
        "The converted settings do not match their retained approval.",
      );
    if (approval?.changed) await records.state.write("web-control.json", approval.approval);
    return false;
  }
  const previous = legacyLocalPolicySchema.parse(raw);
  const intent = await records.state.read("control-intent.json", (value) =>
    z
      .object({ revision: z.number().int().positive(), livePrevious: z.unknown().optional() })
      .passthrough()
      .parse(value),
  );
  if (
    (await records.state.read("policy-transition.json", (value) => value)) !== null ||
    (intent &&
      intent.livePrevious === undefined &&
      (!approval || intent.revision > (approval.legacySettings?.appliedRevision ?? 0)))
  )
    throw new LocalRefusal(
      "LOCAL_CONTROL_PENDING",
      "A retained physical settings effect needs settlement before policy conversion.",
    );
  if (approval && approval.approval.deviceId !== previous.deviceId)
    throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "The retained approval names another device.");
  const { leaseUntil, ...fields } = previous;
  const now = Date.now();
  const next = localPolicySchema.parse({
    ...fields,
    ...approval?.legacySettings,
    version: 2,
    enabled: previous.enabled && leaseUntil > now && leaseUntil <= now + 7 * 24 * 60 * 60_000,
  });
  const receipt = await readRuntimeSettlement(records);
  const legacyProfile = createHash("sha256")
    .update(JSON.stringify({ deviceId: previous.deviceId, runtime: previous.runtime }))
    .digest("hex");
  if (receipt && receipt.profile !== legacyProfile && receipt.profile !== profile(next))
    throw new LocalRefusal(
      "LOCAL_RUNTIME_CHANGED",
      "The retained owner does not identify the previous physical profile.",
    );
  let recovered = false;
  if (receipt && !receipt.settled) {
    if (!options.recoverLegacy)
      throw new LocalRefusal(
        "LOCAL_STOP_PENDING",
        "Explicit exact shutdown recovery is required before policy conversion.",
      );
    if (previous.enabled)
      throw new LocalRefusal(
        "LOCAL_DISABLED_REQUIRED",
        "Disable local work before recovering the previous owner.",
      );
    await settlePrivateRuntime(next);
    if (
      JSON.stringify(await records.state.read("policy.json", (value) => value)) !==
        JSON.stringify(raw) ||
      JSON.stringify(await readRuntimeSettlement(records)) !== JSON.stringify(receipt)
    )
      throw new LocalRefusal(
        "LOCAL_RUNTIME_CHANGED",
        "The retained runtime changed during recovery.",
      );
    await requireRuntimeOwnerAbsent(records);
    await records.state.write("runtime-owner.json", {
      owner: randomUUID(),
      profile: profile(next),
      settled: true,
    });
    recovered = true;
  } else if (receipt && receipt.profile !== profile(next)) {
    // Translate the proof domain, never its settlement assertion. Receipt-first
    // publication makes interruption recoverable with the exact old policy still present.
    await records.state.write("runtime-owner.json", { ...receipt, profile: profile(next) });
  }
  await records.state.write("policy.json", next);
  if (approval?.changed) await records.state.write("web-control.json", approval.approval);
  return recovered;
}

/** Losing an observer must not crash the owner before its release receipt is durable. */
function sendGuardMessage(value: object | string, done?: () => void): void {
  if (!process.connected || !process.send) {
    done?.();
    return;
  }
  process.send(value, () => done?.());
}

export async function settlePrivateRuntime(policy: LocalPolicy): Promise<void> {
  // Stop the captured daemon first, then refresh kernel-only coverage for a late worker birth.
  for (let pass = 0; pass < 2; pass++) {
    const control = new DeviceRuntimeControl(policy);
    try {
      await control.captureForShutdown();
      await control.stop();
    } catch (error) {
      if (!(error instanceof LocalRefusal) || error.code !== "LOCAL_CONTROL_ABSENT") throw error;
    } finally {
      await control.release();
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
  const withoutEnablement = (policy: LocalPolicy) => ({ ...policy, enabled: false });
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
      !equal(withoutEnablement(next), withoutEnablement(transition.next)) ||
      (transition.intermediate &&
        !equal(
          withoutEnablement(transition.intermediate),
          withoutEnablement(transition.previous),
        ) &&
        !equal(withoutEnablement(transition.intermediate), withoutEnablement(transition.next)))
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

async function refuseLiveRecoveryOwner(
  receipt: z.infer<typeof receiptSchema> | null,
): Promise<void> {
  if (!receipt?.ownerPID) return;
  if (receipt.boot && receipt.boot !== (await hostBootIdentity())) return;
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

/** Read the existing custody receipt without contacting or changing the runtime. */
export async function readRuntimeSettlement(records: LocalRecords) {
  return records.state.read("runtime-owner.json", receiptSchema.parse);
}

async function settleCapturedRuntimeOwner(
  records: LocalRecords,
  policy: LocalPolicy,
  receipt: z.infer<typeof receiptSchema> | null,
  settle: typeof settlePrivateRuntime,
): Promise<void> {
  if (receipt && receipt.profile !== profile(policy))
    throw new LocalRefusal(
      "LOCAL_RUNTIME_CHANGED",
      "The previous owner belongs to another locally selected runtime profile.",
    );
  await refuseLiveRecoveryOwner(receipt);
  await settle(policy);
  if (
    JSON.stringify(await records.policy()) !== JSON.stringify(policy) ||
    JSON.stringify(await readRuntimeSettlement(records)) !== JSON.stringify(receipt)
  )
    throw new LocalRefusal(
      "LOCAL_RUNTIME_CHANGED",
      "The local policy or owner receipt changed during physical settlement.",
    );
  await refuseLiveRecoveryOwner(receipt);
  await records.state.write("runtime-owner.json", {
    owner: randomUUID(),
    profile: profile(policy),
    settled: true,
  });
}

/** Caller holds the runner gate and explicit shutdown authority; no credentials are accessed. */
export async function settleRuntimeOwner(
  records: LocalRecords,
  settle: typeof settlePrivateRuntime = settlePrivateRuntime,
): Promise<void> {
  const policy = await records.policy();
  const receipt = await readRuntimeSettlement(records);
  await settleCapturedRuntimeOwner(records, policy, receipt, settle);
}

/** The caller holds the runner gate; only a fresh explicit recovery can close an unknown stop. */
export async function requireRecoveredRuntimeSettlement(
  records: LocalRecords,
  before: { owner: string; profile: string } | null,
): Promise<void> {
  const policy = await records.policy();
  if (policy.enabled)
    throw new LocalRefusal(
      "LOCAL_DISABLED_REQUIRED",
      "Disable work before acknowledging recovered maintenance.",
    );
  const current = await readRuntimeSettlement(records);
  const selectedProfile = profile(policy);
  if (
    !current?.settled ||
    current.profile !== selectedProfile ||
    (before !== null && (before.profile !== selectedProfile || before.owner === current.owner))
  )
    throw new LocalRefusal(
      "LOCAL_STOP_PENDING",
      "A new explicit recovery receipt for this exact runtime profile is required.",
    );
  await refuseLiveRecoveryOwner(current);
}

/** Under the runner gate, a former guard must be absent before a new owner can start. */
export async function requireRuntimeOwnerAbsent(
  records: LocalRecords,
  expectedPolicy?: LocalPolicy,
): Promise<void> {
  const receipt = await records.state.read("runtime-owner.json", (value) => {
    const parsed = receiptSchema.safeParse(value);
    if (!parsed.success)
      throw new LocalRefusal("LOCAL_STATE_UNSAFE", "The retained runtime owner is invalid.");
    return parsed.data;
  });
  if (expectedPolicy && (!receipt || receipt.profile !== profile(expectedPolicy)))
    throw new LocalRefusal(
      "LOCAL_RUNTIME_CHANGED",
      "The former runtime owner does not identify this exact profile.",
    );
  if (receipt && !receipt.settled && !receipt.ownerPID)
    throw new LocalRefusal(
      "LOCAL_OWNER_ACTIVE",
      "The previous runtime owner has no verifiable process identity.",
    );
  await refuseLiveRecoveryOwner(receipt);
}

async function recoveryAdmission(records: LocalRecords) {
  const policy = await records.policy();
  if (policy.enabled)
    throw new LocalRefusal(
      "LOCAL_DISABLED_REQUIRED",
      "Disable work before acknowledging an orphan device owner.",
    );
  const receipt = await records.state.read("runtime-owner.json", receiptSchema.parse);
  return { policy, receipt };
}

/** Explicit local acknowledgement only; no cloud request can reset an orphan owner receipt. */
export async function recoverLocalDevice(records: LocalRecords, confirmed: boolean): Promise<void> {
  if (!confirmed)
    throw new LocalRefusal(
      "LOCAL_RECOVERY_CONFIRM",
      "Pass --confirm to acknowledge this device owner's unknown shutdown locally.",
    );
  const release = await records.state.lock({ recoverStale: true });
  try {
    if (await upgradeLocalPolicyState(records, { recoverLegacy: true })) return;
    const { policy, receipt } = await recoveryAdmission(records);
    await settleCapturedRuntimeOwner(records, policy, receipt, settlePrivateRuntime);
  } finally {
    await release();
  }
}

/** Disable first; an active owner must settle its tracked calls before physical shutdown is acknowledged. */
export async function stopLocalDevice(records: LocalRecords): Promise<void> {
  const raw = await records.state.read("policy.json", (value) => value);
  if (legacyLocalPolicySchema.safeParse(raw).success) return recoverLocalDevice(records, true);
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
    // An exited observer cannot publish a later stop. Explicit disable may
    // take over only through the existing gated, exact physical recovery.
    if (receipt.released) return recoverLocalDevice(records, true);
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
  try {
    await control.captureForShutdown();
    await control.stop();
  } finally {
    await control.release();
  }
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
  if (receipt && !receipt.settled) {
    // A released observer will never publish a physical stop. The explicit
    // credential-recovery caller already holds the runner gate; require that
    // former owner to be absent before the fresh kernel settlement below.
    if (receipt.released) await requireRuntimeOwnerAbsent(records);
    else await stopLocalDevice(records);
  }
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
  /** Exact admitted generation only while the fixed setup operation is pending. */
  readonly setupGeneration?: number;
  prepare(): Promise<void>;
  setupOutcome?(requestId: string, diagnostic: LocalSetupDiagnostic): Promise<void>;
  refreshRemote?(): Promise<void>;
  validate(): Promise<void>;
  stop(): Promise<void>;
}
export interface DeviceGuard {
  readonly active: boolean;
  release?(): Promise<void>;
  space(id: string, activate?: boolean | "resume-setup"): Promise<SpaceGuard>;
  observe(spaceId?: string): Promise<LocalVmObservation[]>;
  retire(id: string, generation: number): Promise<void>;
  remove(id: string, generation: number, localApproval: boolean): Promise<void>;
  recover?(id: string, generation: number): Promise<number>;
  stop(): Promise<void>;
}
export type StartGuard = (
  root: string,
  mode?: "work" | "cleanup",
  signal?: AbortSignal,
) => Promise<DeviceGuard>;
const scope = { id: z.number().int().positive(), spaceId: z.string().uuid() };
const admittedScope = { ...scope, generation: z.number().int().positive() };
const callSchema = z.discriminatedUnion("action", [
  z
    .object({
      id: z.number().int().positive(),
      action: z.literal("observe"),
      spaceId: z.string().uuid().optional(),
    })
    .strict(),
  z.object({ ...scope, action: z.literal("admit") }).strict(),
  z.object({ ...scope, action: z.literal("start-space") }).strict(),
  z.object({ ...scope, action: z.literal("resume-setup") }).strict(),
  z.object({ ...admittedScope, action: z.literal("prepare") }).strict(),
  z
    .object({
      ...admittedScope,
      action: z.literal("setup-outcome"),
      requestId: z.string().regex(/^ws1-[a-f0-9-]{36}$/),
      diagnostic: localSetupDiagnosticSchema,
    })
    .strict(),
  z.object({ ...admittedScope, action: z.literal("refresh-remote") }).strict(),
  z.object({ ...admittedScope, action: z.literal("validate") }).strict(),
  z.object({ ...admittedScope, action: z.literal("stop-space") }).strict(),
  z.object({ ...admittedScope, action: z.literal("retire-space") }).strict(),
  z.object({ ...admittedScope, action: z.literal("recover-space") }).strict(),
  z
    .object({ ...admittedScope, action: z.literal("remove-space"), localApproval: z.boolean() })
    .strict(),
]);

/** One independent process owns all spaces of this private device, not a cloud RPC surface. */
export const startGuard: StartGuard = (root, mode = "work", signal) =>
  new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(new URL("./guard.js", import.meta.url)),
      mode === "cleanup" ? [root, "cleanup"] : [root],
      {
        execArgv: [],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "advanced",
      },
    );
    const cancelStartup = () => {
      if (child.connected) child.send("release");
    };
    signal?.addEventListener("abort", cancelStartup, { once: true });
    if (signal?.aborted) cancelStartup();
    let ready = false,
      closed = false,
      sequence = 0;
    let exitCode: number | null = null;
    let startupError: LocalRefusal | undefined;
    let shutdown: Promise<void> | undefined;
    let releaseSelected = false;
    let physicalSettled = false;
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
    const fail = () => {
      for (const call of pending.values()) call.reject(startupError ?? unavailable());
      pending.clear();
    };
    child.once("error", () => {
      fail();
      reject(unavailable());
    });
    child.once("exit", (code) => {
      signal?.removeEventListener("abort", cancelStartup);
      closed = true;
      exitCode = code;
      fail();
      if (!ready) reject(startupError ?? unavailable());
    });
    const request = (
      spaceId: string | undefined,
      action:
        | "admit"
        | "start-space"
        | "resume-setup"
        | "prepare"
        | "setup-outcome"
        | "refresh-remote"
        | "validate"
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
            ? { id, action, ...(spaceId ? { spaceId } : {}) }
            : action === "remove-space"
              ? { id, action, spaceId, generation, localApproval: value }
              : action === "setup-outcome"
                ? {
                    id,
                    action,
                    spaceId,
                    generation,
                    ...(value as { requestId: string; diagnostic: LocalSetupDiagnostic }),
                  }
                : action === "admit" || action === "start-space" || action === "resume-setup"
                  ? { id, action, spaceId }
                  : { id, action, spaceId, generation };
        child.send(message, (error) => {
          if (error) {
            pending.delete(id);
            failed(unavailable());
          }
        });
      });
    const stop = (release = false): Promise<void> => {
      if (!release && releaseSelected)
        return Promise.reject(
          new LocalRefusal(
            "LOCAL_STOP_PENDING",
            "Released observations do not prove physical shutdown.",
          ),
        );
      if (release && !shutdown) releaseSelected = true;
      shutdown ??= new Promise<void>((done, failed) => {
        if (closed) {
          if (exitCode === 0 && (release || physicalSettled)) done();
          else
            failed(
              new LocalRefusal("LOCAL_STOP_PENDING", "Device shutdown could not be confirmed."),
            );
          return;
        }
        const deadline = setTimeout(
          () => failed(new LocalRefusal("LOCAL_STOP_PENDING", "Device shutdown is still pending.")),
          40_000,
        );
        child.once("exit", (code) => {
          clearTimeout(deadline);
          if (code === 0 && (release || physicalSettled)) done();
          else
            failed(
              new LocalRefusal("LOCAL_STOP_PENDING", "Device shutdown could not be confirmed."),
            );
        });
        if (child.connected) child.send(release ? "release" : "stop");
      });
      return shutdown;
    };
    child.on("message", (value: unknown) => {
      if (
        typeof value === "object" &&
        value !== null &&
        "settled" in value &&
        value.settled === true
      ) {
        physicalSettled = true;
        if (!("id" in value)) return;
      }
      if (
        typeof value === "object" &&
        value !== null &&
        "released" in value &&
        value.released === true
      ) {
        releaseSelected = true;
        if (!("id" in value)) return;
      }
      {
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
          if (ready) fail();
          return;
        }
      }
      if (value === "ready" && !ready) {
        signal?.removeEventListener("abort", cancelStartup);
        ready = true;
        resolve({
          get active() {
            return !closed && !shutdown && child.connected;
          },
          stop,
          release: () => stop(true),
          observe: async (spaceId) => (await request(spaceId, "observe")) as LocalVmObservation[],
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
              .parse(
                await request(
                  spaceId,
                  activate === "resume-setup" ? "resume-setup" : activate ? "start-space" : "admit",
                ),
              );
            const scope = { active: true };
            const existing = scopes.get(spaceId) ?? new Set();
            existing.add(scope);
            scopes.set(spaceId, existing);
            let stopped = false;
            let preparing = 0;
            return {
              get active() {
                return scope.active && !stopped && !closed && !shutdown && child.connected;
              },
              get setupGeneration() {
                return preparing > 0 &&
                  scope.active &&
                  !stopped &&
                  !closed &&
                  !shutdown &&
                  child.connected
                  ? generation
                  : undefined;
              },
              prepare: async () => {
                if (stopped) throw unavailable();
                preparing++;
                try {
                  await request(spaceId, "prepare", undefined, generation);
                } finally {
                  preparing--;
                }
              },
              setupOutcome: async (requestId, diagnostic) => {
                await request(spaceId, "setup-outcome", { requestId, diagnostic }, generation);
              },
              validate: async () => {
                await request(spaceId, "validate", undefined, generation);
              },
              refreshRemote: async () => {
                await request(spaceId, "refresh-remote", undefined, generation);
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
        management?: LocalManagementOutcome;
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
            response.management
              ? localManagementOutcomeSchema.parse(response.management)
              : undefined,
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
            localResult: z.object({ sandboxes: z.number().int().safe().nonnegative() }).strict(),
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

async function runGuard(
  root: string,
  action: "work" | "doctor" | "setup" | "cleanup" = "work",
): Promise<void> {
  let earlyControl: "stop" | "release" | undefined;
  const retainEarlyControl = (value: unknown) => {
    if (value === "stop" || value === "release") earlyControl ??= value;
  };
  process.on("message", retainEarlyControl);
  const records = new LocalRecords(await PrivateState.open(root));
  const initial = await records.policy();
  const control = new RuntimeDeviceOwner(
    records,
    initial,
    action === "setup" ? "setup" : action === "cleanup" ? "cleanup" : "work",
  );
  const receipt = {
    owner: randomUUID(),
    ownerPID: process.pid,
    boot: await hostBootIdentity(),
    profile: profile(initial),
    settled: false,
  };
  await records.state.write("runtime-owner.json", receipt);
  const owners = new Map<string, RuntimeOwner>();
  let stopping: Promise<void> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let releasing = false;
  let settled = false;
  const admissionTails = new Map<string, Promise<unknown>>();
  const shutdown = (): Promise<void> => {
    if (poll) clearTimeout(poll);
    stopping ??= (async () => {
      control.revoke();
      if (releasing) {
        await Promise.all([...owners.values()].map((owner) => owner.release()));
        await control.release();
        await records.state.write("runtime-owner.json", { ...receipt, released: true });
        // Released observations are not evidence that their physical peers stopped.
        return;
      }
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
      settled = true;
    })();
    return stopping;
  };
  const emergency = (error?: unknown) => {
    if (error instanceof LocalRefusal && process.connected)
      sendGuardMessage({ localError: { code: error.code, message: error.message } });
    void shutdown().then(
      () => {
        if (process.connected)
          sendGuardMessage(releasing ? { released: true } : { settled: true }, () =>
            process.exit(0),
          );
        else process.exit(0);
      },
      () => process.exit(1),
    );
  };
  const release = (error?: unknown) => {
    if (!stopping) releasing = true;
    emergency(error);
  };
  process.once("disconnect", release);
  process.once("SIGTERM", release);
  process.once("SIGINT", release);
  const reply = (id: number, result: unknown, error?: unknown, exit = false) => {
    if (!process.connected) return;
    sendGuardMessage(
      error
        ? {
            id,
            ok: false,
            ...(exit && releasing ? { released: true } : {}),
            code: error instanceof LocalRefusal ? error.code : "LOCAL_GUARD_REFUSED",
            message:
              error instanceof LocalRefusal
                ? error.message
                : "The locally owned operation was refused.",
            ...(error instanceof LocalRefusal && error.management
              ? { management: error.management }
              : {}),
          }
        : {
            id,
            ok: true,
            result,
            ...(exit && releasing ? { released: true } : {}),
            ...(exit && settled ? { settled: true } : {}),
          },
      () => {
        if (exit) process.exit(0);
      },
    );
  };
  // Only loss of shared device custody/authority retires independent spaces together.
  // SDK identity and repository admission failures belong to their addressed owner.
  const deviceFailure = (error: unknown, sharedObservation = false): boolean =>
    error instanceof LocalRefusal &&
    (/^(LOCAL_KEYCHAIN_|LOCAL_CONTROL_|LOCAL_DAEMON_|LOCAL_STATE_|LOCAL_(?:RUNTIME_(?:UNSAFE|CHANGED|VERSION|UNAVAILABLE)|BINARY_UNSAFE|DOCKER_LOGIN_REQUIRED)$)/.test(
      error.code,
    ) ||
      (sharedObservation &&
        /^LOCAL_(?:SANDBOX_UNSAFE|NETWORK_(?:UNSAFE|CHANGED))$/.test(error.code)));
  process.on("message", (value: unknown) => {
    if (value === "release") {
      release();
      return;
    }
    if (value === "stop") {
      emergency();
      return;
    }
    if (stopping || !process.connected) return;
    const parsed = callSchema.safeParse(value);
    if (!parsed.success) {
      if (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        Number.isSafeInteger(value.id)
      )
        reply(
          value.id as number,
          null,
          new LocalRefusal("LOCAL_REQUEST_INVALID", "Lifecycle IPC input was refused."),
        );
      return;
    }
    const call = parsed.data;
    void (async () => {
      if (
        action === "cleanup" &&
        !(
          (call.action === "observe" && call.spaceId) ||
          (call.action === "remove-space" && call.localApproval)
        )
      )
        throw new LocalRefusal(
          "LOCAL_UNAUTHORIZED",
          "The cleanup owner admits only exact observation and confirmed removal.",
        );
      if (call.action === "observe") return control.observe(call.spaceId);
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
            (closure) => control.protect(call.spaceId, closure),
            () => control.prepareCredentials(),
            undefined,
            (space, request) => control.readRuntime(space, request),
          );
          owners.set(call.spaceId, owner);
        }
        if (call.action === "recover-space") {
          const generation = await owner.recover(call.generation);
          sendGuardMessage({ retired: call.spaceId });
          return generation;
        }
        await owner.manage(
          call.generation,
          call.action === "remove-space",
          call.action === "remove-space" && call.localApproval,
        );
        sendGuardMessage({ retired: call.spaceId });
        return;
      }
      if (
        call.action === "admit" ||
        call.action === "start-space" ||
        call.action === "resume-setup"
      ) {
        const admitted = (admissionTails.get(call.spaceId) ?? Promise.resolve())
          .catch(() => undefined)
          .then(async () => {
            if (stopping)
              throw new LocalRefusal("LOCAL_NOT_RUNNING", "The device owner is stopping.");
            let owner = owners.get(call.spaceId);
            if (call.action === "resume-setup") {
              const space = await records.get(call.spaceId);
              if (!space)
                throw new LocalRefusal("LOCAL_SANDBOX_ABSENT", "The setup target is absent.");
              requireSetupRecovery(space);
              if (owner?.preparing)
                throw new LocalRefusal(
                  "LOCAL_STOP_PENDING",
                  "Collect the original pending setup before recovery.",
                );
              if (owner?.active) {
                await owner.release();
                owners.delete(call.spaceId);
                owner = undefined;
              }
            }
            if (!owner?.active) {
              await owner?.stop();
              if (stopping)
                throw new LocalRefusal("LOCAL_NOT_RUNNING", "The device admission was revoked.");
              owner = new RuntimeOwner(
                records,
                call.spaceId,
                (closure) => control.protect(call.spaceId, closure),
                () => control.prepareCredentials(),
                undefined,
                (space, request) => control.readRuntime(space, request),
              );
              owners.set(call.spaceId, owner);
              try {
                await owner.admit(
                  call.action === "resume-setup" ? "resume-setup" : call.action === "start-space",
                );
              } catch (error) {
                // Failed initialization has no guest work to retire. Do not cache its rejected
                // admission forever, nor mutate its generation just to discard that promise.
                if (owners.get(call.spaceId) === owner) owners.delete(call.spaceId);
                throw error;
              }
            }
            await owner.admit();
            if (stopping)
              throw new LocalRefusal("LOCAL_NOT_RUNNING", "The device admission was revoked.");
            return owner.generation;
          });
        admissionTails.set(call.spaceId, admitted);
        void admitted
          .finally(() => {
            if (admissionTails.get(call.spaceId) === admitted) admissionTails.delete(call.spaceId);
          })
          .catch(() => undefined);
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
      if (call.action === "setup-outcome") {
        // Bootstrap can be waiting on the broker that reports this outcome. Never
        // enter prepareSpace or the owner's serial/native lane for this message.
        owner.setupOutcome(call.requestId, call.diagnostic);
        return;
      }
      if (call.action === "prepare") {
        try {
          return await control.prepareSpace(call.spaceId, call.generation, () => owner.prepare());
        } catch (error) {
          if (
            call.action === "prepare" &&
            error instanceof LocalRefusal &&
            error.code === "LOCAL_GUEST_SETTLEMENT_UNKNOWN"
          )
            sendGuardMessage({ retired: call.spaceId });
          throw error;
        }
      }
      if (call.action === "validate") return owner.validate();
      if (call.action === "refresh-remote") return owner.refreshRemote();
      try {
        await owner.stop();
      } catch (error) {
        if (deviceFailure(error)) {
          if (!stopping) releasing = true;
          await shutdown();
        }
        throw error;
      }
      sendGuardMessage({ retired: call.spaceId });
    })().then(
      (result) => {
        void (async () => {
          if (stopping) await stopping;
          reply(call.id, result, undefined, Boolean(stopping));
        })().catch((error) => reply(call.id, undefined, error));
      },
      (error) => {
        if (deviceFailure(error, call.action === "observe")) {
          if (!stopping) releasing = true;
          void shutdown().then(
            () => reply(call.id, undefined, error, true),
            (failure) => reply(call.id, undefined, failure),
          );
        } else reply(call.id, undefined, error);
      },
    );
  });
  process.removeListener("message", retainEarlyControl);
  if (earlyControl) {
    if (earlyControl === "release") release();
    else emergency();
    await stopping;
    return;
  }
  const workAuthority = action === "work" || action === "doctor";
  const check = async () => {
    try {
      if (stopping) return;
      const policy = await records.policy();
      if (stopping) return;
      if (workAuthority && !policy.enabled) {
        const error = new LocalRefusal("LOCAL_NOT_RUNNING", "Local work is disabled.");
        if (action === "doctor") release(error);
        else emergency(error);
        return;
      }
      if (
        JSON.stringify(physicalRuntimeProfile(policy)) !==
        JSON.stringify(physicalRuntimeProfile(initial))
      ) {
        emergency();
        return;
      }
      if (!process.connected) {
        release();
        return;
      }
      for (const owner of action === "work" ? owners.values() : [])
        if (owner.active) {
          try {
            await owner.check();
          } catch (error) {
            if (owners.get(owner.id) !== owner) continue;
            if (deviceFailure(error)) {
              release(error);
              return;
            }
            // Repository permission is an access boundary, not a VM stop request.
            // Keep exact native custody so later explicit management can settle it.
            if (error instanceof LocalRefusal && error.code === "LOCAL_REPOSITORY_DENIED") continue;
            // Rejected admission has no guest effects. Metadata refusal must not become
            // a native stop intent merely because the checker observed its promise.
            if (
              !owner.admitted ||
              (error instanceof LocalRefusal && error.code === "LOCAL_OBSERVATION_UNKNOWN")
            ) {
              owners.delete(owner.id);
              continue;
            }
            try {
              await owner.stop();
            } catch (failure) {
              if (deviceFailure(failure)) {
                release(failure);
                return;
              }
              // Own physical settlement remains unknown; custody is retained independently.
              // A later addressed management request can retry this exact stopped owner.
            }
            sendGuardMessage({ retired: owner.id });
          }
        }
      if (!stopping)
        poll = setTimeout(() => {
          void check();
        }, 1000);
    } catch (error) {
      release(error);
    }
  };
  // The same authority checker owns foreground startup and subsequent space work.
  await check();
  if (stopping) {
    await shutdown();
    return;
  }
  try {
    if (!process.connected)
      throw new LocalRefusal("LOCAL_GUARD_UNAVAILABLE", "The local parent disconnected.");
    await control.open();
    if (stopping || !process.connected) {
      await shutdown();
      return;
    }
  } catch (error) {
    if (!stopping) releasing = true;
    await shutdown().catch(() => undefined);
    throw error;
  }
  if (action === "doctor" || action === "setup") {
    const deadline = action === "doctor" ? setTimeout(release, 300_000) : undefined;
    try {
      if (action === "setup") await control.runtime.initialize();
      const sandboxes = action === "doctor" ? (await control.observe()).length : 0;
      if (action === "doctor") releasing = true;
      await shutdown();
      sendGuardMessage({ localResult: { sandboxes } }, () => process.exit(0));
    } catch (error) {
      if (!stopping) releasing = true;
      throw error;
    } finally {
      clearTimeout(deadline);
      await shutdown();
    }
    return;
  }
  // Recovered records retain the same identities; unknown creation is never adopted.
  for (const space of await records.list()) {
    if (action === "cleanup" || stopping) break;
    if (space.desiredState !== "running" || !space.runtimeId) continue;
    const owner = new RuntimeOwner(
      records,
      space.id,
      (closure) => control.protect(space.id, closure),
      () => control.prepareCredentials(),
      undefined,
      (current, request) => control.readRuntime(current, request),
    );
    owners.set(space.id, owner);
    void owner.admit().catch((error: unknown) => {
      if (owners.get(space.id) === owner) owners.delete(space.id);
      if (deviceFailure(error)) release(error);
    });
  }
  if (!stopping && process.connected) sendGuardMessage("ready");
}
if (
  process.argv[1] &&
  new URL(import.meta.url).pathname.endsWith("/guard.js") &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const action = process.argv[3];
  if (action !== undefined && action !== "doctor" && action !== "setup" && action !== "cleanup")
    process.exit(1);
  void runGuard(process.argv[2], action).catch((error) => {
    if (process.connected)
      sendGuardMessage(
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
