import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  LocalRecords,
  policyForSpace,
  requireSetupRecovery,
  type LocalSpace,
} from "./space-record.js";
import {
  LocalRefusal,
  requireLocalGrant,
  requireRef,
  publicPolicy,
  localPolicySchema,
  physicalRuntimeProfile,
  type LocalPolicy,
} from "./policy.js";
import type { LocalVmRuntime, LocalVmIdentity, LocalVmRuntimeFactory } from "./local-vm-runtime.js";
import { createLocalVmRuntime } from "./local-vm-runtime-factory.js";
import { admitStorage, ensureStorageMounted } from "./storage.js";
import {
  startGuard,
  requireRuntimeOwnerAbsent,
  upgradeLocalPolicyState,
  type SpaceGuard,
  type StartGuard,
  type DeviceGuard,
} from "./guard.js";
import { startBroker } from "./broker.js";
import { startBrokerTunnel } from "./broker-tunnel.js";
import { gitBroker } from "./git-broker.js";
import { LocalRelay } from "./relay.js";
import { NetworkBudget } from "./network-budget.js";
import { guestAssets } from "./assets.js";
import { requireNativeAdmission } from "./service-failure.js";

export interface ManagerDependencies {
  signal?: AbortSignal;
  brokerPorts?: { http: number; tunnel: number };
  runtime?: LocalVmRuntimeFactory;
  storage?: typeof admitStorage;
  guard?: StartGuard;
  now?: () => number;
  onFault?: (error: unknown) => void;
}
const brokerState = z.object({ port: z.number().int().min(1024).max(65535) }).strict();

export class LocalManager {
  private readonly guards = new Map<string, SpaceGuard>();
  private device?: DeviceGuard;
  private cleanupOnlyOwner = false;
  private broker?: Awaited<ReturnType<typeof startBroker>>;
  private tunnel?: Awaited<ReturnType<typeof startBrokerTunnel>>;
  private releaseLock?: () => Promise<void>;
  private readonly lanes = new Map<string, Promise<unknown>>();
  private openingOwner?: Promise<DeviceGuard>;
  readonly now: () => number;
  constructor(
    readonly records: LocalRecords,
    readonly dependencies: ManagerDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
  }
  runtime(policy: LocalPolicy): LocalVmRuntime {
    return this.dependencies.runtime?.(policy) ?? createLocalVmRuntime(policy);
  }
  identity(space: LocalSpace): LocalVmIdentity {
    if (!space.runtimeId)
      throw new LocalRefusal(
        "LOCAL_CREATE_UNKNOWN",
        "This local sandbox has no confirmed runtime identity.",
      );
    return { name: space.name, runtimeId: space.runtimeId };
  }
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const result = (this.lanes.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.lanes.set(key, result);
    try {
      return await result;
    } finally {
      if (this.lanes.get(key) === result) this.lanes.delete(key);
    }
  }

  private async owner(cleanupOnly = false): Promise<DeviceGuard> {
    if (!cleanupOnly) await requireNativeAdmission(this.records.state);
    const policy = await this.records.policy();
    const managementOnly = cleanupOnly && !policy.enabled;
    if (!this.device?.active || this.cleanupOnlyOwner !== managementOnly) {
      this.openingOwner ??= (async () => {
        await this.holdRunnerLock();
        if (this.device && !this.device.active) {
          // Losing a guard is not a physical stop. Under the retained runner
          // gate, only proven absence for this profile permits a new observer.
          await this.requireInactiveOwnerAbsent();
        } else await this.device?.stop();
        this.device = await (this.dependencies.guard ?? startGuard)(
          this.records.state.root,
          managementOnly ? "cleanup" : "work",
          this.dependencies.signal,
        );
        this.cleanupOnlyOwner = managementOnly;
        return this.device;
      })().finally(() => {
        this.openingOwner = undefined;
      });
      return this.openingOwner;
    }
    return this.device;
  }

  private async requireInactiveOwnerAbsent(): Promise<void> {
    await this.holdRunnerLock();
    await requireRuntimeOwnerAbsent(this.records, await this.records.policy());
  }

  async holdRunnerLock(): Promise<void> {
    await this.serial("runner-lock", async () => {
      if (this.releaseLock) return;
      const release = await this.records.state.lock({ recoverStale: true });
      try {
        await requireRuntimeOwnerAbsent(this.records);
        await upgradeLocalPolicyState(this.records);
        await this.records.withSettingsChange(async () => {
          const policy = await this.records.policyOrNull();
          if (!policy) return;
          await requireRuntimeOwnerAbsent(this.records);
          // No independent guard can write space records at this admission
          // boundary. Unknown outcomes are retained rather than reinterpreted.
          for (const space of await this.records.list()) {
            if (
              !space.runtimeId ||
              space.failure !== null ||
              (space.phase !== "usable" && space.phase !== "stopped")
            )
              continue;
            const repository = policy.repositories.find((row) => row.id === space.repositoryId);
            if (space.admittedMachine && (space.admittedRepositoryFullName || !repository))
              continue;
            space.admittedMachine ??= {
              cpuCores: policy.runtime.cpuCores,
              memoryBytes: policy.runtime.memoryBytes,
              dockerBytes: policy.runtime.dockerBytes,
            };
            space.admittedRepositoryFullName ??= repository?.fullName;
            await this.records.put(space);
          }
        });
        await new LocalRelay(this.records).markOrphanedGitCredentials();
        this.releaseLock = release;
      } catch (error) {
        await release();
        throw error;
      }
    });
  }
  async open(): Promise<void> {
    return this.serial("open", async () => {
      await requireNativeAdmission(this.records.state);
      // An existing controller owns this exclusion independently of native startup.
      const retainGateOnFailure = Boolean(this.releaseLock);
      await this.holdRunnerLock();
      if (this.broker && this.tunnel) return;
      try {
        const policy = await this.records.policy();
        if (this.dependencies.storage) await this.dependencies.storage(policy);
        else await ensureStorageMounted(this.records.state, policy);
        await this.owner();
        if (this.dependencies.runtime) await this.runtime(policy).boundary.verifyConfiguration();
        const onFault = this.dependencies.onFault ?? (() => undefined);
        const budget = new NetworkBudget();
        const relay = new LocalRelay(this.records);
        const github = gitBroker(budget, onFault, (grant, action, signal) => {
          if (!grant.spaceId)
            throw new LocalRefusal(
              "LOCAL_IDENTITY_CHANGED",
              "Git requires its original locally owned sandbox.",
            );
          return relay.acquireGitCredential(grant.spaceId, grant.repository.id, action, signal);
        });
        this.broker = await startBroker(
          {
            authorize: (credential) =>
              this.records.authorize(
                credential,
                (space) => this.guards.get(space.id)?.setupGeneration === space.generation,
              ),
            budget,
            ...github,
            onFault,
          },
          this.dependencies.brokerPorts?.http,
        );
        const saved = await this.records.state.read("broker.json", brokerState.parse);
        this.tunnel = await startBrokerTunnel(
          this.broker.port,
          saved?.port ?? this.dependencies.brokerPorts?.tunnel,
        );
        await this.records.state.write("broker.json", { port: this.tunnel.port });
      } catch (error) {
        try {
          await this.release(retainGateOnFailure);
        } catch (cleanup) {
          throw new AggregateError([error, cleanup], "Local startup and cleanup failed", {
            cause: error,
          });
        }
        throw error;
      }
    });
  }

  async stopWork(): Promise<void> {
    await this.closeResources(true);
  }
  /** Restore only saved, known VM intent after the owner and its egress are ready. */
  async restoreIntendedWork(): Promise<{
    restored: string[];
    unavailable: { spaceId: string; code: string }[];
  }> {
    const device = await this.owner();
    const rows = await device.observe();
    const result = {
      restored: [] as string[],
      unavailable: [] as { spaceId: string; code: string }[],
    };
    for (const space of await this.records.list()) {
      if (space.desiredState !== "running") continue;
      if (
        !space.runtimeId ||
        space.failure !== null ||
        (space.phase !== "usable" && space.phase !== "stopped") ||
        space.lastStartedAt === null
      ) {
        result.unavailable.push({
          spaceId: space.id,
          code:
            space.failure ?? (!space.runtimeId ? "LOCAL_CREATE_UNKNOWN" : "LOCAL_SETUP_INCOMPLETE"),
        });
        continue;
      }
      const row = rows.find((item) => item.id === space.runtimeId && item.name === space.name);
      // Unknown/missing physical identities remain observations, never a create/adopt request.
      if (row?.status === "running") {
        result.restored.push(space.id);
        continue;
      }
      if (!row || row.status !== "stopped") {
        result.unavailable.push({ spaceId: space.id, code: "LOCAL_OBSERVATION_UNKNOWN" });
        continue;
      }
      try {
        const guard = await device.space(space.id);
        this.guards.set(space.id, guard);
        await guard.prepare();
        result.restored.push(space.id);
      } catch (error) {
        if (!(error instanceof LocalRefusal) || !device.active) throw error;
        result.unavailable.push({ spaceId: space.id, code: error.code });
      }
    }
    return result;
  }
  /** Publish ordinary settings under the existing runner gate without stopping admitted VMs. */
  async applyLivePolicy(previous: LocalPolicy, next: LocalPolicy): Promise<void> {
    await this.serial("policy", async () => {
      await this.holdRunnerLock();
      next = localPolicySchema.parse(next);
      if (
        previous.enabled !== next.enabled ||
        JSON.stringify(physicalRuntimeProfile(previous)) !==
          JSON.stringify(physicalRuntimeProfile(next))
      )
        throw new LocalRefusal(
          "LOCAL_CONTROL_CONFLICT",
          "Physical runtime or enablement changes require explicit stopped control.",
        );
      const current = JSON.stringify(await this.records.policy());
      if (current !== JSON.stringify(previous) && current !== JSON.stringify(next))
        throw new LocalRefusal(
          "LOCAL_CONTROL_CONFLICT",
          "Local policy changed before repository admission.",
        );
      if (current !== JSON.stringify(next)) {
        const machineChanged = (["cpuCores", "memoryBytes", "dockerBytes"] as const).some(
          (key) => previous.runtime[key] !== next.runtime[key],
        );
        if (
          machineChanged &&
          (await this.records.list()).some(
            (space) => space.phase !== "deleted" && !space.admittedMachine,
          )
        )
          throw new LocalRefusal(
            "LOCAL_OBSERVATION_UNKNOWN",
            "Retained sandbox admission must be established before changing machine defaults.",
          );
        await this.records.state.write("policy.json", next);
      }
    });
  }
  /** The daemon's existing observation cycle retries only ready, known local owners. */
  async refreshWorkspaceEnrollments(): Promise<{ spaceId: string; code: string }[]> {
    const policy = await this.records.policyOrNull();
    if (!policy?.enabled || !this.broker || !this.tunnel) return [];
    const unavailable: { spaceId: string; code: string }[] = [];
    for (const saved of await this.records.list()) {
      if (
        saved.desiredState !== "running" ||
        saved.phase !== "usable" ||
        saved.failure !== null ||
        !saved.runtimeId
      )
        continue;
      const guard = await this.serial(`space:${saved.id}`, async () => {
        try {
          const current = await this.require(saved.id);
          if (current.generation !== saved.generation || current.desiredState !== "running") return;
          let guard = this.guards.get(saved.id);
          if (!guard?.active) {
            guard = await (await this.owner()).space(saved.id);
            this.guards.set(saved.id, guard);
          }
          return guard;
        } catch (error) {
          unavailable.push({
            spaceId: saved.id,
            code: error instanceof LocalRefusal ? error.code : "LOCAL_OBSERVATION_UNKNOWN",
          });
        }
      });
      // Optional cloud acquisition must not retain local lifecycle admission.
      try {
        await guard?.refreshRemote?.();
      } catch (error) {
        unavailable.push({
          spaceId: saved.id,
          code: error instanceof LocalRefusal ? error.code : "LOCAL_OBSERVATION_UNKNOWN",
        });
      }
    }
    return unavailable;
  }
  async close(keepLock = false): Promise<void> {
    await this.closeResources(keepLock);
  }
  /** The host service relinquishes observations; no VM stop intent is manufactured. */
  async release(keepLock = false): Promise<void> {
    await this.openingOwner?.catch(() => undefined);
    if (this.device) {
      if (!this.device.active) await this.requireInactiveOwnerAbsent();
      else if (!this.device.release)
        throw new LocalRefusal(
          "LOCAL_GUARD_UNAVAILABLE",
          "Native observation release is unavailable.",
        );
      else await this.device.release();
      this.device = undefined;
    }
    this.guards.clear();
    await this.tunnel?.close();
    this.tunnel = undefined;
    await this.broker?.close();
    this.broker = undefined;
    if (!keepLock) {
      await this.releaseLock?.();
      this.releaseLock = undefined;
    }
  }
  private async closeResources(keepLock: boolean): Promise<void> {
    const errors: unknown[] = [];
    for (const [id, guard] of this.guards) {
      try {
        await guard.stop();
        this.guards.delete(id);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.device?.stop();
      this.device = undefined;
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.tunnel?.close();
      this.tunnel = undefined;
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.broker?.close();
      this.broker = undefined;
    } catch (error) {
      errors.push(error);
    }
    try {
      if (!keepLock && errors.length === 0) {
        await this.releaseLock?.();
        this.releaseLock = undefined;
      }
    } catch (error) {
      errors.push(error);
    }
    if (errors.length)
      throw new AggregateError(errors, "Some local sandboxes could not be confirmed stopped");
  }

  async require(id: string): Promise<LocalSpace> {
    const space = await this.records.get(id);
    if (!space || space.phase === "deleted")
      throw new LocalRefusal(
        "LOCAL_SANDBOX_ABSENT",
        "This device does not own an active sandbox with that ID.",
      );
    return space;
  }

  async create(
    repositoryId: string,
    ref: string,
    operationMarker: string,
    onAdmitted?: () => void | Promise<void>,
  ): Promise<LocalSpace> {
    const admitted = await this.serial(`create:${operationMarker}`, async () => {
      const policy = await this.records.policy();
      requireLocalGrant(policy, repositoryId);
      requireRef(ref);
      z.string()
        .regex(/^moira-[a-f0-9]{24}$/)
        .parse(operationMarker);
      const spaces = await this.records.list();
      const duplicate = spaces.find((space) => space.operationMarker === operationMarker);
      if (duplicate) {
        if (duplicate.repositoryId !== repositoryId || duplicate.ref !== ref)
          throw new LocalRefusal(
            "LOCAL_REPLAY_CONFLICT",
            "Creation marker belongs to another repository or revision.",
          );
        return { space: duplicate, created: false };
      }
      for (const key of await this.records.state.keys("controller-resource-")) {
        const binding = await this.records.state.read(key, (value) =>
          z
            .object({ operationMarker: z.string(), creationClosed: z.boolean() })
            .passthrough()
            .parse(value),
        );
        if (binding?.operationMarker === operationMarker && binding.creationClosed)
          throw new LocalRefusal(
            "LOCAL_CREATE_UNKNOWN",
            "Archived creation admission is closed; it cannot be replayed.",
          );
      }
      await (this.dependencies.storage ?? admitStorage)(policy);
      const id = randomUUID();
      const space: LocalSpace = {
        id,
        name: `moira-${id.replaceAll("-", "")}`,
        runtimeId: null,
        admittedMachine: {
          cpuCores: policy.runtime.cpuCores,
          memoryBytes: policy.runtime.memoryBytes,
          dockerBytes: policy.runtime.dockerBytes,
        },
        repositoryId,
        admittedRepositoryFullName: policy.repositories.find((repo) => repo.id === repositoryId)!
          .fullName,
        operationMarker,
        ref,
        createdAt: this.now(),
        lastStartedAt: null,
        desiredState: "running",
        phase: "creating",
        networkPolicy: null,
        brokerToken: randomBytes(32).toString("hex"),
        generation: 1,
        failure: null,
      };
      await this.records.put(space);
      // Keep the pending intent if independent ownership cannot be established; no SDK
      // creation occurs before that owner, and the parent never overwrites its outcome.
      return { space, created: true };
    });
    await onAdmitted?.();
    return admitted.created ? this.prepare(admitted.space, true) : admitted.space;
  }

  private async prepare(
    space: LocalSpace,
    clone: boolean,
    activate = false,
    onAdmitted?: () => void | Promise<void>,
  ): Promise<LocalSpace> {
    if (!this.tunnel)
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "Start the local companion first.");
    if (clone !== (space.phase === "creating"))
      throw new LocalRefusal("LOCAL_SETUP_INCOMPLETE", "The local setup phase changed.");
    const guard = await (await this.owner()).space(space.id, activate);
    this.guards.set(space.id, guard);
    try {
      await onAdmitted?.();
      await guard.prepare();
      return await this.require(space.id);
    } catch (error) {
      // A failed observation or restart preparation does not authorize stopping
      // an existing VM. Retain its guard for later observation or explicit stop.
      // Initial creation still owns cleanup of its newly admitted setup work.
      if (clone) {
        await guard.stop();
        this.guards.delete(space.id);
      }
      throw error;
    }
  }

  async boundary(space: LocalSpace, runtime: LocalVmRuntime): Promise<void> {
    if (!space.networkPolicy) {
      throw new LocalRefusal(
        "LOCAL_NETWORK_CHANGED",
        "The sandbox network policy changed; restore it locally before allowing work.",
      );
    }
    await runtime.boundary.verify(this.identity(space), space.networkPolicy);
  }

  async start(
    id: string,
    onAdmitted?: () => void | Promise<void>,
    workspaceReleases?: { x64: string; arm64: string },
  ): Promise<LocalSpace> {
    return this.serial(`space:${id}`, async () => {
      const space = await this.require(id);
      const policy = await this.records.policy();
      requireLocalGrant(policy, space.repositoryId);
      if (workspaceReleases) {
        const assets = await guestAssets();
        if (workspaceReleases[assets.payload.architecture] !== assets.payload.release)
          throw new LocalRefusal(
            "LOCAL_WORKSPACE_RELEASE_MISMATCH",
            "Update the Local companion to the server's workspace release before bootstrap.",
          );
      }
      if (space.failure === "LOCAL_SETUP_INCOMPLETE" || space.lastStartedAt === null)
        throw new LocalRefusal(
          "LOCAL_SETUP_INCOMPLETE",
          "Guest preparation did not finish. Resume setup explicitly on this same known codespace.",
        );
      if (space.phase !== "usable" && space.phase !== "stopped") {
        throw new LocalRefusal(
          "LOCAL_SETUP_INCOMPLETE",
          "Guest preparation did not finish. Resume setup explicitly on this same known codespace.",
        );
      }
      await (this.dependencies.storage ?? admitStorage)(policy);
      const guard = this.guards.get(id);
      if (guard?.active) {
        if (space.desiredState !== "running")
          throw new LocalRefusal(
            "LOCAL_STOP_PENDING",
            "The independent owner is completing local shutdown.",
          );
        try {
          await onAdmitted?.();
          await guard.validate();
          await guard.prepare();
          return this.require(id);
        } catch (error) {
          if (!(error instanceof LocalRefusal) || error.code !== "LOCAL_NOT_RUNNING") throw error;
          // An admitted guard can outlive a physically stopped VM. Prepare the
          // same owned identity instead of treating the guard as a running receipt.
        }
      }
      this.guards.delete(id);
      return this.prepare(space, false, true, onAdmitted);
    });
  }

  /** A new explicit setup operation; it never retries the original create receipt. */
  async resumeSetup(id: string, onAdmitted?: () => void | Promise<void>): Promise<LocalSpace> {
    return this.serial(`space:${id}`, async () => {
      const space = await this.require(id);
      const policy = await this.records.policy();
      requireLocalGrant(policy, space.repositoryId);
      requireSetupRecovery(space);
      if (this.guards.get(id)?.setupGeneration !== undefined)
        throw new LocalRefusal(
          "LOCAL_STOP_PENDING",
          "The original setup is still pending; collect its original operation before recovery.",
        );
      if (!this.tunnel)
        throw new LocalRefusal("LOCAL_NOT_RUNNING", "Start the local companion first.");
      await (this.dependencies.storage ?? admitStorage)(policy);
      const guard = await (await this.owner()).space(id, "resume-setup");
      this.guards.set(id, guard);
      await onAdmitted?.();
      // No cleanup stop: this operation owns preparation of an existing bound VM.
      await guard.prepare();
      return this.require(id);
    });
  }

  async stop(id: string, expectedGeneration?: number): Promise<LocalSpace> {
    return (async () => {
      const space = await this.require(id);
      const generation = expectedGeneration ?? space.generation;
      if (space.generation !== generation)
        throw new LocalRefusal(
          "LOCAL_GENERATION_CONFLICT",
          "Refresh this codespace before stopping its exact generation.",
        );
      if (!this.dependencies.runtime) {
        await (await this.owner()).retire(space.id, generation);
        this.guards.delete(id);
        return this.require(id);
      }
      const guard = this.guards.get(id);
      if (guard) {
        await guard.stop();
        this.guards.delete(id);
        return await this.require(id);
      }
      const incomplete =
        space.phase === "creating" || (space.phase === "failed" && space.lastStartedAt === null);
      space.desiredState = "stopped";
      await this.records.put(space);
      this.guards.delete(id);
      const runtime = this.runtime(policyForSpace(await this.records.policy(), space));
      if (space.runtimeId) {
        await runtime.stop(this.identity(space));
        const observed = await runtime.inspectExact(this.identity(space));
        if (observed && observed.status !== "stopped" && observed.status !== "created")
          throw new LocalRefusal(
            "LOCAL_STOP_PENDING",
            "The exact local sandbox stop is not confirmed.",
          );
      } else if ((await runtime.list()).some((item) => item.name === space.name))
        throw new LocalRefusal(
          "LOCAL_CREATE_UNKNOWN",
          "The saved name is occupied without a captured VM identity; inspect pending creation locally.",
        );
      space.phase = incomplete ? "failed" : "stopped";
      if (incomplete && space.failure === null) space.failure = "LOCAL_SETUP_INCOMPLETE";
      space.generation++;
      await this.records.put(space);
      return space;
    })();
  }

  async recover(id: string, localApproval: boolean): Promise<LocalSpace> {
    return this.serial(`space:${id}`, async () => {
      if (!localApproval)
        throw new LocalRefusal(
          "LOCAL_RECOVERY_CONFIRM",
          "Acknowledge the unknown outcome explicitly on this computer.",
        );
      const space = await this.require(id);
      const owner = await this.owner();
      if (!owner.recover)
        throw new LocalRefusal(
          "LOCAL_RECOVERY_REFUSED",
          "The local owner does not support verified recovery.",
        );
      await owner.recover(id, space.generation);
      this.guards.delete(id);
      return this.require(id);
    });
  }

  async remove(id: string, generation: number, localApproval = false): Promise<void> {
    return (async () => {
      const space = await this.records.get(id);
      if (!space)
        throw new LocalRefusal(
          "LOCAL_SANDBOX_ABSENT",
          "This device has no retained sandbox with that ID.",
        );
      const policy = await this.records.policy();
      const repository = policy.repositories.find((item) => item.id === space.repositoryId);
      if (!localApproval && !repository?.allowDelete) {
        throw new LocalRefusal(
          "LOCAL_DELETE_APPROVAL_REQUIRED",
          "Approve deletion of this repository's local sandboxes on the computer.",
        );
      }
      if (space.generation !== generation)
        throw new LocalRefusal(
          "LOCAL_GENERATION_CONFLICT",
          "Refresh the local sandbox before deleting it.",
        );
      if (!this.dependencies.runtime) {
        await (await this.owner(localApproval)).remove(space.id, generation, localApproval);
        this.guards.delete(space.id);
        return;
      }
      const runtime = this.runtime(policyForSpace(policy, space));
      if (space.phase === "deleted") {
        const present = space.runtimeId
          ? await runtime.inspectExact(this.identity(space))
          : (await runtime.list()).find((item) => item.name === space.name);
        if (present)
          throw new LocalRefusal(
            "LOCAL_IDENTITY_CHANGED",
            "A deleted sandbox has a surviving runtime identity.",
          );
        return;
      }
      const guard = this.guards.get(id);
      await guard?.stop();
      this.guards.delete(id);
      const stopped = await this.require(id);
      Object.assign(space, stopped);
      space.desiredState = "deleted";
      space.phase = "deleting";
      await this.records.put(space);
      if (!space.runtimeId) {
        if ((await runtime.list()).some((item) => item.name === space.name))
          throw new LocalRefusal(
            "LOCAL_CREATE_UNKNOWN",
            "The saved name is occupied without a captured VM identity; inspect pending creation locally.",
          );
      } else {
        await runtime.remove(this.identity(space));
        if (await runtime.inspectExact(this.identity(space)))
          throw new LocalRefusal(
            "LOCAL_STOP_PENDING",
            "The exact local sandbox deletion is not confirmed.",
          );
      }
      space.phase = "deleted";
      space.generation++;
      await this.records.put(space);
    })();
  }

  /** The durable manifest is written before SDK creation. The lifecycle gate drains admitted create. */
  async inspectCreation(
    repositoryId: string,
    operationMarker: string,
    close?: () => Promise<void>,
  ) {
    return this.serial(`create:${operationMarker}`, async () => {
      const candidates = (await this.records.list()).filter(
        (space) => space.repositoryId === repositoryId && space.operationMarker === operationMarker,
      );
      if (candidates.length > 1)
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "The creation marker has ambiguous local manifests.",
        );
      if (!candidates.length && close) await close();
      return candidates[0] ?? null;
    });
  }

  async snapshot(spaceId?: string, ownerCleanup = false) {
    const policy = await this.records.policy();
    if (ownerCleanup && !spaceId)
      throw new LocalRefusal("LOCAL_UNAUTHORIZED", "Owner cleanup requires one exact sandbox.");
    const admitted = ownerCleanup || policy.enabled;
    let observationFailure: string | null = null;
    const observed = await (async () => {
      try {
        return this.dependencies.runtime
          ? await this.runtime(policy).list()
          : admitted
            ? await (await this.owner(ownerCleanup)).observe(spaceId)
            : [];
      } catch (error) {
        if (!spaceId) throw error;
        observationFailure = error instanceof LocalRefusal ? error.code : "LOCAL_INTERNAL_ERROR";
        return [];
      }
    })();
    const spaces = [];
    const records = spaceId
      ? [await this.records.get(spaceId)].filter((space): space is LocalSpace => space !== null)
      : await this.records.list();
    for (const space of records) {
      if (space.phase === "deleted" && !spaceId) continue;
      // A creation manifest without an observed UUID is still unknown, even if the
      // SDK now happens to contain the same name. Read-only status cannot adopt it.
      const actual = space.runtimeId
        ? observed.find((item) => item.name === space.name)
        : undefined;
      const pendingAbsent =
        !space.runtimeId &&
        admitted &&
        !observationFailure &&
        (space.phase === "deleted" ||
          (space.phase === "stopped" &&
            space.desiredState === "stopped" &&
            space.failure === null)) &&
        !observed.some((item) => item.name === space.name);
      if (actual && space.runtimeId !== actual.id)
        throw new LocalRefusal("LOCAL_IDENTITY_CHANGED", "A local sandbox identity changed.");
      spaces.push({
        id: space.id,
        name: space.name,
        repositoryId: space.repositoryId,
        operationMarker: space.operationMarker,
        createdAt: space.createdAt,
        lastStartedAt: space.lastStartedAt,
        generation: space.generation,
        desiredState: space.desiredState,
        machine: publicPolicy(policyForSpace(policy, space)).machine,
        state:
          actual?.status ??
          (!admitted || observationFailure
            ? "unknown"
            : space.runtimeId || pendingAbsent
              ? "absent"
              : "unknown"),
        phase: space.phase,
        failure: observationFailure ?? actual?.failure ?? space.failure,
        ...(space.remote ? { remote: space.remote } : {}),
        ...(space.setupFailure ? { setupFailure: space.setupFailure } : {}),
        // Only the independent native owner can attest physical settlement. The persisted
        // phase alone is historical; an injected runtime or unavailable observation cannot.
        nativeStopConfirmed:
          !this.dependencies.runtime &&
          admitted &&
          actual !== undefined &&
          actual.id === space.runtimeId &&
          (actual.status === "stopped" || actual.status === "created") &&
          space.desiredState === "stopped" &&
          (space.phase === "stopped" || space.phase === "failed"),
      });
    }
    return { ...publicPolicy(policy), spaces };
  }
}
