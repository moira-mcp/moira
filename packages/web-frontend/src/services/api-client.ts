/* eslint-disable no-console */
/**
 * API Client Service
 * Type-safe HTTP client for backend communication
 *
 * Note: console.* used for browser debugging of API requests/responses
 */

import axios, { AxiosInstance, AxiosResponse, AxiosError } from "axios";
import {
  ApiResponse,
  ApiErrorCode,
  HealthCheckResponse,
  ServerConfigResponse,
  FeaturesResponse,
  WorkflowListResponse,
  WorkflowDetailResponse,
  WorkflowValidationResponse,
  RawWorkflowResponse,
  WorkflowListRequest,
  WorkflowDetailRequest,
  WorkflowValidationRequest,
} from "../types";

// Public auth endpoints that should not trigger 401/403 interceptor redirects
// NOTE: Only auth-related endpoints should be here. Other endpoints (settings, user/me)
// should NOT be excluded - they need to trigger logout for blocked users.
// NOTE: Axios passes relative URL to interceptor (without baseURL prefix),
// so we need both '/api/...' and '/...' variants
const PUBLIC_AUTH_ENDPOINTS = [
  // Full paths (for external checks)
  "/api/auth/sign-in",
  "/api/auth/sign-up",
  "/api/auth/sign-out",
  "/api/auth/forget-password",
  "/api/auth/reset-password",
  "/api/auth/verify-email",
  "/api/auth/session",
  "/api/auth/get-session",
  // Relative paths (axios interceptor receives these)
  "/auth/sign-in",
  "/auth/sign-up",
  "/auth/sign-out",
  "/auth/forget-password",
  "/auth/reset-password",
  "/auth/verify-email",
  "/auth/session",
  "/auth/get-session",
];

// Auth error handler callback type
type AuthErrorHandler = (status: number, message: string) => void;

// Global auth error handler (set by useAuthErrorHandler hook)
let globalAuthErrorHandler: AuthErrorHandler | null = null;

/**
 * Set global auth error handler for 401/403 responses
 * Called by useAuthErrorHandler hook in AuthProvider
 */
export const setAuthErrorHandler = (handler: AuthErrorHandler | null): void => {
  globalAuthErrorHandler = handler;
};

/**
 * Check if request URL is a public auth endpoint
 */
const isPublicAuthEndpoint = (url?: string): boolean => {
  if (!url) return false;
  return PUBLIC_AUTH_ENDPOINTS.some((endpoint) => url.includes(endpoint));
};

/**
 * API Client Error for frontend error handling
 */
export class ApiClientError extends Error {
  public code: ApiErrorCode;
  public status?: number;
  public details?: Record<string, unknown>;

  constructor(
    message: string,
    code: ApiErrorCode = ApiErrorCode.INTERNAL_ERROR,
    status?: number,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Type-safe API client for MCP Moira backend communication
 */
export class MoiraApiClient {
  private client: AxiosInstance;
  private baseURL: string;
  constructor(baseURL: string = "") {
    this.baseURL = baseURL;

    this.client = axios.create({
      baseURL: `${baseURL}/api`,
      timeout: 30000,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache", // Ensure fresh data as per requirements
      },
    });

    this.setupInterceptors();
  }

  /**
   * Setup request/response interceptors
   */
  private setupInterceptors(): void {
    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        if (process.env.NODE_ENV === "development") {
          console.log(`🌐 API Request: ${config.method?.toUpperCase()} ${config.url}`);
        }
        return config;
      },
      (error) => {
        console.error("🔴 API Request Error:", error);
        return Promise.reject(error);
      },
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response: AxiosResponse<ApiResponse>) => {
        if (process.env.NODE_ENV === "development") {
          console.log(`✅ API Response: ${response.status} ${response.config.url}`);
        }

        // Check if response has API error structure
        if (response.data && !response.data.success && response.data.error) {
          // Handle both error structures: string or object with message
          const errorMessage =
            typeof response.data.error === "string"
              ? response.data.error
              : response.data.error.message;
          const errorCode =
            typeof response.data.error === "string"
              ? ApiErrorCode.INTERNAL_ERROR
              : (response.data.error.code as ApiErrorCode);
          const errorDetails =
            typeof response.data.error === "string" ? undefined : response.data.error.details;

          throw new ApiClientError(errorMessage, errorCode, response.status, errorDetails);
        }

        return response;
      },
      (error: AxiosError<ApiResponse>) => {
        console.error("🔴 API Response Error:", error.response?.status, error.message);

        // Handle network errors
        if (!error.response) {
          throw new ApiClientError(
            "Network error - backend server may be down",
            ApiErrorCode.INTERNAL_ERROR,
            0,
            { originalError: error.message },
          );
        }

        const status = error.response.status;
        const requestUrl = error.config?.url;

        // Handle 401/403 for non-public auth endpoints
        if ((status === 401 || status === 403) && !isPublicAuthEndpoint(requestUrl)) {
          // Extract error message for blocked users
          let errorMessage =
            status === 401
              ? "Your session has expired. Please log in again."
              : "Access denied. Your account may have been blocked.";

          // Try to get specific message from response
          if (error.response.data?.error) {
            const responseError = error.response.data.error;
            if (typeof responseError === "string") {
              errorMessage = responseError;
            } else if (responseError.message) {
              errorMessage = responseError.message;
            }
          }

          // Trigger global auth error handler (navigation + toast)
          if (globalAuthErrorHandler) {
            globalAuthErrorHandler(status, errorMessage);
          }
        }

        // Handle API error responses
        if (error.response.data?.error) {
          // Handle both error structures: string or object with message
          const errorMessage =
            typeof error.response.data.error === "string"
              ? error.response.data.error
              : error.response.data.error.message;
          const errorCode =
            typeof error.response.data.error === "string"
              ? ApiErrorCode.INTERNAL_ERROR
              : (error.response.data.error.code as ApiErrorCode);
          const errorDetails =
            typeof error.response.data.error === "string"
              ? undefined
              : error.response.data.error.details;

          throw new ApiClientError(errorMessage, errorCode, error.response.status, errorDetails);
        }

        // Handle HTTP errors without API error structure
        throw new ApiClientError(
          error.message || "API request failed",
          ApiErrorCode.INTERNAL_ERROR,
          error.response.status,
          { httpError: error.response.statusText },
        );
      },
    );
  }

  /**
   * Health check - verify backend connectivity
   */
  async healthCheck(): Promise<HealthCheckResponse> {
    try {
      const response = await this.client.get<ApiResponse<HealthCheckResponse>>("/health");
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError("Health check failed", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get server configuration
   */
  async getServerConfig(): Promise<ServerConfigResponse> {
    try {
      const response = await this.client.get<ApiResponse<ServerConfigResponse>>("/config");
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError("Failed to get server configuration", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get deployment mode + feature flags. Public endpoint (no auth) consumed
   * pre-auth by the login/register UI.
   */
  async getFeatures(): Promise<FeaturesResponse> {
    try {
      const response = await this.client.get<ApiResponse<FeaturesResponse>>("/features");
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError("Failed to get feature flags", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get list of all workflows with filtering, sorting, and pagination
   */
  async getWorkflows(request?: WorkflowListRequest): Promise<WorkflowListResponse> {
    try {
      const params = new URLSearchParams();

      if (request?.validationStatus) {
        params.append("validationStatus", request.validationStatus);
      }
      if (request?.search) {
        params.append("search", request.search);
      }
      if (request?.visibility) {
        params.append("visibility", request.visibility);
      }
      if (request?.sort) {
        params.append("sort", request.sort);
      }
      if (request?.sortOrder) {
        params.append("sortOrder", request.sortOrder);
      }
      if (request?.limit !== undefined) {
        params.append("limit", request.limit.toString());
      }
      if (request?.offset !== undefined) {
        params.append("offset", request.offset.toString());
      }

      const queryString = params.toString();
      const url = queryString ? `/workflows?${queryString}` : "/workflows";

      const response = await this.client.get<ApiResponse<WorkflowListResponse>>(url);
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError("Failed to get workflow list", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get specific workflow for visualization
   *
   * Supports both:
   * - UUID identifiers (e.g., "550e8400-e29b-41d4-a716-446655440000")
   * - Handle/slug references (e.g., "admin/quick-task")
   */
  async getWorkflow(id: string, request?: WorkflowDetailRequest): Promise<WorkflowDetailResponse> {
    try {
      const params = new URLSearchParams();

      if (request?.includeValidation !== undefined) {
        params.append("includeValidation", request.includeValidation.toString());
      }

      if (request?.layoutOptions?.algorithm) {
        params.append("layoutOptions.algorithm", request.layoutOptions.algorithm);
      }

      if (request?.layoutOptions?.direction) {
        params.append("layoutOptions.direction", request.layoutOptions.direction);
      }

      const queryString = params.toString();

      // Check if this is a handle/slug reference (contains exactly one slash)
      // Handle/slug format: "admin/my-workflow-slug"
      const isHandleSlugRef = id.includes("/") && id.split("/").length === 2;

      let url: string;
      if (isHandleSlugRef) {
        // For handle/slug, construct path with both parts encoded separately
        const [handle, slug] = id.split("/");
        url = `/workflows/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`;
      } else {
        // For UUID or other identifiers, encode as single path segment
        url = `/workflows/${encodeURIComponent(id)}`;
      }

      if (queryString) {
        url += `?${queryString}`;
      }

      const response = await this.client.get<ApiResponse<WorkflowDetailResponse>>(url);
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError(`Failed to get workflow: ${id}`, ApiErrorCode.WORKFLOW_NOT_FOUND);
    }
  }

  /**
   * Get raw workflow JSON content
   */
  async getRawWorkflow(id: string): Promise<RawWorkflowResponse> {
    try {
      const response = await this.client.get<ApiResponse<RawWorkflowResponse>>(
        `/workflows/${encodeURIComponent(id)}/raw`,
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError(
        `Failed to get raw workflow: ${id}`,
        ApiErrorCode.WORKFLOW_NOT_FOUND,
      );
    }
  }

  /**
   * Validate specific workflow
   */
  async validateWorkflow(
    id: string,
    request?: WorkflowValidationRequest,
  ): Promise<WorkflowValidationResponse> {
    try {
      const response = await this.client.post<ApiResponse<WorkflowValidationResponse>>(
        `/workflows/${encodeURIComponent(id)}/validate`,
        request || {},
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError(
        `Failed to validate workflow: ${id}`,
        ApiErrorCode.VALIDATION_FAILED,
      );
    }
  }

  /**
   * Get user settings
   */
  async getUserSettings(): Promise<Record<string, unknown>> {
    try {
      const response = await this.client.get<ApiResponse<Record<string, unknown>>>("/settings");
      return response.data.data || {};
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError("Failed to get user settings", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Update user settings
   */
  async updateUserSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const response = await this.client.put<ApiResponse<Record<string, unknown>>>(
        "/settings",
        settings,
      );
      return response.data.data || {};
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError("Failed to update user settings", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get paginated user sessions
   */
  async getSessions(params?: {
    search?: string;
    sort?: "createdAt" | "expiresAt";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<{
    sessions: Array<{
      id: string;
      ipAddress: string;
      userAgent: string;
      country: string;
      createdAt: string;
      expiresAt: string;
      isCurrent: boolean;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.set("search", params.search);
    if (params?.sort) searchParams.set("sort", params.sort);
    if (params?.sortOrder) searchParams.set("sortOrder", params.sortOrder);
    if (params?.limit !== undefined) searchParams.set("limit", params.limit.toString());
    if (params?.offset !== undefined) searchParams.set("offset", params.offset.toString());

    const query = searchParams.toString();
    const url = `/user/sessions${query ? `?${query}` : ""}`;
    const response = await this.client.get<
      ApiResponse<
        Array<{
          id: string;
          ipAddress: string;
          userAgent: string;
          country: string;
          createdAt: string;
          expiresAt: string;
          isCurrent: boolean;
        }>
      > & { total: number; limit: number; offset: number }
    >(url);

    return {
      sessions: response.data.data || [],
      total: response.data.total ?? 0,
      limit: response.data.limit ?? 20,
      offset: response.data.offset ?? 0,
    };
  }

  /**
   * Get paginated OAuth consents
   */
  async getOAuthConsents(params?: {
    search?: string;
    sort?: "createdAt";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<{
    consents: Array<{
      id: string;
      clientId: string;
      clientName: string;
      clientIcon: string | null;
      scopes: string[];
      createdAt: string;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    const searchParams = new URLSearchParams();
    if (params?.search) searchParams.set("search", params.search);
    if (params?.sort) searchParams.set("sort", params.sort);
    if (params?.sortOrder) searchParams.set("sortOrder", params.sortOrder);
    if (params?.limit !== undefined) searchParams.set("limit", params.limit.toString());
    if (params?.offset !== undefined) searchParams.set("offset", params.offset.toString());

    const query = searchParams.toString();
    const url = `/user/oauth-consents${query ? `?${query}` : ""}`;
    const response = await this.client.get<
      ApiResponse<
        Array<{
          id: string;
          clientId: string;
          clientName: string;
          clientIcon: string | null;
          scopes: string[];
          createdAt: string;
        }>
      > & { total: number; limit: number; offset: number }
    >(url);

    return {
      consents: response.data.data || [],
      total: response.data.total ?? 0,
      limit: response.data.limit ?? 20,
      offset: response.data.offset ?? 0,
    };
  }

  /**
   * Revoke a user session
   */
  async revokeSession(sessionId: string): Promise<void> {
    await this.client.delete(`/user/sessions/${sessionId}`);
  }

  /**
   * Revoke an OAuth consent
   */
  async revokeOAuthConsent(consentId: string): Promise<void> {
    await this.client.delete(`/user/oauth-consents/${consentId}`);
  }

  /**
   * Get user's API tokens
   */
  async getApiTokens(): Promise<{
    tokens: Array<{
      id: string;
      name: string;
      tokenPrefix: string;
      scopes: string[] | null;
      expiresAt: string | null;
      lastUsedAt: string | null;
      createdAt: string;
      revokedAt: string | null;
      isExpired: boolean;
      isRevoked: boolean;
    }>;
    total: number;
  }> {
    const response = await this.client.get<
      ApiResponse<{
        tokens: Array<{
          id: string;
          name: string;
          tokenPrefix: string;
          scopes: string[] | null;
          expiresAt: string | null;
          lastUsedAt: string | null;
          createdAt: string;
          revokedAt: string | null;
          isExpired: boolean;
          isRevoked: boolean;
        }>;
        total: number;
      }>
    >("/tokens");

    return {
      tokens: response.data.data?.tokens || [],
      total: response.data.data?.total ?? 0,
    };
  }

  /**
   * Create a new API token
   */
  async createApiToken(
    name: string,
    expiresIn: "30d" | "90d" | "365d" | "never" = "90d",
  ): Promise<{
    id: string;
    name: string;
    token: string;
    tokenPrefix: string;
    expiresAt: string | null;
    createdAt: string;
  }> {
    const response = await this.client.post<
      ApiResponse<{
        id: string;
        name: string;
        token: string;
        tokenPrefix: string;
        scopes: null;
        expiresAt: string | null;
        createdAt: string;
      }>
    >("/tokens", { name, expiresIn });

    return response.data.data!;
  }

  /**
   * Revoke an API token
   */
  async revokeApiToken(tokenId: string): Promise<void> {
    await this.client.delete(`/tokens/${tokenId}`);
  }

  /**
   * Get dashboard statistics summary
   */
  async getStatsSummary(): Promise<{
    stats: {
      workflowsCount: number;
      executionsCount: number;
      notesCount: number;
    };
    recentWorkflows: Array<{
      id: string;
      name: string;
      description?: string;
      visibility: string;
      createdAt?: string;
    }>;
    recentExecutions: Array<{
      id: string;
      workflowId: string;
      workflowName?: string | null;
      note?: string | null;
      status: string;
      startTime: string;
      endTime?: string;
      duration: number | null;
    }>;
  }> {
    try {
      type StatsSummaryResponse = {
        stats: {
          workflowsCount: number;
          executionsCount: number;
          notesCount: number;
        };
        recentWorkflows: Array<{
          id: string;
          name: string;
          description?: string;
          visibility: string;
          createdAt?: string;
        }>;
        recentExecutions: Array<{
          id: string;
          workflowId: string;
          workflowName?: string | null;
          note?: string | null;
          status: string;
          startTime: string;
          endTime?: string;
          duration: number | null;
        }>;
      };
      const response = await this.client.get<ApiResponse<StatsSummaryResponse>>("/stats/summary");
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError("Failed to get stats summary", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Check backend connectivity
   */
  async checkConnectivity(): Promise<boolean> {
    try {
      await this.healthCheck();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get client configuration
   */
  getConfig() {
    return {
      baseURL: this.baseURL,
      timeout: this.client.defaults.timeout,
      headers: this.client.defaults.headers,
    };
  }

  /**
   * Update base URL (for dynamic backend discovery)
   */
  updateBaseURL(newBaseURL: string): void {
    this.baseURL = newBaseURL;
    this.client.defaults.baseURL = `${newBaseURL}/api`;
  }

  /**
   * Get current user info (including admin status, password reset flag, blocked status, and email verification)
   */
  async getUserInfo(): Promise<{
    id: string;
    email: string;
    handle: string | null;
    isAdmin: boolean;
    passwordResetRequired: boolean;
    blocked: boolean;
    emailVerified: boolean;
  }> {
    try {
      const response = await this.client.get<
        ApiResponse<{
          id: string;
          email: string;
          handle: string | null;
          isAdmin: boolean;
          passwordResetRequired: boolean;
          blocked: boolean;
          emailVerified: boolean;
        }>
      >("/user/me");
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get user info", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Change password when forced reset is required
   */
  async changeForcedPassword(currentPassword: string, newPassword: string): Promise<void> {
    try {
      await this.client.post("/user/change-password-forced", {
        currentPassword,
        newPassword,
      });
    } catch (error) {
      if (error instanceof ApiClientError) {
        throw error;
      }
      throw new ApiClientError("Failed to change password", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get all setting definitions (admin only)
   */
  async getSettingDefinitions(): Promise<
    Array<{
      key: string;
      type: string;
      category: string;
      label: string;
      description: string | null;
      defaultValue: string | null;
      required: boolean;
      validation: string | null;
      adminOnly: boolean;
    }>
  > {
    try {
      type SettingDefinitionsResponse = Array<{
        key: string;
        type: string;
        category: string;
        label: string;
        description: string | null;
        defaultValue: string | null;
        required: boolean;
        validation: string | null;
        adminOnly: boolean;
      }>;
      const response = await this.client.get<ApiResponse<SettingDefinitionsResponse>>(
        "/admin/settings/definitions",
      );
      return response.data.data || [];
    } catch (error) {
      throw new ApiClientError("Failed to get setting definitions", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Export setting definitions (schema) - admin only
   */
  async exportSettingDefinitions(): Promise<{
    version: string;
    exportedAt: string;
    definitions: Array<{
      key: string;
      type: string;
      category: string;
      label: string;
      description: string | null;
      defaultValue: string | null;
      required: boolean;
      validation: string | null;
      adminOnly: boolean;
      protected: boolean;
    }>;
  }> {
    try {
      const response = await this.client.get<
        ApiResponse<{
          version: string;
          exportedAt: string;
          definitions: Array<{
            key: string;
            type: string;
            category: string;
            label: string;
            description: string | null;
            defaultValue: string | null;
            required: boolean;
            validation: string | null;
            adminOnly: boolean;
            protected: boolean;
          }>;
        }>
      >("/admin/settings/definitions/export");
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to export schema", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Export global settings values - admin only
   */
  async exportGlobalSettings(): Promise<{
    version: string;
    exportedAt: string;
    settings: Array<{
      key: string;
      value: string | null;
      type: string;
      label: string;
      description: string | null;
      category: string;
    }>;
  }> {
    try {
      const response = await this.client.get<
        ApiResponse<{
          version: string;
          exportedAt: string;
          settings: Array<{
            key: string;
            value: string | null;
            type: string;
            label: string;
            description: string | null;
            category: string;
          }>;
        }>
      >("/admin/global-settings/export");
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to export global settings", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get admin system stats
   */
  async getAdminStats(): Promise<{
    totalWorkflows: number;
    totalExecutions: number;
    totalDefinitions: number;
    activeExecutions: number;
  }> {
    try {
      type AdminStatsResponse = {
        totalWorkflows: number;
        totalExecutions: number;
        totalDefinitions: number;
        activeExecutions: number;
      };
      const response = await this.client.get<ApiResponse<AdminStatsResponse>>("/admin/stats");
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get admin stats", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  async getAdminUsers(filters?: { search?: string; limit?: number; offset?: number }): Promise<{
    users: Array<{
      id: string;
      email: string;
      name: string | null;
      isAdmin: boolean;
      emailVerified: boolean;
      blocked: boolean;
      createdAt: string;
      workflowsCount: number;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    try {
      type AdminUsersResponse = {
        users: Array<{
          id: string;
          email: string;
          name: string | null;
          isAdmin: boolean;
          emailVerified: boolean;
          blocked: boolean;
          createdAt: string;
          workflowsCount: number;
        }>;
        total: number;
        limit: number;
        offset: number;
      };
      const params = new URLSearchParams();
      if (filters?.search) params.append("search", filters.search);
      if (filters?.limit) params.append("limit", filters.limit.toString());
      if (filters?.offset) params.append("offset", filters.offset.toString());
      const queryString = params.toString();
      const url = queryString ? `/admin/users?${queryString}` : "/admin/users";
      const response = await this.client.get<ApiResponse<AdminUsersResponse>>(url);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get admin users", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Update user (admin only)
   */
  async updateUser(userId: string, updates: { name?: string; isAdmin?: boolean }): Promise<void> {
    try {
      await this.client.put(`/admin/users/${userId}`, updates);
    } catch (error) {
      throw new ApiClientError("Failed to update user", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Delete user (admin only)
   */
  async deleteUser(userId: string): Promise<void> {
    try {
      await this.client.delete(`/admin/users/${userId}`);
    } catch (error) {
      throw new ApiClientError("Failed to delete user", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Logout all users (admin only) - deletes all sessions except current admin session
   */
  async logoutAllUsers(): Promise<{ deletedSessions: number; message: string }> {
    try {
      const response =
        await this.client.delete<ApiResponse<{ deletedSessions: number; message: string }>>(
          "/admin/sessions/all",
        );
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to logout all users", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get all workflows for admin panel (admin only)
   */
  async getAdminWorkflows(filters?: {
    search?: string;
    userId?: string;
    visibility?: "public" | "private" | "all";
    isValid?: "true" | "false" | "unknown";
    fromDate?: number;
    toDate?: number;
    sort?: "createdAt" | "updatedAt" | "name";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<{
    workflows: Array<{
      id: string;
      slug: string;
      userId: string;
      ownerHandle: string;
      name: string;
      description: string | null;
      version: string;
      visibility: "public" | "private";
      nodeCount: number;
      validation: {
        status: "valid" | "invalid" | "unknown";
        errors: string[];
        validatedAt: number | null;
      };
      createdAt: number;
      updatedAt: number;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    try {
      const params = new URLSearchParams();
      if (filters?.search) params.append("search", filters.search);
      if (filters?.userId) params.append("userId", filters.userId);
      if (filters?.visibility && filters.visibility !== "all")
        params.append("visibility", filters.visibility);
      if (filters?.isValid) params.append("isValid", filters.isValid);
      if (filters?.fromDate) params.append("fromDate", filters.fromDate.toString());
      if (filters?.toDate) params.append("toDate", filters.toDate.toString());
      if (filters?.sort) params.append("sort", filters.sort);
      if (filters?.sortOrder) params.append("sortOrder", filters.sortOrder);
      if (filters?.limit) params.append("limit", filters.limit.toString());
      if (filters?.offset) params.append("offset", filters.offset.toString());
      const queryString = params.toString();
      const url = queryString ? `/admin/workflows?${queryString}` : "/admin/workflows";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await this.client.get<ApiResponse<any>>(url);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get admin workflows", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get deleted workflows (admin only)
   */
  async getDeletedWorkflows(filters?: {
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    workflows: Array<{
      id: string;
      name: string;
      userId: string;
      deleted: boolean;
      deletedAt: number | null;
      deletedBy: string | null;
      createdAt?: number;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    try {
      type DeletedWorkflowsResponse = {
        workflows: Array<{
          id: string;
          name: string;
          userId: string;
          deleted: boolean;
          deletedAt: number | null;
          deletedBy: string | null;
          createdAt?: number;
        }>;
        total: number;
        limit: number;
        offset: number;
      };
      const params = new URLSearchParams();
      if (filters?.search) params.append("search", filters.search);
      if (filters?.limit) params.append("limit", filters.limit.toString());
      if (filters?.offset) params.append("offset", filters.offset.toString());
      const queryString = params.toString();
      const url = queryString
        ? `/admin/workflows/deleted?${queryString}`
        : "/admin/workflows/deleted";
      const response = await this.client.get<ApiResponse<DeletedWorkflowsResponse>>(url);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get deleted workflows", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Restore deleted workflow (admin only)
   */
  async restoreWorkflow(workflowId: string): Promise<void> {
    try {
      await this.client.post(`/admin/workflows/${workflowId}/restore`);
    } catch (error) {
      throw new ApiClientError("Failed to restore workflow", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Permanently delete workflow (admin only)
   */
  async hardDeleteWorkflow(workflowId: string): Promise<void> {
    try {
      await this.client.delete(`/admin/workflows/${workflowId}/hard-delete`);
    } catch (error) {
      throw new ApiClientError(
        "Failed to permanently delete workflow",
        ApiErrorCode.INTERNAL_ERROR,
      );
    }
  }

  /**
   * Create setting definition (admin only)
   */
  async createSettingDefinition(definition: {
    key: string;
    type: string;
    category: string;
    label: string;
    description?: string | null;
    defaultValue?: string | null;
    required?: boolean;
    validation?: string | null;
    adminOnly?: boolean;
  }): Promise<void> {
    try {
      await this.client.post("/admin/settings/definitions", definition);
    } catch (error) {
      throw new ApiClientError("Failed to create setting definition", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Update setting definition (admin only)
   */
  async updateSettingDefinition(
    key: string,
    updates: {
      type?: string;
      category?: string;
      label?: string;
      description?: string | null;
      defaultValue?: string | null;
      required?: boolean;
      validation?: string | null;
      adminOnly?: boolean;
    },
  ): Promise<void> {
    try {
      await this.client.put(`/admin/settings/definitions/${encodeURIComponent(key)}`, updates);
    } catch (error) {
      throw new ApiClientError("Failed to update setting definition", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Delete setting definition (admin only)
   */
  async deleteSettingDefinition(key: string): Promise<void> {
    try {
      await this.client.delete(`/admin/settings/definitions/${encodeURIComponent(key)}`);
    } catch (error) {
      throw new ApiClientError("Failed to delete setting definition", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Build workflow URL path, handling handle/slug references properly
   */
  private buildWorkflowPath(workflowId: string, suffix?: string): string {
    // Check if this is a handle/slug reference (contains exactly one slash)
    const isHandleSlugRef = workflowId.includes("/") && workflowId.split("/").length === 2;

    if (isHandleSlugRef) {
      // For handle/slug reference, encode parts separately to preserve the slash
      const [handle, slug] = workflowId.split("/");
      const basePath = `/workflows/${encodeURIComponent(handle)}/${encodeURIComponent(slug)}`;
      return suffix ? `${basePath}/${suffix}` : basePath;
    } else {
      // For UUID or bare slug, encode normally
      const basePath = `/workflows/${encodeURIComponent(workflowId)}`;
      return suffix ? `${basePath}/${suffix}` : basePath;
    }
  }

  /**
   * Delete workflow (soft delete)
   */
  async deleteWorkflow(workflowId: string): Promise<void> {
    try {
      await this.client.delete(this.buildWorkflowPath(workflowId));
    } catch (error) {
      throw new ApiClientError("Failed to delete workflow", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Update workflow visibility
   */
  async updateWorkflowVisibility(
    workflowId: string,
    visibility: "public" | "private",
  ): Promise<{ workflowId: string; visibility: string }> {
    try {
      const response = await this.client.patch<{
        success: boolean;
        data: { workflowId: string; visibility: string };
      }>(this.buildWorkflowPath(workflowId, "visibility"), { visibility });
      return response.data.data;
    } catch (error) {
      throw new ApiClientError("Failed to update workflow visibility", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Copy workflow (use as template)
   * Creates a private copy of the workflow for the current user
   */
  async copyWorkflow(
    workflowId: string,
    newName?: string,
  ): Promise<{
    workflowId: string;
    sourceWorkflowId: string;
    metadata: { name: string; version: string; description: string };
    visibility: string;
  }> {
    try {
      const response = await this.client.post<
        ApiResponse<{
          workflowId: string;
          sourceWorkflowId: string;
          metadata: { name: string; version: string; description: string };
          visibility: string;
        }>
      >(this.buildWorkflowPath(workflowId, "copy"), { newName });
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to copy workflow", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Execution Management Methods
   */

  async getExecutions(params?: {
    status?: string[];
    workflowId?: string;
    search?: string;
    sort?: "createdAt" | "updatedAt";
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): Promise<{
    executions: Array<{
      executionId: string;
      workflowId: string;
      workflowName?: string | null; // Issue #421
      userId: string;
      status: string;
      currentNodeId: string | null;
      note?: string;
      createdAt?: number;
      updatedAt?: number;
      completedAt?: number;
      error?: string;
      errorCount?: number; // Issue #386: Count of errors for badge display
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    try {
      type ExecutionsResponse = {
        executions: Array<{
          executionId: string;
          workflowId: string;
          workflowName?: string | null; // Issue #421
          userId: string;
          status: string;
          currentNodeId: string | null;
          note?: string;
          createdAt?: number;
          updatedAt?: number;
          completedAt?: number;
          error?: string;
          errorCount?: number; // Issue #386
        }>;
        total: number;
        limit: number;
        offset: number;
      };

      const queryParams = new URLSearchParams();
      if (params?.status?.length) {
        queryParams.append("status", params.status.join(","));
      }
      if (params?.workflowId) {
        queryParams.append("workflowId", params.workflowId);
      }
      if (params?.search) {
        queryParams.append("search", params.search);
      }
      if (params?.sort) {
        queryParams.append("sort", params.sort);
      }
      if (params?.sortOrder) {
        queryParams.append("sortOrder", params.sortOrder);
      }
      if (params?.limit !== undefined) {
        queryParams.append("limit", params.limit.toString());
      }
      if (params?.offset !== undefined) {
        queryParams.append("offset", params.offset.toString());
      }

      const queryString = queryParams.toString();
      const url = queryString ? `/executions?${queryString}` : "/executions";
      const response = await this.client.get<ApiResponse<ExecutionsResponse>>(url);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get executions", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  async getExecution(executionId: string): Promise<{
    executionId: string;
    workflowId: string;
    workflowName?: string | null;
    userId: string;
    status: string;
    currentNodeId: string | null;
    waitingForInputNodeId: string | null;
    context: {
      variables: Record<string, unknown>;
      nodeStates: Record<string, unknown>;
    };
    error?: string; // @deprecated - legacy error field
    errors?: Array<{
      // Issue #386: Full error log
      timestamp: number;
      nodeId: string;
      errorType: "validation" | "handler" | "system";
      message: string;
      input?: unknown;
    }>;
  }> {
    try {
      type ExecutionResponse = {
        execution: {
          executionId: string;
          workflowId: string;
          workflowName?: string | null;
          userId: string;
          status: string;
          currentNodeId: string | null;
          waitingForInputNodeId: string | null;
          context: {
            variables: Record<string, unknown>;
            nodeStates: Record<string, unknown>;
          };
          error?: string;
          errors?: Array<{
            timestamp: number;
            nodeId: string;
            errorType: "validation" | "handler" | "system";
            message: string;
            input?: unknown;
          }>;
        };
      };
      const response = await this.client.get<ApiResponse<ExecutionResponse>>(
        `/executions/${executionId}`,
      );
      return response.data.data!.execution;
    } catch (error) {
      throw new ApiClientError("Failed to get execution", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  async updateExecutionContext(
    executionId: string,
    context: { variables?: Record<string, unknown>; nodeStates?: Record<string, unknown> },
  ): Promise<boolean> {
    try {
      type UpdateContextResponse = {
        updated: boolean;
      };
      const response = await this.client.put<ApiResponse<UpdateContextResponse>>(
        `/executions/${executionId}/context`,
        context,
      );
      return response.data.data!.updated;
    } catch (error) {
      throw new ApiClientError("Failed to update execution context", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Update a single value at an arbitrary nesting path inside the execution's variables,
   * without overwriting the rest of the object. Path is relative to `variables`
   * (e.g. ["review_findings", "blocking"]).
   */
  async updateExecutionContextPath(
    executionId: string,
    variablePath: Array<string | number>,
    value: unknown,
  ): Promise<boolean> {
    try {
      type UpdateContextResponse = { updated: boolean };
      const response = await this.client.put<ApiResponse<UpdateContextResponse>>(
        `/executions/${executionId}/context`,
        { variablePath, value },
      );
      return response.data.data!.updated;
    } catch (error) {
      throw new ApiClientError("Failed to update execution context", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Vacuum database (admin only)
   */
  async vacuumDatabase(): Promise<void> {
    try {
      await this.client.post("/admin/database/vacuum");
    } catch (error) {
      throw new ApiClientError("Failed to vacuum database", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Download database backup (admin only)
   * Returns blob for file download
   */
  async downloadDatabaseBackup(): Promise<Blob> {
    try {
      const response = await this.client.post(
        "/admin/database/backup",
        {},
        {
          responseType: "blob",
          timeout: 120000, // 2 minutes - backup can take time for large databases
        },
      );
      return response.data;
    } catch (error) {
      throw new ApiClientError("Failed to download database backup", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get all executions with user info (admin only)
   */
  async getAdminExecutions(filters?: {
    userId?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    executions: Array<{
      executionId: string;
      workflowId: string;
      workflowName?: string | null;
      userId: string;
      userEmail: string;
      userName: string | null;
      status: string;
      currentNodeId: string | null;
      createdAt?: number;
      updatedAt?: number;
      completedAt?: number;
      error?: string;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    try {
      type AdminExecutionsResponse = {
        executions: Array<{
          executionId: string;
          workflowId: string;
          workflowName?: string | null;
          userId: string;
          userEmail: string;
          userName: string | null;
          status: string;
          currentNodeId: string | null;
          createdAt?: number;
          updatedAt?: number;
          completedAt?: number;
          error?: string;
        }>;
        total: number;
        limit: number;
        offset: number;
      };

      const params = new URLSearchParams();
      if (filters?.userId) params.append("userId", filters.userId);
      if (filters?.status) params.append("status", filters.status);
      if (filters?.search) params.append("search", filters.search);
      if (filters?.limit) params.append("limit", filters.limit.toString());
      if (filters?.offset) params.append("offset", filters.offset.toString());

      const queryString = params.toString();
      const url = queryString ? `/admin/executions?${queryString}` : "/admin/executions";

      const response = await this.client.get<ApiResponse<AdminExecutionsResponse>>(url);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get admin executions", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get all API tokens (admin only)
   */
  async getAdminTokens(filters?: {
    status?: string;
    search?: string;
    sort?: string;
    sortOrder?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    tokens: Array<{
      id: string;
      name: string;
      tokenPrefix: string;
      scopes: string[] | null;
      userId: string;
      userEmail: string;
      userName: string | null;
      expiresAt: string | null;
      lastUsedAt: string | null;
      createdAt: string;
      revokedAt: string | null;
      isExpired: boolean;
      isRevoked: boolean;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    try {
      type AdminTokensResponse = {
        tokens: Array<{
          id: string;
          name: string;
          tokenPrefix: string;
          scopes: string[] | null;
          userId: string;
          userEmail: string;
          userName: string | null;
          expiresAt: string | null;
          lastUsedAt: string | null;
          createdAt: string;
          revokedAt: string | null;
          isExpired: boolean;
          isRevoked: boolean;
        }>;
        total: number;
        limit: number;
        offset: number;
      };

      const params = new URLSearchParams();
      if (filters?.status) params.append("status", filters.status);
      if (filters?.search) params.append("search", filters.search);
      if (filters?.sort) params.append("sort", filters.sort);
      if (filters?.sortOrder) params.append("sortOrder", filters.sortOrder);
      if (filters?.limit) params.append("limit", filters.limit.toString());
      if (filters?.offset) params.append("offset", filters.offset.toString());

      const queryString = params.toString();
      const url = queryString ? `/admin/tokens?${queryString}` : "/admin/tokens";

      const response = await this.client.get<ApiResponse<AdminTokensResponse>>(url);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get admin tokens", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Revoke any API token (admin only)
   */
  async revokeAdminToken(tokenId: string): Promise<void> {
    try {
      await this.client.delete(`/admin/tokens/${tokenId}`);
    } catch (error) {
      throw new ApiClientError("Failed to revoke token", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get execution details (admin only - can view any execution)
   */
  async getAdminExecution(executionId: string): Promise<{
    executionId: string;
    workflowId: string;
    workflowName?: string | null;
    userId: string;
    userEmail: string;
    userName: string | null;
    status: string;
    currentNodeId: string | null;
    waitingForInputNodeId: string | null;
    context: {
      variables: Record<string, unknown>;
      nodeStates: Record<string, unknown>;
    };
    createdAt?: number;
    updatedAt?: number;
    completedAt?: number;
    error?: string;
    errors?: Array<{
      // Issue #386: Full error log
      timestamp: number;
      nodeId: string;
      errorType: "validation" | "handler" | "system";
      message: string;
      input?: unknown;
    }>;
  }> {
    try {
      type AdminExecutionResponse = {
        executionId: string;
        workflowId: string;
        workflowName?: string | null;
        userId: string;
        userEmail: string;
        userName: string | null;
        status: string;
        currentNodeId: string | null;
        waitingForInputNodeId: string | null;
        context: {
          variables: Record<string, unknown>;
          nodeStates: Record<string, unknown>;
        };
        createdAt?: number;
        updatedAt?: number;
        completedAt?: number;
        error?: string;
        errors?: Array<{
          timestamp: number;
          nodeId: string;
          errorType: "validation" | "handler" | "system";
          message: string;
          input?: unknown;
        }>;
      };

      const response = await this.client.get<ApiResponse<AdminExecutionResponse>>(
        `/admin/executions/${executionId}`,
      );
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get admin execution", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get audit log entries (admin only)
   */
  async getAuditLogs(filters?: {
    userId?: string;
    action?: string;
    resource?: string;
    resourceId?: string;
    source?: string;
    fromDate?: number;
    toDate?: number;
    sortBy?: string;
    sortOrder?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    entries: Array<{
      id: string;
      userId?: string;
      userEmail: string | null;
      userName: string | null;
      action: string;
      resource?: string;
      resourceId?: string;
      source?: string;
      ip?: string;
      country?: string;
      userAgent?: string;
      metadata?: string;
      changes?: string;
      createdAt: number;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    try {
      const params = new URLSearchParams();
      if (filters?.userId) params.set("userId", filters.userId);
      if (filters?.action) params.set("action", filters.action);
      if (filters?.resource) params.set("resource", filters.resource);
      if (filters?.resourceId) params.set("resourceId", filters.resourceId);
      if (filters?.source) params.set("source", filters.source);
      if (filters?.fromDate) params.set("fromDate", filters.fromDate.toString());
      if (filters?.toDate) params.set("toDate", filters.toDate.toString());
      if (filters?.sortBy) params.set("sortBy", filters.sortBy);
      if (filters?.sortOrder) params.set("sortOrder", filters.sortOrder);
      if (filters?.limit) params.set("limit", filters.limit.toString());
      if (filters?.offset) params.set("offset", filters.offset.toString());

      const url = `/admin/audit-log${params.toString() ? `?${params.toString()}` : ""}`;

      type AuditLogResponse = {
        entries: Array<{
          id: string;
          userId?: string;
          userEmail: string | null;
          userName: string | null;
          action: string;
          resource?: string;
          resourceId?: string;
          source?: string;
          ip?: string;
          country?: string;
          userAgent?: string;
          metadata?: string;
          changes?: string;
          createdAt: number;
        }>;
        total: number;
        limit: number;
        offset: number;
      };

      const response = await this.client.get<ApiResponse<AuditLogResponse>>(url);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get audit logs", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get all available audit action types (admin only)
   * Returns the complete list from AuditAction enum on server
   */
  async getAuditActions(): Promise<{
    actions: string[];
    grouped: Record<string, string[]>;
    totalCount: number;
  }> {
    try {
      type AuditActionsResponse = {
        actions: string[];
        grouped: Record<string, string[]>;
        totalCount: number;
      };

      const response =
        await this.client.get<ApiResponse<AuditActionsResponse>>("/admin/audit/actions");
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get audit actions", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get all global settings (admin only)
   */
  async getGlobalSettings(): Promise<{
    settings: Array<{
      key: string;
      value: string | null;
      type: string;
      label: string;
      description: string | null;
      category: string;
      sortOrder: number;
      updatedAt: number;
      updatedBy: string | null;
    }>;
    grouped: Record<
      string,
      Array<{
        key: string;
        value: string | null;
        type: string;
        label: string;
        description: string | null;
        category: string;
        sortOrder: number;
        updatedAt: number;
        updatedBy: string | null;
      }>
    >;
  }> {
    try {
      type GlobalSettingsResponse = {
        settings: Array<{
          key: string;
          value: string | null;
          type: string;
          label: string;
          description: string | null;
          category: string;
          sortOrder: number;
          updatedAt: number;
          updatedBy: string | null;
        }>;
        grouped: Record<
          string,
          Array<{
            key: string;
            value: string | null;
            type: string;
            label: string;
            description: string | null;
            category: string;
            sortOrder: number;
            updatedAt: number;
            updatedBy: string | null;
          }>
        >;
      };

      const response =
        await this.client.get<ApiResponse<GlobalSettingsResponse>>("/admin/global-settings");
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get global settings", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Update global setting value (admin only)
   */
  async updateGlobalSetting(key: string, value: string | null): Promise<void> {
    try {
      await this.client.put(`/admin/global-settings/${encodeURIComponent(key)}`, { value });
    } catch (error) {
      throw new ApiClientError("Failed to update global setting", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get setting change history (admin only)
   * Fetches audit log entries for a specific setting key
   */
  async getSettingHistory(
    settingKey: string,
    limit = 20,
  ): Promise<
    Array<{
      id: string;
      userId?: string;
      userEmail: string | null;
      userName: string | null;
      action: string;
      changes?: string;
      createdAt: number;
    }>
  > {
    const result = await this.getAuditLogs({
      resource: "globalSetting",
      resourceId: settingKey,
      limit,
    });
    return result.entries;
  }

  /**
   * Reset global setting to default (set value to null) - admin only
   * Used for clearing agent/model prompt overrides
   */
  async resetGlobalSetting(key: string): Promise<{ reset: boolean }> {
    try {
      const response = await this.client.delete<ApiResponse<{ reset: boolean }>>(
        `/admin/global-settings/${encodeURIComponent(key)}`,
      );
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to reset global setting", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get raw value at specific scope (no fallback resolution) - admin only
   * Used by MCP Prompts Editor to load values for editing
   */
  async getMcpPromptScopeValue(params: {
    promptType: string;
    vendor: "default" | "claude" | "chatgpt" | "gemini" | "cursor";
    model?: string | null;
  }): Promise<{
    key: string;
    value: string | null;
    exists: boolean;
    scope: "default" | "agent" | "model";
  }> {
    try {
      const response = await this.client.post<
        ApiResponse<{
          key: string;
          value: string | null;
          exists: boolean;
          scope: "default" | "agent" | "model";
        }>
      >("/admin/global-settings/get-scope-value", params);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get MCP prompt scope value", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Set value at specific scope - admin only
   * Used by MCP Prompts Editor to save values
   */
  async setMcpPromptScopeValue(params: {
    promptType: string;
    vendor: "default" | "claude" | "chatgpt" | "gemini" | "cursor";
    model?: string | null;
    value: string | null;
  }): Promise<{
    key: string;
    updated: boolean;
    scope: "default" | "agent" | "model";
  }> {
    try {
      const response = await this.client.post<
        ApiResponse<{
          key: string;
          updated: boolean;
          scope: "default" | "agent" | "model";
        }>
      >("/admin/global-settings/set-scope-value", params);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to set MCP prompt scope value", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Preview effective prompt for given agent/model context (admin only)
   * Used to test prompt hierarchy resolution
   */
  async previewPrompt(params: {
    type: "systemPrompt" | "systemReminder" | "toolDescription";
    agent?: string;
    model?: string;
    toolName?: string;
  }): Promise<{
    value: string | null;
    resolvedFrom: "default" | "agent" | "model";
    context: {
      agent?: string;
      model?: string;
      type: string;
      toolName?: string;
    };
  }> {
    try {
      const response = await this.client.post<
        ApiResponse<{
          value: string | null;
          resolvedFrom: "default" | "agent" | "model";
          context: {
            agent?: string;
            model?: string;
            type: string;
            toolName?: string;
          };
        }>
      >("/admin/global-settings/preview-prompt", params);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to preview prompt", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Trigger monitoring test error (admin only)
   * Returns 500 error for testing error rate metrics
   */
  async triggerMonitoringTestError(message?: string): Promise<void> {
    // This endpoint intentionally returns 500
    await this.client.post("/admin/monitoring-test/error", { message });
  }

  /**
   * Trigger monitoring test slow request (admin only)
   */
  async triggerMonitoringTestSlowRequest(
    delayMs: number = 3000,
  ): Promise<{ delayMs: number; message: string }> {
    const response = await this.client.post<ApiResponse<{ delayMs: number; message: string }>>(
      "/admin/monitoring-test/slow",
      { delayMs },
    );
    return response.data.data!;
  }

  /**
   * Trigger monitoring test log levels (admin only)
   */
  async triggerMonitoringTestLogLevels(
    levels?: string[],
  ): Promise<{ generatedLogs: string[]; message: string }> {
    const response = await this.client.post<
      ApiResponse<{ generatedLogs: string[]; message: string }>
    >("/admin/monitoring-test/log-levels", { levels });
    return response.data.data!;
  }

  /**
   * Trigger monitoring test workflow execution (admin only)
   */
  async triggerMonitoringTestWorkflow(
    workflowId: string,
  ): Promise<{ workflowId: string; message: string; suggestion: string }> {
    const response = await this.client.post<
      ApiResponse<{ workflowId: string; message: string; suggestion: string }>
    >("/admin/monitoring-test/workflow", { workflowId });
    return response.data.data!;
  }

  /**
   * Trigger monitoring test MCP tool call simulation (admin only)
   */
  async triggerMonitoringTestMcpCall(
    toolName?: string,
    status?: "success" | "error",
  ): Promise<{ toolName: string; status: string; executionTimeMs: number; message: string }> {
    const response = await this.client.post<
      ApiResponse<{ toolName: string; status: string; executionTimeMs: number; message: string }>
    >("/admin/monitoring-test/mcp-call", { toolName, status });
    return response.data.data!;
  }

  // ==================== Analytics API ====================

  /**
   * Get analytics overview (admin only)
   */
  async getAnalyticsOverview(range?: string): Promise<{
    totalUsers: number;
    totalWorkflows: number;
    totalExecutions: number;
    activeExecutions: number;
    completedExecutions: number;
    failedExecutions: number;
    timeRange: string;
  }> {
    try {
      const params = range ? `?range=${range}` : "";
      type OverviewResponse = {
        totalUsers: number;
        totalWorkflows: number;
        totalExecutions: number;
        activeExecutions: number;
        completedExecutions: number;
        failedExecutions: number;
        timeRange: string;
      };
      const response = await this.client.get<ApiResponse<OverviewResponse>>(
        `/admin/analytics/overview${params}`,
      );
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get analytics overview", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get execution statistics (admin only)
   */
  async getAnalyticsExecutions(range?: string): Promise<{
    total: number;
    completed: number;
    failed: number;
    active: number;
    successRate: number;
    avgDurationMs: number | null;
    byWorkflow: Array<{ workflowId: string; workflowName: string; count: number }>;
    overTime: Array<{ date: string; count: number }>;
    timeRange: string;
  }> {
    try {
      const params = range ? `?range=${range}` : "";
      type ExecutionsResponse = {
        total: number;
        completed: number;
        failed: number;
        active: number;
        successRate: number;
        avgDurationMs: number | null;
        byWorkflow: Array<{ workflowId: string; workflowName: string; count: number }>;
        overTime: Array<{ date: string; count: number }>;
        timeRange: string;
      };
      const response = await this.client.get<ApiResponse<ExecutionsResponse>>(
        `/admin/analytics/executions${params}`,
      );
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get execution analytics", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get top workflows by execution count (admin only)
   */
  async getAnalyticsTopWorkflows(
    range?: string,
    limit?: number,
  ): Promise<{
    workflows: Array<{
      workflowId: string;
      workflowName: string;
      executionCount: number;
      completedCount: number;
      failedCount: number;
      successRate: number;
      avgDurationMs: number | null;
    }>;
    timeRange: string;
  }> {
    try {
      const params = new URLSearchParams();
      if (range) params.set("range", range);
      if (limit) params.set("limit", limit.toString());
      const queryString = params.toString() ? `?${params.toString()}` : "";

      type TopWorkflowsResponse = {
        workflows: Array<{
          workflowId: string;
          workflowName: string;
          executionCount: number;
          completedCount: number;
          failedCount: number;
          successRate: number;
          avgDurationMs: number | null;
        }>;
        timeRange: string;
      };
      const response = await this.client.get<ApiResponse<TopWorkflowsResponse>>(
        `/admin/analytics/top-workflows${queryString}`,
      );
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError(
        "Failed to get top workflows analytics",
        ApiErrorCode.INTERNAL_ERROR,
      );
    }
  }

  /**
   * Get user activity statistics (admin only)
   */
  async getAnalyticsUsers(range?: string): Promise<{
    activeUsers: number;
    newUsers: number;
    topUsers: Array<{
      userId: string;
      userEmail: string;
      userName: string | null;
      executionCount: number;
      workflowCount: number;
    }>;
    timeRange: string;
  }> {
    try {
      const params = range ? `?range=${range}` : "";
      type UsersResponse = {
        activeUsers: number;
        newUsers: number;
        topUsers: Array<{
          userId: string;
          userEmail: string;
          userName: string | null;
          executionCount: number;
          workflowCount: number;
        }>;
        timeRange: string;
      };
      const response = await this.client.get<ApiResponse<UsersResponse>>(
        `/admin/analytics/users${params}`,
      );
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get user analytics", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get audit log summary (admin only)
   */
  async getAnalyticsAuditSummary(range?: string): Promise<{
    totalEntries: number;
    byAction: Array<{ action: string; count: number }>;
    byCategory: Array<{ category: string; count: number }>;
    timeRange: string;
  }> {
    try {
      const params = range ? `?range=${range}` : "";
      type AuditSummaryResponse = {
        totalEntries: number;
        byAction: Array<{ action: string; count: number }>;
        byCategory: Array<{ category: string; count: number }>;
        timeRange: string;
      };
      const response = await this.client.get<ApiResponse<AuditSummaryResponse>>(
        `/admin/analytics/audit-summary${params}`,
      );
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError(
        "Failed to get audit summary analytics",
        ApiErrorCode.INTERNAL_ERROR,
      );
    }
  }

  /**
   * Get workflow quality analytics (admin only)
   */
  async getWorkflowQualityAnalytics(
    workflowId: string,
    range?: string,
  ): Promise<{
    workflowId: string;
    workflowName: string;
    totalNodes: number;
    completionRate: number;
    totalExecutions: number;
    completedExecutions: number;
    hotSteps: Array<{ nodeId: string; executionCount: number; nodeName: string }>;
    deadSteps: Array<{ nodeId: string; nodeName: string }>;
    problematicSteps: Array<{
      nodeId: string;
      failureCount: number;
      executionCount: number;
      failureRate: number;
      nodeName: string;
    }>;
    timeRange: string;
  }> {
    try {
      const params = range ? `?range=${range}` : "";
      type WorkflowQualityResponse = {
        workflowId: string;
        workflowName: string;
        totalNodes: number;
        completionRate: number;
        totalExecutions: number;
        completedExecutions: number;
        hotSteps: Array<{ nodeId: string; executionCount: number; nodeName: string }>;
        deadSteps: Array<{ nodeId: string; nodeName: string }>;
        problematicSteps: Array<{
          nodeId: string;
          failureCount: number;
          executionCount: number;
          failureRate: number;
          nodeName: string;
        }>;
        timeRange: string;
      };
      const response = await this.client.get<ApiResponse<WorkflowQualityResponse>>(
        `/admin/analytics/workflow-quality/${workflowId}${params}`,
      );
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError(
        "Failed to get workflow quality analytics",
        ApiErrorCode.INTERNAL_ERROR,
      );
    }
  }

  /**
   * Get operational metrics (admin only)
   */
  async getOperationalMetrics(
    range?: string,
    granularity?: string,
    filters?: { action?: string; source?: string; resource?: string },
  ): Promise<{
    metrics: Array<{
      name: string;
      value: number;
      available: boolean;
      unit: string;
      timeSeries: Array<{ date: string; value: number }>;
    }>;
    breakdowns: {
      byAction: Array<{ label: string; count: number }>;
      bySource: Array<{ label: string; count: number }>;
      byResource: Array<{ label: string; count: number }>;
    };
    activeFilters: {
      action: string | null;
      source: string | null;
      resource: string | null;
    };
    timeRange: string;
    granularity: string;
  }> {
    try {
      const params = new URLSearchParams();
      if (range) params.set("range", range);
      if (granularity) params.set("granularity", granularity);
      if (filters?.action) params.set("action", filters.action);
      if (filters?.source) params.set("source", filters.source);
      if (filters?.resource) params.set("resource", filters.resource);
      const qs = params.toString() ? `?${params.toString()}` : "";
      type OperationalResponse = {
        metrics: Array<{
          name: string;
          value: number;
          available: boolean;
          unit: string;
          timeSeries: Array<{ date: string; value: number }>;
        }>;
        breakdowns: {
          byAction: Array<{ label: string; count: number }>;
          bySource: Array<{ label: string; count: number }>;
          byResource: Array<{ label: string; count: number }>;
        };
        activeFilters: {
          action: string | null;
          source: string | null;
          resource: string | null;
        };
        timeRange: string;
        granularity: string;
      };
      const response = await this.client.get<ApiResponse<OperationalResponse>>(
        `/admin/analytics/operational${qs}`,
      );
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get operational metrics", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get conversion funnel data (admin only)
   */
  async getConversionFunnel(range?: string): Promise<{
    funnel: Array<{ stage: string; label: string; count: number }>;
    registrationTrend: Array<{ date: string; value: number }>;
    timeRange: string;
  }> {
    try {
      const qs = range ? `?range=${range}` : "";
      const response = await this.client.get<
        ApiResponse<{
          funnel: Array<{ stage: string; label: string; count: number }>;
          registrationTrend: Array<{ date: string; value: number }>;
          timeRange: string;
        }>
      >(`/admin/analytics/conversion-funnel${qs}`);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get conversion funnel", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get engagement metrics (admin only)
   */
  async getEngagementMetrics(range?: string): Promise<{
    returningUsersRate: number;
    returningUsersCount: number;
    totalActiveUsers: number;
    avgExecutionsPerUser: number;
    avgTimeToFirstWorkflowDays: number | null;
    activeUsersTrend: Array<{ date: string; value: number }>;
    timeRange: string;
  }> {
    try {
      const qs = range ? `?range=${range}` : "";
      const response = await this.client.get<
        ApiResponse<{
          returningUsersRate: number;
          returningUsersCount: number;
          totalActiveUsers: number;
          avgExecutionsPerUser: number;
          avgTimeToFirstWorkflowDays: number | null;
          activeUsersTrend: Array<{ date: string; value: number }>;
          timeRange: string;
        }>
      >(`/admin/analytics/engagement${qs}`);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get engagement metrics", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  // ==================== Notes API ====================
  /**
   * List notes with optional filtering
   */
  async getNotes(params?: {
    tag?: string;
    keySearch?: string;
    limit?: number;
    offset?: number;
  }): Promise<{
    notes: Array<{
      id: string;
      key: string;
      tags: string[];
      size: number;
      currentVersion: number;
      preview: string;
      createdAt: number;
      updatedAt: number;
    }>;
    total: number;
    allTags: string[];
  }> {
    try {
      const queryParams = new URLSearchParams();
      if (params?.tag) queryParams.append("tag", params.tag);
      if (params?.keySearch) queryParams.append("keySearch", params.keySearch);
      if (params?.limit !== undefined) queryParams.append("limit", params.limit.toString());
      if (params?.offset !== undefined) queryParams.append("offset", params.offset.toString());

      const queryString = queryParams.toString();
      const url = queryString ? `/notes?${queryString}` : "/notes";
      const response = await this.client.get<
        ApiResponse<{
          notes: Array<{
            id: string;
            key: string;
            tags: string[];
            size: number;
            currentVersion: number;
            preview: string;
            createdAt: number;
            updatedAt: number;
          }>;
          total: number;
          allTags: string[];
        }>
      >(url);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get notes", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get note statistics (quota usage)
   */
  async getNoteStats(): Promise<{
    totalNotes: number;
    totalSize: number;
    limit: number;
    usedPercent: number;
  }> {
    try {
      const response = await this.client.get<
        ApiResponse<{
          totalNotes: number;
          totalSize: number;
          limit: number;
          usedPercent: number;
        }>
      >("/notes/stats");
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get note stats", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get single note by key
   */
  async getNote(
    key: string,
    version?: number,
  ): Promise<{
    id: string;
    key: string;
    tags: string[];
    value: string;
    size: number;
    version: number;
    createdAt: number;
    updatedAt: number;
  }> {
    try {
      const queryParams = version !== undefined ? `?version=${version}` : "";
      const response = await this.client.get<
        ApiResponse<{
          id: string;
          key: string;
          tags: string[];
          value: string;
          size: number;
          version: number;
          createdAt: number;
          updatedAt: number;
        }>
      >(`/notes/${encodeURIComponent(key)}${queryParams}`);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get note", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get note version history
   */
  async getNoteHistory(key: string): Promise<
    Array<{
      version: number;
      size: number;
      preview: string;
      createdAt: number;
    }>
  > {
    try {
      const response = await this.client.get<
        ApiResponse<
          Array<{
            version: number;
            size: number;
            preview: string;
            createdAt: number;
          }>
        >
      >(`/notes/${encodeURIComponent(key)}/history`);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get note history", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Create a new note
   */
  async createNote(note: { key: string; value: string; tags?: string[] }): Promise<{
    id: string;
    key: string;
    version: number;
    created: boolean;
  }> {
    try {
      const response = await this.client.post<
        ApiResponse<{
          id: string;
          key: string;
          version: number;
          created: boolean;
        }>
      >("/notes", note);
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to create note", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Update an existing note
   */
  async updateNote(
    key: string,
    updates: { value: string; tags?: string[] },
  ): Promise<{
    id: string;
    key: string;
    version: number;
    updated: boolean;
  }> {
    try {
      const response = await this.client.put<
        ApiResponse<{
          id: string;
          key: string;
          version: number;
          updated: boolean;
        }>
      >(`/notes/${encodeURIComponent(key)}`, updates);
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to update note", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Delete a note (soft delete)
   */
  async deleteNote(key: string): Promise<{
    key: string;
    deleted: boolean;
  }> {
    try {
      const response = await this.client.delete<
        ApiResponse<{
          key: string;
          deleted: boolean;
        }>
      >(`/notes/${encodeURIComponent(key)}`);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to delete note", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Restore a deleted note
   */
  async restoreNote(key: string): Promise<{
    key: string;
    restored: boolean;
  }> {
    try {
      const response = await this.client.post<
        ApiResponse<{
          key: string;
          restored: boolean;
        }>
      >(`/notes/${encodeURIComponent(key)}/restore`);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to restore note", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  // ==================== Artifacts API ====================

  /**
   * List user's artifacts with pagination
   */
  async getArtifacts(params?: { limit?: number; offset?: number }): Promise<{
    artifacts: Array<{
      uuid: string;
      url: string;
      name: string;
      size: number;
      mimeType: string;
      executionId: string | null;
      expiresAt: string;
      createdAt: string;
      updatedAt: string;
    }>;
    total: number;
  }> {
    try {
      const queryParams = new URLSearchParams();
      if (params?.limit !== undefined) queryParams.append("limit", params.limit.toString());
      if (params?.offset !== undefined) queryParams.append("offset", params.offset.toString());

      const queryString = queryParams.toString();
      const url = queryString ? `/artifacts?${queryString}` : "/artifacts";
      const response = await this.client.get<
        ApiResponse<{
          artifacts: Array<{
            uuid: string;
            url: string;
            name: string;
            size: number;
            mimeType: string;
            executionId: string | null;
            expiresAt: string;
            createdAt: string;
            updatedAt: string;
          }>;
          total: number;
        }>
      >(url);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get artifacts", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get artifact quota statistics
   */
  async getArtifactStats(): Promise<{
    totalArtifacts: number;
    totalSize: number;
    storageLimit: number;
    countLimit: number;
    storageUsedPercent: number;
    countUsedPercent: number;
  }> {
    try {
      const response = await this.client.get<
        ApiResponse<{
          totalArtifacts: number;
          totalSize: number;
          storageLimit: number;
          countLimit: number;
          storageUsedPercent: number;
          countUsedPercent: number;
        }>
      >("/artifacts/stats");
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get artifact stats", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get single artifact by UUID
   */
  async getArtifact(uuid: string): Promise<{
    uuid: string;
    url: string;
    name: string;
    size: number;
    mimeType: string;
    executionId: string | null;
    expiresAt: string;
    createdAt: string;
    updatedAt: string;
  }> {
    try {
      const response = await this.client.get<
        ApiResponse<{
          uuid: string;
          url: string;
          name: string;
          size: number;
          mimeType: string;
          executionId: string | null;
          expiresAt: string;
          createdAt: string;
          updatedAt: string;
        }>
      >(`/artifacts/${encodeURIComponent(uuid)}`);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to get artifact", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Create a new artifact
   */
  async createArtifact(artifact: { name: string; content: string; executionId?: string }): Promise<{
    uuid: string;
    url: string;
    name: string;
    size: number;
    expiresAt: string;
  }> {
    try {
      const response = await this.client.post<
        ApiResponse<{
          uuid: string;
          url: string;
          name: string;
          size: number;
          expiresAt: string;
        }>
      >("/artifacts", artifact);
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to create artifact", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Update an existing artifact
   */
  async updateArtifact(
    uuid: string,
    updates: { name?: string; content: string },
  ): Promise<{
    uuid: string;
    updated: boolean;
  }> {
    try {
      const response = await this.client.put<
        ApiResponse<{
          uuid: string;
          updated: boolean;
        }>
      >(`/artifacts/${encodeURIComponent(uuid)}`, updates);
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to update artifact", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Delete an artifact
   */
  async deleteArtifact(uuid: string): Promise<{
    uuid: string;
    deleted: boolean;
  }> {
    try {
      const response = await this.client.delete<
        ApiResponse<{
          uuid: string;
          deleted: boolean;
        }>
      >(`/artifacts/${encodeURIComponent(uuid)}`);
      return response.data.data!;
    } catch (error) {
      throw new ApiClientError("Failed to delete artifact", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  // ==================== Workflow Sharing API ====================

  /**
   * Create an invite link for a workflow
   * @param workflowId - Workflow UUID, slug, or handle/slug reference
   * @param ttlMs - Optional TTL in milliseconds (default: 7 days)
   */
  async createInvite(
    workflowId: string,
    ttlMs?: number,
  ): Promise<{
    invite: { id: string; token: string; expiresAt: number; remainingMs: number };
    inviteUrl: string;
  }> {
    try {
      type CreateInviteResponse = {
        invite: { id: string; token: string; expiresAt: number; remainingMs: number };
        inviteUrl: string;
      };
      const response = await this.client.post<ApiResponse<CreateInviteResponse>>(
        this.buildWorkflowPath(workflowId, "invites"),
        ttlMs ? { ttlMs } : {},
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to create invite", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * List invites for a workflow
   * @param workflowId - Workflow UUID, slug, or handle/slug reference
   * @param params - Optional filter and pagination params
   */
  async listInvites(
    workflowId: string,
    params?: { activeOnly?: boolean; limit?: number; offset?: number },
  ): Promise<{
    invites: Array<{
      id: string;
      token: string;
      createdAt: number;
      expiresAt: number;
      remainingMs: number;
      usedAt?: number | null;
      usedBy?: string | null;
      usedByHandle?: string | null;
    }>;
    total: number;
    hasMore: boolean;
  }> {
    try {
      type ListInvitesResponse = {
        invites: Array<{
          id: string;
          token: string;
          createdAt: number;
          expiresAt: number;
          remainingMs: number;
          usedAt?: number | null;
          usedBy?: string | null;
          usedByHandle?: string | null;
        }>;
        total: number;
        hasMore: boolean;
      };

      const queryParams = new URLSearchParams();
      if (params?.activeOnly !== undefined) {
        queryParams.append("activeOnly", params.activeOnly.toString());
      }
      if (params?.limit !== undefined) {
        queryParams.append("limit", params.limit.toString());
      }
      if (params?.offset !== undefined) {
        queryParams.append("offset", params.offset.toString());
      }

      const queryString = queryParams.toString();
      const path = this.buildWorkflowPath(workflowId, "invites");
      const url = queryString ? `${path}?${queryString}` : path;

      const response = await this.client.get<ApiResponse<ListInvitesResponse>>(url);
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to list invites", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Revoke an invite
   * @param workflowId - Workflow UUID, slug, or handle/slug reference
   * @param inviteId - Invite UUID to revoke
   */
  async revokeInvite(workflowId: string, inviteId: string): Promise<{ revoked: boolean }> {
    try {
      const response = await this.client.delete<ApiResponse<{ revoked: boolean }>>(
        `${this.buildWorkflowPath(workflowId, "invites")}/${inviteId}`,
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to revoke invite", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * List users with shared access to a workflow
   * @param workflowId - Workflow UUID, slug, or handle/slug reference
   * @param params - Optional pagination params
   */
  async listAccess(
    workflowId: string,
    params?: { limit?: number; offset?: number },
  ): Promise<{
    users: Array<{
      userId: string;
      handle: string | null;
      name: string | null;
      grantedAt: number;
      grantedBy: string;
      grantedByHandle: string | null;
    }>;
    total: number;
    hasMore: boolean;
  }> {
    try {
      type ListAccessResponse = {
        users: Array<{
          userId: string;
          handle: string | null;
          name: string | null;
          grantedAt: number;
          grantedBy: string;
          grantedByHandle: string | null;
        }>;
        total: number;
        hasMore: boolean;
      };

      const queryParams = new URLSearchParams();
      if (params?.limit !== undefined) {
        queryParams.append("limit", params.limit.toString());
      }
      if (params?.offset !== undefined) {
        queryParams.append("offset", params.offset.toString());
      }

      const queryString = queryParams.toString();
      const path = this.buildWorkflowPath(workflowId, "access");
      const url = queryString ? `${path}?${queryString}` : path;

      const response = await this.client.get<ApiResponse<ListAccessResponse>>(url);
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to list access", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Revoke a user's access to a workflow
   * @param workflowId - Workflow UUID, slug, or handle/slug reference
   * @param userId - User UUID whose access to revoke
   */
  async revokeAccess(workflowId: string, userId: string): Promise<{ revoked: boolean }> {
    try {
      const response = await this.client.delete<ApiResponse<{ revoked: boolean }>>(
        `${this.buildWorkflowPath(workflowId, "access")}/${userId}`,
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to revoke access", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Get public invite information (for landing page display)
   * Works without authentication
   * @param token - Invite token from URL
   */
  async getInviteInfo(token: string): Promise<{
    valid: boolean;
    expired: boolean;
    used: boolean;
    workflowName: string;
    createdByHandle: string | null;
    expiresAt: number;
    remainingMs: number;
  }> {
    try {
      type InviteInfoResponse = {
        valid: boolean;
        expired: boolean;
        used: boolean;
        workflowName: string;
        createdByHandle: string | null;
        expiresAt: number;
        remainingMs: number;
      };

      const response = await this.client.get<ApiResponse<InviteInfoResponse>>(
        `/invites/${encodeURIComponent(token)}`,
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to get invite info", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  /**
   * Accept an invite and gain access to a workflow
   * Requires authentication
   * @param token - Invite token from URL
   */
  async acceptInvite(token: string): Promise<{
    accessId: string;
    workflowId: string;
    ownerHandle: string;
    slug: string;
    message: string;
  }> {
    try {
      type AcceptInviteResponse = {
        accessId: string;
        workflowId: string;
        ownerHandle: string;
        slug: string;
        message: string;
      };

      const response = await this.client.post<ApiResponse<AcceptInviteResponse>>(
        `/invites/${encodeURIComponent(token)}/accept`,
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to accept invite", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  // --- Admin Lock Management ---

  async getExecutionLocks(executionId: string): Promise<{
    locks: Array<{
      id: string;
      nodeId: string;
      reason: string;
      lockedBy: string;
      status: string;
      createdAt: string;
      unlockedAt: string | null;
    }>;
    total: number;
  }> {
    try {
      type LocksResponse = {
        locks: Array<{
          id: string;
          nodeId: string;
          reason: string;
          lockedBy: string;
          status: string;
          createdAt: string;
          unlockedAt: string | null;
        }>;
        total: number;
      };

      const response = await this.client.get<ApiResponse<LocksResponse>>(
        `/admin/executions/${encodeURIComponent(executionId)}/locks`,
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to get execution locks", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  async adminUnlockExecution(
    executionId: string,
    lockId: string,
  ): Promise<{ lockId: string; status: string; adminOverride: boolean }> {
    try {
      type UnlockResponse = { lockId: string; status: string; adminOverride: boolean };

      const response = await this.client.post<ApiResponse<UnlockResponse>>(
        `/admin/executions/${encodeURIComponent(executionId)}/locks/${encodeURIComponent(lockId)}/unlock`,
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to unlock execution", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  // --- User Lock Management ---

  async getUserExecutionLocks(executionId: string) {
    try {
      type LocksResponse = {
        locks: Array<{
          id: string;
          nodeId: string;
          reason: string;
          lockedBy: string;
          status: string;
          createdAt: string;
          unlockedAt: string | null;
        }>;
        total: number;
      };

      const response = await this.client.get<ApiResponse<LocksResponse>>(
        `/executions/${encodeURIComponent(executionId)}/locks`,
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to get execution locks", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  async ownerUnlockExecution(
    executionId: string,
    lockId: string,
  ): Promise<{ lockId: string; status: string; ownerUnlock: boolean }> {
    try {
      type UnlockResponse = { lockId: string; status: string; ownerUnlock: boolean };

      const response = await this.client.post<ApiResponse<UnlockResponse>>(
        `/executions/${encodeURIComponent(executionId)}/locks/${encodeURIComponent(lockId)}/unlock`,
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to unlock execution", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  async validateLockPin(
    executionId: string,
    lockId: string,
    pin: string,
  ): Promise<{ valid: boolean; lockStatus: string }> {
    try {
      type ValidateResponse = { valid: boolean; lockStatus: string };

      const response = await this.client.post<ApiResponse<ValidateResponse>>(
        `/executions/${encodeURIComponent(executionId)}/locks/${encodeURIComponent(lockId)}/validate-pin`,
        { pin },
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to validate PIN", ApiErrorCode.INTERNAL_ERROR);
    }
  }

  async createLock(
    executionId: string,
    reason: string,
  ): Promise<{ lockId: string; pin: string; locked: boolean }> {
    try {
      type CreateLockResponse = { lockId: string; pin: string; locked: boolean };

      const response = await this.client.post<ApiResponse<CreateLockResponse>>(
        `/executions/${encodeURIComponent(executionId)}/lock`,
        { reason },
      );
      return response.data.data!;
    } catch (error) {
      if (error instanceof ApiClientError) throw error;
      throw new ApiClientError("Failed to lock execution", ApiErrorCode.INTERNAL_ERROR);
    }
  }
}

/**
 * Default API client instance configured for backend on port 5000
 */
export const apiClient = new MoiraApiClient(""); // Empty base URL = same origin, nginx proxies /api/ to backend

/**
 * API client factory for testing
 */
export const createApiClient = (baseURL?: string) => {
  return new MoiraApiClient(baseURL);
};

/**
 * Error handling utilities
 */
export const ApiErrorUtils = {
  /**
   * Check if error is API client error
   */
  isApiClientError: (error: unknown): error is ApiClientError => {
    return error instanceof ApiClientError;
  },

  /**
   * Get user-friendly error message
   */
  getUserFriendlyMessage: (error: unknown): string => {
    if (error instanceof ApiClientError) {
      switch (error.code) {
        case ApiErrorCode.WORKFLOW_NOT_FOUND:
          return "Workflow not found. Please check the workflow name and folder.";
        case ApiErrorCode.FOLDER_NOT_FOUND:
          return "Folder not found. Please check the folder name.";
        case ApiErrorCode.VALIDATION_FAILED:
          return "Workflow validation failed. Please check the workflow structure.";
        case ApiErrorCode.FILE_READ_ERROR:
          return "Unable to read workflow file. Please check file permissions.";
        case ApiErrorCode.INVALID_FORMAT:
          return "Invalid workflow format. Please check the JSON structure.";
        case ApiErrorCode.INTERNAL_ERROR:
          return "Server error occurred. Please try again or contact support.";
        default:
          return error.message;
      }
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "An unexpected error occurred";
  },

  /**
   * Get error severity level
   */
  getErrorSeverity: (error: unknown): "low" | "medium" | "high" => {
    if (error instanceof ApiClientError) {
      switch (error.code) {
        case ApiErrorCode.WORKFLOW_NOT_FOUND:
        case ApiErrorCode.FOLDER_NOT_FOUND:
          return "low"; // User can fix by selecting different workflow
        case ApiErrorCode.VALIDATION_FAILED:
        case ApiErrorCode.INVALID_FORMAT:
          return "medium"; // Workflow issue, may need attention
        case ApiErrorCode.FILE_READ_ERROR:
        case ApiErrorCode.INTERNAL_ERROR:
          return "high"; // System issue, needs investigation
        default:
          return "medium";
      }
    }

    return "medium";
  },
};

export default apiClient;
