/**
 * The applications (MCP clients such as Claude or ChatGPT) this account has authorized through the
 * Moira sign-in page, with what each may do and when it was authorized. Revoking one signs the
 * application out everywhere; it must be authorized again to reconnect.
 */

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AppWindow, Loader2, Plug, Search } from "lucide-react";
import { apiClient } from "@/services/api-client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { ServerPagination } from "@/components/ServerPagination";
import { useDebounce } from "@/hooks/useDebounce";

interface OAuthConsent {
  id: string;
  clientId: string;
  clientName: string;
  clientIcon: string | null;
  scopes: string[];
  createdAt: string;
}

const PAGE_SIZE = 8;

export const OAuthSettings: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [consents, setConsents] = useState<OAuthConsent[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebounce(searchQuery, 300);

  const loadConsents = useCallback(async () => {
    try {
      setLoading(true);
      setLoadFailed(false);
      const result = await apiClient.getOAuthConsents({
        search: debouncedSearch || undefined,
        sort: "createdAt",
        sortOrder: "desc",
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      setConsents(result.consents);
      setTotal(result.total);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, page]);

  useEffect(() => {
    void loadConsents();
  }, [loadConsents]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const revokeConsent = async (consentId: string) => {
    try {
      setRevoking(consentId);
      await apiClient.revokeOAuthConsent(consentId);
      toast.success(t("pages.settings.oauth.revoked"));
      await loadConsents();
    } catch {
      toast.error(t("pages.settings.oauth.revokeFailed"));
    } finally {
      setRevoking(null);
      setRevokeTarget(null);
    }
  };

  const formatDate = (value: string) =>
    new Date(value).toLocaleString(i18n.language, { dateStyle: "medium", timeStyle: "short" });

  return (
    <Card>
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="relative max-w-sm">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            placeholder={t("pages.settings.oauth.searchPlaceholder")}
            aria-label={t("pages.settings.oauth.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            className="pl-9"
            data-testid="oauth-search"
          />
        </div>

        {loading && consents.length === 0 ? (
          <Skeleton className="h-16 w-full" />
        ) : loadFailed ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span>{t("pages.settings.oauth.loadFailed")}</span>
            <Button variant="outline" size="sm" onClick={() => void loadConsents()}>
              {t("pages.settings.retry")}
            </Button>
          </div>
        ) : consents.length === 0 ? (
          <EmptyState
            icon={Plug}
            title={t("pages.settings.oauth.noConsents")}
            description={t("pages.settings.oauth.noConsentsDescription")}
          />
        ) : (
          <ul className="divide-y rounded-lg border" data-testid="oauth-list">
            {consents.map((consent) => (
              <li
                key={consent.id}
                className="flex flex-wrap items-start justify-between gap-3 p-3"
                data-testid={`oauth-consent-${consent.id}`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  {consent.clientIcon ? (
                    <img src={consent.clientIcon} alt="" className="size-8 shrink-0 rounded-md" />
                  ) : (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                      <AppWindow className="size-4" aria-hidden="true" />
                    </span>
                  )}
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-medium">{consent.clientName}</p>
                    {consent.scopes.length > 0 && (
                      <div
                        className="flex flex-wrap gap-1"
                        aria-label={t("pages.settings.oauth.permissions")}
                      >
                        {consent.scopes.map((scope) => (
                          <Badge key={scope} variant="secondary" className="font-mono text-[11px]">
                            {scope}
                          </Badge>
                        ))}
                      </div>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t("pages.settings.oauth.authorized")}: {formatDate(consent.createdAt)}
                      {" · "}
                      {t("pages.settings.oauth.clientId")}:{" "}
                      <span className="font-mono">{consent.clientId}</span>
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRevokeTarget(consent.id)}
                  disabled={revoking === consent.id}
                  data-testid={`oauth-revoke-${consent.id}`}
                >
                  {revoking === consent.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    t("pages.settings.oauth.revoke")
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}

        <ServerPagination
          embedded
          currentPage={page}
          totalPages={Math.ceil(total / PAGE_SIZE)}
          totalItems={total}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
          data-testid="oauth-pager"
        />
      </CardContent>

      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={() => setRevokeTarget(null)}
        title={t("pages.settings.oauth.revoke")}
        description={t("pages.settings.oauth.confirmRevoke")}
        confirmLabel={t("pages.settings.oauth.revoke")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={() => (revokeTarget ? revokeConsent(revokeTarget) : Promise.resolve())}
      />
    </Card>
  );
};
