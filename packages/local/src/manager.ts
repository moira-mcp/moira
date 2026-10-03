import { createHash, randomBytes, randomUUID } from "node:crypto";
import { totalmem, cpus } from "node:os";
import { z } from "zod";
import { LocalRecords, type LocalSpace } from "./space-record.js";
import {
  LocalRefusal,
  requireLocalGrant,
  requireRef,
  publicPolicy,
  type LocalPolicy,
} from "./policy.js";
import { SbxRuntime, type SandboxIdentity } from "./sbx-runtime.js";
import { admitStorage } from "./storage.js";
import { startGuard, type SpaceGuard, type StartGuard } from "./guard.js";
import { startBroker } from "./broker.js";
import { startBrokerTunnel } from "./broker-tunnel.js";
import { gitBroker } from "./git-broker.js";
import { NetworkBudget } from "./network-budget.js";
import { guestAssets, installGuest, type GuestAssets } from "./assets.js";

export interface ManagerDependencies {
  runtime?: (policy: LocalPolicy) => SbxRuntime;
  storage?: typeof admitStorage;
  guard?: StartGuard;
  assets?: () => Promise<GuestAssets>;
  now?: () => number;
  onFault?: (error: unknown) => void;
}
const brokerState = z.object({ port: z.number().int().min(1024).max(65535) }).strict();
const envelope = z.object({ ok: z.literal(true), result: z.unknown() }).strict();

export class LocalManager {
  private readonly guards = new Map<string, SpaceGuard>();
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
  runtime(policy: LocalPolicy): SbxRuntime {
    return this.dependencies.runtime?.(policy) ?? new SbxRuntime(policy);
  }
  identity(space: LocalSpace): SandboxIdentity {
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

  async open(): Promise<void> {
    this.releaseLock = await this.records.state.lock();
    try {
      const policy = await this.records.policy();
      await (this.dependencies.storage ?? admitStorage)(policy);
      await this.runtime(policy).verifySettings();
      const onFault = this.dependencies.onFault ?? (() => undefined);
      const budget = new NetworkBudget(this.records.state);
      this.broker = await startBroker({
        authorize: (credential) => this.records.authorize(credential, this.now()),
        budget,
        git: gitBroker(budget, onFault),
        onFault,
      });
      const saved = await this.records.state.read("broker.json", brokerState.parse);
      this.tunnel = await startBrokerTunnel(this.broker.port, saved?.port);
      await this.records.state.write("broker.json", { port: this.tunnel.port });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const guard of this.guards.values()) {
      try {
        await guard.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    this.guards.clear();
    await this.tunnel?.close();
    await this.broker?.close();
    await this.releaseLock?.();
    this.releaseLock = undefined;
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
        if (duplicate.repositoryId !== repositoryId)
          throw new LocalRefusal(
            "LOCAL_REPLAY_CONFLICT",
            "Creation marker belongs to another repository.",
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
        repositoryId,
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
      const runtime = this.runtime(policy);
      try {
        const identity = await runtime.create(space.name);
        space.runtimeId = identity.runtimeId;
        await this.records.put(space);
        return await this.prepare(space, true);
      } catch (error) {
        space.phase = "failed";
        space.failure = error instanceof LocalRefusal ? error.code : "LOCAL_CREATE_FAILED";
        space.desiredState = "stopped";
        await this.records.put(space);
        if (space.runtimeId) await runtime.stop(this.identity(space));
        throw error;
      }
    });
  }

  private async prepare(space: LocalSpace, clone: boolean): Promise<LocalSpace> {
    if (!this.tunnel)
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "Start the local companion first.");
    const policy = await this.records.policy();
    const repository = requireLocalGrant(policy, space.repositoryId, this.now());
    const runtime = this.runtime(policy);
    const identity = this.identity(space);
    await runtime.start(identity);
    await runtime.verifySettings();
    await runtime.verifyBoundary(identity);
    if (space.networkPolicy) await this.boundary(space, runtime);
    else {
      space.networkPolicy = createHash("sha256")
        .update(await runtime.configureBroker(identity, this.tunnel.port))
        .digest("hex");
      await this.records.put(space);
    }
    const assets = await (this.dependencies.assets ?? guestAssets)();
    const guard = await (this.dependencies.guard ?? startGuard)(this.records.state.root, space.id);
    this.guards.set(space.id, guard);
    try {
      await installGuest(runtime, identity, assets);
      const input = {
        kind: "bootstrap",
        request: {
          proxySource: assets.proxy,
          hostPort: this.tunnel.port,
          spaceId: space.id,
          brokerToken: space.brokerToken,
          repository: repository.fullName,
          ref: space.ref,
          clone,
        },
      };
      const output = await runtime.guest(
        identity,
        ["node", "/tmp/moira-local-runtime/worker.mjs"],
        Buffer.from(JSON.stringify(input)),
        Math.min(300_000, policy.leaseUntil - this.now()),
      );
      envelope.parse(JSON.parse(output.toString("utf8")));
      requireLocalGrant(await this.records.policy(), space.repositoryId, this.now());
      space.phase = "usable";
      space.lastStartedAt = this.now();
      space.failure = null;
      await this.records.put(space);
      return space;
    } catch (error) {
      await guard.stop();
      this.guards.delete(space.id);
      throw error;
    }
  }

  async boundary(space: LocalSpace, runtime: SbxRuntime): Promise<void> {
    await runtime.verifySettings();
    await runtime.verifyBoundary(this.identity(space));
    const observed = createHash("sha256")
      .update(await runtime.networkPolicy(this.identity(space)))
      .digest("hex");
    if (!space.networkPolicy || observed !== space.networkPolicy) {
      throw new LocalRefusal(
        "LOCAL_NETWORK_CHANGED",
        "The sandbox network policy changed; restore it locally before allowing work.",
      );
    }
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
      if (this.guards.has(id)) return space;
      space.desiredState = "running";
      space.generation++;
      await this.records.put(space);
      try {
        return await this.prepare(space, false);
      } catch (error) {
        space.desiredState = "stopped";
        await this.records.put(space);
        await this.runtime(policy).stop(this.identity(space));
        throw error;
      }
    });
  }

  async stop(id: string): Promise<LocalSpace> {
    return this.serial(async () => {
      const space = await this.require(id);
      space.desiredState = "stopped";
      await this.records.put(space);
      await this.guards.get(id)?.stop();
      this.guards.delete(id);
      if (space.runtimeId)
        await this.runtime(await this.records.policy()).stop(this.identity(space));
      space.phase = "stopped";
      space.generation++;
      await this.records.put(space);
      return space;
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
      space.desiredState = "deleted";
      space.phase = "deleting";
      await this.records.put(space);
      await this.guards.get(id)?.stop();
      this.guards.delete(id);
      if (!space.runtimeId)
        throw new LocalRefusal(
          "LOCAL_CREATE_UNKNOWN",
          "Inspect the pending creation locally before removing its record.",
        );
      await this.runtime(policy).remove(this.identity(space));
      space.phase = "deleted";
      space.generation++;
      await this.records.put(space);
    });
  }

  async snapshot() {
    const policy = await this.records.policy();
    const observed = await this.runtime(policy).list();
    const spaces = [];
    for (const space of await this.records.list()) {
      if (space.phase === "deleted") continue;
      const actual = observed.find((item) => item.name === space.name);
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
        state: actual?.status ?? (space.runtimeId ? "absent" : "unknown"),
        phase: space.phase,
        failure: space.failure,
      });
    }
    return { ...publicPolicy(policy), spaces };
  }
}
