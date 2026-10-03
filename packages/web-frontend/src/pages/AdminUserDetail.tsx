/**
 * Admin User Detail Page
 * Detailed user management with actions
 */

import { productFetch } from "@/services/product-fetch";
import React, { useState, useEffect, useRef } from "react";
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
  UserCheck,
  Clock3,
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
import { apiClient } from "../services/api-client";
import { useFeatures } from "../hooks/useFeatures";
import { useResource } from "../hooks/useResource";
import { useReadOwnerGuard } from "../auth/ReadScopeBoundary";
import { DataRegion } from "@/components/DataRegion";
import { InlineError } from "@/components/inline-error";

interface UserDetails {
  user: {
    id: string;
    email: string;
    name: string | null;
    isAdmin: boolean;
    emailVerified: boolean;
    approvedAt: string | null;
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

type SecurityActivity = { sessionsCount: number; oauthTokensCount: number };
type DetailedSession = UserDetails["sessions"][number] & {
  token: string;
  country: string | null;
  updatedAt: string;
};
interface OAuthConnection {
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
}
interface ArtifactQuota {
  overrides: { quotaMb: number | null; maxFiles: number | null };
  effective: { storageLimit: number; countLimit: number };
  usage: {
    totalSize: number;
    totalArtifacts: number;
    storageUsedPercent: number;
    countUsedPercent: number;
  };
}

async function readUserData<T>(id: string, suffix: string, fallback: string): Promise<T> {
  const response = await productFetch(`/api/admin/users/${encodeURIComponent(id)}${suffix}`, {
    credentials: "include",
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(
      typeof result.error === "string" ? result.error : result.error?.message || fallback,
    );
  }
  if (result.data === undefined || result.data === null) throw new Error(fallback);
  return result.data;
}

export const AdminUserDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  return <AdminUserDetailContent key={id} id={id} />;
};

const AdminUserDetailContent: React.FC<{ id: string | undefined }> = ({ id }) => {
  const { t } = useTranslation();
  const { isEnabled, emailDelivery } = useFeatures();
  const accountApprovalEnabled = isEnabled("accountApproval");
  const multiUserAdminEnabled = isEnabled("multiUserAdmin");
  const guardOwner = useReadOwnerGuard();
  const userResource = useResource<UserDetails>(id ?? null, (key) =>
    readUserData(key, "", t("admin.userDetail.errors.loadFailed")),
  );
  const securityResource = useResource<SecurityActivity>(id ?? null, (key) =>
    readUserData(key, "/security-activity", t("common.errors.failedToLoad")),
  );
  const sessionsResource = useResource<DetailedSession[]>(id ?? null, (key) =>
    readUserData(key, "/sessions", t("common.errors.failedToLoad")),
  );
  const oauthResource = useResource<OAuthConnection[]>(id ?? null, (key) =>
    readUserData(key, "/oauth-tokens", t("common.errors.failedToLoad")),
  );
  const quotaResource = useResource<ArtifactQuota>(
    multiUserAdminEnabled ? (id ?? null) : null,
    (key) => readUserData(key, "/artifact-quota", t("common.errors.failedToLoad")),
  );
  const data = userResource.data ?? null;
  const loading = userResource.pending;
  const error = userResource.error;
  const securityActivity = securityResource.data ?? null;
  const detailedSessions = sessionsResource.data ?? [];
  const oauthConnections = oauthResource.data ?? [];
  const artifactQuota = quotaResource.data ?? null;
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [quotaEditMode, setQuotaEditMode] = useState(false);
  const [quotaForm, setQuotaForm] = useState<{
    quotaMb: string;
    maxFiles: string;
  }>({ quotaMb: "", maxFiles: "" });
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const approveButtonRef = useRef<HTMLButtonElement>(null);
  const approvalStatusRef = useRef<HTMLSpanElement>(null);
  const [blockReason, setBlockReason] = useState("");
  const [temporaryPasswordDialogOpen, setTemporaryPasswordDialogOpen] = useState(false);
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [temporaryPasswordConfirm, setTemporaryPasswordConfirm] = useState("");
  const [temporaryPasswordError, setTemporaryPasswordError] = useState<string | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    confirmLabel: string;
    variant?: "default" | "destructive";
    returnFocusToApproval?: boolean;
    onConfirm: () => void | Promise<void>;
  }>({ open: false, title: "", description: "", confirmLabel: "", onConfirm: () => {} });

  const loadUser = userResource.refresh;
  const loadSecurityActivity = securityResource.refresh;
  const loadDetailedSessions = sessionsResource.refresh;
  const loadOAuthConnections = oauthResource.refresh;
  const loadArtifactQuota = quotaResource.refresh;
  const quotaFormRef = useRef(quotaForm);
  quotaFormRef.current = quotaForm;
  const [quotaActionError, setQuotaActionError] = useState<string | null>(null);

  useEffect(() => {
    if (artifactQuota && !quotaEditMode) {
      setQuotaForm({
        quotaMb: artifactQuota.overrides.quotaMb?.toString() ?? "",
        maxFiles: artifactQuota.overrides.maxFiles?.toString() ?? "",
      });
    }
  }, [artifactQuota, quotaEditMode]);

  const savedQuotaRef = useRef<{ before: string; expected: typeof quotaForm } | null>(null);
  useEffect(() => {
    if (quotaResource.pending || quotaResource.error || !artifactQuota || !savedQuotaRef.current)
      return;
    const submitted = savedQuotaRef.current;
    savedQuotaRef.current = null;
    const actual = {
      quotaMb: artifactQuota.overrides.quotaMb?.toString() ?? "",
      maxFiles: artifactQuota.overrides.maxFiles?.toString() ?? "",
    };
    if (
      JSON.stringify(quotaFormRef.current) === submitted.before &&
      JSON.stringify(actual) === JSON.stringify(submitted.expected)
    ) {
      setQuotaForm(actual);
      setQuotaEditMode(false);
    }
  }, [artifactQuota, quotaResource.pending, quotaResource.error]);

  const saveQuota = async (reset: boolean) => {
    if (!id || !multiUserAdminEnabled) return;
    const ownsOperation = guardOwner(false);
    const ownsAuthority = guardOwner();
    const submitted = { ...quotaForm };
    setQuotaSaving(true);
    setQuotaActionError(null);
    try {
      const parseValue = (value: string) => {
        if (value === "") return null;
        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed < 0)
          throw new Error(t("admin.userDetail.artifactQuota.invalidValue"));
        return parsed;
      };
      const values = reset
        ? { quotaMb: null, maxFiles: null }
        : { quotaMb: parseValue(submitted.quotaMb), maxFiles: parseValue(submitted.maxFiles) };
      const response = await productFetch(`/api/admin/users/${id}/artifact-quota`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(values),
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(
          typeof result.error === "string"
            ? result.error
            : result.error?.message ||
                t(reset ? "admin.settingsRegions.resetFailed" : "admin.settingsRegions.saveFailed"),
        );
      if (!ownsOperation()) return;
      savedQuotaRef.current = {
        before: JSON.stringify(submitted),
        expected: {
          quotaMb: result.data.quotaMb?.toString() ?? "",
          maxFiles: result.data.maxFiles?.toString() ?? "",
        },
      };
      await loadArtifactQuota();
    } catch (err) {
      if (!ownsOperation()) return;
      const message = err instanceof Error ? err.message : t("admin.settingsRegions.saveFailed");
      setQuotaActionError(message);
      if (ownsAuthority()) toast.error(message);
    } finally {
      if (ownsOperation()) setQuotaSaving(false);
    }
  };
  const handleSaveQuota = () => saveQuota(false);
  const handleResetQuota = () => saveQuota(true);

  const handleAction = async (
    action: string,
    endpoint: string,
    method: string = "POST",
    body?: object,
    refresh: Array<() => Promise<void>> = [loadUser],
    failureMessage = t("admin.userDetail.errors.actionFailed", { action }),
  ) => {
    if (!id) return;
    const ownsOperation = guardOwner(false);
    const ownsAuthority = guardOwner();
    setActionLoading(action);
    try {
      const response = await productFetch(endpoint, {
        method,
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          typeof data.error === "string" ? data.error : data.error?.message || failureMessage,
        );
      }
      if (!ownsOperation()) return;
      await Promise.all(refresh.map((refreshSource) => refreshSource()));
    } catch (err) {
      if (ownsAuthority()) toast.error(err instanceof Error ? err.message : failureMessage);
      throw err;
    } finally {
      if (ownsOperation()) setActionLoading(null);
    }
  };

  const handleBlock = () => {
    setBlockReason("");
    setBlockDialogOpen(true);
  };

  const handleBlockConfirm = () =>
    handleAction("block", `/api/admin/users/${id}/block`, "POST", { reason: blockReason || null });

  const handleUnblock = () => {
    return handleAction("unblock", `/api/admin/users/${id}/unblock`);
  };

  const handleSendVerification = () => {
    return handleAction("send verification", `/api/admin/users/${id}/send-verification`);
  };

  const handleVerifyEmail = () => {
    return handleAction("verify email", `/api/admin/users/${id}/verify-email`);
  };

  const handleApprove = async () => {
    if (!id || !accountApprovalEnabled) return;
    const ownsOperation = guardOwner(false);
    const ownsAuthority = guardOwner();
    setActionLoading("approve");
    try {
      const result = await apiClient.approveUser(id);
      if (!ownsOperation()) return;
      userResource.update((current) => ({
        ...current,
        user: { ...current.user, approvedAt: result.approvedAt },
      }));
      if (ownsAuthority())
        toast.success(t("admin.userDetail.actions.approveSuccess", { email: data?.user.email }));
    } catch (err) {
      if (ownsAuthority()) toast.error(t("admin.userDetail.actions.approveError"));
      throw err;
    } finally {
      if (ownsOperation()) setActionLoading(null);
    }
  };

  const handleSendReset = () => {
    return handleAction("send reset", `/api/admin/users/${id}/send-reset`);
  };

  const handleRevokeSession = (sessionId: string) =>
    handleAction(
      `revoke-session-${sessionId}`,
      `/api/admin/users/${id}/sessions/${sessionId}`,
      "DELETE",
      undefined,
      [loadUser, loadSecurityActivity, loadDetailedSessions],
      t("admin.userDetail.errors.revokeSessionFailed"),
    );

  const handleRevokeSessions = () =>
    handleAction(
      "revoke-all-sessions",
      `/api/admin/users/${id}/sessions`,
      "DELETE",
      undefined,
      [loadUser, loadSecurityActivity, loadDetailedSessions],
      t("admin.userDetail.errors.revokeSessionsFailed"),
    );

  const handleForcePasswordReset = () => {
    return handleAction(
      "force password reset",
      `/api/admin/users/${id}/force-password-reset`,
      "POST",
      undefined,
      [loadUser, loadSecurityActivity, loadDetailedSessions],
    );
  };

  const handleTemporaryPassword = async () => {
    if (!id) return;
    if (temporaryPassword.length < 8) {
      setTemporaryPasswordError(t("admin.userDetail.recovery.minLength"));
      return;
    }
    if (temporaryPassword !== temporaryPasswordConfirm) {
      setTemporaryPasswordError(t("admin.userDetail.recovery.noMatch"));
      return;
    }

    const ownsOperation = guardOwner(false);
    const ownsAuthority = guardOwner();
    setActionLoading("temporary password");
    setTemporaryPasswordError(null);
    try {
      const response = await productFetch(`/api/admin/users/${id}/temporary-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ temporaryPassword }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error?.message || t("admin.userDetail.recovery.failed"));
      }
      if (!ownsOperation()) return;
      setTemporaryPassword("");
      setTemporaryPasswordConfirm("");
      setTemporaryPasswordDialogOpen(false);
      if (ownsAuthority()) toast.success(t("admin.userDetail.recovery.success"));
      await Promise.all([
        loadUser(),
        loadSecurityActivity(),
        loadDetailedSessions(),
        loadOAuthConnections(),
      ]);
    } catch (err) {
      if (!ownsOperation()) return;
      setTemporaryPasswordError(
        err instanceof Error ? err.message : t("admin.userDetail.recovery.failed"),
      );
    } finally {
      if (ownsOperation()) setActionLoading(null);
    }
  };

  const handleClearPasswordReset = () => {
    return handleAction("clear password reset", `/api/admin/users/${id}`, "PUT", {
      passwordResetRequired: false,
    });
  };

  const handleRevokeOAuthProvider = (provider: string) =>
    handleAction(
      `revoke-oauth-${provider}`,
      `/api/admin/users/${id}/oauth-tokens/${provider}`,
      "DELETE",
      undefined,
      [loadUser, loadSecurityActivity, loadOAuthConnections],
      t("admin.userDetail.errors.revokeOAuthFailed"),
    );

  const handleRevokeOAuthTokens = () =>
    handleAction(
      "revoke-all-oauth",
      `/api/admin/users/${id}/oauth-tokens`,
      "DELETE",
      undefined,
      [loadUser, loadSecurityActivity, loadOAuthConnections],
      t("admin.userDetail.errors.revokeOAuthFailed"),
    );

  if (loading && !data) {
    return <PageShell title={t("admin.userDetail.title")} loading />;
  }

  if (!data) {
    return (
      <PageShell
        title={t("admin.userDetail.title")}
        error={error || t("admin.userDetail.notFound")}
        onRetry={() => void loadUser()}
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
            {accountApprovalEnabled &&
              (user.approvedAt === null ? (
                <span
                  ref={approvalStatusRef}
                  tabIndex={-1}
                  data-testid="approval-focus-target"
                  className="rounded-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                >
                  <Badge
                    className="border-transparent bg-warning/10 text-warning"
                    data-testid="user-approval-pending"
                  >
                    <Clock3 className="h-4 w-4 mr-1" />
                    {t("admin.userDetail.status.pendingApproval")}
                  </Badge>
                </span>
              ) : (
                <span
                  ref={approvalStatusRef}
                  tabIndex={-1}
                  data-testid="approval-focus-target"
                  className="rounded-sm focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                >
                  <Badge
                    className="border-transparent bg-success/10 text-success"
                    data-testid="user-approval-approved"
                  >
                    <UserCheck className="h-4 w-4 mr-1" />
                    {t("admin.userDetail.status.approved")}
                  </Badge>
                </span>
              ))}
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
          {!emailDelivery.available && (
            <div
              className="mb-4 rounded-lg border border-warning/30 bg-warning/10 p-4"
              data-testid="admin-email-delivery-unavailable"
            >
              <p className="font-medium text-warning">
                {t("admin.userDetail.recovery.emailUnavailableTitle")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("admin.userDetail.recovery.emailUnavailableDescription")}
              </p>
              {!user.isAdmin && (
                <Button
                  className="mt-3"
                  variant="outline"
                  onClick={() => setTemporaryPasswordDialogOpen(true)}
                  data-testid="open-temporary-password-dialog"
                >
                  <Key className="mr-2 h-4 w-4" />
                  {t("admin.userDetail.recovery.setTemporaryPassword")}
                </Button>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            {accountApprovalEnabled && user.approvedAt === null && (
              <Button
                ref={approveButtonRef}
                variant="default"
                disabled={actionLoading === "approve"}
                data-testid="approve-user-button"
                onClick={() =>
                  setConfirmDialog({
                    open: true,
                    title: t("admin.userDetail.actions.approveUser"),
                    description: t("admin.userDetail.actions.confirmApprove", {
                      email: user.email,
                    }),
                    confirmLabel: t("admin.userDetail.actions.approveUser"),
                    onConfirm: handleApprove,
                    returnFocusToApproval: true,
                  })
                }
              >
                <UserCheck className="h-4 w-4 mr-2" />
                {actionLoading === "approve"
                  ? t("admin.userDetail.actions.approving")
                  : t("admin.userDetail.actions.approveUser")}
              </Button>
            )}
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
            {emailDelivery.available && (
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
            )}
            {emailDelivery.available && (
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
            )}
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
            <DataRegion
              hasResult={securityResource.data !== undefined}
              pending={securityResource.pending}
              error={securityResource.error}
              onRetry={loadSecurityActivity}
              testId="user-security-region"
            >
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
            </DataRegion>
            {/* Security Action Buttons */}
            <div className="flex flex-wrap gap-3">
              {emailDelivery.available && !user.isAdmin && (
                <Button
                  variant="outline"
                  disabled={actionLoading === "temporary password"}
                  onClick={() => setTemporaryPasswordDialogOpen(true)}
                >
                  <Key className="h-4 w-4 mr-2" />
                  {t("admin.userDetail.recovery.setTemporaryPassword")}
                </Button>
              )}
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
          <DataRegion
            hasResult={true}
            pending={loading}
            error={error}
            onRetry={loadUser}
            testId="user-info-region"
          >
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
              {accountApprovalEnabled && (
                <div>
                  <dt className="text-sm text-muted-foreground">
                    {t("admin.userDetail.userInfo.approval")}
                  </dt>
                  <dd>
                    {user.approvedAt
                      ? `${t("admin.userDetail.userInfo.approvedAt")} ${new Date(
                          user.approvedAt,
                        ).toLocaleString()}`
                      : t("admin.userDetail.status.pendingApproval")}
                  </dd>
                </div>
              )}
            </dl>
          </DataRegion>
        </CardContent>
      </Card>

      {/* Web Sessions */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>
              {t("admin.userDetail.webSessions.title")} (
              {sessionsResource.data === undefined ? "—" : detailedSessions.length})
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
          <DataRegion
            hasResult={sessionsResource.data !== undefined}
            pending={sessionsResource.pending}
            error={sessionsResource.error}
            onRetry={loadDetailedSessions}
            testId="user-sessions-region"
          >
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
          </DataRegion>
        </CardContent>
      </Card>

      {/* OAuth Connections */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex justify-between items-center">
            <CardTitle>
              {t("admin.userDetail.oauthConnections.title")} (
              {oauthResource.data === undefined ? "—" : oauthConnections.length})
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
          <DataRegion
            hasResult={oauthResource.data !== undefined}
            pending={oauthResource.pending}
            error={oauthResource.error}
            onRetry={loadOAuthConnections}
            testId="user-oauth-region"
          >
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
          </DataRegion>
        </CardContent>
      </Card>

      {/* Artifact Quota */}
      {multiUserAdminEnabled && (
        <Card className="mb-6" data-testid="artifact-quota-card">
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>{t("admin.userDetail.artifactQuota.title")}</CardTitle>
              {artifactQuota && !quotaEditMode && (
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
            <DataRegion
              hasResult={quotaResource.data !== undefined}
              pending={quotaResource.pending}
              error={quotaResource.error}
              onRetry={loadArtifactQuota}
              testId="user-quota-region"
            >
              {artifactQuota && (
                <>
                  {/* Usage display */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                    <div>
                      <div className="flex items-center gap-2 mb-2">
                        <HardDrive className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">
                          {t("admin.userDetail.artifactQuota.storage")}
                        </span>
                      </div>
                      <Progress
                        value={artifactQuota.usage.storageUsedPercent}
                        className="h-2 mb-1"
                      />
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
                          {artifactQuota.usage.totalArtifacts} /{" "}
                          {artifactQuota.effective.countLimit}
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
                            onChange={(e) => {
                              const quotaMb = e.currentTarget.value;
                              setQuotaForm((prev) => ({ ...prev, quotaMb }));
                            }}
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
                            onChange={(e) => {
                              const maxFiles = e.currentTarget.value;
                              setQuotaForm((prev) => ({ ...prev, maxFiles }));
                            }}
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
                            savedQuotaRef.current = null;
                            setQuotaActionError(null);
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
                      {quotaActionError && (
                        <InlineError
                          message={quotaActionError}
                          onRetry={() => void handleSaveQuota()}
                          retryLabel={t("common.dataRegion.retry")}
                        />
                      )}
                    </div>
                  )}
                </>
              )}
            </DataRegion>
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
                      ) : email.status === "logged" ? (
                        <AlertTriangle className="h-4 w-4 text-warning" />
                      ) : (
                        <XCircle className="h-4 w-4 text-destructive" />
                      )}
                      <div>
                        <p className="font-medium">{email.subject}</p>
                        <p className="text-sm text-muted-foreground">
                          {t("admin.userDetail.emailHistory.type")}: {email.type} |{" "}
                          {t("admin.userDetail.emailHistory.to")}: {email.to} | {email.status}
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
      <ConfirmDialog
        open={blockDialogOpen}
        onOpenChange={setBlockDialogOpen}
        title={t("admin.userDetail.actions.blockUser")}
        description={t("admin.userDetail.actions.blockReason")}
        confirmLabel={t("admin.userDetail.actions.blockUser")}
        variant="destructive"
        onConfirm={handleBlockConfirm}
      >
        <div className="py-4">
          <Input
            aria-label={t("admin.userDetail.actions.blockReason")}
            value={blockReason}
            onChange={(e) => setBlockReason(e.target.value)}
            placeholder={t("admin.userDetail.actions.blockReason")}
            disabled={actionLoading === "block"}
            autoFocus
          />
        </div>
      </ConfirmDialog>

      <Dialog
        open={temporaryPasswordDialogOpen}
        onOpenChange={
          actionLoading === "temporary password"
            ? undefined
            : (open) => {
                setTemporaryPasswordDialogOpen(open);
                if (!open) {
                  setTemporaryPassword("");
                  setTemporaryPasswordConfirm("");
                  setTemporaryPasswordError(null);
                }
              }
        }
      >
        <DialogContent data-testid="temporary-password-dialog">
          <DialogHeader>
            <DialogTitle>{t("admin.userDetail.recovery.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              {t("admin.userDetail.recovery.description", { email: user.email })}
            </p>
            <div className="space-y-2">
              <label htmlFor="temporary-password" className="text-sm font-medium">
                {t("admin.userDetail.recovery.temporaryPassword")}
              </label>
              <Input
                id="temporary-password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                value={temporaryPassword}
                disabled={actionLoading === "temporary password"}
                onChange={(event) => setTemporaryPassword(event.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="temporary-password-confirm" className="text-sm font-medium">
                {t("admin.userDetail.recovery.confirmTemporaryPassword")}
              </label>
              <Input
                id="temporary-password-confirm"
                type="password"
                autoComplete="new-password"
                value={temporaryPasswordConfirm}
                disabled={actionLoading === "temporary password"}
                onChange={(event) => setTemporaryPasswordConfirm(event.target.value)}
              />
            </div>
            {temporaryPasswordError && (
              <p className="text-sm text-destructive" role="alert">
                {temporaryPasswordError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={actionLoading === "temporary password"}
              onClick={() => setTemporaryPasswordDialogOpen(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              disabled={actionLoading === "temporary password"}
              onClick={handleTemporaryPassword}
              data-testid="submit-temporary-password"
            >
              {actionLoading === "temporary password"
                ? t("admin.userDetail.recovery.saving")
                : t("admin.userDetail.recovery.confirm")}
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
        onReturnFocus={
          confirmDialog.returnFocusToApproval
            ? () => (approveButtonRef.current ?? approvalStatusRef.current)?.focus()
            : undefined
        }
      />
    </PageShell>
  );
};
