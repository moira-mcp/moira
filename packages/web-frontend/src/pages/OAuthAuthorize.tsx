/* eslint-disable no-console */
/**
 * OAuth Authorization Page for MCP clients
 * Shows login form if not authenticated, then consent screen
 * Auto-approves if consent already given
 *
 * Note: console.error used for browser debugging of OAuth consent checks
 */

import { productFetch } from "@/services/product-fetch";
import React, { useState, useMemo, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AuthView } from "../auth/LazyAuthView";
import { authClient, useSession, signOut } from "../auth/better-auth-client";
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
import { AuthErrorDisplay } from "../components/auth/AuthErrorDisplay";
import { AuthLayout } from "../components/AuthLayout";
import { ROUTES } from "../constants/routes";
import { PrivateReadScopeBoundary, useReadOwnerGuard } from "../auth/ReadScopeBoundary";
import { getReadIdentity } from "../services/read-scope";

export const OAuthAuthorize: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { data: session, isPending } = useSession();
  if (session?.user)
    return (
      <PrivateReadScopeBoundary>
        <OAuthAuthorizeConsent />
      </PrivateReadScopeBoundary>
    );
  if (isPending)
    return (
      <AuthLayout showLanguageSwitcher={false}>
        <div className="text-center text-muted-foreground">{t("pages.oauthAuthorize.loading")}</div>
      </AuthLayout>
    );
  const redirectToUrl = `${ROUTES.OAUTH_AUTHORIZE}?${searchParams.toString()}`;
  return (
    <AuthLayout>
      <div className="space-y-4">
        <div className="bg-card border border-border px-6 py-6 rounded-xl shadow-sm">
          <h2 className="text-xl font-semibold leading-none mb-2">
            {t("pages.oauthAuthorize.signInTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("pages.oauthAuthorize.signInDescription")}
          </p>
        </div>
        <AuthView pathname={ROUTES.LOGIN} redirectTo={redirectToUrl} />
        <AuthErrorDisplay />
      </div>
    </AuthLayout>
  );
};

const OAuthAuthorizeConsent: React.FC = () => {
  const captureOwner = useReadOwnerGuard();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { data: session, isPending: isLoading } = useSession();
  const user = session?.user;
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCheckingConsent, setIsCheckingConsent] = useState(false);
  const [hasExistingConsent, setHasExistingConsent] = useState<boolean | null>(null);

  // Get OAuth params
  const clientId = searchParams.get("client_id");
  const scope = searchParams.get("scope");
  const scopes = scope ? scope.split(" ").filter((s) => s) : ["openid"];

  // Build final authorize URL
  const authorizeUrl = useMemo(() => {
    const params = new URLSearchParams();
    searchParams.forEach((value, key) => {
      params.set(key, value);
    });
    return `/api/auth/mcp/authorize?${params.toString()}`;
  }, [searchParams]);

  // Check for existing consent when user is logged in
  useEffect(() => {
    let active = true;
    const ownsResponse = captureOwner();
    const isCurrent = () => active && ownsResponse();
    const checkExistingConsent = async () => {
      if (!user || !clientId) return;

      setIsCheckingConsent(true);
      try {
        const response = await productFetch(
          `/api/oauth/consent/check?client_id=${encodeURIComponent(clientId)}`,
          {
            credentials: "include",
          },
        );

        if (response.ok) {
          const data = await response.json();
          if (!isCurrent()) return;
          if (data.data?.hasConsent) {
            // Auto-approve - redirect directly to authorize
            setHasExistingConsent(true);
            window.location.href = authorizeUrl;
          } else {
            setHasExistingConsent(false);
          }
        } else {
          if (isCurrent()) setHasExistingConsent(false);
        }
      } catch (error) {
        if (!isCurrent()) return;
        // If check fails, show consent screen
        console.error("Failed to check consent:", error);
        setHasExistingConsent(false);
      } finally {
        if (isCurrent()) setIsCheckingConsent(false);
      }
    };

    checkExistingConsent();
    return () => {
      active = false;
    };
  }, [user, clientId, authorizeUrl, captureOwner]);

  // Handle consent approval
  const handleAllow = async () => {
    const isCurrent = captureOwner();
    const ownsPage = captureOwner(false);
    setIsSubmitting(true);

    // Save consent to database before redirecting
    try {
      await productFetch("/api/oauth/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          client_id: clientId,
          scopes: scopes,
        }),
      });
    } catch (error) {
      // Log but don't block - consent saving is not critical for the OAuth flow
      console.error("Failed to save consent:", error);
    }

    if (!isCurrent() && ownsPage()) await authClient.$store.atoms.session.get().refetch();
    if (ownsPage() && getReadIdentity() !== null) window.location.href = authorizeUrl;
    else if (ownsPage()) setIsSubmitting(false);
  };

  // Handle consent denial
  const handleDeny = () => {
    const redirectUri = searchParams.get("redirect_uri");
    if (redirectUri) {
      window.location.href = `${redirectUri}?error=access_denied&error_description=User%20denied%20access`;
    } else {
      window.location.href = ROUTES.DASHBOARD;
    }
  };

  // Handle account switch
  const handleSwitchAccount = async () => {
    await signOut();
    // Page will reload to show login form
  };

  // Get scope descriptions using i18n
  const getScopeDescription = (scopeName: string): string => {
    const key = `pages.oauthAuthorize.scopes.${scopeName.replace(":", "_")}`;
    const translated = t(key);
    // If no translation found, return the scope name
    return translated === key ? scopeName : translated;
  };

  // Show loading while checking session or consent
  if (isLoading || isCheckingConsent || hasExistingConsent === true) {
    return (
      <AuthLayout showLanguageSwitcher={false}>
        <div className="text-center text-muted-foreground">
          {hasExistingConsent === true
            ? t("pages.oauthAuthorize.authorizing")
            : t("pages.oauthAuthorize.loading")}
        </div>
      </AuthLayout>
    );
  }

  // If user is logged in, show consent screen
  if (user) {
    return (
      <AuthLayout>
        <Card className="w-full">
          <CardHeader className="text-center">
            <CardTitle>{t("pages.oauthAuthorize.title")}</CardTitle>
            <CardDescription>{t("pages.oauthAuthorize.description")}</CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {/* Current user info */}
            <div className="flex items-center gap-3 p-3 bg-muted rounded-lg">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                <User className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">
                  {user.name || user.email || t("pages.oauthAuthorize.unknownUser")}
                </p>
                {user.email && user.name && (
                  <p className="text-xs text-muted-foreground truncate">{user.email}</p>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={handleSwitchAccount} className="shrink-0">
                <LogOut className="h-4 w-4 mr-1" />
                {t("pages.oauthAuthorize.switch")}
              </Button>
            </div>

            <Separator />

            {/* Client info */}
            {clientId && (
              <div>
                <p className="text-sm font-medium mb-2">{t("pages.oauthAuthorize.application")}</p>
                <p className="text-sm text-muted-foreground font-mono">{clientId}</p>
              </div>
            )}

            {/* Requested permissions */}
            <div>
              <p className="text-sm font-medium mb-2">
                {t("pages.oauthAuthorize.requestedPermissions")}
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
          </CardContent>

          <CardFooter className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={handleDeny}
              disabled={isSubmitting}
            >
              <X className="h-4 w-4 mr-2" />
              {t("pages.oauthAuthorize.deny")}
            </Button>
            <Button className="flex-1" onClick={handleAllow} disabled={isSubmitting}>
              <Check className="h-4 w-4 mr-2" />
              {isSubmitting
                ? t("pages.oauthAuthorize.authorizing")
                : t("pages.oauthAuthorize.allow")}
            </Button>
          </CardFooter>
        </Card>
      </AuthLayout>
    );
  }

  return null;
};
