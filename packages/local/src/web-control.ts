import { z } from "zod";
import {
  localControlCeilingSchema,
  localDeviceSettingsSchema,
  assertLocalControlSettings,
  type LocalControlCeiling,
  type LocalDeviceControlView,
  type LocalControlReport,
  type LocalDeviceSettingsValue,
  agentRepositoryManagementSchema,
  assertAgentRepositoryAdmission,
  isLiveLocalSettingsChange,
  type AgentRepositoryManagement,
} from "../../shared/src/codespaces/local-management-types.js";
import { LocalRecords } from "./space-record.js";
import { LocalManager } from "./manager.js";
import { localPolicySchema, LocalRefusal, type LocalPolicy } from "./policy.js";
import { replaceStoppedPolicy } from "./guard.js";
import { resizeStorage } from "./storage.js";
import type { LocalRelay } from "./relay.js";
import { LocalRpc } from "./rpc.js";

const approvalSchema = z
  .object({
    origin: z.string().url(),
    userId: z.string().min(1),
    deviceId: z.string().uuid(),
    deviceGeneration: z.number().int().positive(),
    connectionId: z.string().uuid(),
    ceiling: localControlCeilingSchema,
    appliedRevision: z.number().int().nonnegative(),
    agentRepositoryManagement: agentRepositoryManagementSchema.nullable().default(null),
    repositoryRequests: z.array(z.string().uuid()).max(64).default([]),
    rejectedRevision: z.number().int().positive().optional(),
    error: z.object({ code: z.string(), message: z.string() }).strict().optional(),
  })
  .strict();

export function controlSettings(
  policy: LocalPolicy,
  delegation: AgentRepositoryManagement | null = null,
): LocalDeviceSettingsValue {
  return localDeviceSettingsSchema.parse({
    label: policy.label,
    enabled: policy.enabled,
    leaseUntil: policy.leaseUntil,
    cpuCores: policy.runtime.cpuCores,
    memoryBytes: policy.runtime.memoryBytes,
    storageBytes: policy.runtime.maxStorageBytes,
    dockerBytes: policy.runtime.dockerBytes,
    ...policy.limits,
    repositories: policy.repositories,
    gitAuthor: policy.gitAuthor ?? null,
    agentRepositoryManagement: delegation,
  });
}
/** Keep management alive without an SDK owner while work is disabled or expired. */
export class LocalCompanion {
  private opened = false;
  private readonly rpc: LocalRpc;
  constructor(
    readonly manager: LocalManager,
    readonly relay: LocalRelay,
    readonly control = new LocalWebControl(manager.records),
  ) {
    this.rpc = new LocalRpc(manager);
  }
  async pause(): Promise<void> {
    await this.manager.stopWork();
    this.opened = false;
  }
  async cycle(signal?: AbortSignal): Promise<boolean> {
    await this.manager.holdRunnerLock();
    const local = await this.manager.records.policy();
    if ((!local.enabled || local.leaseUntil <= Date.now()) && this.opened) await this.pause();
    await this.relay.confirmed(signal);
    const applied = await this.control.apply(this.relay.control, this.manager);
    if (applied) {
      if (applied === true) this.opened = false;
      await this.relay.confirmed(signal);
    }
    const policy = await this.manager.records.policy();
    if (!policy.enabled || policy.leaseUntil <= Date.now()) {
      if (this.opened) await this.pause();
      return false;
    }
    if (!this.opened) {
      await this.manager.open();
      this.opened = true;
    }
    await this.relay.poll(this.rpc, signal);
    return true;
  }
}
export class LocalWebControl {
  constructor(
    readonly records: LocalRecords,
    private readonly dependencies: {
      replacePolicy?: typeof replaceStoppedPolicy;
      resize?: typeof resizeStorage;
    } = {},
  ) {}
  async optIn(
    identity: {
      origin: string;
      userId?: string;
      deviceId: string;
      deviceGeneration?: number;
      connectionId?: string;
    },
    ceiling: LocalControlCeiling,
    confirmed: boolean,
  ): Promise<void> {
    if (!confirmed)
      throw new LocalRefusal(
        "LOCAL_CONTROL_CONFIRM",
        "Confirm web control and its finite ceiling on this computer.",
      );
    const release = await this.records.state.lock();
    try {
      const policy = await this.records.policy();
      assertLocalControlSettings(
        { ...controlSettings(policy), enabled: false },
        ceiling,
        Date.now(),
      );
      const previous = await this.records.state.read("web-control.json", approvalSchema.parse);
      if (previous)
        throw new LocalRefusal(
          "LOCAL_CONTROL_CONFLICT",
          "Web control is already approved; inspect the existing approval before replacing it.",
        );
      await this.records.state.write(
        "web-control.json",
        approvalSchema.parse({
          origin: identity.origin,
          userId: identity.userId,
          deviceId: identity.deviceId,
          deviceGeneration: identity.deviceGeneration,
          connectionId: identity.connectionId,
          ceiling,
          appliedRevision: 0,
        }),
      );
    } finally {
      await release();
    }
  }
  async report(identity: {
    origin: string;
    userId?: string;
    deviceId: string;
    deviceGeneration?: number;
    connectionId?: string;
  }): Promise<LocalControlReport | undefined> {
    const approval = await this.records.state.read("web-control.json", approvalSchema.parse);
    if (!approval) return undefined;
    if (
      (["origin", "userId", "deviceId", "deviceGeneration", "connectionId"] as const).some(
        (key) => approval[key] !== identity[key],
      )
    )
      throw new LocalRefusal(
        "LOCAL_IDENTITY_CHANGED",
        "The web-control approval belongs to another server or owner.",
      );
    return {
      ceiling: approval.ceiling,
      settings: controlSettings(await this.records.policy(), approval.agentRepositoryManagement),
      appliedRevision: approval.appliedRevision,
      ...(approval.rejectedRevision
        ? { rejectedRevision: approval.rejectedRevision, error: approval.error }
        : {}),
    };
  }
  async apply(
    view: LocalDeviceControlView | undefined,
    manager: LocalManager,
  ): Promise<boolean | "live"> {
    const approval = await this.records.state.read("web-control.json", approvalSchema.parse);
    const intentSchema = z
      .object({
        revision: z.number().int().positive(),
        settings: localDeviceSettingsSchema,
        livePrevious: localPolicySchema.optional(),
        previousDelegation: agentRepositoryManagementSchema.nullable().optional(),
      })
      .strict();
    let intent = approval
      ? await this.records.state.read("control-intent.json", intentSchema.parse)
      : null;
    // A persisted ACK proves completion even if interruption retained its final intent file.
    if (approval && intent && intent.revision <= approval.appliedRevision) {
      await this.records.state.remove("control-intent.json");
      intent = null;
    }
    if (
      !approval ||
      !view ||
      view.revision <= approval.appliedRevision ||
      view.revision === approval.rejectedRevision
    )
      return false;
    if (!view.optedIn || JSON.stringify(view.ceiling) !== JSON.stringify(approval.ceiling))
      throw new LocalRefusal(
        "LOCAL_CONTROL_CONFLICT",
        "The server cannot replace a local web-control envelope.",
      );
    const currentPolicy = await this.records.policy();
    const previousPolicy = intent?.livePrevious ?? currentPolicy;
    const previousDelegation = intent?.livePrevious
      ? (intent.previousDelegation ?? null)
      : approval.agentRepositoryManagement;
    const delegatedRequest =
      view.repositoryAdmissions?.some((entry) => entry.revision === view.revision) === true;
    const live =
      isLiveLocalSettingsChange(
        controlSettings(previousPolicy, previousDelegation),
        view.settings,
      ) &&
      (delegatedRequest ||
        JSON.stringify(previousDelegation) !==
          JSON.stringify(view.settings.agentRepositoryManagement) ||
        Boolean(intent?.livePrevious));
    let effectStarted = false;
    try {
      if (delegatedRequest && !live)
        throw new LocalRefusal(
          "LOCAL_CONTROL_CONFLICT",
          "Delegated admission cannot alter existing local settings.",
        );
      assertLocalControlSettings(view.settings, approval.ceiling, Date.now());
      // Persist intent before any native effect; retry only this same revision/settings.
      const retrySettings = (settings: LocalDeviceSettingsValue) => ({
        ...settings,
        enabled: false,
        leaseUntil: 0,
      });
      if (
        intent &&
        JSON.stringify(retrySettings(intent.settings)) !==
          JSON.stringify(retrySettings(view.settings))
      )
        throw new LocalRefusal(
          "LOCAL_CONTROL_PENDING",
          "A prior control effect still needs settlement; resubmit its same settings to finish it.",
        );
      if (live) {
        const additions = view.settings.repositories.slice(previousPolicy.repositories.length);
        if (additions.length) {
          if (
            JSON.stringify(previousDelegation) !==
            JSON.stringify(view.settings.agentRepositoryManagement)
          )
            throw new LocalRefusal(
              "LOCAL_CONTROL_CONFLICT",
              "A repository addition cannot change its agent authority.",
            );
          if (additions.length !== 1)
            throw new LocalRefusal(
              "LOCAL_CONTROL_CONFLICT",
              "Admit one verified repository request at a time.",
            );
          const receipt = view.repositoryAdmissions?.find(
            (entry) => entry.revision === view.revision,
          );
          if (
            !receipt ||
            receipt.deviceGeneration !== approval.deviceGeneration ||
            receipt.connectionId !== approval.connectionId ||
            receipt.localRepositoryId !== additions[0].id ||
            JSON.stringify(receipt.repository) !== JSON.stringify(additions[0])
          )
            throw new LocalRefusal(
              "LOCAL_CONTROL_CONFLICT",
              "Repository admission has no exact owner-bound receipt.",
            );
          assertAgentRepositoryAdmission(
            previousDelegation,
            additions[0],
            receipt.creationRequestId ? "created" : "existing",
          );
          if (
            !approval.repositoryRequests.includes(receipt.requestId) &&
            approval.repositoryRequests.length >= previousDelegation!.maxRepositories
          )
            throw new LocalRefusal(
              "LOCAL_CONTROL_CONFLICT",
              "The local repository delegation limit is reached.",
            );
        }
        await this.records.state.write("control-intent.json", {
          revision: view.revision,
          settings: view.settings,
          livePrevious: previousPolicy,
          previousDelegation,
        });
        effectStarted = true;
        await manager.appendRepositoryPolicy(previousPolicy, {
          ...previousPolicy,
          repositories: view.settings.repositories,
        });
        const receipt = view.repositoryAdmissions?.find(
          (entry) => entry.revision === view.revision,
        );
        if (additions.length && receipt && !approval.repositoryRequests.includes(receipt.requestId))
          approval.repositoryRequests.push(receipt.requestId);
        approval.agentRepositoryManagement = view.settings.agentRepositoryManagement;
        approval.appliedRevision = view.revision;
        delete approval.rejectedRevision;
        delete approval.error;
        await this.records.state.write("web-control.json", approval);
        await this.records.state.remove("control-intent.json");
        return "live";
      }
      await this.records.state.write("control-intent.json", {
        revision: view.revision,
        settings: view.settings,
      });
      await manager.stopWork();
      await manager.holdRunnerLock();
      const policy = await this.records.policy();
      if (
        (await this.records.list()).some(
          (space) => space.phase !== "deleted" && space.desiredState === "running",
        )
      )
        throw new LocalRefusal(
          "LOCAL_STOP_PENDING",
          "Own sandbox records have not confirmed shutdown.",
        );
      for (const space of await this.records.list())
        if (space.phase !== "deleted") {
          space.admittedMachine ??= {
            cpuCores: policy.runtime.cpuCores,
            memoryBytes: policy.runtime.memoryBytes,
            dockerBytes: policy.runtime.dockerBytes,
          };
          space.admittedRepositoryFullName ??= policy.repositories.find(
            (repo) => repo.id === space.repositoryId,
          )?.fullName;
          await this.records.put(space);
        }
      if (view.settings.storageBytes !== policy.runtime.maxStorageBytes)
        await (this.dependencies.resize ?? resizeStorage)(
          this.records.state,
          policy,
          view.settings.storageBytes,
        );
      const s = view.settings;
      const next = localPolicySchema.parse({
        ...policy,
        label: s.label,
        enabled: s.enabled,
        leaseUntil: s.leaseUntil,
        gitAuthor: s.gitAuthor,
        runtime: {
          ...policy.runtime,
          cpuCores: s.cpuCores,
          memoryBytes: s.memoryBytes,
          maxStorageBytes: s.storageBytes,
          dockerBytes: s.dockerBytes,
        },
        limits: {
          maxSandboxes: s.maxSandboxes,
          maxOperationMs: s.maxOperationMs,
          maxOutputBytes: s.maxOutputBytes,
          maxConcurrent: s.maxConcurrent,
          maxNetworkBytes: s.maxNetworkBytes,
          maxNetworkConnections: s.maxNetworkConnections,
        },
        repositories: s.repositories,
      });
      await (this.dependencies.replacePolicy ?? replaceStoppedPolicy)(this.records, next);
      approval.appliedRevision = view.revision;
      approval.agentRepositoryManagement = view.settings.agentRepositoryManagement;
      delete approval.rejectedRevision;
      delete approval.error;
      await this.records.state.write("web-control.json", approval);
      await this.records.state.remove("control-intent.json");
      return true;
    } catch (error) {
      if (
        error instanceof LocalRefusal &&
        ["LOCAL_STORAGE_SIZE", "LOCAL_STORAGE_FULL", "LOCAL_HOST_STORAGE_LOW"].includes(
          error.code,
        ) &&
        !(await this.records.state.read("storage-resize.json", (value) => value))
      )
        await this.records.state.remove("control-intent.json");
      if (!live || !effectStarted) approval.rejectedRevision = view.revision;
      approval.error = {
        code: error instanceof LocalRefusal ? error.code : "LOCAL_CONTROL_FAILED",
        message:
          error instanceof LocalRefusal
            ? error.message
            : "Local settings did not apply; inspect the device before admitting work.",
      };
      await this.records.state.write("web-control.json", approval);
      // Never claim a failed host/storage transition as applied.
      if (!live && !delegatedRequest) {
        const policy = await this.records.policy();
        policy.enabled = false;
        await this.records.state.write("policy.json", policy);
      }
      return false;
    }
  }
}
