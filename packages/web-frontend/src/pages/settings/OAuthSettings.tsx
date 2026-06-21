/* eslint-disable no-console */
/**
 * OAuth Settings — Paginated DataListView with server-side pagination
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
import { Loader2, KeyRound, Search } from "lucide-react";

interface OAuthConsent {
  id: string;
  clientId: string;
  clientName: string;
  clientIcon: string | null;
  scopes: string[];
  createdAt: string;
}

export const OAuthSettings: React.FC = () => {
  const { t } = useTranslation();
  const { pageSize, containerRef } = useDynamicPageSize();

  const [consents, setConsents] = useState<OAuthConsent[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const debouncedSearch = useDebounce(searchQuery, 300);

  const loadConsents = useCallback(async () => {
    try {
      setLoading(true);
      const result = await apiClient.getOAuthConsents({
        search: debouncedSearch || undefined,
        sort: "createdAt",
        sortOrder: "desc",
        limit: pageSize,
        offset: (currentPage - 1) * pageSize,
      });
      setConsents(result.consents);
      setTotal(result.total);
    } catch (error) {
      console.error("Failed to load OAuth consents:", error);
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, currentPage, pageSize]);

  useEffect(() => {
    loadConsents();
  }, [loadConsents]);

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearch]);

  const revokeConsent = async (consentId: string) => {
    try {
      setRevoking(consentId);
      await apiClient.revokeOAuthConsent(consentId);
      await loadConsents();
    } catch (error) {
      console.error("Failed to revoke consent:", error);
    } finally {
      setRevoking(null);
      setRevokeTarget(null);
    }
  };

  const renderCard = useCallback(
    (consent: OAuthConsent, _viewMode: ViewMode) => (
      <Card key={consent.id}>
        <CardContent className="flex items-start justify-between p-4">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-3">
              {consent.clientIcon && (
                <img src={consent.clientIcon} alt="" className="h-8 w-8 rounded" />
              )}
              <div>
                <h3 className="font-semibold">{consent.clientName}</h3>
                <p className="text-sm text-muted-foreground">
                  {t("pages.settings.oauth.clientId")}: {consent.clientId}
                </p>
              </div>
            </div>
            {consent.scopes.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-2">
                {consent.scopes.map((scope, idx) => (
                  <Badge key={idx} variant="secondary">
                    {scope}
                  </Badge>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground pt-1">
              {t("pages.settings.oauth.authorized")}: {new Date(consent.createdAt).toLocaleString()}
            </p>
          </div>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setRevokeTarget(consent.id)}
            disabled={revoking === consent.id}
          >
            {revoking === consent.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t("pages.settings.oauth.revoke")
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
            placeholder={t("pages.settings.oauth.searchPlaceholder", "Search applications...")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="oauth-search"
          />
        </div>
      </div>

      <DataListView
        items={consents}
        renderCard={renderCard}
        keyExtractor={(c) => c.id}
        storageKey="settings-oauth"
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
        emptyIcon={KeyRound}
        emptyTitle={t("pages.settings.oauth.noConsents")}
        emptyDescription={t(
          "pages.settings.oauth.noConsentsDescription",
          "No OAuth applications have been authorized.",
        )}
        defaultViewMode="list"
        className="flex-1 min-h-0 flex flex-col"
      />

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
    </div>
  );
};
