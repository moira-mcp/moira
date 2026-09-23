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
  /** `silent` keeps the current view on screen instead of showing the loading state. */
  reloadManagement: (options?: { silent?: boolean }) => Promise<void>;
  setManagement: React.Dispatch<React.SetStateAction<CodespaceManagementView | null>>;
}

const GitHubCodespacesContext = createContext<GitHubCodespacesState | null>(null);

export function GitHubCodespacesProvider({ children }: { children: React.ReactNode }) {
  const [connection, setConnection] = useState<CodespaceConnectionView | null>(null);
  const [connectionLoading, setConnectionLoading] = useState(true);
  const [connectionError, setConnectionError] = useState(false);
  const [management, setManagement] = useState<CodespaceManagementView | null>(null);
  const [managementLoading, setManagementLoading] = useState(true);
  const [managementError, setManagementError] = useState(false);

  const reloadConnection = useCallback(async () => {
    try {
      setConnectionLoading(true);
      setConnectionError(false);
      setConnection(await apiClient.getGitHubCodespaceConnection());
    } catch {
      setConnectionError(true);
    } finally {
      setConnectionLoading(false);
    }
  }, []);

  const reloadManagement = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    try {
      if (!silent) setManagementLoading(true);
      setManagementError(false);
      setManagement(await apiClient.getGitHubCodespaces());
    } catch {
      if (!silent) setManagementError(true);
    } finally {
      if (!silent) setManagementLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadConnection();
    void reloadManagement();
  }, [reloadConnection, reloadManagement]);

  const applyConnection = useCallback(
    (next: CodespaceConnectionView) => {
      setConnection(next);
      void reloadManagement({ silent: true });
    },
    [reloadManagement],
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
