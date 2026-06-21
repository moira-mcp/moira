/* eslint-disable no-console */
/**
 * Sessions Settings — Paginated DataListView with server-side pagination
 * Same pattern as Executions/Workflows pages
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { apiClient } from "@/services/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataListView, type ViewMode } from "@/components/DataListView";
import { useDynamicPageSize } from "@/hooks/useDynamicPageSize";
import { useDebounce } from "@/hooks/useDebounce";
import { Loader2, Globe, Monitor, Laptop, Search } from "lucide-react";

interface UserSession {
  id: string;
  ipAddress: string;
  userAgent: string;
  country: string;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export const SessionsSettings: React.FC = () => {
  const { t } = useTranslation();
  const { pageSize, containerRef } = useDynamicPageSize();

  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebounce(searchQuery, 300);

  const loadSessions = useCallback(async () => {
    try {
      setLoading(true);
      const result = await apiClient.getSessions({
        search: debouncedSearch || undefined,
        sort: "createdAt",
        sortOrder: "desc",
        limit: pageSize,
        offset: (currentPage - 1) * pageSize,
      });
      setSessions(result.sessions);
      setTotal(result.total);
    } catch (error) {
      console.error("Failed to load sessions:", error);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, currentPage, pageSize]);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch]);

  const revokeSession = async (sessionId: string) => {
    try {
      setRevoking(sessionId);
      await apiClient.revokeSession(sessionId);
      await loadSessions();
    } catch (error) {
      console.error("Failed to revoke session:", error);
    } finally {
      setRevoking(null);
      setRevokeTarget(null);
    }
  };

  const renderCard = useCallback(
    (session: UserSession, _viewMode: ViewMode) => (
      <Card key={session.id}>
        <CardContent className="flex items-start justify-between p-4">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <Monitor className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-sm">{session.userAgent}</span>
              {session.isCurrent && (
                <Badge variant="outline" className="text-chart-2 border-chart-2/30">
                  {t("pages.settings.sessions.currentSession")}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <span>
                {t("pages.settings.sessions.ipAddress")}: {session.ipAddress}
              </span>
              <span className="flex items-center gap-1">
                <Globe className="h-3 w-3" />
                {t("pages.settings.sessions.location")}: {session.country}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {t("pages.settings.sessions.created")}: {new Date(session.createdAt).toLocaleString()}
              {" · "}
              {t("pages.settings.sessions.expires")}: {new Date(session.expiresAt).toLocaleString()}
            </div>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setRevokeTarget(session.id)}
            disabled={session.isCurrent || revoking === session.id}
            title={
              session.isCurrent
                ? t("pages.settings.sessions.cannotRevokeCurrent")
                : t("pages.settings.sessions.revoke")
            }
          >
            {revoking === session.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t("pages.settings.sessions.revoke")
            )}
          </Button>
        </CardContent>
      </Card>
    ),
    [revoking, t],
  );

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("pages.settings.sessions.searchPlaceholder", "Search sessions...")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="sessions-search"
          />
        </div>
      </div>

      <DataListView
        items={sessions}
        renderCard={renderCard}
        keyExtractor={(s) => s.id}
        storageKey="settings-sessions"
        loading={loading}
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage,
          totalPages,
          totalItems: total,
          pageSize,
          onPageChange: setCurrentPage,
        }}
        emptyIcon={Laptop}
        emptyTitle={t("pages.settings.sessions.noSessions")}
        emptyDescription={t(
          "pages.settings.sessions.noSessionsDescription",
          "No active sessions found.",
        )}
        defaultViewMode="list"
        className="flex-1 min-h-0 flex flex-col"
      />

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={() => setRevokeTarget(null)}
        title={t("pages.settings.sessions.revoke")}
        description={t("pages.settings.sessions.confirmRevoke")}
        confirmLabel={t("pages.settings.sessions.revoke")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={() => (revokeTarget ? revokeSession(revokeTarget) : Promise.resolve())}
      />
    </div>
  );
};
