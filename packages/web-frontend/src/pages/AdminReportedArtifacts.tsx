/**
 * Admin Reported Artifacts Page
 * Abuse review: lists artifacts that have received reports and lets an admin
 * take them down (so they stop being served publicly). Also supports taking
 * down all artifacts of a user.
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Flag, ExternalLink, ShieldX, Ban } from "lucide-react";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { toast } from "sonner";
import { PageShell } from "@/components/PageShell";
import { ConfirmDialog } from "@/components/confirm-dialog";

interface ReportedArtifact {
  uuid: string;
  userId: string;
  name: string;
  reportCount: number;
  lastReportedAt: number | null;
  takenDown: boolean;
  takenDownAt: number | null;
  takenDownBy: string | null;
  takenDownReason: string | null;
  createdAt: number;
}

type PendingAction =
  | { kind: "takedown"; artifact: ReportedArtifact }
  | { kind: "takedownUser"; artifact: ReportedArtifact };

export const AdminReportedArtifacts: React.FC = () => {
  const { t } = useTranslation();

  const [artifacts, setArtifacts] = useState<ReportedArtifact[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/admin/artifacts/reported?limit=100", {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(t("admin.reportedArtifacts.errors.loadFailed"));
      }
      const result = await response.json();
      setArtifacts(result.data.artifacts);
      setTotal(result.data.total);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("admin.reportedArtifacts.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const handleConfirm = async () => {
    if (!pending) return;
    const reason = t("admin.reportedArtifacts.defaultReason");
    try {
      const url =
        pending.kind === "takedown"
          ? `/api/admin/artifacts/${pending.artifact.uuid}/takedown`
          : `/api/admin/users/${pending.artifact.userId}/artifacts/takedown`;
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!response.ok) {
        throw new Error(t("admin.reportedArtifacts.errors.takedownFailed"));
      }
      toast.success(t("admin.reportedArtifacts.takedownSuccess"));
      setPending(null);
      load();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("admin.reportedArtifacts.errors.takedownFailed"),
      );
    }
  };

  if (loading && artifacts.length === 0) {
    return (
      <PageShell
        title={t("admin.reportedArtifacts.title")}
        description={t("admin.reportedArtifacts.subtitle")}
        loading
      />
    );
  }

  if (error && artifacts.length === 0) {
    return (
      <PageShell
        title={t("admin.reportedArtifacts.title")}
        error={error}
        onRetry={load}
        retryLabel={t("admin.reportedArtifacts.retry")}
      />
    );
  }

  return (
    <PageShell
      title={t("admin.reportedArtifacts.title")}
      description={t("admin.reportedArtifacts.subtitle")}
    >
      <div className="mb-4 text-sm text-muted-foreground" data-testid="reported-count">
        {t("admin.reportedArtifacts.resultsCount", { count: total })}
      </div>

      {artifacts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Flag className="h-8 w-8 mx-auto mb-3 opacity-50" />
            {t("admin.reportedArtifacts.noReports")}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {artifacts.map((a) => (
            <Card key={a.uuid} data-testid={`reported-artifact-${a.uuid}`}>
              <CardContent className="pt-4 pb-4 flex items-center justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{a.name}</span>
                    <Badge variant="destructive" className="gap-1">
                      <Flag className="h-3 w-3" />
                      {a.reportCount}
                    </Badge>
                    {a.takenDown && (
                      <Badge variant="outline" className="text-destructive border-destructive">
                        {t("admin.reportedArtifacts.takenDownBadge")}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 truncate">
                    {t("admin.reportedArtifacts.owner")}: {a.userId} · {a.uuid}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open(`/static/${a.uuid}.html`, "_blank")}
                  >
                    <ExternalLink className="h-4 w-4 mr-1" />
                    {t("admin.reportedArtifacts.actions.preview")}
                  </Button>
                  <Button
                    variant="destructive"
                    size="sm"
                    disabled={a.takenDown}
                    onClick={() => setPending({ kind: "takedown", artifact: a })}
                    data-testid={`takedown-${a.uuid}`}
                  >
                    <ShieldX className="h-4 w-4 mr-1" />
                    {t("admin.reportedArtifacts.actions.takedown")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPending({ kind: "takedownUser", artifact: a })}
                    data-testid={`takedown-user-${a.uuid}`}
                  >
                    <Ban className="h-4 w-4 mr-1" />
                    {t("admin.reportedArtifacts.actions.takedownUser")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={
          pending?.kind === "takedownUser"
            ? t("admin.reportedArtifacts.takedownUser.title")
            : t("admin.reportedArtifacts.takedown.title")
        }
        description={
          pending?.kind === "takedownUser"
            ? t("admin.reportedArtifacts.takedownUser.description", {
                user: pending?.artifact.userId,
              })
            : t("admin.reportedArtifacts.takedown.description", { name: pending?.artifact.name })
        }
        confirmLabel={t("admin.reportedArtifacts.actions.takedown")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={handleConfirm}
      />
    </PageShell>
  );
};
