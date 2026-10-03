/**
 * Protected routes own admission and private holdings; public auth operations stay outside.
 */
import React, { useEffect, useState, useSyncExternalStore } from "react";
import { Navigate, useNavigate, useLocation } from "react-router-dom";
import { useSession, authClient, revokeObservedSession } from "../auth/better-auth-client";
import { PrivateReadScopeBoundary } from "../auth/ReadScopeBoundary";
import { apiClient } from "../services/api-client";
import {
  getReadCredentialVersion,
  getReadIdentity,
  getReadOwner,
  subscribeReadScope,
} from "../services/read-scope";
import { ROUTES, APP_PREFIX } from "../constants/routes";
import { buildLoginUrlWithReturn } from "../utils/return-url";
import { useFeatures } from "../hooks/useFeatures";
import { decideAdmissionRoute } from "../auth/admission-routing";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { FeatureFlag } from "../types/api-types";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
  requireEmailVerified?: boolean;
  requireCapability?: FeatureFlag;
}
type AdmissionFacts = Awaited<ReturnType<typeof apiClient.getUserInfo>>;

/** Reset both guard facts and manual page state when the private owner/backend changes. */
export const ProtectedRoute: React.FC<ProtectedRouteProps> = (props) => (
  <PrivateReadScopeBoundary>
    <ProtectedRouteContent {...props} />
  </PrivateReadScopeBoundary>
);

const ProtectedRouteContent: React.FC<ProtectedRouteProps> = ({
  children,
  requireAdmin = false,
  requireEmailVerified = true,
  requireCapability,
}) => {
  const {
    isEnabled: isFeatureEnabled,
    loaded: featuresLoaded,
    error: featuresError,
    retry: retryFeatures,
  } = useFeatures();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: session, isPending } = useSession();
  const credentialVersion = useSyncExternalStore(
    subscribeReadScope,
    getReadCredentialVersion,
    getReadCredentialVersion,
  );
  const [admission, setAdmission] = useState<{
    facts: AdmissionFacts;
    credentialVersion: number;
  } | null>(null);
  const [checkingUser, setCheckingUser] = useState(false);
  const [userInfoError, setUserInfoError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [previouslyAdmitted, setPreviouslyAdmitted] = useState(false);
  const userId = session?.user.id;
  const sessionKey = session?.session.id;

  useEffect(() => {
    let active = true;
    const owner = getReadOwner();
    const capturedCredential = credentialVersion;
    const isCurrent = () =>
      active &&
      owner === getReadOwner() &&
      capturedCredential === getReadCredentialVersion() &&
      getReadIdentity() !== null;
    const observedData = authClient.$store.atoms.session.get().data;
    const observedSession = observedData?.session;
    if (
      !userId ||
      !sessionKey ||
      isPending ||
      !isCurrent() ||
      observedData?.user.id !== userId ||
      observedSession?.id !== sessionKey
    ) {
      return () => {
        active = false;
      };
    }
    setCheckingUser(true);
    setUserInfoError(false);
    apiClient
      .getUserInfo()
      .then((facts) => {
        if (!isCurrent()) return;
        if (facts.id !== userId) throw new Error("Admission belongs to a different account");
        setAdmission({ facts, credentialVersion: capturedCredential });
        setCheckingUser(false);
        setUserInfoError(false);
        if (facts.blocked) {
          void revokeObservedSession(observedSession)
            .then((owned) => {
              // A newer login must not be redirected by an earlier blocked account's operation.
              const currentUser = authClient.$store.atoms.session.get().data?.user.id;
              if (owned && active && (!currentUser || currentUser === userId)) {
                navigate(ROUTES.LOGIN, { replace: true });
              }
            })
            .catch(() => {
              if (active) setUserInfoError(true);
            });
          return;
        }
        if (
          facts.passwordResetRequired &&
          window.location.pathname !== ROUTES.FORCED_PASSWORD_RESET
        ) {
          navigate(ROUTES.FORCED_PASSWORD_RESET, { replace: true });
        }
      })
      .catch(() => {
        if (!isCurrent()) return;
        // Keep prior admitted children mounted, hidden until a successful recheck or a real denial.
        setCheckingUser(false);
        setUserInfoError(true);
      });
    return () => {
      active = false;
    };
  }, [userId, sessionKey, isPending, credentialVersion, retryKey, navigate]);

  const facts = admission?.facts;
  const revalidating =
    isPending ||
    checkingUser ||
    admission?.credentialVersion !== credentialVersion ||
    getReadIdentity() === null ||
    !featuresLoaded;
  const fresh = !revalidating && !userInfoError && !featuresError && !!facts;
  const decision = facts
    ? decideAdmissionRoute({
        accountApprovalRequired: facts.accountApprovalRequired,
        accountApproved: facts.accountApproved,
        emailVerificationGate: requireEmailVerified && isFeatureEnabled("emailVerificationGate"),
        emailVerified: facts.emailVerified,
      })
    : null;
  const forcedReset =
    !!facts?.passwordResetRequired && window.location.pathname !== ROUTES.FORCED_PASSWORD_RESET;
  const roleDenied = requireAdmin && facts?.isAdmin === false;
  const capabilityDenied = !!requireCapability && !isFeatureEnabled(requireCapability);
  const allowed =
    fresh &&
    !facts.blocked &&
    !forcedReset &&
    decision === "allow" &&
    !roleDenied &&
    !capabilityDenied;
  useEffect(() => {
    if (fresh) setPreviouslyAdmitted(allowed);
  }, [fresh, allowed]);

  if (!session && !isPending) {
    const currentUrl = location.pathname + location.search;
    return <Navigate to={buildLoginUrlWithReturn(currentUrl, ROUTES.LOGIN)} replace />;
  }
  if (fresh) {
    if (facts.blocked) return <Navigate to={ROUTES.LOGIN} replace />;
    if (forcedReset) return <Navigate to={ROUTES.FORCED_PASSWORD_RESET} replace />;
    if (decision !== "allow") return <Navigate to={`${APP_PREFIX}/registration-success`} replace />;
    if (roleDenied) return <Navigate to={ROUTES.WORKFLOWS} replace />;
    if (capabilityDenied) return <Navigate to={ROUTES.ADMIN} replace />;
  }
  const hidden = !allowed;
  const accessibility = hidden ? { inert: "" } : {};
  return (
    <>
      {userInfoError ? (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3" role="alert">
          <p className="text-sm text-destructive">
            {t("pages.registrationSuccess.statusLoadError")}
          </p>
          <Button variant="outline" onClick={() => setRetryKey((current) => current + 1)}>
            {t("pages.registrationSuccess.retryStatus")}
          </Button>
        </div>
      ) : featuresError ? (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3" role="alert">
          <p className="text-sm text-destructive">
            {t("pages.registrationSuccess.featuresLoadError")}
          </p>
          <Button variant="outline" onClick={retryFeatures}>
            {t("pages.registrationSuccess.retryFeatures")}
          </Button>
        </div>
      ) : revalidating ? (
        <div className="flex min-h-screen items-center justify-center">
          <div className="text-muted-foreground">{t("common.loading")}</div>
        </div>
      ) : null}
      <div
        {...accessibility}
        style={{ display: hidden ? "none" : "contents" }}
        hidden={hidden}
        aria-hidden={hidden || undefined}
      >
        {allowed || previouslyAdmitted ? children : null}
      </div>
    </>
  );
};
