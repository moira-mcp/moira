/**
 * API types for web-backend
 * Local types for the Express API server
 */

import { WorkflowGraph } from "@mcp-moira/workflow-engine";

// Base API response wrapper
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: ApiError;
  timestamp: string;
}

// API error structure
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  stack?: string; // Only in development
  timestamp?: string; // Error occurrence time
}

// Standard error codes
export const ApiErrorCode = {
  WORKFLOW_NOT_FOUND: "WORKFLOW_NOT_FOUND",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  FILE_READ_ERROR: "FILE_READ_ERROR",
  INVALID_FORMAT: "INVALID_FORMAT",
  FOLDER_NOT_FOUND: "FOLDER_NOT_FOUND",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  INVALID_REQUEST: "INVALID_REQUEST",
  // Slug/Handle error codes
  SLUG_CONFLICT: "SLUG_CONFLICT",
  INVALID_SLUG: "INVALID_SLUG",
  USER_NOT_FOUND: "USER_NOT_FOUND",
  HANDLE_CONFLICT: "HANDLE_CONFLICT",
  INVALID_HANDLE: "INVALID_HANDLE",
  ACCESS_DENIED: "ACCESS_DENIED",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

// Health check endpoint
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

// Workflow validation summary (for list endpoint - cached data)
export interface WorkflowValidationSummary {
  isValid: boolean;
  status: "valid" | "invalid" | "unknown";
  errors: string[];
}

// Workflow validation status (for detail endpoint - full validation)
export interface WorkflowValidationStatus {
  isValid: boolean;
  nodeValidation: Record<
    string,
    {
      isValid: boolean;
      errors: string[];
      warnings: string[];
    }
  >;
  globalErrors: string[];
  globalWarnings: string[];
}

// Workflow list item (for list endpoint with cached validation)
export interface WorkflowListItem {
  id: string;
  slug: string;
  ownerHandle: string;
  ownerName: string;
  visibility: "public" | "private";
  accessType: "public" | "owner" | "shared";
  filePath: string;
  metadata: WorkflowGraph["metadata"];
  validation: WorkflowValidationSummary;
  lastModified: number;
  fileSize: number;
}

// Workflow file information (for detail endpoints with full validation)
export interface WorkflowFileInfo {
  id: string;
  slug: string;
  ownerHandle: string;
  ownerName: string;
  visibility: "public" | "private";
  accessType?: "public" | "owner" | "shared";
  filePath: string;
  metadata: WorkflowGraph["metadata"];
  validation: WorkflowValidationStatus;
  lastModified: number;
  fileSize: number;
}

// Workflow list responses
export interface WorkflowListResponse {
  workflows: WorkflowListItem[];
  totalWorkflows: number;
  validWorkflows: number;
  invalidWorkflows: number;
  lastScan: number;
}

// Workflow detail request/response
export interface WorkflowListRequest {
  validationStatus?: "valid" | "invalid" | "unknown" | "all";
  search?: string;
  visibility?: "public" | "private" | "all";
  sort?: "createdAt" | "name";
  sortOrder?: "asc" | "desc";
  limit?: string;
  offset?: string;
}

export interface WorkflowDetailRequest {
  includeValidation?: boolean;
  layoutOptions?: {
    algorithm?: "dagre" | "manual" | "force";
    direction?: "TB" | "BT" | "LR" | "RL";
  };
  offset?: number;
  limit?: number;
}

export interface WorkflowVisualizationData {
  nodes: unknown[];
  edges: unknown[];
  metadata: {
    workflowId: string;
    workflowName: string;
    nodeCount: number;
    edgeCount: number;
    validationStatus: string;
    lastModified: number;
  };
}

export interface WorkflowDetailResponse {
  workflow: WorkflowGraph;
  validation: WorkflowValidationStatus;
  fileInfo: WorkflowFileInfo;
}

// Validation request/response
export interface WorkflowValidationRequest {
  workflowData?: WorkflowGraph;
}

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
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

// Raw workflow response
export interface RawWorkflowResponse {
  raw: string;
  parsed: WorkflowGraph;
  fileInfo: {
    path: string;
    size: number;
    lastModified: number;
  };
}

// Server configuration
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
