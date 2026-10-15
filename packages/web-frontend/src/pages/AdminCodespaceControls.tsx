import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import type { CodespaceReadinessView } from "@mcp-moira/shared";
import { apiClient } from "@/services/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DataRegion } from "@/components/DataRegion";
import { useLatestRequest } from "@/hooks/useLatestRequest";
import { useRefreshOnActivation } from "@/components/settings/useRefreshOnActivation";
import { useReadOwnerGuard } from "@/auth/ReadScopeBoundary";

export const AdminCodespaceControls: React.FC<{ active?: boolean }> = ({ active = true }) => {
  const { t } = useTranslation();
  const [readiness, setReadiness] = useState<CodespaceReadinessView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const beginRequest = useLatestRequest();
  const guardOwner = useReadOwnerGuard();
  const load = useCallback(async () => {
    const current = beginRequest(),
      owned = guardOwner();
    setLoading(true);
    setLoadError(false);
    try {
      const next = await apiClient.getAdminCodespaces();
      if (current() && owned()) setReadiness(next.readiness);
    } catch {
      if (current() && owned()) setLoadError(true);
    } finally {
      if (current() && owned()) setLoading(false);
    }
  }, [beginRequest, guardOwner]);
  useEffect(() => {
    void load();
  }, [load]);
  useRefreshOnActivation(active, load);
  return (
    <DataRegion
      className="space-y-6"
      testId="admin-codespace-controls"
      hasResult={readiness !== null}
      pending={loading}
      error={loadError ? t("admin.codespaces.loadFailed") : null}
      onRetry={load}
    >
      {readiness && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle className="text-base">{t("admin.codespaces.readinessTitle")}</CardTitle>
            <Badge
              variant={readiness.state === "ready" ? "default" : "secondary"}
              data-testid="admin-codespace-readiness-state"
            >
              {t(`admin.codespaces.states.${readiness.state}`)}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
              aria-label={t("admin.codespaces.refresh")}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            </Button>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 sm:grid-cols-2" data-testid="admin-codespace-readiness-facts">
              <div>
                <dt>{t("admin.codespaces.facts.configuration")}</dt>
                <dd>{t(`admin.codespaces.configuration.${readiness.configuration}`)}</dd>
              </div>
              <div>
                <dt>{t("admin.codespaces.facts.resources")}</dt>
                <dd>{t(readiness.resources_enabled ? "common.enabled" : "common.disabled")}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      )}
    </DataRegion>
  );
};
