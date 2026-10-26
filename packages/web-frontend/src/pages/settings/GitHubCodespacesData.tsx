/** Connection authority is shared; each provider/view owns its discovery response and request fence. */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { apiClient } from "@/services/api-client";
import type { CodespaceConnectionView } from "@mcp-moira/shared";
import type {
  CodespaceManagementView,
  CodespaceTargetsView,
  WorkspaceDiscoveryProvider,
  WorkspaceDiscoveryView,
} from "@/types/api-types";
import { useLatestRequest } from "@/hooks/useLatestRequest";
import { useResource } from "@/hooks/useResource";
import { useRefreshOnActivation } from "@/components/settings/useRefreshOnActivation";
import { useReadOwnerGuard } from "@/auth/ReadScopeBoundary";
import {
  getReadOwner,
  getReadScopeVersion,
  isPrivateReadSuspended,
  subscribeReadScope,
} from "@/services/read-scope";

type ReloadOptions = { silent?: boolean; sync?: boolean; throwOnError?: boolean };
type DiscoveryResult = { data: CodespaceManagementView | null; pending: boolean; error: boolean };
type OwnedDiscoveryResult = DiscoveryResult & { owner: string };
const emptyResult: DiscoveryResult = { data: null, pending: true, error: false };

function useProviderDiscovery(provider: WorkspaceDiscoveryProvider) {
  const guard = useReadOwnerGuard();
  const scope = useSyncExternalStore(subscribeReadScope, getReadScopeVersion, getReadScopeVersion);
  const owner = getReadOwner();
  const visited = useRef(new Set<WorkspaceDiscoveryView>(["actionable"]));
  const [view, setView] = useState<WorkspaceDiscoveryView>("actionable");
  const [results, setResults] = useState<
    Partial<Record<WorkspaceDiscoveryView, OwnedDiscoveryResult>>
  >({});
  const actionable = useLatestRequest(),
    diagnostics = useLatestRequest(),
    history = useLatestRequest();
  const requests = useMemo(
    () => ({ actionable, diagnostics, history }),
    [actionable, diagnostics, history],
  );
  const load = useCallback(
    async (
      target: WorkspaceDiscoveryView,
      { sync = false, silent = false, throwOnError = false }: ReloadOptions = {},
    ) => {
      const current = requests[target]();
      const capturedScope = getReadScopeVersion();
      const capturedOwner = getReadOwner();
      const owned = guard();
      const applicable = () => current() && owned() && capturedScope === getReadScopeVersion();
      visited.current.add(target);
      if (!silent)
        setResults((previous) => ({
          ...previous,
          [target]: {
            ...(previous[target]?.owner === capturedOwner ? previous[target] : emptyResult),
            owner: capturedOwner,
            pending: true,
            error: false,
          },
        }));
      if (isPrivateReadSuspended()) return false;
      try {
        const data = sync
          ? await apiClient.refreshCodespaces(provider, target)
          : await apiClient.getCodespaces(provider, target);
        if (applicable())
          setResults((previous) => ({
            ...previous,
            [target]: { owner: capturedOwner, data, pending: false, error: false },
          }));
        return true;
      } catch (error) {
        if (applicable())
          setResults((previous) => ({
            ...previous,
            [target]: {
              ...(previous[target]?.owner === capturedOwner ? previous[target] : emptyResult),
              owner: capturedOwner,
              pending: false,
              ...(!silent ? { error: true } : {}),
            },
          }));
        if (throwOnError && applicable()) throw error;
        return false;
      }
    },
    [provider, requests, guard],
  );
  useEffect(() => {
    // Revalidate each observed view independently; an unopened history is not an implicit read.
    for (const target of visited.current) void load(target);
  }, [load, scope]);
  const reload = useCallback((options?: ReloadOptions) => load(view, options), [load, view]);
  const select = useCallback(
    (target: WorkspaceDiscoveryView) => {
      setView(target);
      void load(target);
    },
    [load],
  );
  const update = useCallback(
    (change: React.SetStateAction<CodespaceManagementView | null>) => {
      const owned = guard();
      if (!owned() || owner !== getReadOwner() || scope !== getReadScopeVersion()) return;
      requests[view]();
      setResults((previous) => {
        const current = previous[view]?.owner === owner ? previous[view] : emptyResult;
        return {
          ...previous,
          [view]: {
            ...current,
            owner,
            data: typeof change === "function" ? change(current.data) : change,
            pending: false,
          },
        };
      });
    },
    [guard, requests, view, scope, owner],
  );
  const accepted = results[view];
  const result = !isPrivateReadSuspended() && accepted?.owner === owner ? accepted : emptyResult;
  return { view, result, reload, select, update };
}

type DiscoveryState = ReturnType<typeof useProviderDiscovery>;
function useProviderTargets(provider: WorkspaceDiscoveryProvider) {
  const synchronize = useRef(false);
  const result = useResource<CodespaceTargetsView>(`codespace-targets:${provider}`, () => {
    const sync = synchronize.current;
    synchronize.current = false;
    return sync
      ? apiClient.refreshCodespaceTargets(provider)
      : apiClient.getCodespaceTargets(provider);
  });
  const refresh = result.refresh;
  const reload = useCallback(() => {
    synchronize.current = true;
    return refresh();
  }, [refresh]);
  return { ...result, reload };
}
interface GitHubCodespacesState {
  connection: CodespaceConnectionView | null;
  connectionLoading: boolean;
  connectionError: boolean;
  applyConnection(next: CodespaceConnectionView): void;
  reloadConnection(): Promise<void>;
  discovery: Record<WorkspaceDiscoveryProvider, DiscoveryState>;
  targets: Record<WorkspaceDiscoveryProvider, ReturnType<typeof useProviderTargets>>;
  reloadManagement(provider: WorkspaceDiscoveryProvider, options?: ReloadOptions): Promise<boolean>;
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
  const {
    data: connection,
    pending: connectionLoading,
    error: connectionError,
    refresh: reloadConnection,
    update: updateConnection,
  } = useResource<CodespaceConnectionView>("github-codespace-connection", () =>
    apiClient.getGitHubCodespaceConnection(),
  );
  const scope = getReadScopeVersion();
  const local = useProviderDiscovery("local-sandboxes"),
    github = useProviderDiscovery("github-codespaces");
  const localTargets = useProviderTargets("local-sandboxes"),
    githubTargets = useProviderTargets("github-codespaces");
  const reloadLocal = local.reload,
    reloadGitHub = github.reload;
  useRefreshOnActivation(active && view === "github", reloadConnection);
  useRefreshOnActivation(active && view === "environments", github.reload);
  useRefreshOnActivation(active && view === "local", local.reload);
  useRefreshOnActivation(active && view === "environments", githubTargets.reload);
  useRefreshOnActivation(active && view === "local", localTargets.reload);
  const reloadGitHubTargets = githubTargets.reload;
  const reloadLocalTargets = localTargets.reload;
  const applyConnection = useCallback(
    (next: CodespaceConnectionView) => {
      if (scope !== getReadScopeVersion() || isPrivateReadSuspended()) return;
      // All connection effects are enabled by an accepted connection observation.
      updateConnection(() => next);
      void reloadGitHub({ silent: true });
      void reloadGitHubTargets();
    },
    [scope, updateConnection, reloadGitHub, reloadGitHubTargets],
  );
  const reloadManagement = useCallback(
    (provider: WorkspaceDiscoveryProvider, options?: ReloadOptions) => {
      // Device grants and pairing can change creation targets as well as inventory. Each read
      // publishes independently; one result must never be assembled from the other's request.
      void (provider === "local-sandboxes" ? reloadLocalTargets() : reloadGitHubTargets());
      return provider === "local-sandboxes" ? reloadLocal(options) : reloadGitHub(options);
    },
    [reloadLocal, reloadGitHub, reloadLocalTargets, reloadGitHubTargets],
  );
  return (
    <GitHubCodespacesContext.Provider
      value={{
        connection: connection ?? null,
        connectionLoading,
        connectionError: connectionError !== null,
        applyConnection,
        reloadConnection,
        discovery: { "local-sandboxes": local, "github-codespaces": github },
        targets: { "local-sandboxes": localTargets, "github-codespaces": githubTargets },
        reloadManagement,
      }}
    >
      {children}
    </GitHubCodespacesContext.Provider>
  );
}

export function useGitHubCodespaces(): GitHubCodespacesState {
  const value = useContext(GitHubCodespacesContext);
  if (!value) throw new Error("useGitHubCodespaces must be used inside GitHubCodespacesProvider");
  return value;
}
export function useCodespaceDiscovery(provider: WorkspaceDiscoveryProvider) {
  return useGitHubCodespaces().discovery[provider];
}
export function useCodespaceTargets(provider: WorkspaceDiscoveryProvider) {
  return useGitHubCodespaces().targets[provider];
}
