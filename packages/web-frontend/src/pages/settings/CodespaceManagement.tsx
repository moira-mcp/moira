import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ChevronDown,
  Cloud,
  Laptop,
  GitBranch,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { CodespaceSummaryView, LocalDeviceView } from "@mcp-moira/shared";
import { parseLocalRepositoryTargetId } from "@mcp-moira/shared/local-device-types";
import { apiClient } from "@/services/api-client";
import { cn } from "@/lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useGitHubCodespaces } from "./GitHubCodespacesData";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { codespaceErrorMessage } from "@/lib/codespace-error-message";
import { guideAnchor } from "../../guides/anchors";
import { DataRegion } from "@/components/DataRegion";
import { InlineError } from "@/components/inline-error";
import { useReadOwnerGuard } from "@/auth/ReadScopeBoundary";

const BUSY_STATES: ReadonlySet<CodespaceSummaryView["state"]> = new Set([
  "create_pending",
  "create_submitted",
  "start_pending",
  "stop_pending",
  "delete_pending",
  "cleanup_pending",
  "ambiguous",
]);

/** The colour a state reads in: running, resting, moving, or needing attention. */
function stateTone(state: CodespaceSummaryView["state"]): "running" | "idle" | "busy" | "problem" {
  if (state === "usable") return "running";
  if (state === "rejected" || state === "ambiguous") return "problem";
  if (BUSY_STATES.has(state)) return "busy";
  return "idle";
}

const TONE_DOT: Record<ReturnType<typeof stateTone>, string> = {
  running: "bg-emerald-500",
  idle: "bg-muted-foreground/50",
  busy: "bg-amber-500 animate-pulse",
  problem: "bg-destructive",
};

const TONE_BADGE: Record<ReturnType<typeof stateTone>, string> = {
  running: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  idle: "border-border bg-muted text-muted-foreground",
  busy: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  problem: "border-destructive/30 bg-destructive/10 text-destructive",
};

export type CodespaceManagementScope =
  { provider: "github-codespaces" } | { provider: "local-sandboxes"; computer: LocalDeviceView };

type ResourceRequestError = { message: string; origin: CodespaceSummaryView };

function errorStillCurrent(error: ResourceRequestError | undefined, current: CodespaceSummaryView) {
  if (!error) return false;
  const origin = error.origin;
  return !(
    current.generation > origin.generation ||
    (current.observed_at ?? -1) > (origin.observed_at ?? -1) ||
    (current.updated_at > origin.updated_at &&
      (current.lifecycle_error !== origin.lifecycle_error ||
        current.state !== origin.state ||
        current.desired_state !== origin.desired_state ||
        current.observed_state !== origin.observed_state))
  );
}

function localComputerId(repositoryId: string): string | null {
  try {
    return parseLocalRepositoryTargetId(repositoryId).deviceId;
  } catch {
    return null;
  }
}

export function CodespaceManagement({ scope }: { scope: CodespaceManagementScope }) {
  const { t, i18n } = useTranslation();
  const guard = useReadOwnerGuard();
  const provider = scope.provider;
  const computer = scope.provider === "local-sandboxes" ? scope.computer : null;
  const computerId = computer?.deviceId;
  const regionId = computer
    ? `local-codespaces-${computer.deviceId}`
    : "github-codespace-management";
  const formId = computer ? `local-codespace-${computer.deviceId}` : "github-codespace";
  const loadFailed = t(
    computer ? "localDevices.codespaces.loadFailed" : "pages.settings.codespaces.loadFailed",
  );
  const accessEnabled =
    !computer ||
    (computer.status === "active" &&
      computer.policy.enabled &&
      computer.policy.leaseUntil > Date.now());
  const ownerDeleteEnabled =
    !computer || (computer.status === "active" && computer.control?.optedIn === true);
  const {
    management: view,
    managementLoading: loading,
    managementError: loadError,
    reloadManagement,
    setManagement: setView,
  } = useGitHubCodespaces();
  const [repositoryId, setRepositoryId] = useState("");
  // Repository metadata has no default branch; require a ref instead of guessing one.
  const [ref, setRef] = useState("");
  const [creating, setCreating] = useState(false);
  const [busyCodespaces, setBusyCodespaces] = useState<Set<string>>(new Set());
  const [actionErrors, setActionErrors] = useState<
    Record<string, ResourceRequestError & { action: "start" | "stop" }>
  >({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [checkingCodespaces, setCheckingCodespaces] = useState<Set<string>>(new Set());
  const [checkErrors, setCheckErrors] = useState<Record<string, ResourceRequestError>>({});
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteNeedsRefresh, setDeleteNeedsRefresh] = useState(false);
  const checkState = async (codespace: CodespaceSummaryView, trigger?: HTMLButtonElement) => {
    if (computer && codespace.desired_state === "deleted") {
      if (ownerDeleteEnabled) openDeleteDialog(codespace, trigger);
      return;
    }
    const id = codespace.codespace_id;
    const owned = guard(false);
    setCheckingCodespaces((previous) => new Set(previous).add(id));
    setCheckErrors((previous) => {
      const next = { ...previous };
      delete next[id];
      return next;
    });
    try {
      // A previously requested lifecycle intent must be retried through its existing endpoint;
      // provider refresh only observes and cannot complete a pending stop/start/delete effect.
      if (
        accessEnabled &&
        codespace.lifecycle_error !== "CODESPACE_LOCAL_SETUP_INCOMPLETE" &&
        codespace.state !== "create_pending" &&
        codespace.state !== "create_submitted"
      ) {
        const next =
          codespace.desired_state === "deleted"
            ? await apiClient.deleteGitHubCodespace(id, codespace.generation)
            : codespace.desired_state === "stopped"
              ? await apiClient.stopGitHubCodespace(id)
              : await apiClient.startGitHubCodespace(id);
        if (!owned()) return;
        replaceCodespace(next);
      } else {
        const refreshed = await reloadManagement({ sync: true, silent: true });
        if (owned() && !refreshed)
          setCheckErrors((previous) => ({
            ...previous,
            [id]: { message: loadFailed, origin: codespace },
          }));
      }
    } catch (error) {
      if (owned())
        setCheckErrors((previous) => ({
          ...previous,
          [id]: { message: failureMessage(error), origin: codespace },
        }));
    } finally {
      if (owned())
        setCheckingCodespaces((previous) => {
          const next = new Set(previous);
          next.delete(id);
          return next;
        });
    }
  };
  const markBusy = (id: string, busy: boolean) =>
    setBusyCodespaces((previous) => {
      const next = new Set(previous);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
  const [pendingDelete, setPendingDelete] = useState<CodespaceSummaryView | null>(null);
  const deleteDecision = useRef(0);
  // The element that opened the destructive dialog; focus returns to it after closing.
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const openDeleteDialog = (codespace: CodespaceSummaryView, trigger?: HTMLButtonElement) => {
    deleteDecision.current++;
    deleteTriggerRef.current = trigger ?? null;
    setDeleteError(null);
    setDeleteNeedsRefresh(false);
    setPendingDelete(codespace);
  };

  const load = reloadManagement;
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const refreshList = async () => {
    const owned = guard(false);
    if (computer) setRefreshing(true);
    setRefreshError(null);
    try {
      const refreshed = await load({ sync: true, silent: Boolean(computer) });
      if (owned() && computer && !refreshed) setRefreshError(loadFailed);
    } finally {
      if (owned()) setRefreshing(false);
    }
  };

  // Keep the selected repository while it is still offered; otherwise take the first one.
  const repositories = view?.repositories;
  const availableRepositories = repositories?.filter(
    (repository) =>
      (repository.provider ?? "github-codespaces") === provider &&
      (!computerId || localComputerId(repository.repository_id) === computerId),
  );
  useEffect(() => {
    if (!repositories) return;
    setRepositoryId((current) =>
      current &&
      repositories.some(
        (repository) =>
          repository.repository_id === current &&
          (repository.provider ?? "github-codespaces") === provider &&
          (!computerId || localComputerId(repository.repository_id) === computerId),
      )
        ? current
        : (repositories.find(
            (repository) =>
              (repository.provider ?? "github-codespaces") === provider &&
              (!computerId || localComputerId(repository.repository_id) === computerId),
          )?.repository_id ?? ""),
    );
  }, [repositories, provider, computerId]);

  useEffect(() => {
    if (loadError && !computer) toast.error(loadFailed);
  }, [loadError, loadFailed, computer]);

  /**
   * A lifecycle response echoes one codespace, including a finished one the listing no longer
   * offers. Show it at once, then take the server's listing as the authority on what remains.
   */
  const replaceCodespace = (codespace: CodespaceSummaryView) => {
    setCheckErrors((previous) => {
      const next = { ...previous };
      delete next[codespace.codespace_id];
      return next;
    });
    setActionErrors((previous) => {
      const next = { ...previous };
      delete next[codespace.codespace_id];
      return next;
    });
    setView((current) => {
      if (!current) return current;
      const exists = current.codespaces.some(
        (item) => item.codespace_id === codespace.codespace_id,
      );
      return {
        ...current,
        codespaces: exists
          ? current.codespaces.map((item) =>
              item.codespace_id === codespace.codespace_id ? codespace : item,
            )
          : [...current.codespaces, codespace],
      };
    });
    void load({ silent: true });
  };

  // The server's own sentence is English and meant for agents; the reader gets the code's message.
  const failureMessage = (error: unknown): string => {
    const fallback = codespaceErrorMessage(error, t, "pages.settings.codespaces.requestFailed");
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
    return computer && typeof code === "string"
      ? t(`localDevices.codespaces.errors.${code}`, { defaultValue: fallback })
      : fallback;
  };

  const create = async () => {
    if (
      !repositoryId ||
      !accessEnabled ||
      !ref.trim() ||
      !availableRepositories?.some((repository) => repository.repository_id === repositoryId)
    )
      return;
    const owned = guard(false);
    try {
      setCreating(true);
      setCreateError(null);
      const codespace = await apiClient.createGitHubCodespace({
        repository_id: repositoryId,
        ref: ref.trim(),
      });
      if (!owned()) return;
      replaceCodespace(codespace);
      if (codespace.state === "usable") toast.success(t("pages.settings.codespaces.created"));
      else toast(t("localDevices.codespaces.requestAccepted"));
    } catch (error) {
      if (owned()) setCreateError(failureMessage(error));
    } finally {
      if (owned()) setCreating(false);
    }
  };

  const lifecycle = async (codespace: CodespaceSummaryView, action: "start" | "stop") => {
    if (
      !accessEnabled ||
      (action === "start" && codespace.lifecycle_error === "CODESPACE_LOCAL_SETUP_INCOMPLETE")
    )
      return;
    const owned = guard(false);
    try {
      markBusy(codespace.codespace_id, true);
      setActionErrors((previous) => {
        const next = { ...previous };
        delete next[codespace.codespace_id];
        return next;
      });
      const next =
        action === "start"
          ? await apiClient.startGitHubCodespace(codespace.codespace_id)
          : await apiClient.stopGitHubCodespace(codespace.codespace_id);
      if (!owned()) return;
      replaceCodespace(next);
      const completed = action === "start" ? next.state === "usable" : next.state === "stopped";
      if (completed)
        toast.success(
          t(
            action === "start"
              ? "pages.settings.codespaces.started"
              : "pages.settings.codespaces.stopped",
          ),
        );
      else toast(t("localDevices.codespaces.requestAccepted"));
    } catch (error) {
      if (owned())
        setActionErrors((previous) => ({
          ...previous,
          [codespace.codespace_id]: { message: failureMessage(error), action, origin: codespace },
        }));
    } finally {
      if (owned()) markBusy(codespace.codespace_id, false);
    }
  };

  const refreshDeleteTarget = async (target: CodespaceSummaryView): Promise<void> => {
    const owned = guard(false);
    const decision = deleteDecision.current;
    setDeleteNeedsRefresh(true);
    try {
      // Read server bookkeeping only. A refused delete may already have advanced its intent
      // generation; observing that result never authorizes another destructive request.
      const next = await apiClient.getGitHubCodespaces();
      if (!owned() || deleteDecision.current !== decision) return;
      const current = next.codespaces.find(
        (row) =>
          row.codespace_id === target.codespace_id &&
          row.provider === target.provider &&
          row.repository_id === target.repository_id,
      );
      setView(next);
      if (current) {
        setPendingDelete((pending) =>
          pending?.codespace_id === target.codespace_id ? current : pending,
        );
        setDeleteNeedsRefresh(false);
      }
    } catch {
      // Keep confirmation disabled until a current generation can be read. The existing
      // refusal remains visible and the dialog offers a read-only retry.
    }
  };

  const remove = async () => {
    if (!pendingDelete || deleteNeedsRefresh || !ownerDeleteEnabled) return;
    const owned = guard(false);
    try {
      markBusy(pendingDelete.codespace_id, true);
      setDeleteError(null);
      const next = await apiClient.deleteGitHubCodespace(
        pendingDelete.codespace_id,
        pendingDelete.generation,
      );
      if (!owned()) return;
      replaceCodespace(next);
      if (next.state === "deleted") toast.success(t("pages.settings.codespaces.deleted"));
      else toast(t("localDevices.codespaces.requestAccepted"));
    } catch (error) {
      if (owned()) {
        setDeleteError(failureMessage(error));
        // The refusal settles confirmation immediately; a read for a safe retry is independent.
        void refreshDeleteTarget(pendingDelete);
      }
      throw error;
    } finally {
      if (owned()) markBusy(pendingDelete.codespace_id, false);
    }
  };

  if (loading && !view) {
    return (
      <Card data-testid={regionId} {...(!computer ? guideAnchor("settings.codespaces") : {})}>
        <CardContent className="flex min-h-32 items-center justify-center p-6">
          <Loader2 className="h-5 w-5 animate-spin" aria-label={t("common.loading")} />
        </CardContent>
      </Card>
    );
  }

  if (!view) {
    return (
      <Card data-testid={regionId} {...(!computer ? guideAnchor("settings.codespaces") : {})}>
        <CardContent className="space-y-4 p-6">
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>{loadFailed}</AlertTitle>
            <AlertDescription>
              {t("pages.settings.codespaces.loadFailedDescription")}
            </AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => void load()}>
            {t("pages.settings.codespaces.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const selectedProvider = view.providers?.find((entry) => entry.provider === provider);
  const { readiness, connection, limits } = selectedProvider ?? view;
  const repositoriesStale = selectedProvider?.repositories_stale ?? view.repositories_stale;
  const resourcesStale = selectedProvider?.resources_stale ?? view.resources_stale;
  const codespaces = view.codespaces.filter(
    (codespace) =>
      codespace.provider === provider &&
      (!computer || localComputerId(codespace.repository_id) === computer.deviceId),
  );
  const ready = readiness.state === "ready";
  const connected = connection.state === "connected";
  const canCreate = ready && connected && accessEnabled && (availableRepositories?.length ?? 0) > 0;
  const formatDate = (value: number) => new Date(value).toLocaleString(i18n.language);

  return (
    <Card data-testid={regionId} {...(!computer ? guideAnchor("settings.codespaces") : {})}>
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {computer ? (
              <Laptop className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
            ) : (
              <Cloud className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
            )}
            <div className="min-w-0">
              <CardTitle className="text-base">
                {t(computer ? "localDevices.codespaces.title" : "pages.settings.codespaces.title")}
              </CardTitle>
              <CardDescription>
                {t(
                  computer
                    ? "localDevices.codespaces.description"
                    : "pages.settings.codespaces.description",
                )}
              </CardDescription>
            </div>
          </div>
          <Badge
            variant={ready ? "default" : "secondary"}
            data-testid="github-codespace-instance-state"
          >
            {t(`pages.settings.codespaces.instanceStates.${readiness.state}`)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataRegion
          hasResult
          pending={loading || refreshing}
          error={refreshError ?? (loadError ? loadFailed : null)}
          onRetry={computer ? refreshList : () => load()}
          testId={computer ? `${regionId}-region` : "github-management-region"}
        >
          <Alert role="note" data-testid="github-codespace-disclosure">
            <ShieldAlert aria-hidden="true" />
            <AlertTitle>
              {t(
                provider === "local-sandboxes"
                  ? "localDevices.disclosureTitle"
                  : "pages.settings.codespaces.disclosureTitle",
              )}
            </AlertTitle>
            <AlertDescription>
              {t(
                provider === "local-sandboxes"
                  ? "localDevices.localDisclosure"
                  : "pages.settings.codespaces.disclosureDescription",
              )}
            </AlertDescription>
          </Alert>

          {!ready && (
            <Alert variant={readiness.state === "disabled" ? "default" : "destructive"}>
              <AlertCircle aria-hidden="true" />
              <AlertTitle>
                {t(`pages.settings.codespaces.instanceStates.${readiness.state}`)}
              </AlertTitle>
              <AlertDescription>
                {t(
                  provider === "local-sandboxes"
                    ? "localDevices.unavailable"
                    : `pages.settings.codespaces.instanceDescriptions.${readiness.state}`,
                )}
              </AlertDescription>
            </Alert>
          )}

          {ready && !connected && (
            <Alert>
              <AlertCircle aria-hidden="true" />
              <AlertTitle>
                {t(
                  provider === "local-sandboxes"
                    ? "localDevices.title"
                    : "pages.settings.codespaces.connectFirstTitle",
                )}
              </AlertTitle>
              <AlertDescription>
                {t(
                  provider === "local-sandboxes"
                    ? "localDevices.connectionRequired"
                    : "pages.settings.codespaces.connectFirstDescription",
                )}
              </AlertDescription>
            </Alert>
          )}

          {repositoriesStale && !computer && (
            <Alert data-testid="github-codespace-repositories-stale">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>{t("pages.settings.github.repositoriesStaleTitle")}</AlertTitle>
              <AlertDescription>{t("pages.settings.github.repositoriesStale")}</AlertDescription>
            </Alert>
          )}

          {resourcesStale && (
            <Alert data-testid="github-codespace-resources-stale">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>{t("pages.settings.codespaces.resourcesStaleTitle")}</AlertTitle>
              <AlertDescription>
                {t(
                  computer
                    ? "localDevices.codespaces.resourcesStale"
                    : "pages.settings.codespaces.resourcesStale",
                )}
              </AlertDescription>
            </Alert>
          )}

          {canCreate && (
            <form
              className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_minmax(0,12rem)_auto]"
              data-testid={`${formId}-create`}
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <div className="space-y-1">
                <Label htmlFor={`${formId}-repository`}>
                  {t("pages.settings.codespaces.repository")}
                </Label>
                <Select value={repositoryId} onValueChange={setRepositoryId}>
                  <SelectTrigger id={`${formId}-repository`} data-testid={`${formId}-repository`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRepositories?.map((repository) => (
                      <SelectItem key={repository.repository_id} value={repository.repository_id}>
                        {repository.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor={`${formId}-ref`}>{t("pages.settings.codespaces.ref")}</Label>
                <Input
                  id={`${formId}-ref`}
                  data-testid={`${formId}-ref`}
                  value={ref}
                  required
                  placeholder={t("localDevices.codespaces.refPlaceholder")}
                  maxLength={255}
                  onChange={(event) => setRef(event.target.value)}
                />
              </div>
              <div className="flex items-end">
                <Button
                  type="submit"
                  disabled={creating || !repositoryId || !ref.trim()}
                  data-testid={`${formId}-create-submit`}
                >
                  {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t("pages.settings.codespaces.create")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground sm:col-span-3">
                {t(
                  provider === "local-sandboxes"
                    ? "localDevices.createHint"
                    : "pages.settings.codespaces.createHint",
                  {
                    held: limits.codespaces.held,
                    max: limits.codespaces.max_per_user,
                  },
                )}
              </p>
            </form>
          )}

          {createError && (
            <InlineError
              title={t("pages.settings.codespaces.requestFailed")}
              message={createError}
              onRetry={() => void create()}
            />
          )}
          {!accessEnabled && (
            <p className="text-sm text-muted-foreground">
              {t("localDevices.codespaces.accessDisabled")}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium">{t("pages.settings.codespaces.list")}</h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refreshList()}
              aria-label={t("pages.settings.codespaces.refresh")}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>

          {codespaces.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="github-codespace-empty">
              {t("pages.settings.codespaces.empty")}
            </p>
          ) : (
            <ul className="space-y-2" data-testid="github-codespace-list">
              {codespaces.map((codespace) => {
                const setupIncomplete =
                  codespace.lifecycle_error === "CODESPACE_LOCAL_SETUP_INCOMPLETE";
                const busy =
                  BUSY_STATES.has(codespace.state) ||
                  busyCodespaces.has(codespace.codespace_id) ||
                  checkingCodespaces.has(codespace.codespace_id) ||
                  !accessEnabled;
                const requestBusy =
                  busyCodespaces.has(codespace.codespace_id) ||
                  checkingCodespaces.has(codespace.codespace_id);
                const storedActionError = actionErrors[codespace.codespace_id];
                const actionError = errorStillCurrent(storedActionError, codespace)
                  ? storedActionError
                  : undefined;
                const storedCheckError = checkErrors[codespace.codespace_id];
                const checkError = errorStillCurrent(storedCheckError, codespace)
                  ? storedCheckError
                  : undefined;
                const errorMessage =
                  actionError?.message ??
                  checkError?.message ??
                  (codespace.lifecycle_error
                    ? failureMessage({ code: codespace.lifecycle_error })
                    : null);
                const needsAttention = BUSY_STATES.has(codespace.state) && Boolean(errorMessage);
                return (
                  <li
                    key={codespace.codespace_id}
                    className="rounded-lg border bg-card p-3"
                    data-testid={`github-codespace-${codespace.codespace_id}`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex min-w-0 items-start gap-2.5">
                        <span
                          className={cn(
                            "mt-2 size-2 shrink-0 rounded-full",
                            TONE_DOT[needsAttention ? "problem" : stateTone(codespace.state)],
                          )}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{codespace.repository}</p>
                          <p className="flex items-center gap-1 text-sm text-muted-foreground">
                            <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                            <span className="truncate font-mono text-xs">
                              {codespace.current_ref ?? codespace.requested_ref}
                            </span>
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {t(
                              codespace.provider === "local-sandboxes"
                                ? "localDevices.localProviderLine"
                                : "pages.settings.codespaces.providerLine",
                              {
                                machine: codespace.machine.display_name,
                              },
                            )}
                          </p>
                        </div>
                      </div>
                      <Badge
                        variant="outline"
                        className={
                          TONE_BADGE[needsAttention ? "problem" : stateTone(codespace.state)]
                        }
                        data-testid={`github-codespace-state-${codespace.codespace_id}`}
                      >
                        {needsAttention
                          ? t("localDevices.codespaces.needsAttention", {
                              state: t(`pages.settings.codespaces.states.${codespace.state}`),
                            })
                          : t(`pages.settings.codespaces.states.${codespace.state}`)}
                      </Badge>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("localDevices.codespaces.resources", {
                        cpu: codespace.machine.cpu_cores,
                        memory: codespace.machine.memory_bytes / 1024 ** 3,
                      })}
                    </p>
                    {!computer && (
                      <p className="text-xs text-muted-foreground">
                        {t("localDevices.codespaces.disk", {
                          storage: codespace.machine.storage_bytes / 1024 ** 3,
                        })}
                      </p>
                    )}
                    {computer && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {codespace.observed_at === null
                          ? t("localDevices.codespaces.notObserved")
                          : t("localDevices.codespaces.observed", {
                              date: formatDate(codespace.observed_at),
                            })}
                      </p>
                    )}
                    {errorMessage && (
                      <InlineError
                        title={t(
                          actionError
                            ? "pages.settings.codespaces.requestFailed"
                            : "localDevices.codespaces.observationFailed",
                        )}
                        message={errorMessage}
                      />
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {(errorMessage || (computer && BUSY_STATES.has(codespace.state))) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={requestBusy}
                          onClick={(event) =>
                            actionError && !setupIncomplete
                              ? void lifecycle(codespace, actionError.action)
                              : void checkState(codespace, event.currentTarget)
                          }
                          data-testid={`codespace-reconcile-${codespace.codespace_id}`}
                        >
                          {checkingCodespaces.has(codespace.codespace_id) && (
                            <Loader2 className="mr-1 size-4 animate-spin" />
                          )}
                          {t("localDevices.codespaces.reconcile")}
                        </Button>
                      )}
                      {codespace.state === "stopped" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || setupIncomplete}
                          onClick={() => void lifecycle(codespace, "start")}
                          data-testid={`github-codespace-start-${codespace.codespace_id}`}
                        >
                          <Play className="mr-1 h-4 w-4" aria-hidden="true" />
                          {t("pages.settings.codespaces.start")}
                        </Button>
                      )}
                      {codespace.state === "usable" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void lifecycle(codespace, "stop")}
                          data-testid={`github-codespace-stop-${codespace.codespace_id}`}
                        >
                          <Square className="mr-1 h-4 w-4" aria-hidden="true" />
                          {t("pages.settings.codespaces.stop")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={requestBusy || !ownerDeleteEnabled}
                        onClick={(event) => {
                          openDeleteDialog(codespace, event.currentTarget);
                        }}
                        data-testid={`github-codespace-delete-${codespace.codespace_id}`}
                      >
                        <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
                        {t("pages.settings.codespaces.delete")}
                      </Button>
                    </div>
                    <Collapsible className="mt-2">
                      <CollapsibleTrigger
                        className="group inline-flex items-center gap-1 rounded text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid={`github-codespace-details-toggle-${codespace.codespace_id}`}
                      >
                        <ChevronDown
                          className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
                          aria-hidden="true"
                        />
                        {t("pages.settings.codespaces.technicalDetails")}
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <dl
                          className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md bg-muted/50 p-3 text-xs"
                          data-testid={`github-codespace-details-${codespace.codespace_id}`}
                        >
                          <dt className="text-muted-foreground">
                            {t("pages.settings.codespaces.details.requestedRef")}
                          </dt>
                          <dd className="truncate font-mono">{codespace.requested_ref}</dd>
                          <dt className="text-muted-foreground">
                            {t("pages.settings.codespaces.details.currentRef")}
                          </dt>
                          <dd className="truncate font-mono">
                            {codespace.current_ref ??
                              t("pages.settings.codespaces.details.unknown")}
                          </dd>
                          <dt className="text-muted-foreground">
                            {t("pages.settings.codespaces.details.lifecycle")}
                          </dt>
                          <dd>
                            {t("pages.settings.codespaces.detailLine", {
                              desired: t(
                                `pages.settings.codespaces.desired.${codespace.desired_state}`,
                              ),
                              observed: t(
                                `pages.settings.codespaces.observed.${codespace.observed_state}`,
                              ),
                              generation: codespace.generation,
                            })}
                          </dd>
                          <dt className="text-muted-foreground">
                            {t("pages.settings.codespaces.details.updated")}
                          </dt>
                          <dd>{formatDate(codespace.updated_at)}</dd>
                          <dt className="text-muted-foreground">
                            {t("pages.settings.codespaces.details.id")}
                          </dt>
                          <dd className="truncate font-mono">{codespace.codespace_id}</dd>
                        </dl>
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                );
              })}
            </ul>
          )}
        </DataRegion>
      </CardContent>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) {
            deleteDecision.current++;
            setPendingDelete(null);
          }
        }}
        title={t("pages.settings.codespaces.confirmDeleteTitle")}
        description={t("pages.settings.codespaces.confirmDeleteDescription", {
          repository: pendingDelete?.repository ?? "",
        })}
        confirmLabel={t("pages.settings.codespaces.delete")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={remove}
        confirmDisabled={deleteNeedsRefresh || !ownerDeleteEnabled}
        content={
          deleteError ? (
            <>
              <InlineError
                title={t("pages.settings.codespaces.requestFailed")}
                message={deleteError}
              />
              {deleteNeedsRefresh && pendingDelete && (
                <Button variant="outline" onClick={() => void refreshDeleteTarget(pendingDelete)}>
                  {t("localDevices.codespaces.reconcile")}
                </Button>
              )}
            </>
          ) : null
        }
        onReturnFocus={() => deleteTriggerRef.current?.focus()}
      />
    </Card>
  );
}
