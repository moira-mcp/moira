/**
 * Registration Success page - shows email verification instructions
 * Polls for email verification status and redirects when verified
 */

import React, { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CheckCircle, Mail, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AuthLayout } from "@/components/AuthLayout";
import { validateReturnUrl } from "../utils/return-url";
import { ROUTES } from "../constants/routes";

// Buffer seconds to add to server cooldown for network latency
const COOLDOWN_BUFFER_SECONDS = 2;

export const RegistrationSuccess: React.FC = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [isPolling, setIsPolling] = useState(true);
  const [isVerified, setIsVerified] = useState(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // Resend email state
  const [isResending, setIsResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<"idle" | "success" | "error">("idle");
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const [userEmail, setUserEmail] = useState("");

  // Check if there are OAuth params to continue after verification
  const hasOAuthFlow = searchParams.has("client_id") || searchParams.has("redirect_uri");

  // Start countdown timer with seconds from server + buffer
  const startCountdown = useCallback((seconds: number) => {
    const totalSeconds = seconds + COOLDOWN_BUFFER_SECONDS;
    setCountdown(totalSeconds);
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
    }
    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          if (countdownRef.current) {
            clearInterval(countdownRef.current);
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, []);

  // Handle resend verification email via our API (with server-side rate limiting)
  const handleResend = useCallback(async () => {
    if (!userEmail || isResending || countdown > 0) return;

    setIsResending(true);
    setResendStatus("idle");

    try {
      const response = await fetch("/api/user/resend-verification", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });

      const data = await response.json();

      if (response.status === 429) {
        // Rate limited - use cooldown from server
        if (data.cooldownSeconds) {
          startCountdown(data.cooldownSeconds);
        }
        setResendStatus("error");
      } else if (!response.ok || !data.success) {
        setResendStatus("error");
      } else {
        setResendStatus("success");
        // Use cooldown from server response
        if (data.cooldownSeconds) {
          startCountdown(data.cooldownSeconds);
        }
      }
    } catch {
      setResendStatus("error");
    } finally {
      setIsResending(false);
    }
  }, [userEmail, isResending, countdown, startCountdown]);

  // Cleanup countdown on unmount
  useEffect(() => {
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
      }
    };
  }, []);

  // Direct API call to check verification status (bypasses all caches)
  const checkVerificationStatus = useCallback(async () => {
    try {
      // disableCookieCache=true forces Better Auth to read fresh user data from DB
      const response = await fetch("/api/auth/get-session?disableCookieCache=true", {
        credentials: "include",
      });
      if (response.ok) {
        const data = await response.json();
        // Extract email from session for resend functionality
        if (data?.user?.email && !userEmail) {
          setUserEmail(data.user.email);
        }
        if (data?.user?.emailVerified) {
          setIsVerified(true);
          setIsPolling(false);
          if (pollingRef.current) {
            clearInterval(pollingRef.current);
          }
        }
      }
    } catch {
      // Ignore errors, keep polling
    }
  }, [userEmail]);

  useEffect(() => {
    // Poll for email verification every 2 seconds
    pollingRef.current = setInterval(checkVerificationStatus, 2000);
    // Also check immediately
    checkVerificationStatus();

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
      }
    };
  }, [checkVerificationStatus]);

  // When email is verified, redirect
  useEffect(() => {
    if (isVerified) {
      // Small delay to show verified state
      setTimeout(() => {
        if (hasOAuthFlow) {
          // Continue OAuth flow - redirect to authorize with preserved params
          const params = new URLSearchParams();
          searchParams.forEach((value, key) => {
            params.set(key, value);
          });
          navigate(`${ROUTES.OAUTH_AUTHORIZE}?${params.toString()}`);
        } else {
          // Check for returnUrl to redirect to original page
          const returnUrl = searchParams.get("returnUrl");
          const validated = validateReturnUrl(returnUrl);
          navigate(validated || ROUTES.DASHBOARD);
        }
      }, 1500);
    }
  }, [isVerified, navigate, hasOAuthFlow, searchParams]);

  return (
    <AuthLayout showLanguageSwitcher={false}>
      <Card className="w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-chart-2/10">
            {isVerified ? (
              <CheckCircle className="h-8 w-8 text-chart-2" />
            ) : (
              <Mail className="h-8 w-8 text-chart-2" />
            )}
          </div>
          <CardTitle className="text-2xl">
            {isVerified
              ? t("pages.registrationSuccess.verifiedTitle")
              : t("pages.registrationSuccess.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isVerified ? (
            <div className="flex items-center justify-center gap-2 p-4 bg-chart-2/10 rounded-lg">
              <Loader2 className="h-4 w-4 animate-spin text-chart-2" />
              <p className="text-sm text-foreground">
                {t("pages.registrationSuccess.redirecting")}
              </p>
            </div>
          ) : (
            <>
              <div className="flex items-start gap-3 p-4 bg-primary/10 rounded-lg">
                <Mail className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                <div>
                  <p className="text-sm text-foreground">
                    {t("pages.registrationSuccess.emailSent")}
                  </p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t("pages.registrationSuccess.checkInbox")}
                  </p>
                </div>
              </div>
              {isPolling && (
                <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{t("pages.registrationSuccess.waitingVerification")}</span>
                </div>
              )}
              <p className="text-sm text-muted-foreground text-center">
                {t("pages.registrationSuccess.checkSpam")}
              </p>

              {/* Resend verification email section */}
              {userEmail && (
                <div className="pt-2 space-y-3">
                  {resendStatus === "success" && (
                    <Alert className="bg-chart-2/10 border-chart-2/20">
                      <CheckCircle className="h-4 w-4 text-chart-2" />
                      <AlertDescription className="text-foreground">
                        {t("pages.registrationSuccess.resendSuccess")}
                      </AlertDescription>
                    </Alert>
                  )}
                  {resendStatus === "error" && (
                    <Alert variant="destructive">
                      <AlertDescription>
                        {t("pages.registrationSuccess.resendError")}
                      </AlertDescription>
                    </Alert>
                  )}
                  <Button
                    onClick={handleResend}
                    disabled={isResending || countdown > 0}
                    variant="ghost"
                    size="sm"
                    className="w-full text-muted-foreground hover:text-foreground"
                  >
                    {isResending ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {t("pages.registrationSuccess.resendingEmail")}
                      </>
                    ) : countdown > 0 ? (
                      <>
                        <RefreshCw className="h-4 w-4 mr-2" />
                        {t("pages.registrationSuccess.resendCountdown", { seconds: countdown })}
                      </>
                    ) : (
                      <>
                        <RefreshCw className="h-4 w-4 mr-2" />
                        {t("pages.registrationSuccess.resendEmail")}
                      </>
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
          <Button
            onClick={() => {
              // Preserve OAuth params or returnUrl when navigating to login
              if (hasOAuthFlow) {
                const params = new URLSearchParams();
                searchParams.forEach((value, key) => {
                  params.set(key, value);
                });
                navigate(`${ROUTES.LOGIN}?${params.toString()}`);
              } else {
                const returnUrl = searchParams.get("returnUrl");
                navigate(
                  returnUrl
                    ? `${ROUTES.LOGIN}?returnUrl=${encodeURIComponent(returnUrl)}`
                    : ROUTES.LOGIN,
                );
              }
            }}
            className="w-full"
            variant={isVerified ? "default" : "outline"}
          >
            {t("pages.registrationSuccess.goToLogin")}
          </Button>
        </CardContent>
      </Card>
    </AuthLayout>
  );
};
