import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { LocalRecords, policyForSpace, type LocalSpace } from "./space-record.js";
import {
  LocalRefusal,
  requireLocalGrant,
  requireRef,
  publicPolicy,
  localPolicySchema,
  type LocalPolicy,
} from "./policy.js";
import type { LocalVmRuntime, LocalVmIdentity, LocalVmRuntimeFactory } from "./local-vm-runtime.js";
import { createLocalVmRuntime } from "./local-vm-runtime-factory.js";
import { admitStorage } from "./storage.js";
import {
  startGuard,
  requireRuntimeOwnerAbsent,
  type SpaceGuard,
  type StartGuard,
  type DeviceGuard,
} from "./guard.js";
import { startBroker } from "./broker.js";
import { startBrokerTunnel } from "./broker-tunnel.js";
import { gitBroker } from "./git-broker.js";
import { cloudGitBroker } from "./cloud-git-broker.js";
import { LocalRelay } from "./relay.js";
import { NetworkBudget } from "./network-budget.js";

export interface ManagerDependencies {
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
    const policy = await this.records.policy();
    const managementOnly = cleanupOnly && (!policy.enabled || policy.leaseUntil <= this.now());
    if (!this.device?.active || this.cleanupOnlyOwner !== managementOnly) {
      this.openingOwner ??= (async () => {
        await this.device?.stop();
        this.device = await (this.dependencies.guard ?? startGuard)(
          this.records.state.root,
          managementOnly ? "cleanup" : "work",
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

  async holdRunnerLock(): Promise<void> {
    await this.serial("runner-lock", async () => {
      if (this.releaseLock) return;
      const release = await this.records.state.lock({ recoverStale: true });
      try {
        await requireRuntimeOwnerAbsent(this.records);
        this.releaseLock = release;
      } catch (error) {
        await release();
        throw error;
      }
    });
  }
  async open(): Promise<void> {
    await this.holdRunnerLock();
    try {
      const policy = await this.records.policy();
      await (this.dependencies.storage ?? admitStorage)(policy);
      await this.owner();
      if (this.dependencies.runtime) await this.runtime(policy).boundary.verifyConfiguration();
      const onFault = this.dependencies.onFault ?? (() => undefined);
      const budget = new NetworkBudget();
      const relay = new LocalRelay(this.records);
      const direct = gitBroker(budget, onFault);
      const cloud = cloudGitBroker(
        (...args) => relay.gitAuthority(...args),
        budget,
        onFault,
        direct,
      );
      this.broker = await startBroker(
        {
          authorize: (credential) => this.records.authorize(credential, this.now()),
          budget,
          git: async (request, response, grant) => {
            if (
              !grant.repository.private &&
              !grant.repository.allowPush &&
              grant.repository.allowPullRequests !== true
            )
              return direct(request, response, { ...grant, gitCredential: null });
            const connected = await this.records.state.read("connection.json", (value) => value);
            if (!connected && grant.gitCredential !== null) return direct(request, response, grant);
            return cloud(request, response, grant);
          },
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
        await this.close();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], "Local startup and cleanup failed", {
          cause: error,
        });
      }
      throw error;
    }
  }

  async stopWork(): Promise<void> {
    await this.closeResources(true);
  }
  /** The same runner/lifecycle gate admits an exact repository-only expansion. */
  async appendRepositoryPolicy(previous: LocalPolicy, next: LocalPolicy): Promise<void> {
    await this.serial("policy", async () => {
      await this.holdRunnerLock();
      next = localPolicySchema.parse(next);
      const stable = (policy: LocalPolicy) => JSON.stringify({ ...policy, repositories: [] });
      if (
        stable(previous) !== stable(next) ||
        next.repositories.length < previous.repositories.length ||
        previous.repositories.some(
          (repository, index) =>
            JSON.stringify(repository) !== JSON.stringify(next.repositories[index]),
        )
      )
        throw new LocalRefusal(
          "LOCAL_CONTROL_CONFLICT",
          "Live control may only append repository grants.",
        );
      const current = JSON.stringify(await this.records.policy());
      if (current !== JSON.stringify(previous) && current !== JSON.stringify(next))
        throw new LocalRefusal(
          "LOCAL_CONTROL_CONFLICT",
          "Local policy changed before repository admission.",
        );
      if (current !== JSON.stringify(next)) await this.records.state.write("policy.json", next);
    });
  }
  async close(): Promise<void> {
    await this.closeResources(false);
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
      if (!keepLock) {
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
    onAdmitted?: () => void,
  ): Promise<LocalSpace> {
    const admitted = await this.serial(`create:${operationMarker}`, async () => {
      const policy = await this.records.policy();
      requireLocalGrant(policy, repositoryId, this.now());
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
      await new LocalRelay(this.records).assertCreationOpen(repositoryId, operationMarker);
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
    onAdmitted?.();
    return admitted.created ? this.prepare(admitted.space, true) : admitted.space;
  }

  private async prepare(
    space: LocalSpace,
    clone: boolean,
    activate = false,
    onAdmitted?: () => void,
  ): Promise<LocalSpace> {
    if (!this.tunnel)
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "Start the local companion first.");
    if (clone !== (space.phase === "creating"))
      throw new LocalRefusal("LOCAL_SETUP_INCOMPLETE", "The local setup phase changed.");
    const guard = await (await this.owner()).space(space.id, activate);
    this.guards.set(space.id, guard);
    onAdmitted?.();
    try {
      await guard.prepare();
      return await this.require(space.id);
    } catch (error) {
      await guard.stop();
      this.guards.delete(space.id);
      throw error;
    }
  }

  async operation(id: string, request: unknown, signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted();
    let guard = this.guards.get(id);
    if (!guard?.active) {
      guard = await (await this.owner()).space(id);
      this.guards.set(id, guard);
    }
    signal?.throwIfAborted();
    return guard.operation(request);
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

  /** Admit against current identity; independent guest contacts do not hold the lifecycle lane. */
  async dispatchGuest<T>(
    id: string,
    dispatch: (space: LocalSpace, policy: LocalPolicy) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const admitted = await this.serial(`space:${id}`, async () => {
      signal?.throwIfAborted();
      const space = await this.require(id);
      const policy = await this.records.policy();
      requireLocalGrant(policy, space.repositoryId, this.now());
      if (space.desiredState !== "running" || space.phase !== "usable") {
        throw new LocalRefusal(
          "LOCAL_NOT_RUNNING",
          "Start this local sandbox before requesting work.",
        );
      }
      if (this.dependencies.runtime) {
        const runtime = this.runtime(policyForSpace(policy, space));
        if ((await runtime.inspectExact(this.identity(space)))?.status !== "running")
          throw new LocalRefusal("LOCAL_NOT_RUNNING", "The owned sandbox is stopped.");
        await this.boundary(space, runtime);
      } else {
        let guard = this.guards.get(id);
        if (!guard?.active) {
          guard = await (await this.owner()).space(id);
          this.guards.set(id, guard);
        }
        // Fixed guest dispatch performs the backend proof after these local metadata checks.
      }
      // Local configuration and the independent guard can change while runtime checks await.
      const current = await this.require(id);
      if (
        current.desiredState !== "running" ||
        current.phase !== "usable" ||
        current.runtimeId !== space.runtimeId
      )
        throw new LocalRefusal("LOCAL_NOT_RUNNING", "The local sandbox changed before dispatch.");
      const currentPolicy = await this.records.policy();
      requireLocalGrant(currentPolicy, current.repositoryId, this.now());
      if (JSON.stringify(currentPolicy.runtime) !== JSON.stringify(policy.runtime))
        throw new LocalRefusal("LOCAL_RUNTIME_CHANGED", "The locally approved runtime changed.");
      return { space: current, policy: currentPolicy };
    });
    signal?.throwIfAborted();
    return dispatch(admitted.space, admitted.policy);
  }

  async start(id: string, onAdmitted?: () => void): Promise<LocalSpace> {
    return this.serial(`space:${id}`, async () => {
      const space = await this.require(id);
      const policy = await this.records.policy();
      requireLocalGrant(policy, space.repositoryId, this.now());
      if (space.failure === "LOCAL_SETUP_INCOMPLETE" || space.lastStartedAt === null)
        throw new LocalRefusal(
          "LOCAL_SETUP_INCOMPLETE",
          "Guest preparation did not finish. Delete this codespace after confirmed cleanup, then create a new one.",
        );
      if (space.phase !== "usable" && space.phase !== "stopped") {
        throw new LocalRefusal(
          "LOCAL_SETUP_INCOMPLETE",
          "Guest preparation did not finish. Delete this codespace after confirmed cleanup, then create a new one.",
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
          await guard.validate();
          return space;
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
    const admitted = ownerCleanup || (policy.enabled && policy.leaseUntil > this.now());
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
        state:
          actual?.status ??
          (!admitted || observationFailure
            ? "unknown"
            : space.runtimeId || pendingAbsent
              ? "absent"
              : "unknown"),
        phase: space.phase,
        failure: observationFailure ?? actual?.failure ?? space.failure,
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
