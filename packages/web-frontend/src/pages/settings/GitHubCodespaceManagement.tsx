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
import type { CodespaceSummaryView } from "@mcp-moira/shared";
import { apiClient } from "@/services/api-client";
import type { CodespaceManagementView } from "@/types/api-types";
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

const BUSY_STATES: ReadonlySet<CodespaceSummaryView["state"]> = new Set([
  "create_pending",
  "create_submitted",
  "start_pending",
  "stop_pending",
  "delete_pending",
  "cleanup_pending",
  "ambiguous",
]);

function stateVariant(
  state: CodespaceSummaryView["state"],
): "default" | "secondary" | "destructive" | "outline" {
  if (state === "usable") return "default";
  if (state === "rejected" || state === "ambiguous") return "destructive";
  if (BUSY_STATES.has(state)) return "outline";
  return "secondary";
}

export const GitHubCodespaceManagement: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<CodespaceManagementView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [repositoryId, setRepositoryId] = useState("");
  const [ref, setRef] = useState("main");
  const [creating, setCreating] = useState(false);
  const [busyCodespace, setBusyCodespace] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CodespaceSummaryView | null>(null);
  // The element that opened the destructive dialog; focus returns to it after closing.
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      try {
        if (!silent) setLoading(true);
        setLoadError(false);
        const next = await apiClient.getGitHubCodespaces();
        setView(next);
        setRepositoryId((current) =>
          current && next.repositories.some((repository) => repository.repository_id === current)
            ? current
            : (next.repositories[0]?.repository_id ?? ""),
        );
      } catch {
        setLoadError(true);
        toast.error(t("pages.settings.codespaces.loadFailed"));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * A lifecycle response echoes one codespace, including a finished one the listing no longer
   * offers. Show it at once, then take the server's listing as the authority on what remains.
   */
  const replaceCodespace = (codespace: CodespaceSummaryView) => {
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

  const failureMessage = (error: unknown): string => {
    const message = error instanceof Error ? error.message : "";
    return message || t("pages.settings.codespaces.requestFailed");
  };

  const create = async () => {
    if (!repositoryId || !ref.trim()) return;
    try {
      setCreating(true);
      const codespace = await apiClient.createGitHubCodespace({
        repository_id: repositoryId,
        ref: ref.trim(),
      });
      replaceCodespace(codespace);
      toast.success(t("pages.settings.codespaces.created"));
    } catch (error) {
      toast.error(failureMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const lifecycle = async (codespace: CodespaceSummaryView, action: "start" | "stop") => {
    try {
      setBusyCodespace(codespace.codespace_id);
      const next =
        action === "start"
          ? await apiClient.startGitHubCodespace(codespace.codespace_id)
          : await apiClient.stopGitHubCodespace(codespace.codespace_id);
      replaceCodespace(next);
      toast.success(
        t(
          action === "start"
            ? "pages.settings.codespaces.started"
            : "pages.settings.codespaces.stopped",
        ),
      );
    } catch (error) {
      toast.error(failureMessage(error));
    } finally {
      setBusyCodespace(null);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    try {
      setBusyCodespace(pendingDelete.codespace_id);
      const next = await apiClient.deleteGitHubCodespace(
        pendingDelete.codespace_id,
        pendingDelete.generation,
      );
      replaceCodespace(next);
      toast.success(t("pages.settings.codespaces.deleted"));
    } catch (error) {
      toast.error(failureMessage(error));
      throw error;
    } finally {
      setBusyCodespace(null);
    }
  };

  if (loading) {
    return (
      <Card data-testid="github-codespace-management">
        <CardContent className="flex min-h-32 items-center justify-center p-6">
          <Loader2 className="h-5 w-5 animate-spin" aria-label={t("common.loading")} />
        </CardContent>
      </Card>
    );
  }

  if (loadError || !view) {
    return (
      <Card data-testid="github-codespace-management">
        <CardContent className="space-y-4 p-6">
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>{t("pages.settings.codespaces.loadFailed")}</AlertTitle>
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

  const { readiness, connection, repositories, codespaces } = view;
  const ready = readiness.state === "ready";
  const connected = connection.state === "connected";
  const canCreate = ready && connected && repositories.length > 0;
  const formatDate = (value: number) => new Date(value).toLocaleString(i18n.language);

  return (
    <Card data-testid="github-codespace-management">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Cloud className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <CardTitle className="text-base">{t("pages.settings.codespaces.title")}</CardTitle>
              <CardDescription>{t("pages.settings.codespaces.description")}</CardDescription>
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
        <Alert data-testid="github-codespace-disclosure">
          <ShieldAlert aria-hidden="true" />
          <AlertTitle>{t("pages.settings.codespaces.disclosureTitle")}</AlertTitle>
          <AlertDescription>
            {t("pages.settings.codespaces.disclosureDescription")}
          </AlertDescription>
        </Alert>

        {!ready && (
          <Alert variant={readiness.state === "disabled" ? "default" : "destructive"}>
            <AlertCircle aria-hidden="true" />
            <AlertTitle>
              {t(`pages.settings.codespaces.instanceStates.${readiness.state}`)}
            </AlertTitle>
            <AlertDescription>
              {t(`pages.settings.codespaces.instanceDescriptions.${readiness.state}`)}
            </AlertDescription>
          </Alert>
        )}

        {ready && !connected && (
          <Alert>
            <AlertCircle aria-hidden="true" />
            <AlertTitle>{t("pages.settings.codespaces.connectFirstTitle")}</AlertTitle>
            <AlertDescription>
              {t("pages.settings.codespaces.connectFirstDescription")}
            </AlertDescription>
          </Alert>
        )}

        {view.repositories_stale && (
          <Alert data-testid="github-codespace-repositories-stale">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>{t("pages.settings.github.repositoriesStaleTitle")}</AlertTitle>
            <AlertDescription>{t("pages.settings.github.repositoriesStale")}</AlertDescription>
          </Alert>
        )}

        {canCreate && (
          <form
            className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_minmax(0,12rem)_auto]"
            data-testid="github-codespace-create"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="github-codespace-repository">
                {t("pages.settings.codespaces.repository")}
              </Label>
              <Select value={repositoryId} onValueChange={setRepositoryId}>
                <SelectTrigger
                  id="github-codespace-repository"
                  data-testid="github-codespace-repository"
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
              <Label htmlFor="github-codespace-ref">{t("pages.settings.codespaces.ref")}</Label>
              <Input
                id="github-codespace-ref"
                data-testid="github-codespace-ref"
                value={ref}
                maxLength={255}
                onChange={(event) => setRef(event.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button
                type="submit"
                disabled={creating || !repositoryId || !ref.trim()}
                data-testid="github-codespace-create-submit"
              >
                {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t("pages.settings.codespaces.create")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">
              {t("pages.settings.codespaces.createHint", {
                active: readiness.usage.active_resources,
                max: readiness.usage.max_active_resources,
              })}
            </p>
          </form>
        )}

        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">{t("pages.settings.codespaces.list")}</h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
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
              const busy =
                BUSY_STATES.has(codespace.state) || busyCodespace === codespace.codespace_id;
              return (
                <li
                  key={codespace.codespace_id}
                  className="space-y-2 rounded-md border p-3"
                  data-testid={`github-codespace-${codespace.codespace_id}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {codespace.repository}
                        <span className="text-muted-foreground"> @ {codespace.ref}</span>
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("pages.settings.codespaces.providerLine", {
                          machine: codespace.machine.display_name,
                        })}
                      </p>
                    </div>
                    <Badge
                      variant={stateVariant(codespace.state)}
                      data-testid={`github-codespace-state-${codespace.codespace_id}`}
                    >
                      {t(`pages.settings.codespaces.states.${codespace.state}`)}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("pages.settings.codespaces.detailLine", {
                      desired: t(`pages.settings.codespaces.desired.${codespace.desired_state}`),
                      observed: t(`pages.settings.codespaces.observed.${codespace.observed_state}`),
                      generation: codespace.generation,
                      updated: formatDate(codespace.updated_at),
                      // React escapes the rendered text; i18next must not HTML-escape the date.
                      interpolation: { escapeValue: false },
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {codespace.state === "stopped" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
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
                      disabled={busy}
                      onClick={(event) => {
                        deleteTriggerRef.current = event.currentTarget;
                        setPendingDelete(codespace);
                      }}
                      data-testid={`github-codespace-delete-${codespace.codespace_id}`}
                    >
                      <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
                      {t("pages.settings.codespaces.delete")}
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
        title={t("pages.settings.codespaces.confirmDeleteTitle")}
        description={t("pages.settings.codespaces.confirmDeleteDescription", {
          repository: pendingDelete?.repository ?? "",
        })}
        confirmLabel={t("pages.settings.codespaces.delete")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={remove}
        onReturnFocus={() => deleteTriggerRef.current?.focus()}
      />
    </Card>
  );
};
