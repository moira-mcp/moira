/**
 * One data source for the GitHub & Codespaces section.
 *
 * The connection card and the codespaces card used to load and keep their own copies, so
 * disconnecting in one left the other showing codespaces for a connection that no longer existed.
 * Both now read the same state from here: the connection view (`GET /api/integrations/github`) and
 * the codespace view with repositories and limits (`GET /api/integrations/github/codespaces`),
 * loaded together; any change either card makes reloads what it can affect.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { apiClient } from "@/services/api-client";
import type { CodespaceConnectionView } from "@mcp-moira/shared";
import type { CodespaceManagementView } from "@/types/api-types";
import { useLatestRequest } from "@/hooks/useLatestRequest";
import { useRefreshOnActivation } from "@/components/settings/useRefreshOnActivation";

export interface GitHubCodespacesState {
  connection: CodespaceConnectionView | null;
  connectionLoading: boolean;
  connectionError: boolean;
  management: CodespaceManagementView | null;
  managementLoading: boolean;
  managementError: boolean;
  /** Replace the connection view with one a connection request returned, then refresh codespaces. */
  applyConnection: (next: CodespaceConnectionView) => void;
  reloadConnection: () => Promise<void>;
  /** `sync` asks GitHub for current resource state; `silent` keeps the current view on screen. */
  reloadManagement: (options?: { silent?: boolean; sync?: boolean }) => Promise<boolean>;
  setManagement: React.Dispatch<React.SetStateAction<CodespaceManagementView | null>>;
}

const GitHubCodespacesContext = createContext<GitHubCodespacesState | null>(null);

export function GitHubCodespacesProvider({
  children,
  active = true,
  view = "environments",
}: {
  children: React.ReactNode;
  active?: boolean;
  view?: "environments" | "github" | "local";
}) {
  const [connection, setConnection] = useState<CodespaceConnectionView | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState(false);
  const [management, setManagement] = useState<CodespaceManagementView | null>(null);
  const [managementLoading, setManagementLoading] = useState(true);
  const [managementError, setManagementError] = useState(false);
  const beginConnectionRequest = useLatestRequest();
  const beginManagementRequest = useLatestRequest();

  const reloadConnection = useCallback(async () => {
    const isCurrent = beginConnectionRequest();
    try {
      setConnectionLoading(true);
      setConnectionError(false);
      const next = await apiClient.getGitHubCodespaceConnection();
      if (isCurrent()) setConnection(next);
    } catch {
      if (isCurrent()) setConnectionError(true);
    } finally {
      if (isCurrent()) setConnectionLoading(false);
    }
  }, [beginConnectionRequest]);

  const reloadManagement = useCallback(
    async ({ sync = false, silent = false }: { silent?: boolean; sync?: boolean } = {}) => {
      const isCurrent = beginManagementRequest();
      try {
        if (!silent) {
          setManagementLoading(true);
          setManagementError(false);
        }
        const next = sync
          ? await apiClient.refreshGitHubCodespaces()
          : await apiClient.getGitHubCodespaces();
        if (isCurrent()) setManagement(next);
        return true;
      } catch {
        if (isCurrent() && !silent) setManagementError(true);
        return false;
      } finally {
        if (isCurrent()) setManagementLoading(false);
      }
    },
    [beginManagementRequest],
  );

  useEffect(() => {
    void reloadConnection();
    void reloadManagement();
  }, [reloadConnection, reloadManagement]);
  useRefreshOnActivation(active && view === "github", reloadConnection);
  useRefreshOnActivation(active && (view === "environments" || view === "local"), reloadManagement);

  const applyConnection = useCallback(
    (next: CodespaceConnectionView) => {
      beginConnectionRequest();
      setConnection(next);
      setConnectionLoading(false);
      setConnectionError(false);
      void reloadManagement({ silent: true });
    },
    [reloadManagement, beginConnectionRequest],
  );

  const value = useMemo(
    () => ({
      connection,
      connectionLoading,
      connectionError,
      management,
      managementLoading,
      managementError,
      applyConnection,
      reloadConnection,
      reloadManagement,
      setManagement,
    }),
    [
      connection,
      connectionLoading,
      connectionError,
      management,
      managementLoading,
      managementError,
      applyConnection,
      reloadConnection,
      reloadManagement,
    ],
  );
  return (
    <GitHubCodespacesContext.Provider value={value}>{children}</GitHubCodespacesContext.Provider>
  );
}

export function useGitHubCodespaces(): GitHubCodespacesState {
  const value = useContext(GitHubCodespacesContext);
  if (!value) throw new Error("useGitHubCodespaces must be used inside GitHubCodespacesProvider");
  return value;
}
