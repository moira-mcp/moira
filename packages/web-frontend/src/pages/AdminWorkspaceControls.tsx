import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceControlView, WorkspaceReadinessView } from "@mcp-moira/shared";
import { apiClient } from "@/services/api-client";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/confirm-dialog";

function formatMiB(bytes: number): string {
  return `${Math.round((bytes / 1024 ** 2) * 10) / 10} MiB`;
}

function formatAge(ms: number | null): string {
  if (ms === null) return "—";
  return `${Math.round(ms / 1000)} s`;
}

export const AdminWorkspaceControls: React.FC = () => {
  const { t } = useTranslation();
  const [readiness, setReadiness] = useState<WorkspaceReadinessView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [pendingDisable, setPendingDisable] = useState<WorkspaceControlView | null>(null);
  const disableTriggerRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(false);
      const next = await apiClient.getAdminWorkspaces();
      setReadiness(next.readiness);
      setReasons(
        Object.fromEntries(next.controls.map((control) => [control.scope, control.reason ?? ""])),
      );
    } catch {
      setLoadError(true);
      toast.error(t("admin.workspaces.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = async (control: WorkspaceControlView, disabled: boolean) => {
    try {
      setSaving(control.scope);
      const next = await apiClient.setAdminWorkspaceControl(control.scope, {
        disabled,
        reason: reasons[control.scope]?.trim() || null,
      });
      setReadiness(next.readiness);
      toast.success(
        t(disabled ? "admin.workspaces.disabledToast" : "admin.workspaces.enabledToast"),
      );
    } catch (error) {
      toast.error(
        error instanceof Error && error.message ? error.message : t("admin.workspaces.saveFailed"),
      );
      throw error;
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <Card data-testid="admin-workspace-controls">
        <CardContent className="flex min-h-32 items-center justify-center p-6">
          <Loader2 className="h-5 w-5 animate-spin" aria-label={t("common.loading")} />
        </CardContent>
      </Card>
    );
  }

  if (loadError || !readiness) {
    return (
      <Card data-testid="admin-workspace-controls">
        <CardContent className="space-y-4 p-6">
          <Alert variant="destructive">
            <AlertCircle aria-hidden="true" />
            <AlertTitle>{t("admin.workspaces.loadFailed")}</AlertTitle>
          </Alert>
          <Button variant="outline" onClick={() => void load()}>
            {t("admin.workspaces.retry")}
          </Button>
        </CardContent>
      </Card>
    );
  }

  const facts: Array<[string, string]> = [
    [
      t("admin.workspaces.facts.configuration"),
      t(`admin.workspaces.configuration.${readiness.configuration}`),
    ],
    [
      t("admin.workspaces.facts.resources"),
      readiness.resources_enabled ? t("common.enabled") : t("common.disabled"),
    ],
    [
      t("admin.workspaces.facts.connector"),
      t(`admin.workspaces.connector.${readiness.connector.state}`),
    ],
    [
      t("admin.workspaces.facts.reconciliation"),
      t("admin.workspaces.reconciliationValue", {
        resources: readiness.reconciliation.due_resources,
        operations: readiness.reconciliation.due_operations,
        age: formatAge(readiness.reconciliation.oldest_due_age_ms),
      }),
    ],
    [
      t("admin.workspaces.facts.activeResources"),
      `${readiness.usage.active_resources} / ${readiness.usage.max_active_resources}`,
    ],
    [
      t("admin.workspaces.facts.activeOperations"),
      `${readiness.usage.active_operations} / ${readiness.usage.max_active_operations ?? "—"}`,
    ],
    [
      t("admin.workspaces.facts.transferBytes"),
      `${formatMiB(readiness.usage.transfer_live_bytes)} / ${
        readiness.usage.max_transfer_live_bytes === null
          ? "—"
          : formatMiB(readiness.usage.max_transfer_live_bytes)
      }`,
    ],
  ];

  return (
    <div className="space-y-6" data-testid="admin-workspace-controls">
      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">{t("admin.workspaces.readinessTitle")}</CardTitle>
              <CardDescription>{t("admin.workspaces.readinessDescription")}</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={readiness.state === "ready" ? "default" : "secondary"}
                data-testid="admin-workspace-readiness-state"
              >
                {t(`admin.workspaces.states.${readiness.state}`)}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void load()}
                aria-label={t("admin.workspaces.refresh")}
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {readiness.reason && readiness.state !== "ready" && (
            <p
              className="mb-3 text-sm text-muted-foreground"
              data-testid="admin-workspace-readiness-reason"
            >
              {t("admin.workspaces.reason", { reason: readiness.reason })}
            </p>
          )}
          <dl className="grid gap-2 sm:grid-cols-2" data-testid="admin-workspace-readiness-facts">
            {facts.map(([label, value]) => (
              <div key={label} className="rounded-md border p-2">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="text-sm font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("admin.workspaces.controlsTitle")}</CardTitle>
          <CardDescription>{t("admin.workspaces.controlsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {readiness.controls.map((control) => {
            const busy = saving === control.scope;
            return (
              <div
                key={control.scope}
                className="space-y-2 rounded-md border p-3"
                data-testid={`admin-workspace-control-${control.scope.replace(":", "-")}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">
                    {control.scope === "global"
                      ? t("admin.workspaces.scopes.global")
                      : t("admin.workspaces.scopes.provider", { provider: control.scope.slice(9) })}
                  </span>
                  <Badge
                    variant={control.disabled ? "destructive" : "default"}
                    data-testid={`admin-workspace-control-state-${control.scope.replace(":", "-")}`}
                  >
                    {control.disabled
                      ? t("admin.workspaces.stopped")
                      : t("admin.workspaces.accepting")}
                  </Badge>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={`workspace-control-reason-${control.scope}`}>
                    {t("admin.workspaces.reasonLabel")}
                  </Label>
                  <Input
                    id={`workspace-control-reason-${control.scope}`}
                    value={reasons[control.scope] ?? ""}
                    maxLength={500}
                    onChange={(event) =>
                      setReasons((current) => ({ ...current, [control.scope]: event.target.value }))
                    }
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  {control.disabled ? (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => void apply(control, false)}
                      data-testid={`admin-workspace-enable-${control.scope.replace(":", "-")}`}
                    >
                      {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t("admin.workspaces.enable")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={(event) => {
                        disableTriggerRef.current = event.currentTarget;
                        setPendingDisable(control);
                      }}
                      data-testid={`admin-workspace-disable-${control.scope.replace(":", "-")}`}
                    >
                      {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {t("admin.workspaces.disable")}
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={pendingDisable !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDisable(null);
        }}
        title={t("admin.workspaces.confirmDisableTitle")}
        description={t("admin.workspaces.confirmDisableDescription")}
        confirmLabel={t("admin.workspaces.disable")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onReturnFocus={() => disableTriggerRef.current?.focus()}
        onConfirm={async () => {
          if (pendingDisable) await apply(pendingDisable, true);
        }}
      />
    </div>
  );
};
