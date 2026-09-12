import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Cloud,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  Square,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceSummaryView } from "@mcp-moira/shared";
import { apiClient } from "@/services/api-client";
import type { WorkspaceManagementView } from "@/types/api-types";
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

const BUSY_STATES: ReadonlySet<WorkspaceSummaryView["state"]> = new Set([
  "create_pending",
  "create_submitted",
  "start_pending",
  "stop_pending",
  "delete_pending",
  "cleanup_pending",
  "ambiguous",
]);

const FINAL_STATES: ReadonlySet<WorkspaceSummaryView["state"]> = new Set(["deleted", "rejected"]);

function stateVariant(
  state: WorkspaceSummaryView["state"],
): "default" | "secondary" | "destructive" | "outline" {
  if (state === "usable") return "default";
  if (state === "rejected" || state === "ambiguous") return "destructive";
  if (BUSY_STATES.has(state)) return "outline";
  return "secondary";
}

export const GitHubWorkspaceManagement: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<WorkspaceManagementView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [repositoryId, setRepositoryId] = useState("");
  const [ref, setRef] = useState("main");
  const [creating, setCreating] = useState(false);
  const [busyWorkspace, setBusyWorkspace] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummaryView | null>(null);
  // The element that opened the destructive dialog; focus returns to it after closing.
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(false);
      const next = await apiClient.getGitHubWorkspaces();
      setView(next);
      setRepositoryId((current) =>
        current && next.repositories.some((repository) => repository.repository_id === current)
          ? current
          : (next.repositories[0]?.repository_id ?? ""),
      );
    } catch {
      setLoadError(true);
      toast.error(t("pages.settings.workspaces.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceWorkspace = (workspace: WorkspaceSummaryView) => {
    setView((current) => {
      if (!current) return current;
      const exists = current.workspaces.some(
        (item) => item.workspace_id === workspace.workspace_id,
      );
      return {
        ...current,
        workspaces: exists
          ? current.workspaces.map((item) =>
              item.workspace_id === workspace.workspace_id ? workspace : item,
            )
          : [...current.workspaces, workspace],
      };
    });
  };

  const failureMessage = (error: unknown): string => {
    const message = error instanceof Error ? error.message : "";
    return message || t("pages.settings.workspaces.requestFailed");
  };

  const create = async () => {
    if (!repositoryId || !ref.trim()) return;
    try {
      setCreating(true);
      const workspace = await apiClient.createGitHubWorkspace({
        repository_id: repositoryId,
        ref: ref.trim(),
      });
      replaceWorkspace(workspace);
      toast.success(t("pages.settings.workspaces.created"));
    } catch (error) {
      toast.error(failureMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const lifecycle = async (workspace: WorkspaceSummaryView, action: "start" | "stop") => {
    try {
      setBusyWorkspace(workspace.workspace_id);
      const next =
        action === "start"
          ? await apiClient.startGitHubWorkspace(workspace.workspace_id)
          : await apiClient.stopGitHubWorkspace(workspace.workspace_id);
      replaceWorkspace(next);
      toast.success(
        t(
          action === "start"
            ? "pages.settings.workspaces.started"
            : "pages.settings.workspaces.stopped",
        ),
      );
    } catch (error) {
      toast.error(failureMessage(error));
    } finally {
      setBusyWorkspace(null);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      setBusyWorkspace(pendingDelete.workspace_id);
      const next = await apiClient.deleteGitHubWorkspace(
        pendingDelete.workspace_id,
        pendingDelete.generation,
      );
      replaceWorkspace(next);
      toast.success(t("pages.settings.workspaces.deleted"));
    } catch (error) {
      toast.error(failureMessage(error));
      throw error;
    } finally {
      setBusyWorkspace(null);
    }
  };

  if (loading) {
    return (
      <Card data-testid="github-workspace-management">
        <CardContent className="flex min-h-32 items-center justify-center p-6">
          <Loader2 className="h-5 w-5 animate-spin" aria-label={t("common.loading")} />
        </CardContent>
      </Card>
    );
  }

  if (loadError || !view) {
    return (
      <Card data-testid="github-workspace-management">
        <CardContent className="space-y-4 p-6">
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>{t("pages.settings.workspaces.loadFailed")}</AlertTitle>
            <AlertDescription>
              {t("pages.settings.workspaces.loadFailedDescription")}
            </AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => void load()}>
            {t("pages.settings.workspaces.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { readiness, connection, repositories, workspaces } = view;
  const ready = readiness.state === "ready";
  const connected = connection.state === "connected";
  const canCreate = ready && connected && repositories.length > 0;
  const visibleWorkspaces = workspaces.filter((workspace) => !FINAL_STATES.has(workspace.state));
  const formatDate = (value: number) => new Date(value).toLocaleString(i18n.language);

  return (
    <Card data-testid="github-workspace-management">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Cloud className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <CardTitle className="text-base">{t("pages.settings.workspaces.title")}</CardTitle>
              <CardDescription>{t("pages.settings.workspaces.description")}</CardDescription>
            </div>
          </div>
          <Badge
            variant={ready ? "default" : "secondary"}
            data-testid="github-workspace-instance-state"
          >
            {t(`pages.settings.workspaces.instanceStates.${readiness.state}`)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert data-testid="github-workspace-disclosure">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>{t("pages.settings.workspaces.disclosureTitle")}</AlertTitle>
          <AlertDescription>
            {t("pages.settings.workspaces.disclosureDescription")}
          </AlertDescription>
        </Alert>

        {!ready && (
          <Alert variant={readiness.state === "disabled" ? "default" : "destructive"}>
            <AlertCircle aria-hidden="true" />
            <AlertTitle>
              {t(`pages.settings.workspaces.instanceStates.${readiness.state}`)}
            </AlertTitle>
            <AlertDescription>
              {t(`pages.settings.workspaces.instanceDescriptions.${readiness.state}`)}
            </AlertDescription>
          </Alert>
        )}

        {ready && !connected && (
          <Alert>
            <AlertCircle aria-hidden="true" />
            <AlertTitle>{t("pages.settings.workspaces.connectFirstTitle")}</AlertTitle>
            <AlertDescription>
              {t("pages.settings.workspaces.connectFirstDescription")}
            </AlertDescription>
          </Alert>
        )}

        {canCreate && (
          <form
            className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_minmax(0,12rem)_auto]"
            data-testid="github-workspace-create"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="github-workspace-repository">
                {t("pages.settings.workspaces.repository")}
              </Label>
              <Select value={repositoryId} onValueChange={setRepositoryId}>
                <SelectTrigger
                  id="github-workspace-repository"
                  data-testid="github-workspace-repository"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {repositories.map((repository) => (
                    <SelectItem key={repository.repository_id} value={repository.repository_id}>
                      {repository.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="github-workspace-ref">{t("pages.settings.workspaces.ref")}</Label>
              <Input
                id="github-workspace-ref"
                data-testid="github-workspace-ref"
                value={ref}
                maxLength={255}
                onChange={(event) => setRef(event.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button
                type="submit"
                disabled={creating || !repositoryId || !ref.trim()}
                data-testid="github-workspace-create-submit"
              >
                {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("pages.settings.workspaces.create")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              {t("pages.settings.workspaces.createHint", {
                active: readiness.usage.active_resources,
                max: readiness.usage.max_active_resources,
              })}
            </p>
          </form>
        )}

        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">{t("pages.settings.workspaces.list")}</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            aria-label={t("pages.settings.workspaces.refresh")}
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        {visibleWorkspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="github-workspace-empty">
            {t("pages.settings.workspaces.empty")}
          </p>
        ) : (
          <ul className="space-y-2" data-testid="github-workspace-list">
            {visibleWorkspaces.map((workspace) => {
              const busy =
                BUSY_STATES.has(workspace.state) || busyWorkspace === workspace.workspace_id;
              return (
                <li
                  key={workspace.workspace_id}
                  className="space-y-2 rounded-md border p-3"
                  data-testid={`github-workspace-${workspace.workspace_id}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {workspace.repository}
                        <span className="text-muted-foreground"> @ {workspace.ref}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("pages.settings.workspaces.providerLine", {
                          machine: workspace.machine.display_name,
                        })}
                      </p>
                    </div>
                    <Badge
                      variant={stateVariant(workspace.state)}
                      data-testid={`github-workspace-state-${workspace.workspace_id}`}
                    >
                      {t(`pages.settings.workspaces.states.${workspace.state}`)}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("pages.settings.workspaces.detailLine", {
                      desired: t(`pages.settings.workspaces.desired.${workspace.desired_state}`),
                      observed: t(`pages.settings.workspaces.observed.${workspace.observed_state}`),
                      generation: workspace.generation,
                      updated: formatDate(workspace.updated_at),
                      // React escapes the rendered text; i18next must not HTML-escape the date.
                      interpolation: { escapeValue: false },
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {workspace.state === "stopped" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void lifecycle(workspace, "start")}
                        data-testid={`github-workspace-start-${workspace.workspace_id}`}
                      >
                        <Play className="mr-1 h-4 w-4" aria-hidden="true" />
                        {t("pages.settings.workspaces.start")}
                      </Button>
                    )}
                    {workspace.state === "usable" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void lifecycle(workspace, "stop")}
                        data-testid={`github-workspace-stop-${workspace.workspace_id}`}
                      >
                        <Square className="mr-1 h-4 w-4" aria-hidden="true" />
                        {t("pages.settings.workspaces.stop")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={(event) => {
                        deleteTriggerRef.current = event.currentTarget;
                        setPendingDelete(workspace);
                      }}
                      data-testid={`github-workspace-delete-${workspace.workspace_id}`}
                    >
                      <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
                      {t("pages.settings.workspaces.delete")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title={t("pages.settings.workspaces.confirmDeleteTitle")}
        description={t("pages.settings.workspaces.confirmDeleteDescription", {
          repository: pendingDelete?.repository ?? "",
        })}
        confirmLabel={t("pages.settings.workspaces.delete")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={remove}
        onReturnFocus={() => deleteTriggerRef.current?.focus()}
      />
    </Card>
  );
};
