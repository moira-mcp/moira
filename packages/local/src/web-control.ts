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
import { controlApprovalSchema as approvalSchema } from "./control-approval.js";

type ControlIdentity = {
  origin: string;
  userId?: string;
  deviceId: string;
  deviceGeneration?: number;
  connectionId?: string;
};

function assertApprovalIdentity(
  approval: z.infer<typeof approvalSchema>,
  identity: ControlIdentity,
): void {
  if (
    (["origin", "userId", "deviceId", "deviceGeneration", "connectionId"] as const).some(
      (key) => approval[key] !== identity[key],
    )
  )
    throw new LocalRefusal(
      "LOCAL_IDENTITY_CHANGED",
      "The web-control approval belongs to another server or owner.",
    );
}

export function controlSettings(
  policy: LocalPolicy,
  delegation: AgentRepositoryManagement | null = policy.agentRepositoryManagement,
): LocalDeviceSettingsValue {
  return localDeviceSettingsSchema.parse({
    label: policy.label,
    enabled: policy.enabled,
    cpuCores: policy.runtime.cpuCores,
    memoryBytes: policy.runtime.memoryBytes,
    storageBytes: policy.runtime.maxStorageBytes,
    dockerBytes: policy.runtime.dockerBytes,
    repositories: policy.repositories,
    gitAuthor: policy.gitAuthor ?? null,
    agentRepositoryManagement: delegation,
  });
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
    identity: ControlIdentity,
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
      ceiling = localControlCeilingSchema.parse(ceiling);
      const policy = await this.records.policy();
      assertLocalControlSettings({ ...controlSettings(policy), enabled: false }, ceiling);
      const previous = await this.records.state.read("web-control.json", approvalSchema.parse);
      if (previous) assertApprovalIdentity(previous, identity);
      await this.records.state.write(
        "web-control.json",
        approvalSchema.parse(
          previous
            ? { ...previous, ceiling }
            : {
                origin: identity.origin,
                userId: identity.userId,
                deviceId: identity.deviceId,
                deviceGeneration: identity.deviceGeneration,
                connectionId: identity.connectionId,
                ceiling,
              },
        ),
      );
    } finally {
      await release();
    }
  }
  async report(
    identity: ControlIdentity,
    observedPolicy?: LocalPolicy,
  ): Promise<LocalControlReport | undefined> {
    const approval = await this.records.state.read("web-control.json", approvalSchema.parse);
    if (!approval) return undefined;
    assertApprovalIdentity(approval, identity);
    const policy = observedPolicy ?? (await this.records.policy());
    return {
      ceiling: approval.ceiling,
      settings: controlSettings(policy),
      appliedRevision: policy.appliedRevision,
      ...(approval.rejectedRevision && approval.rejectedRevision > policy.appliedRevision
        ? { rejectedRevision: approval.rejectedRevision, error: approval.error }
        : {}),
    };
  }
  async hasUnsettledEffect(): Promise<boolean> {
    if (await this.records.state.read("policy-transition.json", (value) => value)) return true;
    const intent = await this.records.state.read("control-intent.json", (value) =>
      z.object({ revision: z.number().int().positive() }).passthrough().parse(value),
    );
    if (!intent) return false;
    // The durable owner receipt proves completion; retiring its final intent
    // requires no native effect and does not retry an unknown transition.
    if (intent.revision <= (await this.records.policy()).appliedRevision) {
      await this.records.state.remove("control-intent.json");
      return false;
    }
    return true;
  }
  async apply(
    view: LocalDeviceControlView | undefined,
    manager: LocalManager,
    kind: "settings" | "repository" = "settings",
  ): Promise<boolean | "live"> {
    const approval = await this.records.state.read("web-control.json", approvalSchema.parse);
    const currentPolicy = await this.records.policy();
    const intentSchema = z
      .object({
        revision: z.number().int().positive(),
        settings: localDeviceSettingsSchema,
        livePrevious: localPolicySchema.optional(),
        previousDelegation: agentRepositoryManagementSchema.nullable().optional(),
      })
      .strict();
    await this.hasUnsettledEffect();
    const intent = approval
      ? await this.records.state.read("control-intent.json", intentSchema.parse)
      : null;
    if (
      !approval ||
      !view ||
      view.revision <= currentPolicy.appliedRevision ||
      view.revision === approval.rejectedRevision
    )
      return false;
    if (!view.optedIn || JSON.stringify(view.ceiling) !== JSON.stringify(approval.ceiling))
      throw new LocalRefusal(
        "LOCAL_CONTROL_CONFLICT",
        "The server cannot replace a local web-control envelope.",
      );
    const previousPolicy = intent?.livePrevious ?? currentPolicy;
    const previousDelegation = intent?.livePrevious
      ? (intent.previousDelegation ?? null)
      : currentPolicy.agentRepositoryManagement;
    const delegatedRequest = kind === "repository";
    const live = isLiveLocalSettingsChange(
      controlSettings(previousPolicy, previousDelegation),
      view.settings,
    );
    let effectStarted = false;
    try {
      if (delegatedRequest && !live)
        throw new LocalRefusal(
          "LOCAL_CONTROL_CONFLICT",
          "Delegated admission cannot alter existing local settings.",
        );
      assertLocalControlSettings(view.settings, approval.ceiling);
      // Persist intent before any native effect; retry only this same revision/settings.
      const retrySettings = (settings: LocalDeviceSettingsValue) => ({
        ...settings,
        enabled: false,
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
        if (delegatedRequest) {
          const stable = (settings: LocalDeviceSettingsValue) => ({
            ...settings,
            repositories: [],
          });
          if (
            JSON.stringify(stable(controlSettings(previousPolicy, previousDelegation))) !==
              JSON.stringify(stable(view.settings)) ||
            additions.length !== 1 ||
            previousPolicy.repositories.some(
              (repository, index) =>
                JSON.stringify(repository) !== JSON.stringify(view.settings.repositories[index]),
            )
          )
            throw new LocalRefusal(
              "LOCAL_CONTROL_CONFLICT",
              "Delegated admission may only append its exact repository grant.",
            );
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
        }
        await this.records.state.write("control-intent.json", {
          revision: view.revision,
          settings: view.settings,
          livePrevious: previousPolicy,
          previousDelegation,
        });
        effectStarted = true;
        await manager.applyLivePolicy(previousPolicy, {
          ...previousPolicy,
          appliedRevision: view.revision,
          agentRepositoryManagement: view.settings.agentRepositoryManagement,
          label: view.settings.label,
          gitAuthor: view.settings.gitAuthor,
          runtime: {
            ...previousPolicy.runtime,
            cpuCores: view.settings.cpuCores,
            memoryBytes: view.settings.memoryBytes,
            dockerBytes: view.settings.dockerBytes,
          },
          repositories: view.settings.repositories,
        });
        const receipt = view.repositoryAdmissions?.find(
          (entry) => entry.revision === view.revision,
        );
        if (delegatedRequest && receipt && !approval.repositoryRequests.includes(receipt.requestId))
          approval.repositoryRequests.push(receipt.requestId);
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
        appliedRevision: view.revision,
        agentRepositoryManagement: s.agentRepositoryManagement,
        label: s.label,
        enabled: s.enabled,
        gitAuthor: s.gitAuthor,
        runtime: {
          ...policy.runtime,
          cpuCores: s.cpuCores,
          memoryBytes: s.memoryBytes,
          maxStorageBytes: s.storageBytes,
          dockerBytes: s.dockerBytes,
        },
        repositories: s.repositories,
      });
      await (this.dependencies.replacePolicy ?? replaceStoppedPolicy)(this.records, next);
      delete approval.rejectedRevision;
      delete approval.error;
      await this.records.state.write("web-control.json", approval);
      await this.records.state.remove("control-intent.json");
      return true;
    } catch (error) {
      if (
        error instanceof LocalRefusal &&
        ["LOCAL_STORAGE_SIZE", "LOCAL_STORAGE_FULL"].includes(error.code) &&
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
