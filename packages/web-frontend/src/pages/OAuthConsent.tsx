/**
 * OAuth Consent Page
 * Shows consent screen for MCP clients requesting access
 * Allows user to approve or deny, and switch accounts
 */

import { productFetch } from "@/services/product-fetch";
import React, { useState, useRef } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  authClient,
  useSession,
  signOut,
  waitForSessionSettlement,
} from "../auth/better-auth-client";
import { PrivateReadScopeBoundary, useReadOwnerGuard } from "../auth/ReadScopeBoundary";
import { getReadIdentity, isReadSessionSuspended } from "../services/read-scope";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Separator } from "../components/ui/separator";
import { Check, X, User, Key, LogOut } from "lucide-react";
import { AuthLayout } from "../components/AuthLayout";
import { ROUTES } from "../constants/routes";

export const OAuthConsent: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: session, isPending } = useSession();
  const [switchingOwner, setSwitchingOwner] = useState<string | null>(null);
  const alive = useRef(true);
  React.useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  React.useEffect(() => {
    if (session?.user) {
      if (switchingOwner && switchingOwner !== session.user.id) setSwitchingOwner(null);
      return;
    }
    if (!isPending && !isReadSessionSuspended()) {
      const params = new URLSearchParams(searchParams);
      if (switchingOwner) params.delete("consent_code");
      navigate(`${ROUTES.OAUTH_AUTHORIZE}?${params.toString()}`);
    }
  }, [isPending, session?.user, switchingOwner, navigate, searchParams]);

  // This public operation survives the private owner's departure; consent facts do not.
  const handleSwitchAccount = async () => {
    setSwitchingOwner(session?.user.id ?? null);
    try {
      const result = await signOut();
      if (result.error && alive.current) setSwitchingOwner(null);
      // The authoritative anonymous session effect owns the redirect, even when
      // provider invalidation supersedes one of the transport's refetch promises.
    } catch (error) {
      if (alive.current) setSwitchingOwner(null);
      throw error;
    }
  };
  return (
    <PrivateReadScopeBoundary>
      <OAuthConsentContent onSwitchAccount={handleSwitchAccount} />
    </PrivateReadScopeBoundary>
  );
};

const OAuthConsentContent: React.FC<{ onSwitchAccount: () => Promise<void> }> = ({
  onSwitchAccount,
}) => {
  const captureOwner = useReadOwnerGuard();
  const settlementLifetime = useRef(new AbortController());
  React.useEffect(() => {
    if (settlementLifetime.current.signal.aborted)
      settlementLifetime.current = new AbortController();
    return () => settlementLifetime.current.abort();
  }, []);
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: session, isPending: isLoading } = useSession();
  const user = session?.user;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Get OAuth params from URL
  const consentCode = searchParams.get("consent_code");
  const clientId = searchParams.get("client_id");
  const scope = searchParams.get("scope");

  // Show loading while checking auth
  if (isLoading) {
    return (
      <AuthLayout>
        <div className="text-center text-muted-foreground">{t("pages.oauthConsent.loading")}</div>
      </AuthLayout>
    );
  }

  // If no user, we're redirecting
  if (!user) {
    return null;
  }

  // Parse scopes for display
  const scopes = scope ? scope.split(" ").filter((s) => s) : ["openid"];

  // Handle consent decision
  const handleConsent = async (accept: boolean) => {
    if (!consentCode) {
      setError(t("pages.oauthConsent.missingConsentCode"));
      return;
    }

    setIsSubmitting(true);
    setError(null);
    const isCurrent = captureOwner(false);

    try {
      const response = await productFetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        credentials: "include",
        body: JSON.stringify({
          accept,
          consent_code: consentCode,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          data.error_description || data.message || `Consent failed: ${response.status}`,
        );
      }

      // Response contains redirectURI
      const data = await response.json();
      // This auth mutation retires credentials itself. Confirm the cookie's current owner
      // before applying its redirect, rather than accepting the dispatch credential epoch.
      await authClient.$store.atoms.session.get().refetch();
      const settled = await waitForSessionSettlement(settlementLifetime.current.signal);
      if (!isCurrent() || !settled || settled.error || getReadIdentity() === null) return;
      if (data.redirectURI) {
        window.location.href = data.redirectURI;
      } else if (data.redirectTo) {
        window.location.href = data.redirectTo;
      } else {
        // Fallback - redirect to dashboard
        navigate(ROUTES.DASHBOARD);
      }
    } catch (err) {
      if (!isCurrent()) return;
      setError(err instanceof Error ? err.message : t("pages.oauthConsent.consentFailed"));
    } finally {
      if (isCurrent()) setIsSubmitting(false);
    }
  };

  // Get scope descriptions using i18n
  const getScopeDescription = (scopeName: string): string => {
    const key = `pages.oauthConsent.scopes.${scopeName.replace(":", "_")}`;
    const translated = t(key);
    // If no translation found, return the scope name
    return translated === key ? scopeName : translated;
  };

  if (!consentCode || !clientId) {
    return (
      <AuthLayout>
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="text-destructive">
              {t("pages.oauthConsent.invalidRequest")}
            </CardTitle>
            <CardDescription>{t("pages.oauthConsent.missingParams")}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Button onClick={() => navigate(ROUTES.DASHBOARD)} className="w-full">
              {t("pages.oauthConsent.goToDashboard")}
            </Button>
          </CardFooter>
        </Card>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle>{t("pages.oauthConsent.title")}</CardTitle>
          <CardDescription>{t("pages.oauthConsent.description")}</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Current user info */}
          <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
              <User className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">
                {user?.name || user?.email || t("pages.oauthConsent.unknownUser")}
              </p>
              {user?.email && user?.name && (
                <p className="text-xs text-muted-foreground truncate">{user.email}</p>
              )}
            </div>
            <Button variant="ghost" size="sm" onClick={onSwitchAccount} className="shrink-0">
              <LogOut className="h-4 w-4 mr-1" />
              {t("pages.oauthConsent.switch")}
            </Button>
          </div>

          <Separator />

          {/* Client info */}
          <div>
            <p className="text-sm font-medium mb-2">{t("pages.oauthConsent.application")}</p>
            <p className="text-sm text-muted-foreground font-mono">{clientId}</p>
          </div>

          {/* Requested permissions */}
          <div>
            <p className="text-sm font-medium mb-2">
              {t("pages.oauthConsent.requestedPermissions")}
            </p>
            <ul className="space-y-2">
              {scopes.map((scopeName) => (
                <li key={scopeName} className="flex items-start gap-2 text-sm">
                  <Key className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                  <span className="text-muted-foreground">{getScopeDescription(scopeName)}</span>
                </li>
              ))}
            </ul>
          </div>

          {error && (
            <div className="p-3 bg-destructive/10 text-destructive text-sm rounded-lg">{error}</div>
          )}
        </CardContent>

        <CardFooter className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => handleConsent(false)}
            disabled={isSubmitting}
          >
            <X className="h-4 w-4 mr-2" />
            {t("pages.oauthConsent.deny")}
          </Button>
          <Button className="flex-1" onClick={() => handleConsent(true)} disabled={isSubmitting}>
            <Check className="h-4 w-4 mr-2" />
            {isSubmitting ? t("pages.oauthConsent.authorizing") : t("pages.oauthConsent.allow")}
          </Button>
        </CardFooter>
      </Card>
    </AuthLayout>
  );
};
