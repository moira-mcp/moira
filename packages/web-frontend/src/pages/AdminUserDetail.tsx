/**
 * Admin User Detail Page
 * Detailed user management with actions
 */

import React, { useState, useEffect } from "react";
import { useParams, Link } from "react-router-dom";
import { PageShell } from "../components/PageShell";
import { ROUTES } from "../constants/routes";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Shield,
  ShieldOff,
  Mail,
  Key,
  LogOut,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Trash2,
  HardDrive,
  FileText,
  RotateCcw,
} from "lucide-react";
import { formatSize } from "@/components/cards/format-utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";

interface UserDetails {
  user: {
    id: string;
    email: string;
    name: string | null;
    isAdmin: boolean;
    emailVerified: boolean;
    blocked: boolean;
    blockedAt: string | null;
    blockedReason: string | null;
    blockedBy: string | null;
    blockedByName?: string | null;
    passwordResetRequired: boolean;
    passwordResetRequestedAt: string | null;
    passwordResetRequestedBy: string | null;
    createdAt: string;
    updatedAt: string;
  };
  stats: {
    workflowsCount: number;
    sessionsCount: number;
    emailsCount: number;
    oauthTokensCount?: number;
  };
  sessions: Array<{
    id: string;
    createdAt: string;
    expiresAt: string;
    ipAddress: string | null;
    userAgent: string | null;
  }>;
  emails: Array<{
    id: string;
    type: string;
    to: string;
    subject: string;
    messageId: string;
    status: string;
    error: string | null;
    createdAt: string;
  }>;
}

export const AdminUserDetail: React.FC = () => {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<UserDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [securityActivity, setSecurityActivity] = useState<{
    sessionsCount: number;
    oauthTokensCount: number;
  } | null>(null);
  const [detailedSessions, setDetailedSessions] = useState<
    Array<{
      id: string;
      token: string;
      ipAddress: string | null;
      userAgent: string | null;
      country: string | null;
      createdAt: string;
      expiresAt: string;
      updatedAt: string;
    }>
  >([]);
  const [oauthConnections, setOauthConnections] = useState<
    Array<{
      consentId: string;
      clientId: string;
      scopes: string;
      consentGiven: boolean;
      createdAt: string;
      updatedAt: string;
      tokens: Array<{
        id: string;
        accessToken: string;
        refreshToken: string | null;
        expiresAt: string;
        createdAt: string;
      }>;
    }>
  >([]);
  const [artifactQuota, setArtifactQuota] = useState<{
    overrides: { quotaMb: number | null; maxFiles: number | null };
    effective: { storageLimit: number; countLimit: number };
    usage: {
      totalSize: number;
      totalArtifacts: number;
      storageUsedPercent: number;
      countUsedPercent: number;
    };
  } | null>(null);
  const [quotaEditMode, setQuotaEditMode] = useState(false);
  const [quotaForm, setQuotaForm] = useState<{
    quotaMb: string;
    maxFiles: string;
  }>({ quotaMb: "", maxFiles: "" });
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const [blockReason, setBlockReason] = useState("");
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    variant?: "default" | "destructive";
    onConfirm: () => void | Promise<void>;
  }>({ open: false, title: "", description: "", confirmLabel: "", onConfirm: () => {} });

  const loadUser = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/admin/users/${id}`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(t("admin.userDetail.errors.loadFailed"));
      }
      const result = await response.json();
      setData(result.data);
      setError(null);

      // Load security activity and detailed data
      await Promise.all([
        loadSecurityActivity(),
        loadDetailedSessions(),
        loadOAuthConnections(),
        loadArtifactQuota(),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("admin.userDetail.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  };

  const loadSecurityActivity = async () => {
    if (!id) return;
    try {
      const response = await fetch(`/api/admin/users/${id}/security-activity`, {
        credentials: "include",
      });
      if (response.ok) {
        const result = await response.json();
        setSecurityActivity({
          sessionsCount: result.data.sessionsCount,
          oauthTokensCount: result.data.oauthTokensCount,
        });
      }
    } catch (err) {
      // Ignore security activity errors - not critical for page load
      // eslint-disable-next-line no-console
      console.error("Failed to load security activity:", err);
    }
  };

  const loadDetailedSessions = async () => {
    if (!id) return;
    try {
      const response = await fetch(`/api/admin/users/${id}/sessions`, {
        credentials: "include",
      });
      if (response.ok) {
        const result = await response.json();
        setDetailedSessions(result.data);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to load sessions:", err);
    }
  };

  const loadOAuthConnections = async () => {
    if (!id) return;
    try {
      const response = await fetch(`/api/admin/users/${id}/oauth-tokens`, {
        credentials: "include",
      });
      if (response.ok) {
        const result = await response.json();
        setOauthConnections(result.data);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to load OAuth connections:", err);
    }
  };

  const loadArtifactQuota = async () => {
    if (!id) return;
    try {
      const response = await fetch(`/api/admin/users/${id}/artifact-quota`, {
        credentials: "include",
      });
      if (response.ok) {
        const result = await response.json();
        setArtifactQuota(result.data);
        // Initialize form with current overrides
        setQuotaForm({
          quotaMb: result.data.overrides.quotaMb?.toString() ?? "",
          maxFiles: result.data.overrides.maxFiles?.toString() ?? "",
        });
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to load artifact quota:", err);
    }
  };

  const handleSaveQuota = async () => {
    if (!id) return;
    setQuotaSaving(true);
    try {
      const response = await fetch(`/api/admin/users/${id}/artifact-quota`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          quotaMb: quotaForm.quotaMb === "" ? null : parseInt(quotaForm.quotaMb, 10),
          maxFiles: quotaForm.maxFiles === "" ? null : parseInt(quotaForm.maxFiles, 10),
        }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update quota");
      }
      await loadArtifactQuota();
      setQuotaEditMode(false);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to save quota:", err);
      toast.error(err instanceof Error ? err.message : "Failed to save quota");
    } finally {
      setQuotaSaving(false);
    }
  };

  const handleResetQuota = async () => {
    if (!id) return;
    setQuotaSaving(true);
    try {
      const response = await fetch(`/api/admin/users/${id}/artifact-quota`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ quotaMb: null, maxFiles: null }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to reset quota");
      }
      await loadArtifactQuota();
      setQuotaEditMode(false);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Failed to reset quota:", err);
      toast.error(err instanceof Error ? err.message : "Failed to reset quota");
    } finally {
      setQuotaSaving(false);
    }
  };

  useEffect(() => {
    if (id) {
      loadUser();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleAction = async (
    action: string,
    endpoint: string,
    method: string = "POST",
    body?: object,
  ) => {
    if (!id) return;
    setActionLoading(action);
    try {
      const response = await fetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || t("admin.userDetail.errors.actionFailed", { action }));
      }
      await loadUser();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("admin.userDetail.errors.actionFailed", { action }),
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleBlock = () => {
    setBlockReason("");
    setBlockDialogOpen(true);
  };

  const handleBlockConfirm = () => {
    setBlockDialogOpen(false);
    handleAction("block", `/api/admin/users/${id}/block`, "POST", { reason: blockReason || null });
  };

  const handleUnblock = () => {
    handleAction("unblock", `/api/admin/users/${id}/unblock`);
  };

  const handleSendVerification = () => {
    handleAction("send verification", `/api/admin/users/${id}/send-verification`);
  };

  const handleVerifyEmail = () => {
    handleAction("verify email", `/api/admin/users/${id}/verify-email`);
  };

  const handleSendReset = () => {
    handleAction("send reset", `/api/admin/users/${id}/send-reset`);
  };

  const handleRevokeSession = async (sessionId: string) => {
    if (!id) return;
    setActionLoading(`revoke-session-${sessionId}`);
    try {
      const response = await fetch(`/api/admin/users/${id}/sessions/${sessionId}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || t("admin.userDetail.errors.revokeSessionFailed"));
      }
      await Promise.all([loadSecurityActivity(), loadDetailedSessions()]);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("admin.userDetail.errors.revokeSessionFailed"),
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleRevokeSessions = async () => {
    if (!id) return;
    setActionLoading("revoke-all-sessions");
    try {
      const response = await fetch(`/api/admin/users/${id}/sessions`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || t("admin.userDetail.errors.revokeSessionsFailed"));
      }
      await Promise.all([loadUser(), loadDetailedSessions()]);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("admin.userDetail.errors.revokeSessionsFailed"),
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleForcePasswordReset = () => {
    handleAction("force password reset", `/api/admin/users/${id}/force-password-reset`, "POST");
  };

  const handleClearPasswordReset = () => {
    handleAction("clear password reset", `/api/admin/users/${id}`, "PUT", {
      passwordResetRequired: false,
    });
  };

  const handleRevokeOAuthProvider = async (provider: string) => {
    if (!id) return;
    setActionLoading(`revoke-oauth-${provider}`);
    try {
      const response = await fetch(`/api/admin/users/${id}/oauth-tokens/${provider}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || t("admin.userDetail.errors.revokeOAuthFailed"));
      }
      await Promise.all([loadSecurityActivity(), loadOAuthConnections()]);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("admin.userDetail.errors.revokeOAuthFailed"),
      );
    } finally {
      setActionLoading(null);
    }
  };

  const handleRevokeOAuthTokens = async () => {
    if (!id) return;
    setActionLoading("revoke-all-oauth");
    try {
      const response = await fetch(`/api/admin/users/${id}/oauth-tokens`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || t("admin.userDetail.errors.revokeOAuthFailed"));
      }
      await Promise.all([loadUser(), loadOAuthConnections()]);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t("admin.userDetail.errors.revokeOAuthFailed"),
      );
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return <PageShell title={t("admin.userDetail.title")} loading />;
  }

  if (error || !data) {
    return (
      <PageShell
        title={t("admin.userDetail.title")}
        error={error || t("admin.userDetail.notFound")}
      />
    );
  }

  const { user, stats, emails } = data;

  return (
    <PageShell title={user.email} description={user.name || undefined}>
      {/* Back navigation */}
      <div className="mb-6">
        <Link
          to={ROUTES.ADMIN_USERS}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft className="h-4 w-4" />
          {t("admin.userDetail.backToUsers")}
        </Link>
        <div className="flex items-center justify-end">
          <div className="flex gap-2">
            {user.blocked ? (
              <Badge className="border-transparent bg-destructive/10 text-destructive">
                {t("admin.userDetail.status.blocked")}
              </Badge>
            ) : user.emailVerified ? (
              <Badge className="border-transparent bg-success text-success-foreground">
                {t("admin.userDetail.status.verified")}
              </Badge>
            ) : (
              <Badge className="border-transparent bg-warning text-warning-foreground">
                {t("admin.userDetail.status.unverified")}
              </Badge>
            )}
            {user.isAdmin && (
              <Badge className="border-transparent bg-info text-info-foreground">
                {t("admin.userDetail.status.admin")}
              </Badge>
            )}
            {user.passwordResetRequired && (
              <Badge className="border-transparent bg-chart-4/20 text-chart-4 flex items-center gap-1">
                <AlertTriangle className="h-4 w-4" />
                {t("admin.userDetail.security.passwordResetRequired")}
              </Badge>
            )}
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{stats.workflowsCount}</div>
            <p className="text-sm text-muted-foreground">{t("admin.userDetail.stats.workflows")}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{stats.sessionsCount}</div>
            <p className="text-sm text-muted-foreground">
              {t("admin.userDetail.stats.activeSessions")}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="text-2xl font-bold">{stats.emailsCount}</div>
            <p className="text-sm text-muted-foreground">
              {t("admin.userDetail.stats.emailsSent")}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Actions */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("admin.userDetail.actions.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {user.blocked ? (
              <Button
                variant="outline"
                disabled={actionLoading === "unblock"}
                onClick={() =>
                  setConfirmDialog({
                    open: true,
                    title: t("admin.userDetail.actions.unblockUser"),
                    description: t("admin.userDetail.actions.confirmUnblock"),
                    confirmLabel: t("admin.userDetail.actions.unblockUser"),
                    onConfirm: handleUnblock,
                  })
                }
              >
                <ShieldOff className="h-4 w-4 mr-2" />
                {actionLoading === "unblock"
                  ? t("admin.userDetail.actions.processing")
                  : t("admin.userDetail.actions.unblockUser")}
              </Button>
            ) : (
              <Button
                variant="destructive"
                onClick={handleBlock}
                disabled={actionLoading === "block"}
              >
                <Shield className="h-4 w-4 mr-2" />
                {actionLoading === "block"
                  ? t("admin.userDetail.actions.processing")
                  : t("admin.userDetail.actions.blockUser")}
              </Button>
            )}
            {!user.emailVerified && (
              <Button
                variant="default"
                disabled={actionLoading === "verify email"}
                onClick={() =>
                  setConfirmDialog({
                    open: true,
                    title: t("admin.userDetail.actions.verifyEmail"),
                    description: t("admin.userDetail.actions.confirmVerifyEmail"),
                    confirmLabel: t("admin.userDetail.actions.verifyEmail"),
                    onConfirm: handleVerifyEmail,
                  })
                }
              >
                <CheckCircle className="h-4 w-4 mr-2" />
                {actionLoading === "verify email"
                  ? t("admin.userDetail.actions.processing")
                  : t("admin.userDetail.actions.verifyEmail")}
              </Button>
            )}
            <Button
              variant="outline"
              disabled={actionLoading === "send verification"}
              onClick={() =>
                setConfirmDialog({
                  open: true,
                  title: t("admin.userDetail.actions.sendVerification"),
                  description: t("admin.userDetail.actions.confirmSendVerification"),
                  confirmLabel: t("admin.userDetail.actions.sendVerification"),
                  onConfirm: handleSendVerification,
                })
              }
            >
              <Mail className="h-4 w-4 mr-2" />
              {actionLoading === "send verification"
                ? t("admin.userDetail.actions.sending")
                : t("admin.userDetail.actions.sendVerification")}
            </Button>
            <Button
              variant="outline"
              disabled={actionLoading === "send reset"}
              onClick={() =>
                setConfirmDialog({
                  open: true,
                  title: t("admin.userDetail.actions.sendPasswordReset"),
                  description: t("admin.userDetail.actions.confirmSendReset"),
                  confirmLabel: t("admin.userDetail.actions.sendPasswordReset"),
                  onConfirm: handleSendReset,
                })
              }
            >
              <Key className="h-4 w-4 mr-2" />
              {actionLoading === "send reset"
                ? t("admin.userDetail.actions.sending")
                : t("admin.userDetail.actions.sendPasswordReset")}
            </Button>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    disabled={actionLoading === "revoke-all-sessions" || stats.sessionsCount === 0}
                    onClick={() =>
                      setConfirmDialog({
                        open: true,
                        title: t("admin.userDetail.actions.revokeAllSessions"),
                        description: t("admin.userDetail.actions.confirmRevokeSessions"),
                        confirmLabel: t("admin.userDetail.actions.revokeAllSessions"),
                        onConfirm: handleRevokeSessions,
                      })
                    }
                  >
                    <LogOut className="h-4 w-4 mr-2" />
                    {actionLoading === "revoke-all-sessions"
                      ? t("admin.userDetail.actions.revoking")
                      : t("admin.userDetail.actions.revokeAllSessions")}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{t("admin.userDetail.tooltips.revokeAllSessions")}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          {user.blocked && user.blockedAt && (
            <div className="mt-4 p-3 bg-destructive/10 rounded-lg">
              <p className="text-sm text-destructive">
                <strong>{t("admin.userDetail.blocked.label")}:</strong>{" "}
                {new Date(user.blockedAt).toLocaleString()}
              </p>
              {user.blockedReason && (
                <p className="text-sm text-destructive">
                  <strong>{t("admin.userDetail.blocked.reason")}:</strong> {user.blockedReason}
                </p>
              )}
              {user.blockedBy && (
                <p className="text-sm text-destructive">
                  <strong>{t("admin.userDetail.blockedBy")}:</strong>{" "}
                  {user.blockedByName || user.blockedBy}
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Security Actions */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("admin.userDetail.security.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Security Activity Stats */}
            {securityActivity && (
              <div className="grid grid-cols-2 gap-4 p-4 bg-muted/50 rounded-lg">
                <div>
                  <p className="text-sm text-muted-foreground">
                    {t("admin.userDetail.security.activeSessions")}
                  </p>
                  <p className="text-2xl font-bold">{securityActivity.sessionsCount}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">
                    {t("admin.userDetail.security.oauthTokens")}
                  </p>
                  <p className="text-2xl font-bold">{securityActivity.oauthTokensCount}</p>
                </div>
              </div>
            )}

            {/* Security Action Buttons */}
            <div className="flex flex-wrap gap-3">
              <Button
                variant="destructive"
                disabled={actionLoading === "force password reset" || user.passwordResetRequired}
                onClick={() =>
                  setConfirmDialog({
                    open: true,
                    title: t("admin.userDetail.security.forcePasswordReset"),
                    description: t("admin.userDetail.security.confirmForcePasswordReset"),
                    confirmLabel: t("admin.userDetail.security.forcePasswordReset"),
                    variant: "destructive",
                    onConfirm: handleForcePasswordReset,
                  })
                }
              >
                <AlertTriangle className="h-4 w-4 mr-2" />
                {actionLoading === "force password reset"
                  ? t("admin.userDetail.security.forcePasswordResetProcessing")
                  : t("admin.userDetail.security.forcePasswordReset")}
              </Button>
              <Button
                variant="destructive"
                disabled={
                  actionLoading === "revoke-all-oauth" || securityActivity?.oauthTokensCount === 0
                }
                onClick={() =>
                  setConfirmDialog({
                    open: true,
                    title: t("admin.userDetail.security.revokeAllOAuth"),
                    description: t("admin.userDetail.oauthConnections.confirmRevokeAll"),
                    confirmLabel: t("admin.userDetail.security.revokeAllOAuth"),
                    variant: "destructive",
                    onConfirm: handleRevokeOAuthTokens,
                  })
                }
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {actionLoading === "revoke-all-oauth"
                  ? t("admin.userDetail.security.revokeAllOAuthProcessing")
                  : t("admin.userDetail.security.revokeAllOAuth")}
              </Button>
            </div>

            {/* Password Reset Status */}
            {user.passwordResetRequired && user.passwordResetRequestedAt && (
              <div className="mt-4 p-3 bg-chart-4/10 rounded-lg">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-sm text-chart-4">
                      <strong>{t("admin.userDetail.security.passwordResetRequired")}</strong>
                    </p>
                    <p className="text-sm text-chart-4">
                      {t("admin.userDetail.security.passwordResetRequestedAt")}:{" "}
                      {new Date(user.passwordResetRequestedAt).toLocaleString()}
                    </p>
                    {user.passwordResetRequestedBy && (
                      <p className="text-sm text-chart-4">
                        {t("admin.userDetail.security.passwordResetRequestedBy")}:{" "}
                        {user.passwordResetRequestedBy}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={actionLoading === "clear password reset"}
                    onClick={() =>
                      setConfirmDialog({
                        open: true,
                        title: t("admin.userDetail.security.clearReset"),
                        description: t("admin.userDetail.security.confirmClearPasswordReset"),
                        confirmLabel: t("admin.userDetail.security.clearReset"),
                        onConfirm: handleClearPasswordReset,
                      })
                    }
                  >
                    <XCircle className="h-4 w-4 mr-2" />
                    {actionLoading === "clear password reset"
                      ? t("admin.userDetail.security.clearResetProcessing")
                      : t("admin.userDetail.security.clearReset")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* User Info */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>{t("admin.userDetail.userInfo.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <dt className="text-sm text-muted-foreground">
                {t("admin.userDetail.userInfo.userId")}
              </dt>
              <dd className="font-mono text-sm">{user.id}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">
                {t("admin.userDetail.userInfo.email")}
              </dt>
              <dd>{user.email}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">
                {t("admin.userDetail.userInfo.created")}
              </dt>
              <dd>{new Date(user.createdAt).toLocaleString()}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">
                {t("admin.userDetail.userInfo.updated")}
              </dt>
              <dd>{new Date(user.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {/* Web Sessions */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>
              {t("admin.userDetail.webSessions.title")} ({detailedSessions.length})
            </CardTitle>
            {detailedSessions.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={actionLoading === "revoke-all-sessions"}
                onClick={() =>
                  setConfirmDialog({
                    open: true,
                    title: t("admin.userDetail.webSessions.revokeAll"),
                    description: t("admin.userDetail.actions.confirmRevokeSessions"),
                    confirmLabel: t("admin.userDetail.webSessions.revokeAll"),
                    variant: "destructive",
                    onConfirm: handleRevokeSessions,
                  })
                }
              >
                <LogOut className="h-4 w-4 mr-2" />
                {t("admin.userDetail.webSessions.revokeAll")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {detailedSessions.length === 0 ? (
            <p className="text-muted-foreground">{t("admin.userDetail.sessions.noSessions")}</p>
          ) : (
            <div className="space-y-3">
              {detailedSessions.map((session) => (
                <div key={session.id} className="p-3 border rounded-lg">
                  <div className="flex justify-between items-start gap-4">
                    <div className="flex-1">
                      <p className="text-sm font-mono mb-1">{session.id.slice(0, 12)}...</p>
                      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                        <div>
                          <p>
                            {t("admin.userDetail.webSessions.ip")}:{" "}
                            {session.ipAddress || t("admin.userDetail.sessions.unknown")}
                          </p>
                          {session.country && (
                            <p>
                              {t("admin.userDetail.webSessions.country")}: {session.country}
                            </p>
                          )}
                        </div>
                        <div>
                          <p>
                            {t("admin.userDetail.webSessions.created")}:{" "}
                            {new Date(session.createdAt).toLocaleString()}
                          </p>
                          <p>
                            {t("admin.userDetail.webSessions.expires")}:{" "}
                            {new Date(session.expiresAt).toLocaleString()}
                          </p>
                        </div>
                      </div>
                      {session.userAgent && (
                        <p className="text-xs text-muted-foreground truncate mt-1">
                          {session.userAgent}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actionLoading === `revoke-session-${session.id}`}
                      onClick={() =>
                        setConfirmDialog({
                          open: true,
                          title: t("admin.userDetail.webSessions.revoke"),
                          description: t("admin.userDetail.webSessions.confirmRevokeSession"),
                          confirmLabel: t("admin.userDetail.webSessions.revoke"),
                          variant: "destructive",
                          onConfirm: () => handleRevokeSession(session.id),
                        })
                      }
                    >
                      <LogOut className="h-4 w-4 mr-1" />
                      {t("admin.userDetail.webSessions.revoke")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* OAuth Connections */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>
              {t("admin.userDetail.oauthConnections.title")} ({oauthConnections.length})
            </CardTitle>
            {oauthConnections.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                disabled={actionLoading === "revoke-all-oauth"}
                onClick={() =>
                  setConfirmDialog({
                    open: true,
                    title: t("admin.userDetail.oauthConnections.revokeAll"),
                    description: t("admin.userDetail.oauthConnections.confirmRevokeAll"),
                    confirmLabel: t("admin.userDetail.oauthConnections.revokeAll"),
                    variant: "destructive",
                    onConfirm: handleRevokeOAuthTokens,
                  })
                }
              >
                <Key className="h-4 w-4 mr-2" />
                {t("admin.userDetail.oauthConnections.revokeAll")}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {oauthConnections.length === 0 ? (
            <p className="text-muted-foreground">
              {t("admin.userDetail.oauthConnections.noConnections")}
            </p>
          ) : (
            <div className="space-y-3">
              {oauthConnections.map((connection) => (
                <div key={connection.consentId} className="p-3 border rounded-lg">
                  <div className="flex justify-between items-start gap-4">
                    <div className="flex-1">
                      <p className="text-sm font-medium mb-1">{connection.clientId}</p>
                      <div className="text-xs text-muted-foreground space-y-1">
                        <p>
                          {t("admin.userDetail.oauthConnections.scopes")}:{" "}
                          {connection.scopes || "None"}
                        </p>
                        <p>
                          {t("admin.userDetail.oauthConnections.connected")}:{" "}
                          {new Date(connection.createdAt).toLocaleString()}
                        </p>
                        <p>
                          {t("admin.userDetail.oauthConnections.tokens")}:{" "}
                          {connection.tokens.length}
                        </p>
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actionLoading === `revoke-oauth-${connection.clientId}`}
                      onClick={() =>
                        setConfirmDialog({
                          open: true,
                          title: t("admin.userDetail.oauthConnections.revoke"),
                          description: t(
                            "admin.userDetail.oauthConnections.confirmRevokeProvider",
                            {
                              provider: connection.clientId,
                            },
                          ),
                          confirmLabel: t("admin.userDetail.oauthConnections.revoke"),
                          variant: "destructive",
                          onConfirm: () => handleRevokeOAuthProvider(connection.clientId),
                        })
                      }
                    >
                      <Key className="h-4 w-4 mr-1" />
                      {t("admin.userDetail.oauthConnections.revoke")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Artifact Quota */}
      {artifactQuota && (
        <Card className="mb-6" data-testid="artifact-quota-card">
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>{t("admin.userDetail.artifactQuota.title")}</CardTitle>
              {!quotaEditMode && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setQuotaEditMode(true)}
                  data-testid="edit-quota-button"
                >
                  {t("admin.userDetail.artifactQuota.override")}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {/* Usage display */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <HardDrive className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">
                    {t("admin.userDetail.artifactQuota.storage")}
                  </span>
                </div>
                <Progress value={artifactQuota.usage.storageUsedPercent} className="h-2 mb-1" />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    {formatSize(artifactQuota.usage.totalSize)} /{" "}
                    {formatSize(artifactQuota.effective.storageLimit)}
                  </span>
                  <span>
                    {artifactQuota.usage.storageUsedPercent.toFixed(1)}%{" "}
                    {t("admin.userDetail.artifactQuota.used")}
                  </span>
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium">
                    {t("admin.userDetail.artifactQuota.files")}
                  </span>
                </div>
                <Progress value={artifactQuota.usage.countUsedPercent} className="h-2 mb-1" />
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>
                    {artifactQuota.usage.totalArtifacts} / {artifactQuota.effective.countLimit}
                  </span>
                  <span>
                    {artifactQuota.usage.countUsedPercent.toFixed(1)}%{" "}
                    {t("admin.userDetail.artifactQuota.used")}
                  </span>
                </div>
              </div>
            </div>

            {/* Override status */}
            <div className="p-3 bg-muted/50 rounded-lg mb-4">
              {artifactQuota.overrides.quotaMb !== null ||
              artifactQuota.overrides.maxFiles !== null ? (
                <span className="text-sm text-info">
                  {t("admin.userDetail.artifactQuota.customQuota")}:{" "}
                  {artifactQuota.overrides.quotaMb !== null &&
                    `${artifactQuota.overrides.quotaMb} MB`}
                  {artifactQuota.overrides.quotaMb !== null &&
                    artifactQuota.overrides.maxFiles !== null &&
                    ", "}
                  {artifactQuota.overrides.maxFiles !== null &&
                    `${artifactQuota.overrides.maxFiles} files`}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {t("admin.userDetail.artifactQuota.usingDefault")}
                </span>
              )}
            </div>

            {/* Edit form */}
            {quotaEditMode && (
              <div className="space-y-4 p-4 border rounded-lg" data-testid="quota-edit-form">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-medium mb-1 block">
                      {t("admin.userDetail.artifactQuota.overrideQuotaMb")}
                    </label>
                    <Input
                      type="number"
                      min="0"
                      placeholder={
                        artifactQuota.effective.storageLimit / (1024 * 1024) + " (default)"
                      }
                      value={quotaForm.quotaMb}
                      onChange={(e) =>
                        setQuotaForm((prev) => ({ ...prev, quotaMb: e.target.value }))
                      }
                      data-testid="quota-mb-input"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {t("admin.userDetail.artifactQuota.nullHint")}
                    </p>
                  </div>
                  <div>
                    <label className="text-sm font-medium mb-1 block">
                      {t("admin.userDetail.artifactQuota.overrideMaxFiles")}
                    </label>
                    <Input
                      type="number"
                      min="0"
                      placeholder={artifactQuota.effective.countLimit + " (default)"}
                      value={quotaForm.maxFiles}
                      onChange={(e) =>
                        setQuotaForm((prev) => ({ ...prev, maxFiles: e.target.value }))
                      }
                      data-testid="quota-max-files-input"
                    />
                    <p className="text-xs text-muted-foreground mt-1">
                      {t("admin.userDetail.artifactQuota.nullHint")}
                    </p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    onClick={handleSaveQuota}
                    disabled={quotaSaving}
                    data-testid="save-quota-button"
                  >
                    {quotaSaving
                      ? t("admin.userDetail.artifactQuota.saving")
                      : t("admin.userDetail.artifactQuota.save")}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={handleResetQuota}
                    disabled={quotaSaving}
                    data-testid="reset-quota-button"
                  >
                    <RotateCcw className="h-4 w-4 mr-2" />
                    {t("admin.userDetail.artifactQuota.resetToDefault")}
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setQuotaEditMode(false);
                      // Reset form to current values
                      setQuotaForm({
                        quotaMb: artifactQuota.overrides.quotaMb?.toString() ?? "",
                        maxFiles: artifactQuota.overrides.maxFiles?.toString() ?? "",
                      });
                    }}
                    disabled={quotaSaving}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Email History */}
      <Card>
        <CardHeader>
          <CardTitle>
            {t("admin.userDetail.emailHistory.title")} ({emails.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {emails.length === 0 ? (
            <p className="text-muted-foreground">{t("admin.userDetail.emailHistory.noEmails")}</p>
          ) : (
            <div className="space-y-3">
              {emails.map((email) => (
                <div key={email.id} className="p-3 border rounded-lg">
                  <div className="flex justify-between items-start">
                    <div className="flex items-center gap-2">
                      {email.status === "sent" ? (
                        <CheckCircle className="h-4 w-4 text-success" />
                      ) : (
                        <XCircle className="h-4 w-4 text-destructive" />
                      )}
                      <div>
                        <p className="font-medium">{email.subject}</p>
                        <p className="text-sm text-muted-foreground">
                          {t("admin.userDetail.emailHistory.type")}: {email.type} |{" "}
                          {t("admin.userDetail.emailHistory.to")}: {email.to}
                        </p>
                        {email.error && <p className="text-sm text-destructive">{email.error}</p>}
                      </div>
                    </div>
                    <div className="text-right text-xs text-muted-foreground">
                      <p>{new Date(email.createdAt).toLocaleString()}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Block User Dialog */}
      <Dialog open={blockDialogOpen} onOpenChange={setBlockDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("admin.userDetail.actions.blockUser")}</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium mb-2 block">
              {t("admin.userDetail.actions.blockReason")}
            </label>
            <Input
              value={blockReason}
              onChange={(e) => setBlockReason(e.target.value)}
              placeholder={t("admin.userDetail.actions.blockReason")}
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBlockDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={handleBlockConfirm}>
              {t("admin.userDetail.actions.blockUser")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog((prev) => ({ ...prev, open }))}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmLabel={confirmDialog.confirmLabel}
        variant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
      />
    </PageShell>
  );
};
