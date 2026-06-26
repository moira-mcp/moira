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

// ===== Marketplace =====

export type MarketplaceSort = "recent" | "rating" | "installs" | "trending";

export interface MarketplaceListing {
  id: string;
  workflowId: string;
  title: string;
  summary: string | null;
  category: string;
  tags: string; // JSON string[]
  status: string;
  verified: boolean;
  featured: boolean;
  ratingAvg: number;
  ratingCount: number;
  installCount: number;
  startCount: number;
  isPaid: boolean;
  price: number | null;
  currency: string | null;
  publishedAt: string;
  updatedAt: string;
}

export type MarketplaceGalleryItem = MarketplaceListing & {
  ownerHandle: string | null;
  slug: string;
};

export interface MarketplaceGalleryPage {
  items: MarketplaceGalleryItem[];
  total: number;
  limit: number;
  offset: number;
  sort: MarketplaceSort;
}

export interface MarketplaceEntitlement {
  accessible: boolean;
  reason: "free" | "paid-coming-soon" | "purchase-required";
}

export interface MarketplaceListingDetail {
  listing: MarketplaceListing;
  workflowId: string;
  workflow: WorkflowGraph;
  ownerHandle: string;
  startRef: string;
  entitlement: MarketplaceEntitlement;
}

export interface MarketplaceReview {
  id: string;
  stars: number;
  reviewText: string | null;
  authorHandle: string | null;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Origin of a library item (mirrors the backend `LibraryOrigin`). */
export type LibraryOrigin = "own" | "added" | "shared";

/**
 * Filterable library source (the single "Your library" surface's chip set, mirrors the
 * backend `LibrarySourceFilter`):
 *   - all      — every item.
 *   - official — items owned by an official system account (`official === true`).
 *   - added    — origin "added" (marketplace flows + seeded official base flows).
 *   - mine     — origin "own" (the user's own workflows).
 *   - shared   — origin "shared" (flows shared with the user).
 */
export type LibrarySourceFilter = "all" | "official" | "added" | "mine" | "shared";

export interface MarketplaceLibraryItem {
  origin: LibraryOrigin;
  workflowId: string | null;
  slug: string;
  name: string;
  ownerHandle: string | null;
  /** True when the flow is owned by an official system account (drives the Official badge). */
  official: boolean;
  kind?: "reference" | "copy";
  listingId?: string | null;
}

export interface MarketplaceGalleryQuery {
  search?: string;
  category?: string;
  tag?: string;
  sort?: MarketplaceSort;
  limit?: number;
  offset?: number;
}

export interface PublishListingRequest {
  workflowId: string;
  category?: string;
  tags?: string[];
  title?: string;
  summary?: string | null;
}

export interface RateListingResult {
  ratingAvg: number;
  ratingCount: number;
}

export type DeploymentMode = "self-host" | "saas";

export type FeatureFlag =
  | "openRegistration"
  | "emailVerificationGate"
  | "verificationEmailOnSignup"
  | "legalConsents"
  | "betaNotices"
  | "multiUserAdmin"
  | "socialLogin"
  | "paidWorkflows"
  | "marketplace";

export interface FeaturesResponse {
  deploymentMode: DeploymentMode;
  features: Record<FeatureFlag, boolean>;
  /**
   * MCP endpoint URL resolved at runtime from the server's own host config,
   * e.g. "http://localhost:8077/mcp". Used in self-host so the displayed MCP
   * URL matches the actual host/port instead of a build-time-baked value.
   */
  mcpUrl: string;
  /**
   * Public hosted marketplace promotion gate. `promotionEnabled` is true on every
   * instance that is not itself the canonical store (so self-host promotes the
   * store regardless of the local marketplace flag), false on the store itself.
   * `url` is the store address to link to.
   */
  publicStore: {
    promotionEnabled: boolean;
    url: string;
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
  /** "Mine" origin: restrict to the user's own workflows (exclude others' public + shared). */
  ownedOnly?: boolean;
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
