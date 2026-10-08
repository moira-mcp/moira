import { z } from "zod";
import {
  LocalRecords,
  spaceSchema,
  policyForSpace,
  requireSpaceGrant,
  type LocalSpace,
} from "./space-record.js";
import { LocalRelay } from "./relay.js";
import {
  localManagementOutcomeSchema,
  LOCAL_WORKER_REQUEST_TIMEOUT_MS,
} from "../../shared/src/codespaces/local-protocol.js";
import type { LocalVmRuntime } from "./local-vm-runtime.js";
import { createLocalVmRuntime } from "./local-vm-runtime-factory.js";
import { runProcess, type RunProcess } from "./process.js";
import { guestAssets, installGuest, runtimeApiAsset } from "./assets.js";
import {
  LocalRefusal,
  MAX_MESSAGE_BYTES,
  requireOperationOutputBudget,
  requireOperationExecutionBudget,
  type LocalPolicy,
} from "./policy.js";

const operation = z
  .object({
    action: z.enum([
      "execute",
      "inspect",
      "cancel",
      "finalize",
      "output",
      "file-execute",
      "file-inspect",
    ]),
    remoteMarker: z.string().regex(/^moira-op-[a-f0-9]{32}$/),
    repositoryFullName: z.string(),
  })
  .passthrough();

/** The independent guard owns every native call that can start this space. */
export class RuntimeOwner {
  private readonly controller = new AbortController();
  private readonly cleanupController = new AbortController();
  private readonly children = new Set<Promise<unknown>>();
  private readonly guestContacts = new Set<Promise<unknown>>();
  private tail: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  private drained?: Promise<void>;
  private stopping = false;
  private unknownGuest = false;
  private stopOrigin?: LocalSpace;
  private confirmingStop?: Promise<void>;
  private space?: LocalSpace;
  private policy?: LocalPolicy;
  private runtime?: LocalVmRuntime;
  private cleanupRuntime?: LocalVmRuntime;
  private admission?: Promise<void>;
  private admissionComplete = false;
  private admittedGenerationValue = 0;
  private createdRuntimeId?: string;
  private managementTail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly records: LocalRecords,
    readonly id: string,
    private readonly protectRuntime: (closure?: boolean) => Promise<void>,
    private readonly prepareCredentials: () => Promise<void>,
    private readonly loadAssets: typeof guestAssets = guestAssets,
  ) {}

  get active(): boolean {
    return !this.stopping;
  }
  get unknownIdentity(): boolean {
    return !this.space?.runtimeId;
  }
  get generation(): number {
    return this.space?.generation ?? 0;
  }
  get admittedGeneration(): number {
    return this.admittedGenerationValue;
  }
  get admitted(): boolean {
    return this.admissionComplete;
  }

  private readonly run: RunProcess = (request) => {
    const signal = request.signal
      ? AbortSignal.any([request.signal, this.controller.signal])
      : this.controller.signal;
    const child = (async () => {
      if (
        request.binary === this.policy?.runtime.binary ||
        (request.binary === process.execPath && request.argv[0] === runtimeApiAsset())
      )
        await this.protectRuntime();
      return runProcess({ ...request, signal });
    })();
    this.children.add(child);
    void child.then(
      () => this.children.delete(child),
      () => this.children.delete(child),
    );
    return child;
  };
  private readonly cleanupRun: RunProcess = (request) => {
    const child = (async () => {
      if (
        request.binary === this.policy?.runtime.binary ||
        (request.binary === process.execPath && request.argv[0] === runtimeApiAsset())
      )
        await this.protectRuntime(true);
      return runProcess({ ...request, signal: this.cleanupController.signal });
    })();
    this.children.add(child);
    void child.then(
      () => this.children.delete(child),
      () => this.children.delete(child),
    );
    return child;
  };

  admit(activate = false): Promise<void> {
    this.admission ??= this.initialize(activate);
    return this.admission;
  }

  private async initialize(activate: boolean): Promise<void> {
    this.space = (await this.records.get(this.id)) ?? undefined;
    this.policy = await this.records.policy();
    if (!this.space)
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "This sandbox has no local work admission.");
    this.policy = policyForSpace(this.policy, this.space);
    if (this.space.failure === "LOCAL_GUEST_SETTLEMENT_UNKNOWN")
      throw new LocalRefusal(
        "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
        "Acknowledge the retained unknown outcome locally before admitting new work.",
      );
    if (
      this.space.failure === "LOCAL_SETUP_INCOMPLETE" ||
      ((this.space.phase === "usable" || this.space.phase === "stopped") &&
        this.space.lastStartedAt === null)
    )
      throw new LocalRefusal(
        "LOCAL_SETUP_INCOMPLETE",
        "Guest preparation did not finish. Delete this codespace after confirmed cleanup, then create a new one.",
      );
    requireSpaceGrant(this.policy, this.space, Date.now());
    if (activate) {
      if (this.space.phase !== "usable" && this.space.phase !== "stopped")
        throw new LocalRefusal(
          "LOCAL_SETUP_INCOMPLETE",
          "Inspect incomplete local initialization.",
        );
      if (this.space.desiredState !== "running") {
        this.space.desiredState = "running";
        this.space.generation++;
        await this.records.put(this.space);
      }
    }
    if (this.space.desiredState !== "running")
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "This sandbox has no local work admission.");
    this.admittedGenerationValue = this.space.generation;
    await this.protectRuntime();
    this.runtime = createLocalVmRuntime(this.policy, {
      run: this.run,
      prepareCredentials: this.prepareCredentials,
    });
    await this.prepareCredentials();
    this.cleanupRuntime = createLocalVmRuntime(this.policy, {
      run: this.cleanupRun,
      prepareCredentials: this.prepareCredentials,
    });
    await this.prepareCredentials();
    this.admissionComplete = true;
  }

  private async current(): Promise<{
    space: LocalSpace;
    policy: LocalPolicy;
    runtime: LocalVmRuntime;
  }> {
    await this.admission;
    if (this.stopping || !this.space || !this.policy)
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "The independent work guard is stopping.");
    const space = await this.records.get(this.id);
    const configured = await this.records.policy();
    const policy = space ? policyForSpace(configured, space) : configured;
    if (
      !space ||
      space.runtimeId !== this.space.runtimeId ||
      space.repositoryId !== this.space.repositoryId ||
      space.operationMarker !== this.space.operationMarker ||
      space.desiredState !== "running"
    )
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "The locally owned sandbox changed.");
    requireSpaceGrant(policy, space, Date.now());
    if (
      policy.deviceId !== this.policy.deviceId ||
      JSON.stringify(policy.runtime) !== JSON.stringify(this.policy.runtime)
    )
      throw new LocalRefusal("LOCAL_RUNTIME_CHANGED", "The locally approved runtime changed.");
    if (!this.runtime)
      throw new LocalRefusal("LOCAL_GUARD_UNAVAILABLE", "The local runtime is not prepared.");
    if (this.stopping)
      throw new LocalRefusal("LOCAL_NOT_RUNNING", "The independent work guard is stopping.");
    this.space = space;
    return { space, policy, runtime: this.runtime };
  }

  async check(): Promise<number> {
    const { policy } = await this.current();
    return Math.max(1, Math.min(1000, policy.leaseUntil - Date.now()));
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.current();
      return work();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async persist(space: LocalSpace): Promise<void> {
    if (this.stopping) throw new LocalRefusal("LOCAL_CANCELLED", "Local work was stopped.");
    await this.records.put(space);
    this.space = space;
  }

  /** A lost exec response is not a guest cancellation receipt. Fence before settling its VM. */
  private async settleGuestResult<T>(result: Promise<T>): Promise<T> {
    try {
      return await result;
    } catch (error) {
      if (!(error instanceof LocalRefusal) || error.code !== "LOCAL_GUEST_SETTLEMENT_UNKNOWN")
        throw error;
      this.stopping = true;
      this.unknownGuest = true;
      this.controller.abort();
      await this.quiesce();
      const space = await this.records.get(this.id);
      if (!space || !this.space || space.runtimeId !== this.space.runtimeId)
        throw new LocalRefusal(
          "LOCAL_STOP_PENDING",
          "Unknown guest work has no confirmed VM identity.",
        );
      if (
        space.desiredState !== "stopped" ||
        (space.phase !== "failed" && space.phase !== "stopped") ||
        space.failure !== "LOCAL_GUEST_SETTLEMENT_UNKNOWN"
      )
        throw new LocalRefusal(
          "LOCAL_STOP_PENDING",
          "Unknown guest work has no durable stop fence.",
        );
      // Outside the serial work promise: stop() drains that promise without awaiting itself.
      await this.stop();
      await this.protectRuntime();
      throw error;
    }
  }

  prepare(): Promise<void> {
    return this.settleGuestResult(
      this.serial(async () => {
        const { space, policy, runtime } = await this.current();
        const repository = requireSpaceGrant(policy, space, Date.now());
        const clone = space.phase === "creating";
        await this.protectRuntime();
        if (!space.runtimeId) {
          if (!clone)
            throw new LocalRefusal("LOCAL_CREATE_UNKNOWN", "Inspect the pending local creation.");
          const identity = await runtime.create(space.name);
          // Capture the observed result even when stop arrived while creation settled.
          this.createdRuntimeId = identity.runtimeId;
          const created = { ...space, runtimeId: identity.runtimeId };
          await this.records.put(created);
          this.space = created;
          await this.protectRuntime();
          if (this.stopping)
            throw new LocalRefusal("LOCAL_CANCELLED", "Local creation was stopped.");
          space.runtimeId = identity.runtimeId;
        }
        const identity = { name: space.name, runtimeId: space.runtimeId };
        await runtime.start(identity);
        await this.protectRuntime();
        await runtime.boundary.verify(identity);
        const saved = await this.records.state.read(
          "broker.json",
          z.object({ port: z.number().int().min(1024).max(65535) }).strict().parse,
        );
        if (!saved) throw new LocalRefusal("LOCAL_NOT_RUNNING", "The local broker is unavailable.");
        if (space.networkPolicy) await this.boundary(space, runtime);
        else {
          space.networkPolicy = await runtime.boundary.configureNetwork(identity, saved.port);
          await this.persist(space);
        }
        const assets = await this.loadAssets();
        await installGuest(runtime, identity, assets);
        const latest = await this.current();
        let gitAuthor = policy.gitAuthor ?? null;
        if (
          !gitAuthor &&
          (repository.private || repository.allowPush || repository.allowPullRequests === true) &&
          (await this.records.state.read("connection.json", (value) => value))
        )
          gitAuthor = await new LocalRelay(this.records).gitIdentity(
            space.id,
            space.repositoryId,
            this.controller.signal,
          );
        const output = await runtime.runFixedGuest(
          identity,
          "worker",
          Buffer.from(
            JSON.stringify({
              kind: "bootstrap",
              request: {
                proxySource: assets.proxy,
                hostPort: saved.port,
                spaceId: space.id,
                brokerToken: space.brokerToken,
                repository: repository.fullName,
                ref: space.ref,
                clone,
                gitAuthor,
              },
            }),
          ),
          Math.min(300_000, latest.policy.leaseUntil - Date.now()),
          this.controller.signal,
        );
        z.object({ ok: z.literal(true), result: z.unknown() })
          .strict()
          .parse(JSON.parse(output.toString("utf8")));
        await this.current();
        space.phase = "usable";
        space.lastStartedAt = Date.now();
        space.failure = null;
        await this.persist(space);
      }),
    );
  }

  private async boundary(space: LocalSpace, runtime: LocalVmRuntime): Promise<void> {
    if (!space.runtimeId)
      throw new LocalRefusal("LOCAL_CREATE_UNKNOWN", "No confirmed runtime identity.");
    const identity = { name: space.name, runtimeId: space.runtimeId };
    if (!space.networkPolicy)
      throw new LocalRefusal("LOCAL_NETWORK_CHANGED", "The sandbox network policy changed.");
    await runtime.boundary.verify(identity, space.networkPolicy);
  }

  operation(value: unknown): Promise<Buffer> {
    const contact = (async () => {
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > MAX_MESSAGE_BYTES - 1024)
        throw new LocalRefusal(
          "LOCAL_REQUEST_TOO_LARGE",
          "Guest operation input exceeds its bound.",
        );
      const request = operation.parse(value);
      const { space, policy, runtime } = await this.current();
      const repository = requireSpaceGrant(policy, space, Date.now());
      if (request.repositoryFullName !== repository.fullName)
        throw new LocalRefusal(
          "LOCAL_REPOSITORY_DENIED",
          "Operation repository differs from local admission.",
        );
      if (space.phase !== "usable" || !space.runtimeId)
        throw new LocalRefusal("LOCAL_NOT_RUNNING", "This local sandbox is not initialized.");
      if (request.action === "execute") {
        request.timeoutMs = requireOperationExecutionBudget(
          request.timeoutMs,
          request.maxRetainedBytes,
          policy.leaseUntil - Date.now(),
        );
        requireOperationOutputBudget(request.maxStdoutBytes, request.maxStderrBytes);
      }
      const identity = { name: space.name, runtimeId: space.runtimeId };
      await this.protectRuntime();
      if (!space.networkPolicy)
        throw new LocalRefusal(
          "LOCAL_NETWORK_CHANGED",
          "The sandbox network policy is unconfirmed.",
        );
      const latest = await this.current();
      return runtime.runFixedGuest(
        identity,
        "worker",
        Buffer.from(JSON.stringify({ kind: "operation", request })),
        Math.min(LOCAL_WORKER_REQUEST_TIMEOUT_MS, latest.policy.leaseUntil - Date.now()),
        this.controller.signal,
        {
          expectedNetworkDigest: space.networkPolicy,
          confirm: async () => {
            const admitted = await this.current();
            if (
              admitted.space.phase !== "usable" ||
              admitted.space.networkPolicy !== space.networkPolicy
            )
              throw new LocalRefusal(
                "LOCAL_NETWORK_CHANGED",
                "The local dispatch receipt changed during verification.",
              );
          },
        },
      );
    })();
    this.guestContacts.add(contact);
    void contact.then(
      () => this.guestContacts.delete(contact),
      () => this.guestContacts.delete(contact),
    );
    return contact;
  }

  validate(): Promise<void> {
    return this.serial(async () => {
      const { space, runtime } = await this.current();
      if (space.phase !== "usable" || !space.runtimeId)
        throw new LocalRefusal("LOCAL_NOT_RUNNING", "This sandbox is not initialized.");
      await this.protectRuntime();
      if (
        (await runtime.inspectExact({ name: space.name, runtimeId: space.runtimeId }))?.status !==
        "running"
      )
        throw new LocalRefusal("LOCAL_NOT_RUNNING", "The owned sandbox is stopped.");
      await this.boundary(space, runtime);
    });
  }

  quiesce(emergency = false): Promise<void> {
    this.stopping = true;
    this.controller.abort();
    if (emergency) this.cleanupController.abort();
    this.drained ??= (async () => {
      await Promise.allSettled([...this.children]);
      await Promise.allSettled([...this.guestContacts]);
      await this.admission?.catch(() => undefined);
      await this.tail;
      const space = this.space;
      const policy = this.policy;
      if (!space || !policy) return;
      this.stopOrigin = { ...space };
      if (!space.runtimeId && this.createdRuntimeId) space.runtimeId = this.createdRuntimeId;
      if (space.desiredState === "running") {
        space.desiredState = "stopped";
        space.generation++;
      }
      if (this.unknownGuest) {
        space.phase = "failed";
        space.failure = "LOCAL_GUEST_SETTLEMENT_UNKNOWN";
      }
      if (!space.runtimeId) {
        space.phase = "failed";
        space.failure = "LOCAL_CREATE_UNKNOWN";
      }
      await this.records.put(space);
    })();
    return this.drained.then(async () => {
      await Promise.allSettled([...this.children]);
    });
  }

  confirmStopped(): Promise<void> {
    // Space-level stop and device-level shutdown can confirm the same physical settlement.
    this.confirmingStop ??= this.confirmStoppedReceipt().finally(() => {
      this.confirmingStop = undefined;
    });
    return this.confirmingStop;
  }

  private async confirmStoppedReceipt(): Promise<void> {
    if (
      this.space?.runtimeId &&
      this.space.phase !== "deleting" &&
      this.space.phase !== "deleted"
    ) {
      const current = await this.records.get(this.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(spaceSchema.parse(this.space)))
        throw new LocalRefusal(
          "LOCAL_GENERATION_CONFLICT",
          "The local stop receipt changed before confirmation.",
        );
      const before = this.stopOrigin;
      const incomplete =
        before?.phase === "creating" ||
        (before?.phase === "failed" && before.lastStartedAt === null);
      this.space.phase = incomplete ? "failed" : "stopped";
      // Physical closure is not guest readiness. A failed bootstrap keeps its provenance
      // in the existing failure field, so a later start cannot resume it as initialized.
      if (incomplete && this.space.failure === null) this.space.failure = "LOCAL_SETUP_INCOMPLETE";
      if (
        (before?.phase === "usable" || before?.phase === "stopped") &&
        before.desiredState === "running" &&
        before.failure === null &&
        before.runtimeId &&
        before.networkPolicy &&
        this.space.generation === before.generation + 1 &&
        this.space.desiredState === "stopped" &&
        this.space.failure === null &&
        (
          [
            "id",
            "runtimeId",
            "name",
            "repositoryId",
            "operationMarker",
            "ref",
            "createdAt",
            "networkPolicy",
            "brokerToken",
          ] as const
        ).every((key) => this.space![key] === before[key])
      ) {
        // This is the same authoritative stopped-generation proof used by explicit recovery.
        // A later start advances generation, so this receipt cannot admit a subsequent change.
        this.space.recoveryGeneration = this.space.generation;
      }
      await this.records.put(this.space);
    }
  }

  async settleManagement(): Promise<void> {
    await this.managementTail;
  }

  /** Local acknowledgement rebinds a verified stopped VM, never retries retained work. */
  recover(generation: number): Promise<number> {
    const work = this.managementTail
      .catch(() => undefined)
      .then(async () => {
        const space = await this.records.get(this.id);
        const configured = await this.records.policy();
        const policy = space ? policyForSpace(configured, space) : configured;
        if (!space || space.generation !== generation)
          throw new LocalRefusal("LOCAL_GENERATION_CONFLICT", "The recovery target changed.");
        requireSpaceGrant(policy, space, Date.now());
        if (
          !space.runtimeId ||
          space.desiredState !== "stopped" ||
          space.phase !== "stopped" ||
          (space.failure !== null && space.failure !== "LOCAL_GUEST_SETTLEMENT_UNKNOWN")
        )
          throw new LocalRefusal(
            "LOCAL_RECOVERY_REFUSED",
            "Recovery requires an initialized stopped VM with no failure or a retained unknown guest outcome.",
          );
        await this.protectRuntime();
        this.space = space;
        this.policy = policy;
        const runtime = createLocalVmRuntime(policy, {
          run: this.cleanupRun,
          prepareCredentials: this.prepareCredentials,
        });
        if (
          (await runtime.inspectExact({ name: space.name, runtimeId: space.runtimeId }))?.status !==
          "stopped"
        )
          throw new LocalRefusal(
            "LOCAL_STOP_PENDING",
            "Recovery requires the exact VM to remain stopped.",
          );
        await this.boundary(space, runtime);
        await this.protectRuntime();
        const current = await this.records.get(this.id);
        const latest = policyForSpace(await this.records.policy(), space);
        requireSpaceGrant(latest, space, Date.now());
        if (
          !current ||
          JSON.stringify(current) !== JSON.stringify(space) ||
          latest.deviceId !== policy.deviceId ||
          JSON.stringify(latest.runtime) !== JSON.stringify(policy.runtime)
        )
          throw new LocalRefusal(
            "LOCAL_GENERATION_CONFLICT",
            "The recovery admission changed during verification.",
          );
        const recovered = {
          ...space,
          generation: generation + 1,
          recoveryGeneration: generation + 1,
          failure: null,
        };
        await this.records.put(recovered);
        this.space = recovered;
        this.stopping = true;
        return recovered.generation;
      });
    this.managementTail = work;
    return work;
  }

  manage(generation: number, remove: boolean, localApproval = false): Promise<void> {
    let admitted = false;
    const work = this.managementTail
      .catch(() => undefined)
      .then(async () => {
        let space = await this.records.get(this.id);
        const configured = await this.records.policy();
        const policy = space ? policyForSpace(configured, space) : configured;
        if (!space || space.generation !== generation)
          throw new LocalRefusal(
            "LOCAL_GENERATION_CONFLICT",
            "The local sandbox generation changed.",
          );
        if (remove && !localApproval) {
          const repository = requireSpaceGrant(policy, space, Date.now());
          if (!repository.allowDelete)
            throw new LocalRefusal(
              "LOCAL_DELETE_APPROVAL_REQUIRED",
              "Approve this sandbox deletion locally.",
            );
        }
        await this.protectRuntime(true);
        // Preserve the active owner's captured create result until its calls have drained.
        this.space ??= space;
        this.policy = policy;
        this.cleanupRuntime ??= createLocalVmRuntime(policy, {
          run: this.cleanupRun,
          prepareCredentials: this.prepareCredentials,
        });
        if (space.phase === "deleted") {
          const deletedName = space.name;
          const present = space.runtimeId
            ? await this.cleanupRuntime.inspectExact({
                name: space.name,
                runtimeId: space.runtimeId,
              })
            : (await this.cleanupRuntime.list()).find((item) => item.name === deletedName);
          if (present)
            throw new LocalRefusal(
              "LOCAL_IDENTITY_CHANGED",
              "A deleted local sandbox has a surviving runtime identity.",
            );
          return;
        }
        admitted = true;
        if (space.desiredState !== "running") {
          // An explicit management request is a new local stop intent even when an
          // older record already requested stop. Never authorize retirement from that old generation.
          space.generation++;
          await this.records.put(space);
          this.space = space;
        }
        await this.quiesce();
        space = await this.records.get(this.id);
        if (!space || !this.space || JSON.stringify(space) !== JSON.stringify(this.space))
          throw new LocalRefusal(
            "LOCAL_GENERATION_CONFLICT",
            "The local management target changed during settlement.",
          );
        const runtime = this.cleanupRuntime;
        const identity = space.runtimeId ? { name: space.name, runtimeId: space.runtimeId } : null;
        if (identity) {
          await runtime.stop(identity);
          const current = await runtime.inspectExact(identity);
          if (current && current.status !== "stopped" && current.status !== "created")
            throw new LocalRefusal("LOCAL_STOP_PENDING", "The sandbox stop is not confirmed.");
        } else if ((await runtime.list()).some((item) => item.name === space!.name)) {
          // A same-name VM without our captured UUID cannot be adopted, stopped, or removed.
          throw new LocalRefusal(
            "LOCAL_CREATE_UNKNOWN",
            "Creation settled without a captured VM identity; the saved name is occupied. Inspect this computer's pending creation.",
          );
        } else {
          space.desiredState = "stopped";
          space.phase = "stopped";
          space.failure = null;
          await this.records.put(space);
          this.space = space;
        }
        await this.protectRuntime();
        await this.confirmStopped();
        if (!remove) return;
        if (this.cleanupController.signal.aborted)
          throw new LocalRefusal("LOCAL_CANCELLED", "Deletion was interrupted.");
        space.desiredState = "deleted";
        space.phase = "deleting";
        await this.records.put(space);
        this.space = space;
        if (identity) await runtime.remove(identity);
        const remaining = identity
          ? await runtime.inspectExact(identity)
          : (await runtime.list()).find((item) => item.name === space!.name);
        if (remaining)
          throw new LocalRefusal(
            "LOCAL_STOP_PENDING",
            "The exact local sandbox deletion is not confirmed.",
          );
        if (this.cleanupController.signal.aborted)
          throw new LocalRefusal("LOCAL_CANCELLED", "Deletion outcome is unknown.");
        space.phase = "deleted";
        space.generation++;
        await this.records.put(space);
        this.space = space;
      })
      .catch(async (error: unknown) => {
        const current = await this.records.get(this.id);
        if (
          admitted &&
          error instanceof LocalRefusal &&
          current &&
          this.space &&
          current.generation > generation &&
          current.desiredState !== "running" &&
          JSON.stringify(current) === JSON.stringify(this.space)
        ) {
          throw new LocalRefusal(
            error.code,
            error.message,
            localManagementOutcomeSchema.parse({
              spaceId: this.id,
              repositoryId: current.repositoryId,
              operationMarker: current.operationMarker,
              originGeneration: generation,
              generation: current.generation,
              action: remove ? "delete" : "stop",
            }),
          );
        }
        throw error;
      });
    this.managementTail = work;
    return work;
  }

  stop(): Promise<void> {
    this.closing ??= (async () => {
      await this.quiesce();
      const space = this.space;
      const policy = this.policy;
      if (!space || !policy) return;
      const runtime =
        this.cleanupRuntime ??
        createLocalVmRuntime(policy, {
          run: this.cleanupRun,
          prepareCredentials: this.prepareCredentials,
        });
      if (space.runtimeId) {
        const identity = { name: space.name, runtimeId: space.runtimeId };
        await runtime.stop(identity);
        const current = await runtime.inspectExact(identity);
        if (current && current.status !== "stopped" && current.status !== "created")
          throw new LocalRefusal("LOCAL_STOP_PENDING", "Native sandbox shutdown has not settled.");
        await this.protectRuntime();
        await this.confirmStopped();
      }
    })();
    return this.closing;
  }
}
