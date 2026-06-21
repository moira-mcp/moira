/* eslint-disable no-console */
/**
 * Share Dialog Component
 * Modal for managing workflow sharing: generating invites and viewing/revoking access
 */

import React, { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Link2, Copy, Check, Trash2, Users, Clock } from "lucide-react";
import { apiClient, ApiClientError } from "../../services/api-client";
import { APP_PREFIX } from "../../constants/routes";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { ConfirmDialog } from "../confirm-dialog";
import { toast } from "sonner";

interface ShareDialogProps {
  open: boolean;
  onClose: () => void;
  workflowId: string;
}

interface Invite {
  id: string;
  token: string;
  createdAt: number;
  expiresAt: number;
  remainingMs: number;
  usedAt?: number | null;
  usedBy?: string | null;
  usedByHandle?: string | null;
}

interface Access {
  userId: string;
  handle: string | null;
  name: string | null;
  grantedAt: number;
  grantedBy: string;
  grantedByHandle: string | null;
}

export const ShareDialog: React.FC<ShareDialogProps> = ({ open, onClose, workflowId }) => {
  const { t } = useTranslation();

  // Invites state
  const [invites, setInvites] = useState<Invite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [invitesError, setInvitesError] = useState<string | null>(null);

  // Access state
  const [accessList, setAccessList] = useState<Access[]>([]);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessError, setAccessError] = useState<string | null>(null);

  // Action state
  const [generating, setGenerating] = useState(false);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{
    type: "invite" | "access";
    id: string;
    name?: string;
  } | null>(null);

  // Load invites
  const loadInvites = useCallback(async () => {
    if (!workflowId || workflowId.length < 2) {
      console.warn("ShareDialog: Invalid workflowId for loadInvites:", workflowId);
      return;
    }
    try {
      setInvitesLoading(true);
      setInvitesError(null);
      const result = await apiClient.listInvites(workflowId, { activeOnly: false });
      setInvites(result.invites);
    } catch (err) {
      setInvitesError(
        err instanceof ApiClientError ? err.message : t("common.errors.failedToLoad"),
      );
    } finally {
      setInvitesLoading(false);
    }
  }, [workflowId, t]);

  // Load access list
  const loadAccess = useCallback(async () => {
    if (!workflowId || workflowId.length < 2) {
      console.warn("ShareDialog: Invalid workflowId for loadAccess:", workflowId);
      return;
    }
    try {
      setAccessLoading(true);
      setAccessError(null);
      const result = await apiClient.listAccess(workflowId);
      setAccessList(result.users);
    } catch (err) {
      setAccessError(err instanceof ApiClientError ? err.message : t("common.errors.failedToLoad"));
    } finally {
      setAccessLoading(false);
    }
  }, [workflowId, t]);

  // Load data when dialog opens
  useEffect(() => {
    if (process.env.NODE_ENV === "development") {
      console.log("ShareDialog effect:", { open, workflowId });
    }
    if (open && workflowId && workflowId.length >= 2) {
      loadInvites();
      loadAccess();
    }
  }, [open, workflowId, loadInvites, loadAccess]);

  // Generate new invite
  const handleGenerateInvite = async () => {
    try {
      setGenerating(true);
      const result = await apiClient.createInvite(workflowId);
      // Add to list and copy URL
      setInvites((prev) => [
        {
          id: result.invite.id,
          token: result.invite.token,
          createdAt: Date.now(),
          expiresAt: result.invite.expiresAt,
          remainingMs: result.invite.remainingMs,
        },
        ...prev,
      ]);
      // Auto-copy to clipboard
      await navigator.clipboard.writeText(result.inviteUrl);
      setCopiedToken(result.invite.token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch (err) {
      const message =
        err instanceof ApiClientError
          ? err.message
          : t("pages.workflowDetail.sharing.generateError");
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  };

  // Copy invite link
  const handleCopyLink = async (token: string) => {
    try {
      // Construct full URL (same as backend does)
      const baseUrl = window.location.origin;
      const inviteUrl = `${baseUrl}${APP_PREFIX}/invites/${token}`;
      await navigator.clipboard.writeText(inviteUrl);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      toast.error(t("pages.workflowDetail.sharing.clipboardError"));
    }
  };

  // Revoke invite
  const handleRevokeInvite = (inviteId: string) => {
    setRevokeTarget({ type: "invite", id: inviteId });
  };

  // Revoke access
  const handleRevokeAccess = (userId: string, userName: string | null) => {
    setRevokeTarget({ type: "access", id: userId, name: userName || undefined });
  };

  const handleConfirmRevoke = async () => {
    if (!revokeTarget) return;
    try {
      setRevokingId(revokeTarget.id);
      if (revokeTarget.type === "invite") {
        await apiClient.revokeInvite(workflowId, revokeTarget.id);
        setInvites((prev) => prev.filter((inv) => inv.id !== revokeTarget.id));
      } else {
        await apiClient.revokeAccess(workflowId, revokeTarget.id);
        setAccessList((prev) => prev.filter((a) => a.userId !== revokeTarget.id));
      }
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.message : t("pages.workflowDetail.sharing.revokeError");
      toast.error(message);
    } finally {
      setRevokingId(null);
    }
  };

  // Format time remaining
  const formatTimeRemaining = (ms: number): string => {
    if (ms <= 0) return t("pages.workflowDetail.sharing.expired");
    const hours = Math.floor(ms / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h`;
    const minutes = Math.floor(ms / (1000 * 60));
    return `${minutes}m`;
  };

  // Format date
  const formatDate = (timestamp: number): string => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("pages.workflowDetail.sharing.title")}</DialogTitle>
          <DialogDescription>{t("pages.workflowDetail.sharing.description")}</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="invites">
          <TabsList className="w-full">
            <TabsTrigger value="invites" className="flex-1 gap-2">
              <Link2 className="h-4 w-4" />
              {t("pages.workflowDetail.sharing.tabs.invites")}
            </TabsTrigger>
            <TabsTrigger value="access" className="flex-1 gap-2">
              <Users className="h-4 w-4" />
              {t("pages.workflowDetail.sharing.tabs.access")}
              {accessList.length > 0 && (
                <Badge variant="secondary" className="ml-1">
                  {accessList.length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="invites">
            <div className="space-y-4">
              <Button
                onClick={handleGenerateInvite}
                disabled={generating}
                className="w-full"
                data-testid="generate-invite-button"
              >
                <Link2 className="h-4 w-4 mr-2" />
                {generating
                  ? t("pages.workflowDetail.sharing.generating")
                  : t("pages.workflowDetail.sharing.generateInvite")}
              </Button>

              {/* Invites list */}
              {invitesLoading ? (
                <div className="text-center text-muted-foreground py-4">
                  {t("pages.workflowDetail.sharing.loadingInvites")}
                </div>
              ) : invitesError ? (
                <div className="text-center text-destructive py-4">{invitesError}</div>
              ) : invites.length === 0 ? (
                <div className="text-center text-muted-foreground py-4">
                  {t("pages.workflowDetail.sharing.noInvites")}
                </div>
              ) : (
                <div className="space-y-2">
                  {invites.map((invite) => {
                    const isExpired = invite.remainingMs <= 0;
                    const isUsed = !!invite.usedAt;

                    return (
                      <div
                        key={invite.id}
                        className={`flex items-center justify-between p-3 rounded-lg border ${
                          isExpired || isUsed ? "bg-muted/50 opacity-60" : "bg-background"
                        }`}
                        data-testid="invite-item"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <code className="text-xs truncate max-w-[120px]">
                              {invite.token.substring(0, 8)}...
                            </code>
                            {isUsed ? (
                              <Badge variant="secondary">
                                {t("pages.workflowDetail.sharing.used", {
                                  handle: invite.usedByHandle || "user",
                                })}
                              </Badge>
                            ) : isExpired ? (
                              <Badge variant="destructive">
                                {t("pages.workflowDetail.sharing.expired")}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="gap-1">
                                <Clock className="h-3 w-3" />
                                {formatTimeRemaining(invite.remainingMs)}
                              </Badge>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground mt-1">
                            {formatDate(invite.createdAt)}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 ml-2">
                          {!isUsed && !isExpired && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleCopyLink(invite.token)}
                              className="h-8 w-8 p-0"
                              data-testid="copy-invite-button"
                              aria-label={t("pages.workflowDetail.sharing.copyLink")}
                            >
                              {copiedToken === invite.token ? (
                                <Check className="h-4 w-4 text-success" />
                              ) : (
                                <Copy className="h-4 w-4" />
                              )}
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRevokeInvite(invite.id)}
                            disabled={revokingId === invite.id}
                            className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                            data-testid="revoke-invite-button"
                            aria-label={t("pages.workflowDetail.sharing.revokeInvite")}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="access">
            <div className="space-y-2">
              {accessLoading ? (
                <div className="text-center text-muted-foreground py-4">
                  {t("pages.workflowDetail.sharing.loadingAccess")}
                </div>
              ) : accessError ? (
                <div className="text-center text-destructive py-4">{accessError}</div>
              ) : accessList.length === 0 ? (
                <div className="text-center text-muted-foreground py-4">
                  {t("pages.workflowDetail.sharing.noAccess")}
                </div>
              ) : (
                accessList.map((access) => (
                  <div
                    key={access.userId}
                    className="flex items-center justify-between p-3 rounded-lg border bg-background"
                    data-testid="access-item"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-medium truncate">
                        {access.name || access.handle || access.userId.substring(0, 8)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {access.grantedByHandle
                          ? t("pages.workflowDetail.sharing.grantedBy", {
                              handle: access.grantedByHandle,
                            })
                          : t("pages.workflowDetail.sharing.grantedAt", {
                              time: formatDate(access.grantedAt),
                            })}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRevokeAccess(access.userId, access.name)}
                      disabled={revokingId === access.userId}
                      className="h-8 w-8 p-0 text-destructive hover:text-destructive hover:bg-destructive/10"
                      data-testid="revoke-access-button"
                      aria-label={t("pages.workflowDetail.sharing.revokeAccess")}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))
              )}
            </div>
          </TabsContent>
        </Tabs>

        <ConfirmDialog
          open={!!revokeTarget}
          onOpenChange={(open) => {
            if (!open) setRevokeTarget(null);
          }}
          title={t("pages.workflowDetail.sharing.confirmRevoke")}
          description={
            revokeTarget?.type === "access"
              ? t("pages.workflowDetail.sharing.confirmRevokeAccess", {
                  name: revokeTarget.name || revokeTarget.id,
                })
              : t("pages.workflowDetail.sharing.confirmRevoke")
          }
          confirmLabel={t("common.delete")}
          variant="destructive"
          onConfirm={handleConfirmRevoke}
        />
      </DialogContent>
    </Dialog>
  );
};
