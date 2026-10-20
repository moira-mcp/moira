import { z } from "zod";
import {
  LocalRecords,
  spaceSchema,
  policyForSpace,
  requireSpaceGrant,
  workspaceRemoteObservationSchema,
  requireSetupRecovery,
  type LocalSpace,
} from "./space-record.js";
import { LocalRelay, LocalDeviceAuthorityFailure, localConnectionSchema } from "./relay.js";
import { controllerIdentitySchema } from "../../shared/src/codespaces/local-controller-protocol.js";
import {
  localManagementOutcomeSchema,
  workspaceSetupFailureSchema,
} from "../../shared/src/codespaces/local-protocol.js";
import type { LocalVmRuntime } from "./local-vm-runtime.js";
import { createLocalVmRuntime } from "./local-vm-runtime-factory.js";
import { runProcess, type RunProcess, type ProcessRequest, type ProcessResult } from "./process.js";
import { guestAssets, installGuest, runtimeApiAsset, type GuestAssets } from "./assets.js";
import { LocalRefusal, type LocalPolicy } from "./policy.js";

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
  private releasing = false;
  private readonly preparations = new Set<Promise<void>>();
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
  private assets?: Promise<GuestAssets>;
  private enrollment?: Promise<void>;

  private ownerAssets(): Promise<GuestAssets> {
    this.assets ??= this.loadAssets().catch((error) => {
      this.assets = undefined;
      throw error;
    });
    return this.assets;
  }

  constructor(
    readonly records: LocalRecords,
    readonly id: string,
    private readonly protectRuntime: (closure?: boolean) => Promise<void>,
    private readonly prepareCredentials: () => Promise<void>,
    private readonly loadAssets: typeof guestAssets = guestAssets,
    private readonly readRuntime?: (
      space: LocalSpace,
      request: ProcessRequest,
    ) => Promise<ProcessResult | undefined>,
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
  get preparing(): boolean {
    return this.preparations.size > 0;
  }

  private readonly run: RunProcess = (request) => {
    const signal = request.signal
      ? AbortSignal.any([request.signal, this.controller.signal])
      : this.controller.signal;
    const child = (async () => {
      if (
        request.binary === this.policy?.runtime.binary ||
        (request.binary === process.execPath && request.argv[0] === runtimeApiAsset())
      ) {
        if (this.readRuntime && this.space) {
          const observation = await this.readRuntime(this.space, { ...request, signal });
          if (observation) return observation;
        }
        await this.protectRuntime();
        await this.current();
      }
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

  admit(activate: boolean | "resume-setup" = false): Promise<void> {
    this.admission ??= this.initialize(activate);
    return this.admission;
  }

  private async initialize(activate: boolean | "resume-setup"): Promise<void> {
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
    const resume = activate === "resume-setup";
    if (resume) requireSetupRecovery(this.space);
    if (
      !resume &&
      (this.space.failure === "LOCAL_SETUP_INCOMPLETE" ||
        ((this.space.phase === "usable" || this.space.phase === "stopped") &&
          this.space.lastStartedAt === null))
    )
      throw new LocalRefusal(
        "LOCAL_SETUP_INCOMPLETE",
        "Guest preparation did not finish. Resume setup on this same codespace explicitly.",
      );
    requireSpaceGrant(this.policy, this.space);
    if (resume) {
      this.space = {
        ...this.space,
        desiredState: "running",
        generation: this.space.generation + 1,
      };
      await this.records.put(this.space);
    } else if (activate) {
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
    if (space.generation !== this.space.generation)
      throw new LocalRefusal(
        "LOCAL_GENERATION_CONFLICT",
        "The independent work admission changed.",
      );
    requireSpaceGrant(policy, space);
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
    await this.current();
    return 1000;
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
      if (this.releasing) throw error;
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
    const work = this.settleGuestResult(
      this.serial(async () => {
        const { space, policy, runtime } = await this.current();
        const repository = requireSpaceGrant(policy, space);
        const clone = space.lastStartedAt === null;
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
        const assets = await this.ownerAssets();
        await installGuest(runtime, identity, assets, this.controller.signal);
        await this.current();
        let gitAuthor = policy.gitAuthor ?? null;
        if (!gitAuthor) {
          const cached = await this.records.state.read(
            `controller-git-identity-${space.id}.json`,
            (value) =>
              z
                .object({
                  repositoryId: z.literal(space.repositoryId),
                  runtimeId: z.literal(space.runtimeId),
                  author: z.object({ name: z.string().min(1), email: z.string().email() }).strict(),
                })
                .strict()
                .parse(value),
          );
          gitAuthor = cached?.author ?? null;
        }
        if (
          clone &&
          !gitAuthor &&
          repository.private &&
          (await this.records.state.read("connection.json", (value) => value))
        ) {
          gitAuthor = await new LocalRelay(this.records).gitIdentity(
            space.id,
            space.repositoryId,
            this.controller.signal,
          );
          await this.records.state.write(`controller-git-identity-${space.id}.json`, {
            repositoryId: space.repositoryId,
            runtimeId: space.runtimeId,
            author: gitAuthor,
          });
        }
        const output = await runtime.runFixedGuest(
          identity,
          "bootstrap",
          Buffer.from(
            JSON.stringify({
              proxySource: assets.proxy,
              hostPort: saved.port,
              spaceId: space.id,
              operationMarker: space.operationMarker,
              brokerToken: space.brokerToken,
              repository: repository.fullName,
              ref: space.ref,
              clone,
              gitAuthor,
            }),
          ),
          null,
          this.controller.signal,
        );
        const setup = z
          .discriminatedUnion("ok", [
            z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
            z.object({ ok: z.literal(false), reason: workspaceSetupFailureSchema }).strict(),
          ])
          .parse(JSON.parse(output.toString("utf8")));
        if (!setup.ok) {
          await this.current();
          await this.persist({ ...space, setupFailure: setup.reason });
          const remedies = {
            repository_unproven:
              "The existing repository was preserved because its setup ownership is not proved. Inspect it locally before recovery.",
            prerequisite_unavailable:
              "Safe repository publication requires Linux Python3, libc renameat2 and filesystem no-replace support.",
            repository_checkout_failed:
              "Repository preparation did not complete. Repair the repository access or requested ref, then resume this same setup.",
            configuration_failed:
              "Fixed guest configuration did not complete. Inspect local prerequisite diagnostics before resuming this same setup.",
          };
          throw new LocalRefusal("LOCAL_SETUP_INCOMPLETE", remedies[setup.reason]);
        }
        const probe = z
          .object({
            environmentIdentity: z.string().regex(/^[a-f0-9]{64}$/),
            architecture: z.string(),
          })
          .strict()
          .parse(
            JSON.parse(
              (
                await runtime.runFixedGuest(
                  identity,
                  "probe",
                  undefined,
                  30_000,
                  this.controller.signal,
                )
              ).toString("utf8"),
            ),
          );
        const authority = await this.remoteAuthority();
        // Local Unix readiness precedes optional cloud enrollment. The daemon's
        // existing reconciliation will acquire authority outside work lanes.
        const connection = authority.connection;
        const remoteState = connection?.authorityRefused ? "refused" : "unconfigured";
        const configureLocal =
          space.lastStartedAt === null ||
          space.failure !== null ||
          space.workspaceReadiness?.release !== assets.payload.release ||
          space.workspaceReadiness?.environmentIdentity !== probe.environmentIdentity;
        if (configureLocal)
          await runtime.runFixedGuest(
            identity,
            "configure",
            Buffer.from(
              JSON.stringify({
                version: 1,
                repositoryFullName: repository.fullName,
                root: `/workspaces/${repository.fullName.split("/")[1]}`,
                expectedOrigin: `http://${space.id}:${space.brokerToken}@127.0.0.1:3437/git/${repository.fullName}.git`,
                environmentIdentity: probe.environmentIdentity,
                mode: "local-only",
                remoteState,
              }),
            ),
            30_000,
            this.controller.signal,
          );
        await runtime.runFixedGuest(
          identity,
          "start-service",
          undefined,
          null,
          this.controller.signal,
        );
        const observed = await this.waitWorkspaceHealth(
          runtime,
          identity,
          probe.environmentIdentity,
          assets.payload.release,
        );
        await this.current();
        space.phase = "usable";
        space.lastStartedAt = Date.now();
        space.failure = null;
        space.remote = observed;
        if (configureLocal) space.remoteAuthority = authority.identity;
        space.workspaceReadiness = {
          release: assets.payload.release,
          environmentIdentity: probe.environmentIdentity,
        };
        delete space.setupFailure;
        await this.persist(space);
      }),
    );
    this.preparations.add(work);
    void work.finally(() => this.preparations.delete(work)).catch(() => undefined);
    return work;
  }

  private async waitWorkspaceHealth(
    runtime: LocalVmRuntime,
    identity: { name: string; runtimeId: string },
    environmentIdentity: string,
    releaseIdentity: string,
  ): Promise<LocalSpace["remote"]> {
    const value = JSON.parse(
      (
        await runtime.runFixedGuest(identity, "health", undefined, 30_000, this.controller.signal)
      ).toString("utf8"),
    );
    if (
      value.environmentIdentity !== environmentIdentity ||
      value.releaseIdentity !== releaseIdentity
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "Workspace readiness belongs to another release or guest.",
      );
    return value.remote === undefined
      ? undefined
      : workspaceRemoteObservationSchema.parse(value.remote);
  }

  private async remoteAuthority() {
    const connection = await this.records.state.read(
      "connection.json",
      localConnectionSchema.parse,
    );
    const identity = controllerIdentitySchema.safeParse(connection);
    return { identity: identity.success ? identity.data : undefined, connection };
  }

  /** Re-enroll an already ready Unix owner; never clone, start a VM, or retry a command. */
  refreshRemote(): Promise<void> {
    if (this.enrollment) return this.enrollment;
    const work = this.refreshEnrollment().finally(() => {
      if (this.enrollment === work) this.enrollment = undefined;
    });
    this.enrollment = work;
    return work;
  }

  private async refreshEnrollment(): Promise<void> {
    const captured = await this.serial(async () => {
      const admission = await this.current();
      const runtime = admission.runtime;
      let space = admission.space;
      if (space.phase !== "usable" || space.failure !== null || !space.runtimeId) return;
      const identity = { name: space.name, runtimeId: space.runtimeId };
      const release =
        space.workspaceReadiness?.release ?? (await this.ownerAssets()).payload.release;
      const health = JSON.parse(
        (
          await runtime.runFixedGuest(identity, "health", undefined, 30_000, this.controller.signal)
        ).toString("utf8"),
      );
      if (health.releaseIdentity !== release || !/^[a-f0-9]{64}$/.test(health.environmentIdentity))
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "Workspace readiness belongs to another release or guest.",
        );
      const observed =
        health.remote === undefined
          ? undefined
          : workspaceRemoteObservationSchema.parse(health.remote);
      if (!observed) return;
      const authority = await this.remoteAuthority();
      const sameAuthority =
        JSON.stringify(space.remoteAuthority) === JSON.stringify(authority.identity);
      if (
        sameAuthority &&
        ["connecting", "connected", "unavailable", "refused"].includes(observed.state)
      ) {
        ({ space } = await this.current());
        if (JSON.stringify(space.remote) !== JSON.stringify(observed))
          await this.persist({ ...space, remote: observed });
        return;
      }
      const { policy } = await this.current();
      const repository = requireSpaceGrant(policy, space);
      const probe = z
        .object({
          environmentIdentity: z.literal(health.environmentIdentity),
          architecture: z.string(),
        })
        .strict()
        .parse(
          JSON.parse(
            (
              await runtime.runFixedGuest(
                identity,
                "probe",
                undefined,
                30_000,
                this.controller.signal,
              )
            ).toString("utf8"),
          ),
        );
      return { space, repository, probe, release, authority, runtime, identity };
    });
    if (!captured) return;
    const { space: original, repository, probe, release, authority, runtime, identity } = captured;
    let remote: Awaited<ReturnType<LocalRelay["workspaceCredential"]>> | undefined,
      remoteState: "unconfigured" | "enrollment_unavailable" | "refused" = "unconfigured";
    try {
      remote = await new LocalRelay(this.records).workspaceCredential(
        original.id,
        original.repositoryId,
        probe.environmentIdentity,
        this.controller.signal,
      );
    } catch (error) {
      if (error instanceof LocalDeviceAuthorityFailure) remoteState = "refused";
      else if (error instanceof LocalRefusal && error.code === "LOCAL_RELAY_UNAVAILABLE")
        remoteState = "enrollment_unavailable";
      else if (!(
        error instanceof LocalRefusal &&
        error.code === "LOCAL_NOT_ENROLLED" &&
        (await this.records.state.read("connection.json", localConnectionSchema.parse)) === null
      ))
        throw error;
    }
    // A cloud response has no right to enter a newer local generation or a
    // replacement controller authority. Only this short effect owns the lane.
    await this.serial(async () => {
      const { space, policy } = await this.current();
      if (
        space.generation !== original.generation ||
        space.runtimeId !== original.runtimeId ||
        space.repositoryId !== original.repositoryId ||
        space.operationMarker !== original.operationMarker ||
        space.phase !== "usable" ||
        space.failure !== null
      )
        throw new LocalRefusal(
          "LOCAL_GENERATION_CONFLICT",
          "Workspace enrollment belongs to an older local admission.",
        );
      requireSpaceGrant(policy, space);
      if (JSON.stringify(await this.remoteAuthority()) !== JSON.stringify(authority))
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "Workspace enrollment authority changed while acquiring its credential.",
        );
      await runtime.runFixedGuest(
        identity,
        "configure",
        Buffer.from(
          JSON.stringify({
            version: 1,
            repositoryFullName: repository.fullName,
            root: `/workspaces/${repository.fullName.split("/")[1]}`,
            expectedOrigin: `http://${space.id}:${space.brokerToken}@127.0.0.1:3437/git/${repository.fullName}.git`,
            environmentIdentity: probe.environmentIdentity,
            ...(remote ? { remote } : { mode: "local-only", remoteState }),
          }),
        ),
        30_000,
        this.controller.signal,
      );
      const observed = await this.waitWorkspaceHealth(
        runtime,
        identity,
        probe.environmentIdentity,
        release,
      );
      const current = await this.current();
      if (JSON.stringify(await this.remoteAuthority()) !== JSON.stringify(authority))
        throw new LocalRefusal(
          "LOCAL_IDENTITY_CHANGED",
          "Workspace enrollment authority changed during configuration.",
        );
      await this.persist({
        ...current.space,
        remote: observed,
        remoteAuthority: authority.identity,
        workspaceReadiness: { release, environmentIdentity: probe.environmentIdentity },
      });
    });
  }

  private async boundary(space: LocalSpace, runtime: LocalVmRuntime): Promise<void> {
    if (!space.runtimeId)
      throw new LocalRefusal("LOCAL_CREATE_UNKNOWN", "No confirmed runtime identity.");
    const identity = { name: space.name, runtimeId: space.runtimeId };
    if (!space.networkPolicy)
      throw new LocalRefusal("LOCAL_NETWORK_CHANGED", "The sandbox network policy changed.");
    await runtime.boundary.verify(identity, space.networkPolicy);
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

  /** Observer/service loss cannot replace the saved physical intent with a stop. */
  async release(): Promise<void> {
    this.releasing = true;
    this.stopping = true;
    this.controller.abort();
    this.cleanupController.abort();
    await Promise.allSettled([...this.children, ...this.guestContacts]);
    await this.admission?.catch(() => undefined);
    await this.tail.catch(() => undefined);
    await Promise.allSettled([...this.preparations]);
    await this.managementTail.catch(() => undefined);
    if (this.unknownGuest && this.space) {
      const current = await this.records.get(this.id);
      if (
        current &&
        current.runtimeId === this.space.runtimeId &&
        current.operationMarker === this.space.operationMarker &&
        current.generation === this.space.generation &&
        current.desiredState === "running"
      )
        await this.records.put({
          ...current,
          phase: "failed",
          failure: "LOCAL_GUEST_SETTLEMENT_UNKNOWN",
        });
    }
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
        requireSpaceGrant(policy, space);
        const incomplete =
          space.lastStartedAt === null &&
          space.phase === "failed" &&
          space.failure === "LOCAL_GUEST_SETTLEMENT_UNKNOWN";
        if (
          !space.runtimeId ||
          space.desiredState !== "stopped" ||
          (space.phase !== "stopped" && !incomplete) ||
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
        requireSpaceGrant(latest, space);
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
          failure: incomplete ? "LOCAL_SETUP_INCOMPLETE" : null,
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
          const repository = requireSpaceGrant(policy, space);
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
