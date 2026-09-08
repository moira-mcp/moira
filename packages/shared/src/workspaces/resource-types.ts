export const WORKSPACE_PROVIDER_CONTRACT_VERSION = 1 as const;

export interface WorkspaceRepositoryTarget {
  id: string;
  fullName: string;
  private: boolean;
}

export type WorkspaceResourceState =
  | "create_pending"
  | "create_submitted"
  | "usable"
  | "cleanup_pending"
  | "deleted"
  | "rejected"
  | "ambiguous";

export type WorkspaceProviderHealthState =
  "disabled" | "misconfigured" | "unavailable" | "available";

export interface WorkspaceMachine {
  name: string;
  displayName: string;
  operatingSystem: string;
  cpuCores: number;
  memoryBytes: number;
  storageBytes: number;
}

export interface WorkspaceProviderResource {
  name: string;
  displayName: string;
  ownerId: string;
  billableOwnerId: string;
  repositoryId: string;
  repositoryFullName: string;
  ref: string;
  state: "provisioning" | "available" | "shutdown" | "deleting" | "failed";
  machine: WorkspaceMachine | null;
  createdAt: number;
}

export type WorkspaceCreateProviderResult =
  | { outcome: "accepted"; resource: WorkspaceProviderResource | null }
  | { outcome: "rejected"; reason: string };

export interface WorkspaceProviderAdapter {
  readonly id: string;
  readonly contractVersion: typeof WORKSPACE_PROVIDER_CONTRACT_VERSION;
  readonly capabilities: Readonly<{
    disposable: boolean;
    exactLifecycle: boolean;
    personalBillingOnly: boolean;
    connector: string;
  }>;
  health(): Promise<{ state: WorkspaceProviderHealthState; reason: string | null }>;
  getIdentity(credential: string): Promise<{ id: string; login: string }>;
  listMachines(
    credential: string,
    repository: WorkspaceRepositoryTarget,
  ): Promise<WorkspaceMachine[]>;
  create(
    credential: string,
    input: {
      repository: WorkspaceRepositoryTarget;
      ref: string;
      machine: WorkspaceMachine;
      operationMarker: string;
      idleTimeoutMinutes: number;
      retentionMinutes: number;
    },
  ): Promise<WorkspaceCreateProviderResult>;
  listOwned(credential: string): Promise<WorkspaceProviderResource[]>;
  getExact(credential: string, resourceName: string): Promise<WorkspaceProviderResource | null>;
  stopExact(credential: string, resourceName: string): Promise<"accepted" | "absent">;
  deleteExact(credential: string, resourceName: string): Promise<"accepted" | "absent">;
  probeConnector(credential: string, resourceName: string): Promise<void>;
}

export interface WorkspaceResourcePolicy {
  enabled: boolean;
  maxCpuCores: number;
  maxMemoryBytes: number;
  maxStorageBytes: number;
  maxActivePerUser: number;
  maxActiveGlobal: number;
  maxOperationsPerDay: number;
  createThrottleMs: number;
  remoteTtlMs: number;
  createDeadlineMs: number;
  cleanupDeadlineMs: number;
  claimLeaseMs: number;
  reconcileIntervalMs: number;
}

export interface WorkspaceResourceRecord {
  id: string;
  userId: string;
  connectionId: string;
  provider: string;
  repositoryId: string;
  repositoryFullName: string;
  requestedRef: string;
  operationMarker: string;
  providerResourceName: string | null;
  externalOwnerId: string | null;
  billableOwnerId: string | null;
  machine: WorkspaceMachine;
  state: WorkspaceResourceState;
  generation: number;
  createDeadlineAt: number;
  remoteExpiresAt: number;
  cleanupDeadlineAt: number | null;
  claimId: string | null;
  claimExpiresAt: number | null;
  lastOutcome: string | null;
  createdAt: number;
  updatedAt: number;
}

export type WorkspaceResourceErrorCode =
  | "WORKSPACE_PROVIDER_DISABLED"
  | "WORKSPACE_PROVIDER_UNAVAILABLE"
  | "WORKSPACE_POLICY_LIMIT"
  | "WORKSPACE_CREATE_REJECTED"
  | "WORKSPACE_CREATE_PENDING"
  | "WORKSPACE_RESOURCE_INVALID"
  | "WORKSPACE_NOT_FOUND";

export class WorkspaceResourceError extends Error {
  constructor(
    public readonly code: WorkspaceResourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceResourceError";
  }
}
