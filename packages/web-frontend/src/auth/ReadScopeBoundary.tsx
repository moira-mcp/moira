import { Fragment, useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { InlineError } from "../components/inline-error";
import { authClient } from "./better-auth-client";
import { useFeatures } from "../hooks/useFeatures";
import {
  getReadOwner,
  getReadCredentialVersion,
  getReadIdentity,
  getReadScopeVersion,
  isPrivateReadSuspended,
  observeReadCapabilities,
  subscribeReadScope,
} from "../services/read-scope";

/** Observe auth/features for requests without owning public route operation state. */
export function ReadScopeBoundary({ children }: { children: React.ReactNode }) {
  authClient.useSession();
  const { deploymentMode, features, loaded, error } = useFeatures();
  const capabilityKey = JSON.stringify([deploymentMode, features, loaded, error]);
  useEffect(() => observeReadCapabilities(capabilityKey), [capabilityKey]);
  return <>{children}</>;
}

/** Own private holdings; anonymous completion/invite content can explicitly remain public. */
export function PrivateReadScopeBoundary({
  children,
  allowAnonymous = false,
}: {
  children: React.ReactNode;
  allowAnonymous?: boolean;
}) {
  const session = authClient.useSession();
  const { t } = useTranslation();
  useSyncExternalStore(subscribeReadScope, getReadScopeVersion, getReadScopeVersion);
  const suspended = isPrivateReadSuspended() || (!allowAnonymous && getReadIdentity() === null);
  const accessibility = suspended ? { inert: "" } : {};
  return (
    <>
      {suspended && session.error && (
        <div className="p-4">
          <InlineError
            title={t("common.errors.failedToLoad")}
            message={t("pages.registrationSuccess.statusLoadError")}
            retryLabel={t("pages.registrationSuccess.retryStatus")}
            onRetry={() => void session.refetch()}
          />
        </div>
      )}
      <div
        {...accessibility}
        style={{ display: suspended ? "none" : "contents" }}
        hidden={suspended}
        aria-hidden={suspended || undefined}
      >
        <Fragment key={getReadOwner()}>{children}</Fragment>
      </div>
    </>
  );
}

/** Retire asynchronous page effects; owner-only mode is for cleanup or freshly revalidated actions. */
export function useReadOwnerGuard() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return useCallback((checkCredential = true) => {
    const owner = getReadOwner();
    const credential = getReadCredentialVersion();
    return () =>
      alive.current &&
      owner === getReadOwner() &&
      (!checkCredential ||
        (!isPrivateReadSuspended() && credential === getReadCredentialVersion()));
  }, []);
}
