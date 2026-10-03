/**
 * Invite Accept Page
 * Landing page for accepting workflow invite links
 *
 * Route: /invites/:token
 *
 * Displays invite info and allows authenticated users to accept access.
 * Redirects to login if not authenticated.
 */

import React, { useState, useEffect, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Users, Clock, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { apiClient, ApiClientError } from "../services/api-client";
import { authClient, useSession } from "../auth/better-auth-client";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { ROUTES } from "../constants/routes";
import { AuthLayout } from "../components/AuthLayout";
import { PrivateReadScopeBoundary, useReadOwnerGuard } from "../auth/ReadScopeBoundary";
import { useResource } from "../hooks/useResource";
import { getReadIdentity } from "../services/read-scope";

interface InviteInfo {
  valid: boolean;
  expired: boolean;
  used: boolean;
  workflowName: string;
  createdByHandle: string | null;
  expiresAt: number;
  remainingMs: number;
}

export const InviteAcceptPage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  return (
    <PrivateReadScopeBoundary allowAnonymous>
      <InviteAcceptContent key={token} />
    </PrivateReadScopeBoundary>
  );
};

const InviteAcceptContent: React.FC = () => {
  const captureOwner = useReadOwnerGuard();
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    },
    [],
  );
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data: session, isPending: sessionLoading } = useSession();

  const {
    data: inviteInfo,
    pending: loading,
    error,
  } = useResource<InviteInfo>(
    token ?? null,
    (value) => apiClient.getInviteInfo(value),
    (err) =>
      err instanceof ApiClientError && err.status === 404
        ? "not_found"
        : err instanceof Error
          ? err.message
          : "unknown",
  );
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [acceptedWorkflowPath, setAcceptedWorkflowPath] = useState<string | null>(null);

  // Accept invite
  const handleAccept = async () => {
    if (!token) return;
    const isCurrent = captureOwner();
    const ownsPage = captureOwner(false);

    try {
      setAccepting(true);
      setAcceptError(null);
      const result = await apiClient.acceptInvite(token);
      if (!isCurrent() && ownsPage()) await authClient.$store.atoms.session.get().refetch();
      if (!ownsPage() || getReadIdentity() === null) return;
      setAccepted(true);
      // Use handle/slug format for redirect URL (e.g., /workflows/admin/my-workflow)
      const workflowPath = `${result.ownerHandle}/${result.slug}`;
      setAcceptedWorkflowPath(workflowPath);
      // Auto-redirect after short delay
      redirectTimer.current = setTimeout(() => {
        if (ownsPage() && getReadIdentity() !== null)
          navigate(`${ROUTES.WORKFLOWS}/${workflowPath}`);
      }, 2000);
    } catch (err) {
      if (!isCurrent()) return;
      if (err instanceof ApiClientError) {
        // Map error messages to translation keys
        const msg = err.message.toLowerCase();
        if (msg.includes("own") || msg.includes("self")) {
          setAcceptError(t("pages.inviteAccept.selfInvite"));
        } else if (msg.includes("already")) {
          setAcceptError(t("pages.inviteAccept.alreadyHaveAccess"));
        } else {
          setAcceptError(err.message);
        }
      } else {
        setAcceptError(t("pages.inviteAccept.acceptError"));
      }
    } finally {
      if (ownsPage()) setAccepting(false);
    }
  };

  // Format expiry time
  const formatExpiry = (timestamp: number): string => {
    return new Date(timestamp).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Render loading state
  if (loading || sessionLoading) {
    return (
      <AuthLayout showLanguageSwitcher={false}>
        <Card className="w-full">
          <CardContent className="py-8 text-center">
            <div className="animate-pulse text-muted-foreground">
              {t("pages.inviteAccept.loading")}
            </div>
          </CardContent>
        </Card>
      </AuthLayout>
    );
  }

  // Render error state (invite not found)
  if (error === "not_found" || !inviteInfo) {
    return (
      <AuthLayout showLanguageSwitcher={false}>
        <Card className="w-full">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <XCircle className="h-6 w-6 text-destructive" />
            </div>
            <CardTitle>{t("pages.inviteAccept.notFound")}</CardTitle>
            <CardDescription>{t("pages.inviteAccept.notFoundDescription")}</CardDescription>
          </CardHeader>
          <CardFooter className="justify-center">
            <Button variant="outline" asChild>
              <Link to={ROUTES.DASHBOARD}>{t("pages.inviteAccept.backToDashboard")}</Link>
            </Button>
          </CardFooter>
        </Card>
      </AuthLayout>
    );
  }

  // Render expired state
  if (inviteInfo.expired) {
    return (
      <AuthLayout showLanguageSwitcher={false}>
        <Card className="w-full">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-chart-5/10 flex items-center justify-center">
              <Clock className="h-6 w-6 text-chart-5" />
            </div>
            <CardTitle>{t("pages.inviteAccept.expired")}</CardTitle>
            <CardDescription>{t("pages.inviteAccept.expiredDescription")}</CardDescription>
          </CardHeader>
          <CardFooter className="justify-center">
            <Button variant="outline" asChild>
              <Link to={ROUTES.DASHBOARD}>{t("pages.inviteAccept.backToDashboard")}</Link>
            </Button>
          </CardFooter>
        </Card>
      </AuthLayout>
    );
  }

  // Render already used state
  if (inviteInfo.used) {
    return (
      <AuthLayout showLanguageSwitcher={false}>
        <Card className="w-full">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-muted flex items-center justify-center">
              <AlertCircle className="h-6 w-6 text-muted-foreground" />
            </div>
            <CardTitle>{t("pages.inviteAccept.used")}</CardTitle>
            <CardDescription>{t("pages.inviteAccept.usedDescription")}</CardDescription>
          </CardHeader>
          <CardFooter className="justify-center">
            <Button variant="outline" asChild>
              <Link to={ROUTES.DASHBOARD}>{t("pages.inviteAccept.backToDashboard")}</Link>
            </Button>
          </CardFooter>
        </Card>
      </AuthLayout>
    );
  }

  // Render success state (after accepting)
  if (accepted) {
    return (
      <AuthLayout showLanguageSwitcher={false}>
        <Card className="w-full">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-chart-2/10 flex items-center justify-center">
              <CheckCircle2 className="h-6 w-6 text-chart-2" />
            </div>
            <CardTitle className="text-chart-2">{t("pages.inviteAccept.acceptSuccess")}</CardTitle>
          </CardHeader>
          <CardFooter className="justify-center">
            {acceptedWorkflowPath && (
              <Button asChild>
                <Link to={`${ROUTES.WORKFLOWS}/${acceptedWorkflowPath}`}>
                  {t("pages.inviteAccept.goToWorkflow")}
                </Link>
              </Button>
            )}
          </CardFooter>
        </Card>
      </AuthLayout>
    );
  }

  // Render valid invite (main state)
  return (
    <AuthLayout showLanguageSwitcher={false}>
      <Card className="w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
            <Users className="h-6 w-6 text-primary" />
          </div>
          <CardTitle>{t("pages.inviteAccept.valid")}</CardTitle>
          <CardDescription>
            {t("pages.inviteAccept.validDescription", {
              handle: inviteInfo.createdByHandle || "someone",
            })}
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Workflow name */}
          <div className="rounded-lg bg-muted p-4 text-center">
            <div className="text-sm text-muted-foreground mb-1">
              {t("pages.inviteAccept.workflowName")}
            </div>
            <div className="font-semibold text-lg">{inviteInfo.workflowName}</div>
          </div>

          {/* Expiry info */}
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Clock className="h-4 w-4" />
            <span>
              {t("pages.inviteAccept.expiresAt")}: {formatExpiry(inviteInfo.expiresAt)}
            </span>
          </div>

          {/* Error message */}
          {acceptError && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-destructive text-sm text-center">
              {acceptError}
            </div>
          )}
        </CardContent>

        <CardFooter className="flex flex-col gap-3">
          {session?.user ? (
            <Button
              onClick={handleAccept}
              disabled={accepting}
              className="w-full"
              data-testid="accept-invite-button"
            >
              {accepting ? t("pages.inviteAccept.accepting") : t("pages.inviteAccept.accept")}
            </Button>
          ) : (
            <>
              <div className="text-sm text-muted-foreground text-center">
                {t("pages.inviteAccept.loginRequired")}
              </div>
              <Button asChild className="w-full">
                <Link
                  to={`${ROUTES.LOGIN}?redirect=${encodeURIComponent(window.location.pathname)}`}
                >
                  {t("pages.inviteAccept.signIn")}
                </Link>
              </Button>
            </>
          )}
          <Button variant="outline" asChild className="w-full">
            <Link to={ROUTES.DASHBOARD}>{t("pages.inviteAccept.backToDashboard")}</Link>
          </Button>
        </CardFooter>
      </Card>
    </AuthLayout>
  );
};
