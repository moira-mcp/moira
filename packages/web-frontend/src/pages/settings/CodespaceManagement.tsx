import React, { useEffect, useMemo, useRef, useState } from "react";
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
import type { LocalDeviceView } from "@mcp-moira/shared";
import { parseLocalRepositoryTargetId } from "@mcp-moira/shared/local-device-types";
import { decodeReference, isReference } from "@mcp-moira/shared/workspace-references";
import { apiClient } from "@/services/api-client";
import type { ManagedWorkspaceView, WorkspaceOperationView } from "@/types/api-types";
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

const BUSY_STATES: ReadonlySet<ManagedWorkspaceView["state"]> = new Set([
  "create_pending",
  "create_submitted",
  "start_pending",
  "stop_pending",
  "delete_pending",
  "cleanup_pending",
  "ambiguous",
]);

/** The colour a state reads in: running, resting, moving, or needing attention. */
function stateTone(state: ManagedWorkspaceView["state"]): "running" | "idle" | "busy" | "problem" {
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

type ResourceRequestError = { message: string; origin: ManagedWorkspaceView };
type RetainedOperation = {
  operation?: string;
  owner: string;
  query?: string;
  action: "create" | "start" | "resume_setup" | "stop" | "delete" | "adopt";
};

function errorStillCurrent(error: ResourceRequestError | undefined, current: ManagedWorkspaceView) {
  if (!error) return false;
  const origin = error.origin;
  return !(
    current.workspace !== origin.workspace ||
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

/** Recognize the workspace-addressed HTTP projection inside otherwise opaque operation data. */
function isWorkspaceObservation(value: unknown): value is ManagedWorkspaceView {
  return (
    value !== null &&
    typeof value === "object" &&
    "workspace" in value &&
    isReference(value.workspace, "workspace") &&
    "codespace_id" in value &&
    decodeReference(value.workspace, "workspace").resourceId === value.codespace_id
  );
}

export function CodespaceManagement({ scope }: { scope: CodespaceManagementScope }) {
  const { t, i18n } = useTranslation();
  const guard = useReadOwnerGuard();
  const provider = scope.provider;
  const computer = scope.provider === "local-sandboxes" ? scope.computer : null;
  const computerId = computer?.deviceId;
  const localCapability =
    computer?.owner.state === "available" && computer.owner.local.state === "configured"
      ? computer.owner.local
      : null;
  const ownerUnavailable = computer?.owner.state === "unavailable";
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
      computer.owner.state === "available" &&
      localCapability?.policy.enabled === true);
  const ownerDeleteEnabled =
    !computer ||
    (computer.status === "active" &&
      computer.owner.state === "available" &&
      localCapability?.control?.optedIn === true);
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
  const [controllerId, setControllerId] = useState("");
  const [devcontainerPath, setDevcontainerPath] = useState("");
  const [providerName, setProviderName] = useState("");
  const availableControllers = useMemo(
    () => view?.controllers?.filter((entry) => entry.available) ?? [],
    [view?.controllers],
  );
  useEffect(() => {
    setControllerId((current) =>
      view?.controllers?.some((entry) => entry.device_id === current && entry.available)
        ? current
        : availableControllers.length === 1
          ? availableControllers[0].device_id
          : "",
    );
  }, [view?.controllers, availableControllers]);
  const [creating, setCreating] = useState(false);
  const [busyCodespaces, setBusyCodespaces] = useState<Set<string>>(new Set());
  const [actionErrors, setActionErrors] = useState<
    Record<string, ResourceRequestError & { action: "start" | "resume_setup" | "stop" }>
  >({});
  const [createError, setCreateError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState<{ message: string; target: string } | null>(null);
  const [unconfirmedOperations, setUnconfirmedOperations] = useState<
    Record<string, RetainedOperation>
  >({});
  const retainedRef = useRef<Record<string, RetainedOperation>>({});
  const [operationCandidates, setOperationCandidates] = useState<
    Record<string, { operations: WorkspaceOperationView[]; nextCursor?: string }>
  >({});
  const pendingOperationIds = (target: string): string[] => [
    ...new Set([
      ...(retainedRef.current[target]?.operation ? [retainedRef.current[target].operation!] : []),
      ...(view?.codespaces.find((entry) => entry.codespace_id === target)?.pending_operations ??
        []),
    ]),
  ];
  const hasUnconfirmedOperation = (target: string) =>
    Boolean(unconfirmedOperations[target]) || pendingOperationIds(target).length > 0;
  const retainOperation = (target: string, retained: RetainedOperation) => {
    retainedRef.current = { ...retainedRef.current, [target]: retained };
    setUnconfirmedOperations(retainedRef.current);
  };
  const clearOperation = (target: string) => {
    const next = { ...retainedRef.current };
    delete next[target];
    retainedRef.current = next;
    setUnconfirmedOperations(next);
    setOperationCandidates((previous) => {
      const next = { ...previous };
      delete next[target];
      return next;
    });
  };
  const receiptError = (receipt: WorkspaceOperationView) =>
    receipt.error ?? (receipt.outcome?.ok === false ? receipt.outcome.error : undefined);
  const receiptConfirmed = (receipt: WorkspaceOperationView) => receipt.state === "completed";
  const unconfirmedFailure = (error: unknown) => {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return ![
      "CODESPACE_LOCAL_DELETE_APPROVAL_REQUIRED",
      "CODESPACE_GENERATION_CONFLICT",
      "CODESPACE_AUTHORIZATION_REQUIRED",
      "CODESPACE_REQUEST_INVALID",
      "CODESPACE_RESOURCE_INVALID",
      "CODESPACE_PROVIDER_DISABLED",
      "CODESPACE_PROVIDER_UNAVAILABLE",
      "CODESPACE_LOCAL_SETUP_INCOMPLETE",
      "LOCAL_UNAVAILABLE",
    ].includes(code);
  };
  const collectOperation = async (target: string, cursor?: string) => {
    const owned = guard(false);
    const retained = retainedRef.current[target];
    const references = pendingOperationIds(target);
    if (!references.length) {
      if (!retained) return;
      const found = await apiClient.findWorkspaceOperations(retained.owner, retained.query, cursor);
      if (!owned() || retainedRef.current[target] !== retained) return;
      setOperationCandidates((previous) => ({
        ...previous,
        [target]: {
          operations: cursor
            ? [...(previous[target]?.operations ?? []), ...found.operations].filter(
                (entry, index, rows) =>
                  rows.findIndex((peer) => peer.operation === entry.operation) === index,
              )
            : found.operations,
          ...(found.nextCursor ? { nextCursor: found.nextCursor } : {}),
        },
      }));
      return;
    }
    let refused = false;
    for (const reference of references) {
      const receipt = await apiClient.getWorkspaceOperation(reference);
      if (!owned() || retainedRef.current[target] !== retained) return;
      if (receipt.operation !== reference || !receiptConfirmed(receipt))
        throw new Error(t("localDevices.editor.unconfirmed"));
      if (receiptError(receipt)) refused = true;
    }
    clearOperation(target);
    setActionErrors((previous) => {
      const next = { ...previous };
      delete next[target];
      return next;
    });
    if (target === "create") setCreateError(null);
    if (target === "adopt") setAdoptError(null);
    if (!(await reloadManagement({ sync: true, silent: true }))) throw new Error(loadFailed);
    if (refused) toast.error(t("localDevices.provisioning.failed"));
  };
  const selectOriginal = async (target: string, operation: string) => {
    const retained = retainedRef.current[target];
    if (!retained) return;
    retainOperation(target, { ...retained, operation });
    try {
      await collectOperation(target);
    } catch {
      toast.error(t("localDevices.editor.unconfirmed"));
    }
  };
  const acceptOperation = (
    target: string,
    retained: RetainedOperation,
    receipt: WorkspaceOperationView,
  ) => {
    const observation = receipt.outcome?.ok ? receipt.outcome.result : receipt.original;
    if (isWorkspaceObservation(observation)) replaceCodespace(observation);
    if (receiptConfirmed(receipt)) clearOperation(target);
    else retainOperation(target, { ...retained, operation: receipt.operation });
    const error = receiptError(receipt);
    if (error) throw Object.assign(new Error(error.message), { code: error.code });
    if (!receiptConfirmed(receipt)) toast(t("localDevices.codespaces.requestAccepted"));
  };
  const [checkingCodespaces, setCheckingCodespaces] = useState<Set<string>>(new Set());
  const [checkErrors, setCheckErrors] = useState<Record<string, ResourceRequestError>>({});
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteNeedsRefresh, setDeleteNeedsRefresh] = useState(false);
  const checkState = async (codespace: ManagedWorkspaceView, trigger?: HTMLButtonElement) => {
    if (
      computer &&
      codespace.desired_state === "deleted" &&
      !hasUnconfirmedOperation(codespace.codespace_id)
    ) {
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
      if (hasUnconfirmedOperation(id)) {
        await collectOperation(id);
        return;
      }
      const refreshed = await reloadManagement({ sync: true, silent: true, throwOnError: true });
      if (owned() && !refreshed)
        setCheckErrors((previous) => ({
          ...previous,
          [id]: { message: loadFailed, origin: codespace },
        }));
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
  const [pendingDelete, setPendingDelete] = useState<ManagedWorkspaceView | null>(null);
  const pendingDeleteCollectOnly = Boolean(
    pendingDelete &&
    hasUnconfirmedOperation(pendingDelete.codespace_id) &&
    (computer ||
      pendingDelete.desired_state === "deleted" ||
      unconfirmedOperations[pendingDelete.codespace_id]?.action === "delete"),
  );
  const deleteDecision = useRef(0);
  // The element that opened the destructive dialog; focus returns to it after closing.
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const openDeleteDialog = (codespace: ManagedWorkspaceView, trigger?: HTMLButtonElement) => {
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
  const availableRepositories = useMemo(
    () =>
      repositories?.filter(
        (repository) =>
          (repository.provider ?? "github-codespaces") === provider &&
          (computerId
            ? localComputerId(repository.repository_id) === computerId
            : repository.device_id === controllerId),
      ),
    [repositories, provider, computerId, controllerId],
  );
  useEffect(() => {
    if (!availableRepositories) return;
    setRepositoryId((current) =>
      availableRepositories.some((repository) => repository.repository_id === current)
        ? current
        : (availableRepositories[0]?.repository_id ?? ""),
    );
  }, [availableRepositories]);

  useEffect(() => {
    if (loadError && !computer) toast.error(loadFailed);
  }, [loadError, loadFailed, computer]);

  /**
   * A lifecycle response echoes one codespace, including a finished one the listing no longer
   * offers. Show it at once, then take the server's listing as the authority on what remains.
   */
  const replaceCodespace = (codespace: ManagedWorkspaceView) => {
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
        unavailable: current.unavailable?.filter(
          (entry) => entry.codespace_id !== codespace.codespace_id,
        ),
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

  const selectedController = (deviceId?: string) =>
    view?.controllers?.find((entry) => entry.device_id === (deviceId ?? controllerId))?.controller;
  const create = async () => {
    const repository = availableRepositories?.find((entry) => entry.repository_id === repositoryId);
    if (!repository || hasUnconfirmedOperation("create") || !accessEnabled || !ref.trim()) return;
    const owned = guard(false);
    const retained: RetainedOperation = {
      owner: repository.controller,
      action: "create",
      query: repository.name,
    };
    retainOperation("create", retained);
    let returned = false;
    try {
      setCreating(true);
      setCreateError(null);
      const receipt = await apiClient.createWorkspace({
        target: repository.target,
        branch: ref.trim(),
        ...(!computer && devcontainerPath.trim()
          ? { devcontainer_path: devcontainerPath.trim() }
          : {}),
      });
      if (!owned()) return;
      returned = true;
      acceptOperation("create", retained, receipt);
      if (receiptConfirmed(receipt)) toast.success(t("pages.settings.codespaces.created"));
    } catch (error) {
      if (!owned()) return;
      if (!returned && !unconfirmedFailure(error)) clearOperation("create");
      setCreateError(failureMessage(error));
    } finally {
      if (owned()) setCreating(false);
    }
  };
  const lifecycle = async (
    codespace: ManagedWorkspaceView,
    action: "start" | "resume_setup" | "stop",
  ) => {
    if (
      !accessEnabled ||
      hasUnconfirmedOperation(codespace.codespace_id) ||
      (action === "start" && codespace.lifecycle_error === "CODESPACE_LOCAL_SETUP_INCOMPLETE")
    )
      return;
    const owner = codespace.controller;
    if (!owner) {
      setActionErrors((previous) => ({
        ...previous,
        [codespace.codespace_id]: {
          message: t("localDevices.provisioning.select"),
          action,
          origin: codespace,
        },
      }));
      return;
    }
    const owned = guard(false),
      target = codespace.codespace_id;
    // Non-create owner descriptors need not contain repository metadata.
    const retained: RetainedOperation = { owner, action };
    retainOperation(target, retained);
    let returned = false;
    try {
      markBusy(target, true);
      setActionErrors((previous) => {
        const next = { ...previous };
        delete next[target];
        return next;
      });
      const receipt = await apiClient.changeWorkspace(codespace.workspace, action);
      if (!owned()) return;
      returned = true;
      acceptOperation(target, retained, receipt);
      if (receiptConfirmed(receipt))
        toast.success(
          t(
            action === "stop"
              ? "pages.settings.codespaces.stopped"
              : "pages.settings.codespaces.started",
          ),
        );
    } catch (error) {
      if (!owned()) return;
      if (!returned && !unconfirmedFailure(error)) clearOperation(target);
      setActionErrors((previous) => ({
        ...previous,
        [target]: { message: failureMessage(error), action, origin: codespace },
      }));
    } finally {
      if (owned()) markBusy(target, false);
    }
  };
  const adopt = async (codespace?: ManagedWorkspaceView) => {
    const target = codespace?.codespace_id ?? "adopt",
      owner = selectedController();
    if (
      !owner ||
      adopting ||
      hasUnconfirmedOperation(target) ||
      (!codespace && !providerName.trim())
    )
      return;
    const owned = guard(false),
      retained: RetainedOperation = { owner, action: "adopt" };
    retainOperation(target, retained);
    let returned = false;
    try {
      setAdopting(true);
      setAdoptError(null);
      const receipt = codespace
        ? await apiClient.adoptWorkspace(codespace.workspace, owner)
        : await apiClient.adoptExternalWorkspace(owner, providerName.trim());
      if (!owned()) return;
      returned = true;
      acceptOperation(target, retained, receipt);
    } catch (error) {
      if (!owned()) return;
      if (!returned && !unconfirmedFailure(error)) clearOperation(target);
      setAdoptError({ message: failureMessage(error), target });
    } finally {
      if (owned()) setAdopting(false);
    }
  };
  const refreshDeleteTarget = async () => {
    // A new observation closes the previous decision; only another explicit confirmation can delete.
    deleteDecision.current++;
    setPendingDelete(null);
    await refreshList();
  };
  const remove = async () => {
    const captured = pendingDelete;
    if (
      !captured ||
      deleteNeedsRefresh ||
      !ownerDeleteEnabled ||
      !view?.codespaces.some((entry) => entry.codespace_id === captured.codespace_id)
    )
      return;
    if (pendingDeleteCollectOnly) {
      await collectOperation(captured.codespace_id);
      return;
    }
    const owner = captured.controller;
    if (!owner) {
      setDeleteError(t("localDevices.provisioning.select"));
      throw new Error(t("localDevices.provisioning.select"));
    }
    const owned = guard(false),
      decision = deleteDecision.current,
      target = captured.codespace_id;
    const retained: RetainedOperation = { owner, action: "delete" };
    retainOperation(target, retained);
    let returned = false;
    try {
      markBusy(target, true);
      setDeleteError(null);
      const receipt = await apiClient.deleteWorkspace(captured.workspace);
      if (!owned()) return;
      returned = true;
      acceptOperation(target, retained, receipt);
      if (receiptConfirmed(receipt)) toast.success(t("pages.settings.codespaces.deleted"));
    } catch (error) {
      if (!owned()) return;
      if (!returned && !unconfirmedFailure(error)) clearOperation(target);
      if (deleteDecision.current === decision) {
        setDeleteError(failureMessage(error));
        setDeleteNeedsRefresh(!retainedRef.current[target]);
      }
      throw error;
    } finally {
      if (owned()) markBusy(target, false);
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
  const metadata =
    selectedProvider && !("error" in selectedProvider)
      ? selectedProvider
      : view.providers
        ? undefined
        : view;
  const readiness = metadata?.readiness;
  const connection = metadata?.connection;
  const providerError = view.provider_errors?.find((entry) => entry.provider === provider)?.error;
  const repositoriesStale = metadata?.repositories_stale ?? view.repositories_stale;
  const resourcesStale = metadata?.resources_stale ?? view.resources_stale;
  const codespaces = view.codespaces.filter(
    (codespace) =>
      codespace.provider === provider &&
      (!computer || localComputerId(codespace.repository_id) === computer.deviceId),
  );
  const unavailable = (view.unavailable ?? []).filter(
    (entry) =>
      entry.provider === provider &&
      (!computer || localComputerId(entry.repository_id) === computer.deviceId),
  );
  const ready = readiness?.state === "ready";
  const connected = connection?.state === "connected";
  const canCreate =
    ready &&
    connected &&
    accessEnabled &&
    (availableRepositories?.length ?? 0) > 0 &&
    (computer !== null || controllerId !== "");
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
          {readiness && (
            <Badge
              variant={ready ? "default" : "secondary"}
              data-testid="github-codespace-instance-state"
            >
              {t(`pages.settings.codespaces.instanceStates.${readiness.state}`)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <DataRegion
          hasResult
          pending={loading || refreshing}
          error={
            ownerUnavailable
              ? t("localDevices.ownerUnavailable")
              : (refreshError ?? (loadError ? loadFailed : null))
          }
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

          {providerError && (
            <InlineError
              title={t("localDevices.codespaces.providerUnavailable")}
              message={failureMessage(providerError)}
              onRetry={() => void refreshList()}
              retryLabel={t("localDevices.codespaces.reconcile")}
            />
          )}

          {readiness && !ready && (
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

          {!computer && connected && (
            <div className="space-y-2">
              <Label htmlFor={`${formId}-controller`}>
                {t("localDevices.provisioning.controller")}
              </Label>
              <Select
                value={controllerId}
                onValueChange={setControllerId}
                disabled={
                  creating ||
                  adopting ||
                  hasUnconfirmedOperation("create") ||
                  hasUnconfirmedOperation("adopt")
                }
              >
                <SelectTrigger id={`${formId}-controller`}>
                  <SelectValue placeholder={t("localDevices.provisioning.select")} />
                </SelectTrigger>
                <SelectContent>
                  {availableControllers.map((entry) => (
                    <SelectItem key={entry.device_id} value={entry.device_id}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {availableControllers.length === 0 && (
                <p role="status">{t("localDevices.provisioning.unavailable")}</p>
              )}
            </div>
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
                  disabled={
                    creating || !repositoryId || !ref.trim() || hasUnconfirmedOperation("create")
                  }
                  data-testid={`${formId}-create-submit`}
                >
                  {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t("pages.settings.codespaces.create")}
                </Button>
              </div>
              {!computer && (
                <div className="space-y-1 sm:col-span-3">
                  <Label htmlFor={`${formId}-configuration`}>
                    {t("localDevices.provisioning.configuration")}
                  </Label>
                  <Input
                    id={`${formId}-configuration`}
                    value={devcontainerPath}
                    onChange={(event) => setDevcontainerPath(event.target.value)}
                  />
                </div>
              )}
              <p className="text-xs text-muted-foreground sm:col-span-3">
                {t(
                  provider === "local-sandboxes"
                    ? "localDevices.createHint"
                    : "localDevices.provisioning.hint",
                )}
              </p>
            </form>
          )}

          {!computer && connected && controllerId && (
            <form
              className="space-y-2 rounded-md border p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void adopt();
              }}
            >
              <Label htmlFor={`${formId}-existing`}>
                {t("localDevices.provisioning.existingName")}
              </Label>
              <Input
                id={`${formId}-existing`}
                value={providerName}
                onChange={(event) => setProviderName(event.target.value)}
                required
              />
              <Button
                type="submit"
                disabled={adopting || !providerName.trim() || hasUnconfirmedOperation("adopt")}
              >
                {t("localDevices.provisioning.adopt")}
              </Button>
            </form>
          )}
          {adoptError && (
            <InlineError
              title={t("pages.settings.codespaces.requestFailed")}
              message={adoptError.message}
              onRetry={() =>
                hasUnconfirmedOperation(adoptError.target)
                  ? void collectOperation(adoptError.target).catch(() =>
                      setAdoptError({
                        ...adoptError,
                        message: t("localDevices.provisioning.unconfirmed"),
                      }),
                    )
                  : void refreshList()
              }
            />
          )}

          {createError && (
            <InlineError
              title={t("pages.settings.codespaces.requestFailed")}
              message={createError}
              onRetry={() =>
                hasUnconfirmedOperation("create")
                  ? void collectOperation("create")
                      .then(() => setCreateError(null))
                      .catch(() => setCreateError(t("localDevices.editor.unconfirmed")))
                  : void create()
              }
            />
          )}
          {Object.entries(unconfirmedOperations).map(([target, retained]) => (
            <Alert key={target} data-testid={`workspace-original-${target}`}>
              <AlertTitle>{t("localDevices.codespaces.originalTitle")}</AlertTitle>
              <AlertDescription>
                <p>
                  {t(
                    retained.operation
                      ? "localDevices.editor.unconfirmed"
                      : "localDevices.codespaces.findOriginalHint",
                  )}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void collectOperation(target).catch(() =>
                      toast.error(t("localDevices.editor.unconfirmed")),
                    )
                  }
                >
                  {t(
                    retained.operation
                      ? "localDevices.codespaces.collectOriginal"
                      : "localDevices.codespaces.findOriginal",
                  )}
                </Button>
                {operationCandidates[target] && (
                  <>
                    {operationCandidates[target].operations.length === 0 && (
                      <p>{t("localDevices.codespaces.noOriginalMatch")}</p>
                    )}
                    <ul className="mt-2 space-y-2">
                      {operationCandidates[target].operations.map((candidate) => (
                        <li key={candidate.operation}>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void selectOriginal(target, candidate.operation)}
                          >
                            {t("localDevices.codespaces.selectOriginal", {
                              description: candidate.descriptor?.description ?? candidate.state,
                            })}
                          </Button>
                        </li>
                      ))}
                    </ul>
                    {operationCandidates[target].nextCursor && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          void collectOperation(
                            target,
                            operationCandidates[target].nextCursor,
                          ).catch(() => toast.error(t("localDevices.editor.unconfirmed")))
                        }
                      >
                        {t("localDevices.codespaces.moreOriginals")}
                      </Button>
                    )}
                  </>
                )}
              </AlertDescription>
            </Alert>
          ))}
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

          {codespaces.length === 0 && unavailable.length === 0 && !providerError ? (
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
                const outcomeUnconfirmed = hasUnconfirmedOperation(codespace.codespace_id);
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
                                machine:
                                  codespace.machine?.display_name ??
                                  t("pages.settings.codespaces.details.unknown"),
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
                    {codespace.remote && (
                      <p
                        className="mt-2 text-xs text-muted-foreground"
                        data-testid={`codespace-remote-${codespace.codespace_id}`}
                      >
                        {t(`localDevices.codespaces.remote.${codespace.remote.state}`)}
                      </p>
                    )}
                    {codespace.machine && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {t("localDevices.codespaces.resources", {
                          cpu: codespace.machine.cpu_cores,
                          memory: codespace.machine.memory_bytes / 1024 ** 3,
                        })}
                      </p>
                    )}
                    {!computer && codespace.machine && (
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
                    {setupIncomplete && codespace.setup_failure && (
                      <p
                        className="mt-2 text-sm text-muted-foreground"
                        data-testid={`codespace-setup-remedy-${codespace.codespace_id}`}
                      >
                        {t(`localDevices.codespaces.setupFailure.${codespace.setup_failure}`)}
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {(computer || codespace.controller) &&
                        setupIncomplete &&
                        codespace.desired_state !== "deleted" && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={requestBusy || !accessEnabled || outcomeUnconfirmed}
                            onClick={() => void lifecycle(codespace, "resume_setup")}
                            data-testid={`codespace-resume-setup-${codespace.codespace_id}`}
                          >
                            <Play className="mr-1 h-4 w-4" aria-hidden="true" />
                            {t("localDevices.codespaces.resumeSetup")}
                          </Button>
                        )}
                      {!computer && codespace.state !== "usable" && !outcomeUnconfirmed && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={requestBusy || adopting || !controllerId}
                          onClick={() => void adopt(codespace)}
                        >
                          {t("localDevices.provisioning.adopt")}
                        </Button>
                      )}
                      {(errorMessage ||
                        outcomeUnconfirmed ||
                        (computer && BUSY_STATES.has(codespace.state))) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={requestBusy}
                          onClick={(event) => void checkState(codespace, event.currentTarget)}
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
                          disabled={busy || setupIncomplete || outcomeUnconfirmed}
                          onClick={() => void lifecycle(codespace, "start")}
                          data-testid={`github-codespace-start-${codespace.codespace_id}`}
                        >
                          <Play className="mr-1 h-4 w-4" aria-hidden="true" />
                          {t("pages.settings.codespaces.start")}
                        </Button>
                      )}
                      {(codespace.state === "usable" ||
                        (!computer &&
                          ["create_pending", "create_submitted", "start_pending"].includes(
                            codespace.state,
                          ))) && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy || outcomeUnconfirmed}
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
                        disabled={requestBusy || !ownerDeleteEnabled || outcomeUnconfirmed}
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
                            {t(`pages.settings.codespaces.desired.${codespace.desired_state}`)}
                            {" · "}
                            {t(`pages.settings.codespaces.observed.${codespace.observed_state}`)}
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
              {unavailable.map((entry) => (
                <li
                  key={entry.codespace_id}
                  className="rounded-md border p-3"
                  data-testid={`codespace-unavailable-${entry.codespace_id}`}
                >
                  <p className="truncate font-medium">{entry.repository}</p>
                  <p className="flex items-center gap-1 text-sm text-muted-foreground">
                    <GitBranch className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate font-mono text-xs">{entry.requested_ref}</span>
                  </p>
                  <InlineError
                    title={t("localDevices.codespaces.observationFailed")}
                    message={failureMessage(entry.error)}
                  />
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("localDevices.codespaces.unavailableIdentity")}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs">{entry.codespace_id}</p>
                </li>
              ))}
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
        confirmLabel={t(
          pendingDeleteCollectOnly
            ? "localDevices.codespaces.reconcile"
            : "pages.settings.codespaces.delete",
        )}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={remove}
        confirmDisabled={
          deleteNeedsRefresh ||
          !ownerDeleteEnabled ||
          !view.codespaces.some((entry) => entry.codespace_id === pendingDelete?.codespace_id)
        }
        content={
          deleteError ? (
            <>
              <InlineError
                title={t("pages.settings.codespaces.requestFailed")}
                message={deleteError}
              />
              {deleteNeedsRefresh && pendingDelete && (
                <Button variant="outline" onClick={() => void refreshDeleteTarget()}>
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
