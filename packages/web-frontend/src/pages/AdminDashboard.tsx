/** Administration overview, bounded user analytics and deployment-neutral system state. */
import React, { useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { LogOut } from "lucide-react";
import { apiClient } from "../services/api-client";
import { PageShell } from "../components/PageShell";
import { ROUTES } from "../constants/routes";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineError } from "@/components/inline-error";
import { useFeatures } from "../hooks/useFeatures";
import { useResource } from "@/hooks/useResource";
import { useAnalyticsExclusions } from "@/hooks/useAnalyticsExclusions";
import { useSession } from "@/auth/better-auth-client";
import { AdminOverview } from "@/components/admin/AdminOverview";
import { AnalyticsExclusionsControl } from "@/components/admin/AnalyticsExclusionsControl";
import { formatDate } from "@/components/cards/format-utils";

export const AdminDashboard: React.FC = () => {
  const { t } = useTranslation();
  const { isEnabled } = useFeatures();
  const analyticsEnabled = isEnabled("adminAnalytics");
  const multiUserAdminEnabled = isEnabled("multiUserAdmin");
  const { data: session } = useSession();
  const accountId = session?.user.id ?? null;
  const exclusions = useAnalyticsExclusions(accountId);
  const system = useResource("system-status", () => apiClient.getAdminSystemStatus());
  const stats = useResource(analyticsEnabled ? "admin-stats" : null, () =>
    apiClient.getAdminStats(),
  );
  const [logoutAllDialogOpen, setLogoutAllDialogOpen] = useState(false);
  const [logoutAllResult, setLogoutAllResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const handleLogoutAll = async () => {
    setLogoutAllResult(null);
    try {
      const result = await apiClient.logoutAllUsers();
      setLogoutAllResult({ success: true, message: result.message });
    } catch (error) {
      setLogoutAllResult({
        success: false,
        message: error instanceof Error ? error.message : t("common.errors.actionFailed"),
      });
      throw error;
    }
  };
  if (!system.data)
    return (
      <PageShell
        title={t("admin.dashboard.title")}
        loading={system.pending}
        error={system.error}
        onRetry={() => void system.refresh()}
        retryLabel={t("pages.dashboard.retry")}
      />
    );
  const health = system.data.systemHealth;
  return (
    <PageShell
      title={t("admin.dashboard.title")}
      description={t("adminOverview.description")}
      actions={
        analyticsEnabled && (
          <AnalyticsExclusionsControl
            key={accountId}
            accountId={accountId}
            value={exclusions.value}
            onChange={exclusions.setValue}
            storageError={exclusions.storageError}
          />
        )
      }
    >
      {analyticsEnabled && (
        <>
          <p className="mb-4 text-xs text-muted-foreground" data-testid="admin-exclusions-status">
            {exclusions.value.mode === "default-admins"
              ? t("adminOverview.defaultExclusions")
              : t("adminOverview.customExclusions", { count: exclusions.value.userIds.length })}
          </p>
          <AdminOverview key={accountId} accountId={accountId} exclusions={exclusions.value} />
        </>
      )}
      <Card className="mt-4" data-testid="admin-system-health">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("adminOverview.health")}</CardTitle>
          <p className="text-xs text-muted-foreground">{t("adminOverview.systemScope")}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          {system.error && (
            <InlineError
              title={t("common.errors.failedToLoad")}
              message={system.error}
              onRetry={() => void system.refresh()}
              retryLabel={t("pages.dashboard.retry")}
            />
          )}
          <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("admin.dashboard.systemHealth.backendStatus")}
              </dt>
              <dd className="mt-1 flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`size-2 rounded-full ${health.backendStatus === "healthy" ? "bg-success" : "bg-destructive-fill"}`}
                />
                {health.backendStatus}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("admin.dashboard.systemHealth.databaseSize")}
              </dt>
              <dd className="mt-1">
                {(health.databaseSize / 1024 / 1024).toFixed(2)} {t("common.units.mb")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("admin.dashboard.stats.settingDefinitions")}
              </dt>
              <dd className="mt-1">{system.data.totalDefinitions}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("admin.dashboard.systemHealth.workflowReconciliation")}
              </dt>
              <dd className="mt-1">
                {health.workflowReconciliation.status === "ok" ? (
                  <Badge variant="secondary">
                    {t("admin.dashboard.systemHealth.reconciliationOk")}
                  </Badge>
                ) : (
                  <Badge variant="destructive">{health.workflowReconciliation.code}</Badge>
                )}
              </dd>
            </div>
          </dl>
          {health.workflowReconciliation.status === "error" && (
            <div className="space-y-3 text-sm" data-testid="workflow-reconciliation-error">
              <p className="font-medium text-destructive">{health.workflowReconciliation.code}</p>
              {health.workflowReconciliation.conflicts.map((conflict) => (
                <div key={`${conflict.owner}/${conflict.slug}`} className="space-y-1">
                  <p className="font-medium">
                    {conflict.owner}/{conflict.slug} ({conflict.classification})
                  </p>
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {conflict.instruction}
                  </p>
                  <dl className="break-all text-xs text-muted-foreground">
                    <dt>previous</dt>
                    <dd>{conflict.candidateRefs.previous ?? "absent"}</dd>
                    <dt>current</dt>
                    <dd>{conflict.candidateRefs.current}</dd>
                    <dt>incoming</dt>
                    <dd>{conflict.candidateRefs.incoming}</dd>
                  </dl>
                </div>
              ))}
            </div>
          )}
          {stats.data && (
            <dl className="flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3 text-xs text-muted-foreground">
              {[
                [t("admin.dashboard.stats.totalWorkflows"), stats.data.totalWorkflows],
                [t("admin.dashboard.stats.totalExecutions"), stats.data.totalExecutions],
                [t("admin.dashboard.stats.activeExecutions"), stats.data.activeExecutions],
              ].map(([label, count]) => (
                <div key={label}>
                  <dt className="inline">{label}: </dt>
                  <dd className="inline font-medium text-foreground">{count}</dd>
                </div>
              ))}
            </dl>
          )}
          {stats.error && (
            <InlineError
              title={t("common.errors.failedToLoad")}
              message={stats.error}
              onRetry={() => void stats.refresh()}
              retryLabel={t("pages.dashboard.retry")}
            />
          )}
        </CardContent>
      </Card>
      {analyticsEnabled && stats.data && stats.data.recentActivity.length > 0 && (
        <Card className="mt-4" data-testid="admin-recent-activity">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{t("admin.dashboard.recentActivity.title")}</CardTitle>
            <p className="text-xs text-muted-foreground">{t("adminOverview.systemEvents")}</p>
          </CardHeader>
          <CardContent className="space-y-2">
            {stats.data.recentActivity.map((activity) => (
              <div
                key={activity.id}
                className="flex flex-wrap justify-between gap-2 border-b border-border py-2 text-xs last:border-0"
              >
                <span>
                  {activity.action} · {activity.workflowId}
                </span>
                <span className="text-muted-foreground">
                  {formatDate(activity.timestamp ?? undefined)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Card className="mt-4">
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("adminOverview.maintenance")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button variant="outline" asChild>
            <Link to={ROUTES.ADMIN_SETTINGS}>{t("admin.dashboard.quickLinks.systemSettings")}</Link>
          </Button>
          {multiUserAdminEnabled && (
            <>
              <Button variant="outline" asChild>
                <Link to={ROUTES.ADMIN_DELETED_WORKFLOWS}>
                  {t("admin.dashboard.quickLinks.deletedWorkflows")}
                </Link>
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  setLogoutAllResult(null);
                  setLogoutAllDialogOpen(true);
                }}
              >
                <LogOut className="mr-2 size-4" />
                {t("admin.dashboard.logoutAll.button")}
              </Button>
              <ConfirmDialog
                open={logoutAllDialogOpen}
                onOpenChange={(open) => {
                  setLogoutAllDialogOpen(open);
                  if (!open) setLogoutAllResult((result) => (result?.success ? result : null));
                }}
                title={t("admin.dashboard.logoutAll.confirmTitle")}
                description={t("admin.dashboard.logoutAll.confirmDescription")}
                confirmLabel={t("admin.dashboard.logoutAll.confirm")}
                cancelLabel={t("auth.CANCEL")}
                variant="destructive"
                onConfirm={handleLogoutAll}
              >
                {logoutAllResult && !logoutAllResult.success && (
                  <InlineError
                    title={t("common.errors.actionFailed")}
                    message={logoutAllResult.message}
                  />
                )}
              </ConfirmDialog>
              {logoutAllResult?.success && (
                <p className="text-sm text-success">{logoutAllResult.message}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
};
