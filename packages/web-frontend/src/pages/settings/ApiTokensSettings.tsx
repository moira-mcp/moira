/**
 * API tokens: long-lived credentials an MCP client sends as a Bearer header when it cannot use the
 * browser sign-in (OAuth). A token is shown once, when it is created; afterwards only its prefix is
 * visible, and revoking it cuts every client using it off at once.
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { apiClient } from "@/services/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
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
  const { t, i18n } = useTranslation();

  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
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

  const loadTokens = useCallback(async () => {
    try {
      setLoading(true);
      setLoadFailed(false);
      const result = await apiClient.getApiTokens();
      setTokens(result.tokens);
    } catch {
      setLoadFailed(true);
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
    } catch {
      toast.error(t("pages.settings.apiTokens.createFailed"));
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (tokenId: string) => {
    try {
      setRevoking(tokenId);
      await apiClient.revokeApiToken(tokenId);
      toast.success(t("pages.settings.apiTokens.revoked"));
      await loadTokens();
    } catch {
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
      toast.error(t("pages.settings.apiTokens.copyFailed"));
    }
  };

  const getStatusBadge = useCallback(
    (token: ApiToken) => {
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
    },
    [t],
  );

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return new Date(date).toLocaleDateString(i18n.language, { dateStyle: "medium" });
  };

  return (
    <Card>
      <CardContent className="space-y-3 p-4 sm:p-5">
        {/* The section's description already says what tokens are; the card starts with the action. */}
        <div className="flex justify-end">
          <Button onClick={() => setCreateOpen(true)} size="sm" data-testid="create-token-button">
            <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
            {t("pages.settings.apiTokens.createToken")}
          </Button>
        </div>

        {loading && tokens.length === 0 ? (
          <Skeleton className="h-16 w-full" />
        ) : loadFailed ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
            <span>{t("pages.settings.apiTokens.loadFailed")}</span>
            <Button variant="outline" size="sm" onClick={() => void loadTokens()}>
              {t("pages.settings.retry")}
            </Button>
          </div>
        ) : tokens.length === 0 ? (
          <EmptyState
            icon={KeyRound}
            title={t("pages.settings.apiTokens.noTokens")}
            description={t("pages.settings.apiTokens.noTokensDescription")}
          />
        ) : (
          <ul className="divide-y rounded-lg border" data-testid="token-list">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex flex-wrap items-start justify-between gap-3 p-3"
                data-testid={`token-row-${token.id}`}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <KeyRound className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium" data-testid="token-name">
                        {token.name}
                      </span>
                      {getStatusBadge(token)}
                    </div>
                    <code
                      className="inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-xs"
                      data-testid="token-prefix"
                    >
                      {token.tokenPrefix}...
                    </code>
                    <p className="text-xs text-muted-foreground">
                      {t("pages.settings.apiTokens.created")}: {formatDate(token.createdAt)}
                      {" · "}
                      {t("pages.settings.apiTokens.expires")}:{" "}
                      {token.expiresAt
                        ? formatDate(token.expiresAt)
                        : t("pages.settings.apiTokens.expiryNever")}
                      {" · "}
                      {t("pages.settings.apiTokens.lastUsed")}:{" "}
                      {token.lastUsedAt
                        ? formatDate(token.lastUsedAt)
                        : t("pages.settings.apiTokens.neverUsed")}
                    </p>
                  </div>
                </div>
                {!token.isRevoked && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRevokeTarget(token.id)}
                    disabled={revoking === token.id}
                    data-testid={`revoke-token-${token.id}`}
                  >
                    {revoking === token.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      t("pages.settings.apiTokens.revoke")
                    )}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

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
    </Card>
  );
};
