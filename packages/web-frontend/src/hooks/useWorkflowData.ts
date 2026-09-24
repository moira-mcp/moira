/* eslint-disable no-console */
/**
 * Custom React Hooks for Workflow Data Management
 * Handles API communication and state management for workflow visualization
 *
 * Note: console.error used for browser debugging of API/validation errors
 */

import { useState, useEffect, useCallback } from "react";
import {
  WorkflowListResponse,
  WorkflowListRequest,
  WorkflowDetailResponse,
  WorkflowValidationResponse,
} from "../types";

import { apiClient, ApiErrorUtils } from "../services/api-client";
import { useSession } from "../auth/better-auth-client";
import { useResource } from "./useResource";
import { useLatestRequest } from "./useLatestRequest";

/**
 * Hook for managing workflow list data with server-side filtering and pagination
 *
 * PASSIVE HOOK: Does NOT auto-load on mount. The calling component is responsible
 * for calling loadWorkflows() when needed. This prevents duplicate API calls when
 * multiple effects trigger loads.
 */
export function useWorkflowList() {
  const { data: session } = useSession();
  const [workflows, setWorkflows] = useState<WorkflowListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  // Stable reference to session existence to avoid callback recreation
  const isAuthenticated = !!session;
  const beginRequest = useLatestRequest();

  const loadWorkflows = useCallback(
    async (filters?: WorkflowListRequest) => {
      // Don't load if not authenticated
      if (!isAuthenticated) {
        return;
      }

      const isCurrent = beginRequest();
      setLoading(true);
      setError(null);

      try {
        const response = await apiClient.getWorkflows(filters);
        // A newer query (a filter, a page, the page size settling) may have answered first
        if (!isCurrent()) return;
        setWorkflows(response);
        setLastUpdated(Date.now());
      } catch (err) {
        if (!isCurrent()) return;
        const message = ApiErrorUtils.getUserFriendlyMessage(err);
        setError(message);
        console.error("Failed to load workflows:", err);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [isAuthenticated, beginRequest],
  );

  const refreshWorkflows = useCallback(
    (filters?: WorkflowListRequest) => {
      loadWorkflows(filters);
    },
    [loadWorkflows],
  );

  // NO auto-load - component controls when to fetch
  // This prevents duplicate requests when hook is mounted

  return {
    workflows,
    loading,
    error,
    lastUpdated,
    loadWorkflows,
    refreshWorkflows,
    isAuthenticated,
  };
}

/**
 * Hook for managing individual workflow data.
 *
 * Keeps the last loaded workflow while a refetch is pending (a save, a retry, a refresh), so a
 * page never has to blank its content: `loading` is true only before the first data of a
 * workflow, `pending` whenever a fetch is in flight, and an error leaves the last workflow in
 * place beside its message.
 */
export function useWorkflowDetail(workflowId?: string) {
  const resource = useResource<WorkflowDetailResponse>(
    workflowId ?? null,
    (id) => apiClient.getWorkflow(id),
    (err) => {
      console.error("Failed to load workflow:", err);
      return ApiErrorUtils.getUserFriendlyMessage(err);
    },
  );
  const workflow = resource.data ?? null;
  return {
    workflow,
    /** The first load of a workflow: nothing to show yet, or another workflow's data still held. */
    loading: resource.pending && (workflow === null || resource.dataKey !== (workflowId ?? null)),
    /** Any fetch in flight, including a refetch that keeps the current workflow on screen. */
    pending: resource.pending,
    /** The held workflow is the requested one (false while a change of id is pending or failed). */
    current: workflow !== null && resource.dataKey === (workflowId ?? null),
    error: resource.error,
    refreshWorkflow: resource.refresh,
  };
}

/**
 * Hook for workflow validation
 */
export function useWorkflowValidation() {
  const [validationResult, setValidationResult] = useState<WorkflowValidationResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validateWorkflow = useCallback(
    async (
      workflowId: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workflowData?: any,
    ) => {
      setLoading(true);
      setError(null);

      try {
        const response = await apiClient.validateWorkflow(workflowId, {
          workflowData,
        });
        setValidationResult(response);
      } catch (err) {
        const message = ApiErrorUtils.getUserFriendlyMessage(err);
        setError(message);
        console.error("Workflow validation failed:", err);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return {
    validationResult,
    loading,
    error,
    validateWorkflow,
  };
}

/**
 * Hook for backend connectivity monitoring
 */
export function useBackendHealth() {
  const { data: session } = useSession();
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [healthData, setHealthData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const checkHealth = useCallback(async () => {
    // Don't check if not authenticated
    if (!session) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const health = await apiClient.healthCheck();
      setHealthData(health);
      setIsHealthy(isBackendOperable(health.status));
    } catch (err) {
      setIsHealthy(false);
      const message = ApiErrorUtils.getUserFriendlyMessage(err);
      setError(message);
      console.error("Backend health check failed:", err);
    } finally {
      setLoading(false);
    }
  }, [session]);

  // Check health on mount and set up periodic checks only if authenticated
  useEffect(() => {
    if (!session) {
      return;
    }

    checkHealth();

    // Check health every 30 seconds
    const interval = setInterval(checkHealth, 30000);

    return () => clearInterval(interval);
  }, [session, checkHealth]);

  return {
    isHealthy,
    healthData,
    loading,
    error,
    checkHealth,
  };
}

export function isBackendOperable(status: "ok" | "degraded" | "error"): boolean {
  return status === "ok" || status === "degraded";
}

/**
 * Combined hook for workflow application state
 */
export interface WorkflowBreadcrumb {
  workflowId: string;
  workflowName: string;
}

export function useWorkflowApp() {
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<WorkflowBreadcrumb[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");

  const workflowList = useWorkflowList();
  const workflowDetail = useWorkflowDetail(selectedWorkflow || undefined);
  const health = useBackendHealth();

  const selectWorkflow = useCallback(
    (workflowId: string, workflowName?: string) => {
      // Add to breadcrumb if this is a navigation (not initial selection)
      if (selectedWorkflow && workflowName) {
        setBreadcrumbs((prev) => [
          ...prev,
          {
            workflowId: selectedWorkflow,
            workflowName: selectedWorkflow,
          },
        ]);
      }

      setSelectedWorkflow(workflowId);
    },
    [selectedWorkflow],
  );

  const clearSelection = useCallback(() => {
    setSelectedWorkflow(null);
    setBreadcrumbs([]);
  }, []);

  const clearBreadcrumbs = useCallback(() => {
    setBreadcrumbs([]);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const changeTheme = useCallback((newTheme: "light" | "dark" | "system") => {
    setTheme(newTheme);
    // Apply theme to document
    document.documentElement.setAttribute("data-theme", newTheme);
  }, []);

  // Initialize theme on mount
  useEffect(() => {
    const savedTheme =
      (localStorage.getItem("moira-theme") as "light" | "dark" | "system") || "system";
    changeTheme(savedTheme);
  }, [changeTheme]);

  // Save theme preference
  useEffect(() => {
    localStorage.setItem("moira-theme", theme);
  }, [theme]);

  return {
    // State
    selectedWorkflow,
    breadcrumbs,
    sidebarOpen,
    theme,

    // Data hooks
    workflowList,
    workflowDetail,
    health,

    // Actions
    selectWorkflow,
    clearSelection,
    clearBreadcrumbs,
    toggleSidebar,
    changeTheme,

    // Computed values
    hasWorkflowSelected: !!selectedWorkflow,
    isBackendConnected: health.isHealthy === true,
  };
}
