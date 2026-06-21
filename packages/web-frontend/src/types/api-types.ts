/**
 * API communication type definitions for the frontend
 */

import { WorkflowValidationStatus } from "./react-flow-types";
import { WorkflowGraph, ValidationResult, WorkflowFileInfo } from "./workflow-types";

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  timestamp: string;
}

export type DeploymentMode = "self-host" | "saas";

export type FeatureFlag =
  | "openRegistration"
  | "emailVerificationGate"
  | "verificationEmailOnSignup"
  | "legalConsents"
  | "betaNotices"
  | "multiUserAdmin"
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
  status: "ok" | "error";
  services: {
    fileSystem: boolean;
    validation: boolean;
    mcpEngine: boolean;
  };
  uptime: number;
  timestamp: string;
  version: string;
}

export interface WorkflowListRequest {
  validationStatus?: "valid" | "invalid" | "warning" | "all";
  search?: string;
  visibility?: "public" | "private" | "all";
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
