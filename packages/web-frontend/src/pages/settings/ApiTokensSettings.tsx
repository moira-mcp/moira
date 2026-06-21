/* eslint-disable no-console */
/**
 * API Tokens Settings — Token management with create dialog and one-time token display
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "@/services/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataListView, type ViewMode } from "@/components/DataListView";
import { useDynamicPageSize } from "@/hooks/useDynamicPageSize";
import { Loader2, KeyRound, Plus, Copy, Check, AlertTriangle } from "lucide-react";

interface ApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[] | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  isExpired: boolean;
  isRevoked: boolean;
}

type ExpirationOption = "30d" | "90d" | "365d" | "never";

export const ApiTokensSettings: React.FC = () => {
  const { t } = useTranslation();
  const { pageSize, containerRef } = useDynamicPageSize();

  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);

  // Create dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenExpiry, setTokenExpiry] = useState<ExpirationOption>("90d");

  // Token display dialog state
  const [displayToken, setDisplayToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Pagination (client-side since API returns all tokens for user)
  const [currentPage, setCurrentPage] = useState(1);

  const loadTokens = useCallback(async () => {
    try {
      setLoading(true);
      const result = await apiClient.getApiTokens();
      setTokens(result.tokens);
    } catch (error) {
      console.error("Failed to load API tokens:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTokens();
  }, [loadTokens]);

  const handleCreate = async () => {
    const trimmedName = tokenName.trim();
    if (!trimmedName) return;

    try {
      setCreating(true);
      const result = await apiClient.createApiToken(trimmedName, tokenExpiry);
      setDisplayToken(result.token);
      setCreateOpen(false);
      setTokenName("");
      setTokenExpiry("90d");
      await loadTokens();
    } catch (error) {
      console.error("Failed to create token:", error);
      toast.error(t("pages.settings.apiTokens.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (tokenId: string) => {
    try {
      setRevoking(tokenId);
      await apiClient.revokeApiToken(tokenId);
      await loadTokens();
    } catch (error) {
      console.error("Failed to revoke token:", error);
      toast.error(t("pages.settings.apiTokens.revokeFailed"));
    } finally {
      setRevoking(null);
      setRevokeTarget(null);
    }
  };

  const handleCopy = async () => {
    if (!displayToken) return;
    try {
      await navigator.clipboard.writeText(displayToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  const getStatusBadge = (token: ApiToken) => {
    if (token.isRevoked) {
      return <Badge variant="destructive">{t("pages.settings.apiTokens.statusRevoked")}</Badge>;
    }
    if (token.isExpired) {
      return (
        <Badge variant="secondary" className="text-orange-600 dark:text-orange-400">
          {t("pages.settings.apiTokens.statusExpired")}
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="text-chart-2 border-chart-2/30">
        {t("pages.settings.apiTokens.statusActive")}
      </Badge>
    );
  };

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return new Date(date).toLocaleDateString();
  };

  // Client-side pagination
  const startIdx = (currentPage - 1) * pageSize;
  const paginatedTokens = tokens.slice(startIdx, startIdx + pageSize);
  const totalPages = Math.ceil(tokens.length / pageSize);

  const renderCard = useCallback(
    (token: ApiToken, _viewMode: ViewMode) => (
      <Card key={token.id} data-testid={`token-row-${token.id}`}>
        <CardContent className="flex items-start justify-between p-4">
          <div className="flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              <span className="font-medium text-sm" data-testid="token-name">
                {token.name}
              </span>
              {getStatusBadge(token)}
            </div>
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              <code
                className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono"
                data-testid="token-prefix"
              >
                {token.tokenPrefix}...
              </code>
            </div>
            <div className="text-xs text-muted-foreground">
              {t("pages.settings.apiTokens.created")}: {formatDate(token.createdAt)}
              {token.expiresAt && (
                <>
                  {" · "}
                  {t("pages.settings.apiTokens.expires")}: {formatDate(token.expiresAt)}
                </>
              )}
              {token.lastUsedAt && (
                <>
                  {" · "}
                  {t("pages.settings.apiTokens.lastUsed")}: {formatDate(token.lastUsedAt)}
                </>
              )}
            </div>
          </div>
          {!token.isRevoked && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setRevokeTarget(token.id)}
              disabled={revoking === token.id}
              data-testid={`revoke-token-${token.id}`}
            >
              {revoking === token.id ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                t("pages.settings.apiTokens.revoke")
              )}
            </Button>
          )}
        </CardContent>
      </Card>
    ),
    [revoking, t],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t("pages.settings.apiTokens.description")}</p>
        <Button onClick={() => setCreateOpen(true)} size="sm" data-testid="create-token-button">
          <Plus className="h-4 w-4 mr-1" />
          {t("pages.settings.apiTokens.createToken")}
        </Button>
      </div>

      <DataListView
        items={paginatedTokens}
        renderCard={renderCard}
        keyExtractor={(token) => token.id}
        storageKey="settings-api-tokens"
        loading={loading}
        containerRef={containerRef}
        pagination={{
          mode: "total",
          currentPage,
          totalPages,
          totalItems: tokens.length,
          pageSize,
          onPageChange: setCurrentPage,
        }}
        emptyIcon={KeyRound}
        emptyTitle={t("pages.settings.apiTokens.noTokens")}
        emptyDescription={t("pages.settings.apiTokens.noTokensDescription")}
        defaultViewMode="list"
        className="flex-1 min-h-0 flex flex-col"
      />

      {/* Create Token Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent data-testid="create-token-dialog">
          <DialogHeader>
            <DialogTitle>{t("pages.settings.apiTokens.createToken")}</DialogTitle>
            <DialogDescription>{t("pages.settings.apiTokens.createDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="token-name">{t("pages.settings.apiTokens.tokenName")}</Label>
              <Input
                id="token-name"
                placeholder={t("pages.settings.apiTokens.tokenNamePlaceholder")}
                value={tokenName}
                onChange={(e) => setTokenName(e.target.value)}
                maxLength={100}
                data-testid="token-name-input"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="token-expiry">{t("pages.settings.apiTokens.expiration")}</Label>
              <Select
                value={tokenExpiry}
                onValueChange={(v) => setTokenExpiry(v as ExpirationOption)}
              >
                <SelectTrigger data-testid="token-expiry-select" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30d">{t("pages.settings.apiTokens.expiry30d")}</SelectItem>
                  <SelectItem value="90d">{t("pages.settings.apiTokens.expiry90d")}</SelectItem>
                  <SelectItem value="365d">{t("pages.settings.apiTokens.expiry365d")}</SelectItem>
                  <SelectItem value="never">{t("pages.settings.apiTokens.expiryNever")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!tokenName.trim() || creating}
              data-testid="confirm-create-token"
            >
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("pages.settings.apiTokens.createToken")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Token Display Dialog (shown once after creation) */}
      <Dialog
        open={!!displayToken}
        onOpenChange={(open) => {
          if (!open) {
            setDisplayToken(null);
            setCopied(false);
          }
        }}
      >
        <DialogContent showCloseButton={false} data-testid="token-display-dialog">
          <DialogHeader>
            <DialogTitle>{t("pages.settings.apiTokens.tokenCreated")}</DialogTitle>
            <DialogDescription>
              <span className="flex items-center gap-2 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {t("pages.settings.apiTokens.tokenWarning")}
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2">
              <code
                className="flex-1 bg-muted p-3 rounded text-sm font-mono break-all select-all"
                data-testid="displayed-token-value"
              >
                {displayToken}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={handleCopy}
                data-testid="copy-token-button"
              >
                {copied ? <Check className="h-4 w-4 text-chart-2" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                setDisplayToken(null);
                setCopied(false);
              }}
              data-testid="close-token-display"
            >
              {t("pages.settings.apiTokens.doneButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke Confirmation Dialog */}
      <ConfirmDialog
        open={!!revokeTarget}
        onOpenChange={() => setRevokeTarget(null)}
        title={t("pages.settings.apiTokens.revoke")}
        description={t("pages.settings.apiTokens.confirmRevoke")}
        confirmLabel={t("pages.settings.apiTokens.revoke")}
        cancelLabel={t("common.cancel")}
        variant="destructive"
        onConfirm={() => (revokeTarget ? handleRevoke(revokeTarget) : Promise.resolve())}
      />
    </div>
  );
};
