/**
 * Invite Accept Page
 * Landing page for accepting workflow invite links
 *
 * Route: /invites/:token
 *
 * Displays invite info and allows authenticated users to accept access.
 * Redirects to login if not authenticated.
 */

import React, { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Users, Clock, AlertCircle, CheckCircle2, XCircle } from "lucide-react";
import { apiClient, ApiClientError } from "../services/api-client";
import { useSession } from "../auth/better-auth-client";
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
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { data: session, isPending: sessionLoading } = useSession();

  const [inviteInfo, setInviteInfo] = useState<InviteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [acceptedWorkflowPath, setAcceptedWorkflowPath] = useState<string | null>(null);

  // Load invite info
  const loadInviteInfo = useCallback(async () => {
    if (!token) return;

    try {
      setLoading(true);
      setError(null);
      const info = await apiClient.getInviteInfo(token);
      setInviteInfo(info);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setError("not_found");
      } else {
        setError(err instanceof Error ? err.message : "unknown");
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadInviteInfo();
  }, [loadInviteInfo]);

  // Accept invite
  const handleAccept = async () => {
    if (!token) return;

    try {
      setAccepting(true);
      setAcceptError(null);
      const result = await apiClient.acceptInvite(token);
      setAccepted(true);
      // Use handle/slug format for redirect URL (e.g., /workflows/admin/my-workflow)
      const workflowPath = `${result.ownerHandle}/${result.slug}`;
      setAcceptedWorkflowPath(workflowPath);
      // Auto-redirect after short delay
      setTimeout(() => {
        navigate(`${ROUTES.WORKFLOWS}/${workflowPath}`);
      }, 2000);
    } catch (err) {
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
      setAccepting(false);
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
