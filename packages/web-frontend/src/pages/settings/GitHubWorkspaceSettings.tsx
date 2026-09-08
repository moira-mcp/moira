import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, CheckCircle2, Github, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceConnectionView } from "@mcp-moira/shared";
import { apiClient } from "@/services/api-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";

function statusVariant(
  state: WorkspaceConnectionView["state"],
): "default" | "secondary" | "destructive" | "outline" {
  if (state === "connected") return "default";
  if (["configuration_error", "refresh_failed", "revocation_pending"].includes(state)) {
    return "destructive";
  }
  return "secondary";
}

export const GitHubWorkspaceSettings: React.FC = () => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WorkspaceConnectionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [recoveringExternalRevocation, setRecoveringExternalRevocation] = useState(false);
  const [confirmExternalRevocation, setConfirmExternalRevocation] = useState(false);
  const disconnectButtonRef = useRef<HTMLButtonElement>(null);
  const externalRevocationButtonRef = useRef<HTMLButtonElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(false);
      setStatus(await apiClient.getGitHubWorkspaceConnection());
    } catch {
      setLoadError(true);
      toast.error(t("pages.settings.github.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadStatus();
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("github");
    if (outcome) {
      const key = `pages.settings.github.outcomes.${outcome}`;
      if (outcome === "connected") toast.success(t(key));
      else if (outcome === "installation_required") toast.warning(t(key));
      else toast.error(t(key));
      url.searchParams.delete("github");
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, [loadStatus, t]);

  const disconnect = async () => {
    try {
      setDisconnecting(true);
      const next = await apiClient.disconnectGitHubWorkspace();
      setStatus(next);
      if (next.state === "revocation_pending") {
        toast.warning(t("pages.settings.github.revocationPending"));
      } else {
        toast.success(t("pages.settings.github.disconnected"));
      }
    } catch {
      toast.error(t("pages.settings.github.disconnectFailed"));
      throw new Error("disconnect failed");
    } finally {
      setDisconnecting(false);
    }
  };

  const startAuthorization = () => {
    window.location.assign("/api/integrations/github/start");
  };

  const finishExternalRevocation = async () => {
    try {
      setRecoveringExternalRevocation(true);
      const recoveryReason = status.reason;
      setStatus(await apiClient.confirmGitHubExternalRevocation());
      toast.success(
        t(
          recoveryReason === "AUTH_GRANT_REVOCATION_REQUIRED"
            ? "pages.settings.github.externalGrantRevocationCompleted"
            : "pages.settings.github.externalRevocationCompleted",
        ),
      );
    } catch {
      toast.error(t("pages.settings.github.externalRevocationFailed"));
      throw new Error("external revocation recovery failed");
    } finally {
      setRecoveringExternalRevocation(false);
    }
  };

  if (loading) {
    return (
      <Card data-testid="github-workspace-settings">
        <CardContent className="flex min-h-32 items-center justify-center p-6">
          <Loader2 className="h-5 w-5 animate-spin" aria-label={t("common.loading")} />
        </CardContent>
      </Card>
    );
  }

  if (loadError || !status) {
    return (
      <Card data-testid="github-workspace-settings">
        <CardContent className="space-y-4 p-6">
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>{t("pages.settings.github.loadFailed")}</AlertTitle>
            <AlertDescription>{t("pages.settings.github.loadFailedDescription")}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={() => void loadStatus()}>
            {t("pages.settings.github.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const actionableError = ["configuration_error", "refresh_failed", "revocation_pending"].includes(
    status.state,
  );
  const requiresExternalRevocation = [
    "CREDENTIAL_UNREADABLE",
    "AUTH_GRANT_REVOCATION_REQUIRED",
  ].includes(status.reason ?? "");

  return (
    <Card data-testid="github-workspace-settings">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <Github className="mt-0.5 h-6 w-6 shrink-0" aria-hidden="true" />
            <div className="min-w-0">
              <CardTitle className="text-base">{t("pages.settings.github.title")}</CardTitle>
              <CardDescription>{t("pages.settings.github.description")}</CardDescription>
            </div>
          </div>
          <Badge variant={statusVariant(status.state)} data-testid="github-workspace-status">
            {t(`pages.settings.github.states.${status.state}`)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.state === "disabled" && (
          <Alert>
            <ShieldCheck aria-hidden="true" />
            <AlertTitle>{t("pages.settings.github.disabledTitle")}</AlertTitle>
            <AlertDescription>{t("pages.settings.github.disabledDescription")}</AlertDescription>
          </Alert>
        )}

        {actionableError && (
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>
              {t(`pages.settings.github.errors.${status.reason ?? "UNKNOWN"}.title`)}
            </AlertTitle>
            <AlertDescription>
              {t(`pages.settings.github.errors.${status.reason ?? "UNKNOWN"}.description`)}
            </AlertDescription>
          </Alert>
        )}

        {status.account && (
          <div className="flex flex-wrap items-center gap-2" data-testid="github-workspace-account">
            <CheckCircle2 className="h-4 w-4 text-primary" aria-hidden="true" />
            <span className="font-medium">@{status.account.login}</span>
            <span className="text-sm text-muted-foreground">
              {t("pages.settings.github.accountId", { id: status.account.id })}
            </span>
          </div>
        )}

        {status.state === "installation_required" && status.installationUrl && (
          <Button asChild>
            <a href={status.installationUrl} rel="noreferrer">
              {t("pages.settings.github.install")}
            </a>
          </Button>
        )}

        {status.state === "connected" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium">{t("pages.settings.github.repositories")}</h3>
              <span className="text-xs text-muted-foreground">{status.repositories.length}</span>
            </div>
            <div
              className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-2"
              data-testid="github-workspace-repositories"
            >
              {status.repositories.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("pages.settings.github.noRepositories")}
                </p>
              ) : (
                status.repositories.map((repository) => (
                  <div
                    key={repository.externalRepositoryId}
                    className="flex items-center justify-between gap-3 rounded px-2 py-1 text-sm"
                  >
                    <span className="min-w-0 truncate">{repository.fullName}</span>
                    <Badge variant="outline">
                      {repository.private
                        ? t("pages.settings.github.private")
                        : t("pages.settings.github.public")}
                    </Badge>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {status.canConnect && (
            <Button onClick={startAuthorization} data-testid="github-workspace-connect">
              {status.state === "connection_required" || status.state === "disconnected"
                ? t("pages.settings.github.connect")
                : t("pages.settings.github.reconnect")}
            </Button>
          )}
          {status.canDisconnect && !requiresExternalRevocation && (
            <Button
              ref={disconnectButtonRef}
              variant="destructive"
              disabled={disconnecting}
              onClick={() => setConfirmDisconnect(true)}
              data-testid="github-workspace-disconnect"
            >
              {disconnecting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("pages.settings.github.disconnect")}
            </Button>
          )}
          {requiresExternalRevocation && (
            <Button
              ref={externalRevocationButtonRef}
              variant="destructive"
              disabled={recoveringExternalRevocation}
              onClick={() => setConfirmExternalRevocation(true)}
              data-testid="github-workspace-confirm-external-revocation"
            >
              {recoveringExternalRevocation && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("pages.settings.github.confirmExternalRevocationAction")}
            </Button>
          )}
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        title={t("pages.settings.github.disconnect")}
        description={t("pages.settings.github.confirmDisconnect")}
        confirmLabel={t("pages.settings.github.disconnect")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={disconnect}
        returnFocusRef={disconnectButtonRef}
      />
      <ConfirmDialog
        open={confirmExternalRevocation}
        onOpenChange={setConfirmExternalRevocation}
        title={t("pages.settings.github.confirmExternalRevocationTitle")}
        description={t(
          status.reason === "AUTH_GRANT_REVOCATION_REQUIRED"
            ? "pages.settings.github.confirmExternalGrantRevocationDescription"
            : "pages.settings.github.confirmExternalRevocationDescription",
        )}
        confirmLabel={t("pages.settings.github.confirmExternalRevocationAction")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={finishExternalRevocation}
        returnFocusRef={externalRevocationButtonRef}
      />
    </Card>
  );
};
