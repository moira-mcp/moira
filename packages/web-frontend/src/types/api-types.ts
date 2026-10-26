/**
 * API communication type definitions for the frontend
 */

import type {
  CodespaceConnectionView,
  CodespacePublicReadinessView,
  CodespaceReadinessView,
  CodespaceSummaryView,
  CodespaceUnavailableResourceView,
  CodespaceProviderErrorView,
  CodespaceDiscoveryView,
} from "@mcp-moira/shared";
import type { WorkspaceReference } from "@mcp-moira/shared/workspace-references";

export interface ManagedWorkspaceView extends Omit<
  CodespaceSummaryView,
  "generation" | "pending_request_ids"
> {
  workspace: string;
  controller?: string;
  pending_operations: string[];
}
export interface WorkspaceOperationView {
  operation: string;
  kind?: string;
  state: "pending" | "accepted" | "completed" | "unconfirmed" | "absent";
  original?: unknown;
  descriptor?: { kind: string; description?: string; createdAt?: number };
  outcome?:
    { ok: true; result?: unknown } | { ok: false; error: { code: string; message: string } };
  error?: { code: string; message: string };
  observation_error?: { code: string };
}

export type WorkspaceDiscoveryProvider = WorkspaceReference["provider"];
export type WorkspaceDiscoveryView = CodespaceDiscoveryView;
/** One provider/view observation; billing has its own read boundary. */
export interface CodespaceTargetsView {
  provider: WorkspaceDiscoveryProvider;
  readiness?: CodespaceReadinessView;
  connection?: CodespaceConnectionView;
  repositories: Array<{
    repository_id: string;
    name: string;
    private: boolean;
    provider?: string;
    device_id?: string;
    device_label?: string;
    target: string;
    controller: string;
  }>;
  repositories_stale: boolean;
  provider_errors?: CodespaceProviderErrorView[];
  controllers?: Array<{
    device_id: string;
    label: string;
    available?: boolean;
    controller: string;
  }>;
}

export interface CodespaceManagementView {
  provider: WorkspaceDiscoveryProvider;
  has_diagnostics: boolean;
  resources_stale: boolean;
  codespaces: ManagedWorkspaceView[];
  unavailable?: Array<
    Omit<CodespaceUnavailableResourceView, "pending_request_ids"> & {
      identity: string;
      pending_operations: string[];
    }
  >;
  provider_errors?: CodespaceProviderErrorView[];
}
import { WorkflowValidationStatus } from "./react-flow-types.js";
import { WorkflowGraph, ValidationResult, WorkflowFileInfo } from "./workflow-types.js";

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  timestamp: string;
}

export type DeploymentMode = "self-host" | "saas";

export type FeatureFlag =
  | "openRegistration"
  | "accountApproval"
  | "emailVerificationGate"
  | "verificationEmailOnSignup"
  | "legalConsents"
  | "betaNotices"
  | "multiUserAdmin"
  | "userManagement"
  | "adminAnalytics"
  | "adminOperations"
  | "operationsDevelopment"
  | "socialLogin";

export interface FeaturesResponse {
  deploymentMode: DeploymentMode;
  features: Record<FeatureFlag, boolean>;
  /**
   * MCP endpoint URL resolved at runtime from the server's own host config,
   * e.g. "http://localhost:8077/mcp". Used in self-host so the displayed MCP
   * URL matches the actual host/port instead of a build-time-baked value.
   */
  mcpUrl: string;
  emailDelivery: {
    state: "real" | "test" | "unavailable" | "configuration-error";
    provider: "smtp" | "brevo" | "test" | null;
    available: boolean;
    reason: string | null;
  };
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string;
  timestamp?: string;
}

export const ApiErrorCode = {
  WORKFLOW_NOT_FOUND: "WORKFLOW_NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  FILE_READ_ERROR: "FILE_READ_ERROR",
  INVALID_FORMAT: "INVALID_FORMAT",
  FOLDER_NOT_FOUND: "FOLDER_NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  INVALID_REQUEST: "INVALID_REQUEST",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export interface HealthCheckResponse {
  status: "ok" | "degraded" | "error";
  services: {
    fileSystem: boolean;
    validation: boolean;
    mcpEngine: boolean;
    workflowReconciliation: boolean;
    codespaces: boolean;
  };
  codespaces?: CodespacePublicReadinessView;
  reconciliation: {
    status: "ok" | "error";
    code: string;
    conflicts: unknown[];
  };
  uptime: number;
  timestamp: string;
  version: string;
}

export interface AdminSystemStatusResponse {
  totalDefinitions: number;
  systemHealth: {
    backendStatus: string;
    databaseSize: number;
    codespaces?: CodespaceReadinessView;
    workflowReconciliation: {
      status: "ok" | "error";
      code: string;
      conflicts: Array<{
        owner: string;
        slug: string;
        classification: string;
        instruction: string;
        candidateRefs: {
          previous: string | null;
          current: string;
          incoming: string;
        };
      }>;
    };
  };
}

export interface AdminStatsResponse extends AdminSystemStatusResponse {
  totalWorkflows: number;
  totalExecutions: number;
  activeExecutions: number;
  recentActivity: Array<{
    id: string;
    workflowId: string;
    status: string;
    displayStatus?: import("@mcp-moira/shared/execution-management").OverviewStatus;
    stopReason?: string | null;
    timestamp: number | null;
    action: string;
  }>;
}

export interface WorkflowListRequest {
  validationStatus?: "valid" | "invalid" | "unknown" | "all";
  search?: string;
  /** Exact slugs: only workflows with one of them are listed. */
  slugs?: string[];
  visibility?: "public" | "private" | "all";
  /** Whose workflows: mine, shared with me, the public catalog, or all readable ones. */
  access?: "all" | "mine" | "shared" | "catalog";
  sort?: "createdAt" | "name";
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface WorkflowListResponse {
  workflows: WorkflowFileInfo[];
  totalWorkflows: number;
  validWorkflows: number;
  invalidWorkflows: number;
  lastScan: number;
}

export interface WorkflowDetailRequest {
  includeValidation?: boolean;
  layoutOptions?: {
    algorithm?: "dagre" | "manual" | "force";
    direction?: "TB" | "BT" | "LR" | "RL";
  };
}

export interface WorkflowDetailResponse {
  workflow: WorkflowGraph;
  validation: WorkflowValidationStatus;
  fileInfo: WorkflowFileInfo;
}

export interface WorkflowValidationRequest {
  workflowData?: WorkflowGraph;
}

export interface WorkflowValidationResponse {
  validation: WorkflowValidationStatus;
  details: ValidationResult;
  nodeValidations: Record<
    string,
    {
      isValid: boolean;
      errors: string[];
      warnings: string[];
      suggestions?: string[];
    }
  >;
}

export interface RawWorkflowResponse {
  raw: string;
  parsed: WorkflowGraph;
  fileInfo: {
    path: string;
    size: number;
    lastModified: number;
  };
}

export interface ServerConfigResponse {
  workflowDirectories: string[];
  defaultFolders: string[];
  serverPort: number;
  environment: "development" | "production";
  features: {
    caching: boolean;
    fileWatching: boolean;
    authentication: boolean;
  };
}

export interface ApiClientError extends Error {
  code: ApiErrorCode;
  status?: number;
  response?: {
    data?: ApiResponse;
    status: number;
    statusText: string;
  };
}

// ==================== Workflow Sharing Types ====================

export interface WorkflowInvite {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  remainingMs: number;
  usedAt?: number | null;
  usedBy?: string | null;
  usedByHandle?: string | null;
}

export interface WorkflowAccess {
  userId: string;
  handle: string | null;
  name: string | null;
  grantedAt: number;
  grantedBy: string;
  grantedByHandle: string | null;
}

export interface CreateInviteResponse {
  invite: {
    id: string;
    token: string;
    expiresAt: number;
    remainingMs: number;
  };
  inviteUrl: string;
}

export interface ListInvitesResponse {
  invites: WorkflowInvite[];
  total: number;
  hasMore: boolean;
}

export interface ListAccessResponse {
  users: WorkflowAccess[];
  total: number;
  hasMore: boolean;
}

export interface InviteInfoResponse {
  valid: boolean;
  expired: boolean;
  used: boolean;
  workflowName: string;
  createdByHandle: string | null;
  expiresAt: number;
  remainingMs: number;
}

export interface AcceptInviteResponse {
  accessId: string;
  workflowId: string;
  message: string;
}
