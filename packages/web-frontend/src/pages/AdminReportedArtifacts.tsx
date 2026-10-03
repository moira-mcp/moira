/**
 * Admin Reported Artifacts Page
 * Abuse review: lists artifacts that have received reports and lets an admin
 * take them down (so they stop being served publicly). Also supports taking
 * down all artifacts of a user.
 */

import { productFetch } from "@/services/product-fetch";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Flag, ExternalLink, ShieldX, Ban, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "../components/ui/badge";
import { toast } from "sonner";
import { PageShell } from "@/components/PageShell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataListView } from "@/components/DataListView";
import { CardShell } from "@/components/cards/CardShell";
import { useResource } from "@/hooks/useResource";
import { useListPageSize } from "@/hooks/useListPageSize";
import { useReadOwnerGuard } from "@/auth/ReadScopeBoundary";

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

  const [page, setPage] = useState(1);
  const { pageSize, containerRef, onViewModeChange } = useListPageSize(() => setPage(1));
  const [pending, setPending] = useState<PendingAction | null>(null);
  const guardOwner = useReadOwnerGuard();

  const resource = useResource(JSON.stringify({ page, pageSize }), async (key) => {
    const requested = JSON.parse(key) as { page: number; pageSize: number };
    async function read(targetPage: number) {
      const response = await productFetch(
        `/api/admin/artifacts/reported?limit=${requested.pageSize}&offset=${(targetPage - 1) * requested.pageSize}`,
        {
          credentials: "include",
        },
      );
      if (!response.ok) {
        throw new Error(t("admin.reportedArtifacts.errors.loadFailed"));
      }
      const result = await response.json();
      return result.data as { artifacts: ReportedArtifact[]; total: number };
    }
    let data = await read(requested.page);
    const acceptedPage = Math.min(
      requested.page,
      Math.max(1, Math.ceil(data.total / requested.pageSize)),
    );
    if (acceptedPage !== requested.page) data = await read(acceptedPage);
    return { ...data, page: acceptedPage, pageSize: requested.pageSize };
  });
  const accepted = resource.data;
  const artifacts = accepted?.artifacts ?? [];
  const total = accepted?.total ?? 0;

  const handleConfirm = async () => {
    if (!pending) return;
    const isCurrentOwner = guardOwner();
    const reason = t("admin.reportedArtifacts.defaultReason");
    try {
      const url =
        pending.kind === "takedown"
          ? `/api/admin/artifacts/${pending.artifact.uuid}/takedown`
          : `/api/admin/users/${pending.artifact.userId}/artifacts/takedown`;
      const response = await productFetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      if (!response.ok) {
        throw new Error(t("admin.reportedArtifacts.errors.takedownFailed"));
      }
      if (!isCurrentOwner()) return;
      toast.success(t("admin.reportedArtifacts.takedownSuccess"));
      setPending(null);
      await resource.refresh();
    } catch (err) {
      if (isCurrentOwner())
        toast.error(
          err instanceof Error ? err.message : t("admin.reportedArtifacts.errors.takedownFailed"),
        );
      throw err;
    }
  };

  return (
    <PageShell
      title={t("admin.reportedArtifacts.title")}
      description={t("admin.reportedArtifacts.subtitle")}
    >
      <DataListView
        hasResult={accepted !== undefined}
        items={artifacts}
        loading={resource.pending}
        error={resource.error}
        onRetry={resource.refresh}
        toolbar={
          <>
            <Button variant="outline" size="sm" onClick={() => void resource.refresh()}>
              <RotateCcw className="size-4" />
              {t("common.dataRegion.refresh")}
            </Button>
            {accepted && (
              <span className="text-sm text-muted-foreground" data-testid="reported-count">
                {t("admin.reportedArtifacts.resultsCount", { count: total })}
              </span>
            )}
          </>
        }
        keyExtractor={(item) => item.uuid}
        storageKey="reported-artifacts-view-mode"
        containerRef={containerRef}
        onViewModeChange={onViewModeChange}
        className="flex-1 min-h-0 flex flex-col"
        emptyIcon={Flag}
        emptyTitle={t("admin.reportedArtifacts.noReports")}
        pagination={{
          mode: "total",
          currentPage: accepted?.page ?? 1,
          totalPages: Math.ceil(total / (accepted?.pageSize ?? pageSize)),
          totalItems: total,
          pageSize: accepted?.pageSize ?? pageSize,
          onPageChange: setPage,
        }}
        renderCard={(a, viewMode) => (
          <CardShell
            compact={viewMode === "grid"}
            testId={`reported-artifact-${a.uuid}`}
            icon={<Flag />}
            title={a.name}
            description={<span className="font-mono text-xs">{a.uuid}</span>}
            meta={
              <span>
                {t("admin.reportedArtifacts.owner")}: {a.userId}
              </span>
            }
            badges={
              <>
                <Badge variant="destructive">{a.reportCount}</Badge>
                {a.takenDown && (
                  <Badge variant="outline" className="text-destructive border-destructive">
                    {t("admin.reportedArtifacts.takenDownBadge")}
                  </Badge>
                )}
              </>
            }
            actions={[
              {
                icon: <ExternalLink />,
                label: t("admin.reportedArtifacts.actions.preview"),
                onClick: () => window.open(`/static/${a.uuid}.html`, "_blank"),
              },
              {
                icon: <ShieldX />,
                label: t("admin.reportedArtifacts.actions.takedown"),
                variant: "destructive" as const,
                disabled: a.takenDown,
                onClick: () => setPending({ kind: "takedown", artifact: a }),
                testId: `takedown-${a.uuid}`,
              },
              {
                icon: <Ban />,
                label: t("admin.reportedArtifacts.actions.takedownUser"),
                onClick: () => setPending({ kind: "takedownUser", artifact: a }),
                testId: `takedown-user-${a.uuid}`,
              },
            ]}
          />
        )}
      />

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
