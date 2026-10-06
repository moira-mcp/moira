import { randomBytes, randomUUID } from "node:crypto";
import { totalmem, cpus } from "node:os";
import { z } from "zod";
import { LocalRecords, policyForSpace, type LocalSpace } from "./space-record.js";
import {
  LocalRefusal,
  requireLocalGrant,
  requireRef,
  publicPolicy,
  type LocalPolicy,
} from "./policy.js";
import type { LocalVmRuntime, LocalVmIdentity, LocalVmRuntimeFactory } from "./local-vm-runtime.js";
import { createLocalVmRuntime } from "./local-vm-runtime-factory.js";
import { admitStorage } from "./storage.js";
import { startGuard, type SpaceGuard, type StartGuard, type DeviceGuard } from "./guard.js";
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
  private broker?: Awaited<ReturnType<typeof startBroker>>;
  private tunnel?: Awaited<ReturnType<typeof startBrokerTunnel>>;
  private releaseLock?: () => Promise<void>;
  private lifecycleTail: Promise<unknown> = Promise.resolve();
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
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.lifecycleTail.then(action);
    this.lifecycleTail = result.catch(() => undefined);
    return result;
  }

  private async owner(): Promise<DeviceGuard> {
    if (!this.device?.active) {
      await this.device?.stop();
      this.device = await (this.dependencies.guard ?? startGuard)(this.records.state.root);
    }
    return this.device;
  }

  async holdRunnerLock(): Promise<void> {
    this.releaseLock ??= await this.records.state.lock();
  }
  async open(): Promise<void> {
    await this.holdRunnerLock();
    try {
      const policy = await this.records.policy();
      await (this.dependencies.storage ?? admitStorage)(policy);
      await this.owner();
      if (this.dependencies.runtime) await this.runtime(policy).boundary.verifyConfiguration();
      const onFault = this.dependencies.onFault ?? (() => undefined);
      const budget = new NetworkBudget(this.records.state);
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

  async create(repositoryId: string, ref: string, operationMarker: string): Promise<LocalSpace> {
    return this.serial(async () => {
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
        return duplicate;
      }
      const count = spaces.filter((space) => space.phase !== "deleted").length;
      if (
        count >= policy.limits.maxSandboxes ||
        (count + 1) * policy.runtime.memoryBytes > totalmem() * 0.8 ||
        policy.runtime.cpuCores > cpus().length
      ) {
        throw new LocalRefusal(
          "LOCAL_RESOURCE_LIMIT",
          "The locally approved machine or sandbox capacity is exhausted.",
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
      return this.prepare(space, true);
    });
  }

  private async prepare(space: LocalSpace, clone: boolean, activate = false): Promise<LocalSpace> {
    if (!this.tunnel)
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "Start the local companion first.");
    if (clone !== (space.phase === "creating"))
      throw new LocalRefusal("LOCAL_SETUP_INCOMPLETE", "The local setup phase changed.");
    const guard = await (await this.owner()).space(space.id, activate);
    this.guards.set(space.id, guard);
    try {
      await guard.prepare();
      return await this.require(space.id);
    } catch (error) {
      await guard.stop();
      this.guards.delete(space.id);
      throw error;
    }
  }

  async operation(id: string, request: unknown): Promise<Buffer> {
    let guard = this.guards.get(id);
    if (!guard?.active) {
      guard = await (await this.owner()).space(id);
      this.guards.set(id, guard);
    }
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

  /** Hold the existing lifecycle boundary until this guest contact has settled. */
  async dispatchGuest<T>(
    id: string,
    dispatch: (space: LocalSpace, policy: LocalPolicy) => Promise<T>,
  ): Promise<T> {
    return this.serial(async () => {
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
        current.generation !== space.generation ||
        current.runtimeId !== space.runtimeId
      )
        throw new LocalRefusal("LOCAL_NOT_RUNNING", "The local sandbox changed before dispatch.");
      const currentPolicy = await this.records.policy();
      requireLocalGrant(currentPolicy, current.repositoryId, this.now());
      if (JSON.stringify(currentPolicy.runtime) !== JSON.stringify(policy.runtime))
        throw new LocalRefusal("LOCAL_RUNTIME_CHANGED", "The locally approved runtime changed.");
      return dispatch(current, currentPolicy);
    });
  }

  async start(id: string): Promise<LocalSpace> {
    return this.serial(async () => {
      const space = await this.require(id);
      const policy = await this.records.policy();
      requireLocalGrant(policy, space.repositoryId, this.now());
      await (this.dependencies.storage ?? admitStorage)(policy);
      if (space.phase !== "usable" && space.phase !== "stopped") {
        throw new LocalRefusal(
          "LOCAL_SETUP_INCOMPLETE",
          "This sandbox was not fully initialized; inspect it locally.",
        );
      }
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
      return this.prepare(space, false, true);
    });
  }

  async stop(id: string): Promise<LocalSpace> {
    return this.serial(async () => {
      const space = await this.require(id);
      const guard =
        this.guards.get(id) ??
        (space.desiredState === "running" ? await (await this.owner()).space(id) : undefined);
      if (guard) {
        await guard.stop();
        this.guards.delete(id);
        return await this.require(id);
      }
      if (!this.dependencies.runtime) {
        await (await this.owner()).retire(space.id, space.generation);
        return this.require(id);
      }
      space.desiredState = "stopped";
      await this.records.put(space);
      this.guards.delete(id);
      if (space.runtimeId)
        await this.runtime(policyForSpace(await this.records.policy(), space)).stop(
          this.identity(space),
        );
      space.phase = "stopped";
      space.generation++;
      await this.records.put(space);
      return space;
    });
  }

  async recover(id: string, localApproval: boolean): Promise<LocalSpace> {
    return this.serial(async () => {
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
    return this.serial(async () => {
      const space = await this.require(id);
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
        await (await this.owner()).remove(space.id, generation, localApproval);
        this.guards.delete(space.id);
        return;
      }
      const guard =
        this.guards.get(id) ??
        (space.desiredState === "running" ? await (await this.owner()).space(id) : undefined);
      await guard?.stop();
      this.guards.delete(id);
      const stopped = await this.require(id);
      Object.assign(space, stopped);
      space.desiredState = "deleted";
      space.phase = "deleting";
      await this.records.put(space);
      if (!space.runtimeId)
        throw new LocalRefusal(
          "LOCAL_CREATE_UNKNOWN",
          "Inspect the pending creation locally before removing its record.",
        );
      await this.runtime(policyForSpace(policy, space)).remove(this.identity(space));
      space.phase = "deleted";
      space.generation++;
      await this.records.put(space);
    });
  }

  async snapshot() {
    const policy = await this.records.policy();
    const admitted = policy.enabled && policy.leaseUntil > this.now();
    const observed = this.dependencies.runtime
      ? await this.runtime(policy).list()
      : admitted
        ? await (await this.owner()).observe()
        : [];
    const spaces = [];
    for (const space of await this.records.list()) {
      if (space.phase === "deleted") continue;
      // A creation manifest without an observed UUID is still unknown, even if the
      // SDK now happens to contain the same name. Read-only status cannot adopt it.
      const actual = space.runtimeId
        ? observed.find((item) => item.name === space.name)
        : undefined;
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
          (!admitted
            ? space.phase === "stopped"
              ? "stopped"
              : "unknown"
            : space.runtimeId
              ? "absent"
              : "unknown"),
        phase: space.phase,
        failure: space.failure,
      });
    }
    return { ...publicPolicy(policy), spaces };
  }
}
