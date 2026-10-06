/**
 * The browsers and devices signed in to this account, named the way a person recognises them
 * ("Chrome on macOS") rather than by their raw User-Agent header, with the one they are using now
 * marked. Any other session can be signed out.
 */

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Globe,
  Laptop,
  Loader2,
  Monitor,
  Search,
  Smartphone,
  Tablet,
  Terminal,
} from "lucide-react";
import { apiClient } from "@/services/api-client";
import { parseUserAgent, type ParsedUserAgent } from "@/lib/user-agent";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { DataRegion } from "@/components/DataRegion";
import { useResource } from "@/hooks/useResource";
import { useRefreshOnActivation } from "@/components/settings/useRefreshOnActivation";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { ServerPagination } from "@/components/ServerPagination";
import { useDebounce } from "@/hooks/useDebounce";

interface UserSession {
  id: string;
  /** Each is null when the server does not know it; the row then leaves it out. */
  ipAddress: string | null;
  userAgent: string | null;
  country: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

const PAGE_SIZE = 8;

function DeviceIcon({ agent }: { agent: ParsedUserAgent }) {
  const Icon = agent.client
    ? Terminal
    : agent.device === "mobile"
      ? Smartphone
      : agent.device === "tablet"
        ? Tablet
        : Monitor;
  return <Icon className="size-4" aria-hidden="true" />;
}

export const SessionsSettings: React.FC<{ active?: boolean }> = ({ active = true }) => {
  const { t, i18n } = useTranslation();
  const [page, setPage] = useState(1);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebounce(searchQuery, 300);

  const resource = useResource<{
    sessions: UserSession[];
    total: number;
    page: number;
    search: string;
  }>(JSON.stringify({ page, search: debouncedSearch }), async (key) => {
    const query = JSON.parse(key) as { page: number; search: string };
    const result = await apiClient.getSessions({
      search: query.search || undefined,
      sort: "createdAt",
      sortOrder: "desc",
      limit: PAGE_SIZE,
      offset: (query.page - 1) * PAGE_SIZE,
    });
    return { ...result, ...query };
  });
  const sessions = resource.data?.sessions ?? [];
  useRefreshOnActivation(active, resource.refresh);
  const total = resource.data?.total ?? 0;

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const revokeSession = async (sessionId: string) => {
    try {
      setRevoking(sessionId);
      await apiClient.revokeSession(sessionId);
      toast.success(t("pages.settings.sessions.revoked"));
      setRevokeTarget(null);
      await resource.refresh();
    } catch (error) {
      toast.error(t("pages.settings.sessions.revokeFailed"));
      throw error;
    } finally {
      setRevoking(null);
    }
  };

  const formatDate = (value: string) =>
    new Date(value).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" });

  const deviceName = (agent: ParsedUserAgent): string => {
    if (agent.client) return t("pages.settings.sessions.client", { name: agent.browser });
    if (agent.browser && agent.os) {
      return t("pages.settings.sessions.browserOnOs", { browser: agent.browser, os: agent.os });
    }
    return agent.browser ?? agent.os ?? t("pages.settings.sessions.unknownDevice");
  };

  return (
    <>
      <div className="space-y-3">
        <div className="relative max-w-sm">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            placeholder={t("pages.settings.sessions.searchPlaceholder")}
            aria-label={t("pages.settings.sessions.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="pl-9"
            data-testid="sessions-search"
          />
        </div>

        <DataRegion
          hasResult={resource.data !== undefined}
          pending={resource.pending}
          error={resource.error}
          onRetry={resource.refresh}
          testId="sessions-data-region"
          resultScope={
            resource.data && (
              <span>
                {t("common.pagination.page", {
                  current: resource.data.page,
                  total: Math.max(1, Math.ceil(total / PAGE_SIZE)),
                })}
                {resource.data.search &&
                  ` · ${t("common.filters.search")}: ${resource.data.search}`}
              </span>
            )
          }
        >
          {sessions.length === 0 ? (
            <EmptyState
              icon={Laptop}
              title={t("pages.settings.sessions.noSessions")}
              description={t("pages.settings.sessions.noSessionsDescription")}
            />
          ) : (
            <ul className="divide-y rounded-lg border" data-testid="sessions-list">
              {sessions.map((session) => {
                const agent = parseUserAgent(session.userAgent);
                return (
                  <li
                    key={session.id}
                    className="flex flex-wrap items-start justify-between gap-3 p-3"
                    data-testid={`session-row-${session.id}`}
                    data-current={session.isCurrent ? "true" : undefined}
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <DeviceIcon agent={agent} />
                      </span>
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="text-sm font-medium"
                            data-hint={session.userAgent || undefined}
                            data-testid="session-device"
                          >
                            {deviceName(agent)}
                            {agent.headless && (
                              <span className="text-muted-foreground">
                                {" "}
                                · {t("pages.settings.sessions.automated")}
                              </span>
                            )}
                          </span>
                          {session.isCurrent && (
                            <Badge
                              variant="outline"
                              className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                            >
                              {t("pages.settings.sessions.currentSession")}
                            </Badge>
                          )}
                        </div>
                        {(session.ipAddress || session.country) && (
                          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                            {session.ipAddress && (
                              <span data-testid="session-ip">
                                {t("pages.settings.sessions.ipAddress")}: {session.ipAddress}
                              </span>
                            )}
                            {session.country && (
                              <span
                                className="inline-flex items-center gap-1"
                                data-testid="session-location"
                              >
                                <Globe className="size-3" aria-hidden="true" />
                                {t("pages.settings.sessions.location")}: {session.country}
                              </span>
                            )}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {t("pages.settings.sessions.created")}: {formatDate(session.createdAt)}
                          {" · "}
                          {t("pages.settings.sessions.expires")}: {formatDate(session.expiresAt)}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRevokeTarget(session.id)}
                      disabled={session.isCurrent || revoking === session.id}
                      data-hint={
                        session.isCurrent
                          ? t("pages.settings.sessions.cannotRevokeCurrent")
                          : undefined
                      }
                      data-testid={`session-revoke-${session.id}`}
                    >
                      {revoking === session.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        t("pages.settings.sessions.revoke")
                      )}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          <ServerPagination
            embedded
            currentPage={resource.data?.page ?? page}
            totalPages={Math.ceil(total / PAGE_SIZE)}
            totalItems={total}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            data-testid="sessions-pager"
          />
        </DataRegion>
      </div>

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
    </>
  );
};
