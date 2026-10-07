import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  LocalDeviceError,
  LOCAL_BROWSER_DEVELOPMENT_DOMAINS,
  localRepositoryTargetId,
  type AgentRepositoryManagement,
  type LocalDeviceService,
  type LocalDeviceView,
} from "@mcp-moira/shared";

export interface VerifiedLocalGitHubRepository {
  githubUserId: string;
  owner: string;
  repositoryId: string;
  fullName: string;
  private: boolean;
  canRead: boolean;
  canPush: boolean;
}
export interface LocalRepositoryAdmissionResult {
  status: "pending" | "applied" | "rejected";
  device_id: string;
  request_id: string;
  revision: number;
  local_repository_id: string | null;
  error: { code: string; message: string } | null;
}
export const localRepositoryAdmissionInputSchema = z
  .object({
    deviceId: z.string().uuid(),
    repositoryId: z.string().regex(/^[1-9][0-9]*$/),
    requestId: z.string().uuid(),
  })
  .strict();

/** Only owner-applied consent and independently verified GitHub grants can produce local authority. */
export class LocalRepositoryAdmissionService {
  constructor(
    private readonly dependencies: {
      devices: LocalDeviceService;
      verifyAccount: (userId: string) => Promise<{ githubUserId: string; owner: string }>;
      verifyRepository: (
        userId: string,
        repositoryId: string,
      ) => Promise<VerifiedLocalGitHubRepository>;
      listInstallations?: (
        userId: string,
      ) => Promise<
        Array<{ installation_id: string; owner: string; repository_selection: "all" | "selected" }>
      >;
    },
  ) {}

  async validateOwner(userId: string, delegation: AgentRepositoryManagement | null): Promise<void> {
    if (!delegation) return;
    const account = await this.dependencies.verifyAccount(userId);
    if (
      account.githubUserId !== delegation.githubUserId ||
      account.owner.toLowerCase() !== delegation.owner.toLowerCase()
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Choose the current connected GitHub account for agent delegation.",
      );
  }

  async listDevices(userId: string) {
    const owned = this.dependencies.devices.listOwned(userId);
    let installations: Array<{
      installation_id: string;
      owner: string;
      repository_selection: "all" | "selected";
    }> = [];
    let githubSetupRequired = false;
    if (this.dependencies.listInstallations) {
      try {
        installations = await this.dependencies.listInstallations(userId);
        githubSetupRequired = installations.length === 0;
      } catch (error) {
        if (!(error instanceof LocalDeviceError)) throw error;
        githubSetupRequired = true;
      }
    }
    return {
      installations,
      github_setup_required: githubSetupRequired,
      devices: owned.devices.map((device) => ({
        device_id: device.deviceId,
        label: device.label,
        status: device.status,
        enabled: device.policy.enabled,
        lease_until: device.policy.leaseUntil,
        delegation: device.control?.appliedAgentRepositoryManagement ?? null,
        control_status: device.control?.status ?? "not-enabled",
        revision: device.control?.revision ?? 0,
        applied_revision: device.control?.appliedRevision ?? 0,
      })),
    };
  }

  private result(device: LocalDeviceView, requestId: string): LocalRepositoryAdmissionResult {
    const control = device.control!;
    const receipt = control.repositoryAdmissions!.find((entry) => entry.requestId === requestId)!;
    const granted = device.policy.repositories.find(
      (repository) => repository.id === receipt.localRepositoryId,
    );
    const applied =
      control.appliedRevision >= receipt.revision &&
      receipt.deviceGeneration === device.deviceGeneration &&
      receipt.connectionId === device.connectionId &&
      JSON.stringify(granted) === JSON.stringify(receipt.repository);
    const rejected =
      !applied &&
      (control.status === "rejected" ||
        control.revision > receipt.revision ||
        receipt.deviceGeneration !== device.deviceGeneration ||
        receipt.connectionId !== device.connectionId);
    return {
      status: applied ? "applied" : rejected ? "rejected" : "pending",
      device_id: device.deviceId,
      request_id: requestId,
      revision: receipt.revision,
      local_repository_id: applied
        ? localRepositoryTargetId(device.deviceId, receipt.localRepositoryId)
        : null,
      error: rejected
        ? (control.error ?? {
            code: "LOCAL_CONTROL_CONFLICT",
            message: "Repository admission was superseded or revoked.",
          })
        : null,
    };
  }

  async addExistingRepository(
    userId: string,
    value: z.infer<typeof localRepositoryAdmissionInputSchema>,
  ): Promise<LocalRepositoryAdmissionResult> {
    return this.addRepository(userId, value);
  }

  /** Only the internal creation lifecycle supplies provenance; the database verifies it. */
  async addCreatedRepository(
    userId: string,
    value: z.infer<typeof localRepositoryAdmissionInputSchema>,
    creationRequestId: string,
  ): Promise<LocalRepositoryAdmissionResult> {
    z.string().uuid().parse(creationRequestId);
    return this.addRepository(userId, value, creationRequestId);
  }

  private async addRepository(
    userId: string,
    value: z.infer<typeof localRepositoryAdmissionInputSchema>,
    creationRequestId?: string,
  ): Promise<LocalRepositoryAdmissionResult> {
    const input = localRepositoryAdmissionInputSchema.parse(value);
    let device = this.dependencies.devices.getActiveDevice(userId, input.deviceId);
    const previous = device.control?.repositoryAdmissions?.find(
      (entry) => entry.requestId === input.requestId,
    );
    if (previous) {
      if (previous.githubRepositoryId !== input.repositoryId)
        throw new LocalDeviceError("LOCAL_CONFLICT", "Repository request identity changed.");
      return this.result(device, input.requestId);
    }
    const delegation = device.control?.appliedAgentRepositoryManagement;
    if (
      !delegation ||
      !(creationRequestId ? delegation.allowNewPrivate : delegation.allowExistingPrivate)
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "Enable and apply limited agent repository management in Moira Settings first.",
      );
    const verified = await this.dependencies.verifyRepository(userId, input.repositoryId);
    device = this.dependencies.devices.getActiveDevice(userId, input.deviceId);
    const raced = device.control?.repositoryAdmissions?.find(
      (entry) => entry.requestId === input.requestId,
    );
    if (raced) {
      if (raced.githubRepositoryId !== input.repositoryId)
        throw new LocalDeviceError("LOCAL_CONFLICT", "Repository request identity changed.");
      return this.result(device, input.requestId);
    }
    if (
      JSON.stringify(device.control?.appliedAgentRepositoryManagement) !==
        JSON.stringify(delegation) ||
      verified.githubUserId !== delegation.githubUserId ||
      verified.owner.toLowerCase() !== delegation.owner.toLowerCase() ||
      verified.repositoryId !== input.repositoryId ||
      !verified.private ||
      !verified.canRead ||
      (delegation.allowPush && !verified.canPush)
    )
      throw new LocalDeviceError(
        "LOCAL_UNAUTHORIZED",
        "The repository or connected account exceeds the applied delegation.",
      );
    const added = this.dependencies.devices.requestRepositoryAdmission(userId, input.deviceId, {
      requestId: input.requestId,
      githubRepositoryId: input.repositoryId,
      deviceGeneration: device.deviceGeneration,
      expectedRevision: device.control!.revision,
      ...(creationRequestId ? { creationRequestId } : {}),
      repository: {
        id: randomUUID(),
        fullName: verified.fullName,
        private: true,
        allowPush: delegation.allowPush,
        allowDelete: false,
        allowPullRequests: false,
        domains: [...LOCAL_BROWSER_DEVELOPMENT_DOMAINS],
      },
    });
    return this.result(added, input.requestId);
  }
}
