import React, { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AuthView } from "../auth/LazyAuthView";
import { useSession } from "../auth/better-auth-client";
import { originalAuthorizationParams } from "../auth/authorization-params";
import { PrivateReadScopeBoundary } from "../auth/ReadScopeBoundary";
import { AuthErrorDisplay } from "../components/auth/AuthErrorDisplay";
import { AuthLayout } from "../components/AuthLayout";
import { ROUTES } from "../constants/routes";

function ResumeAuthorization({ target }: { target: string }) {
  const { t } = useTranslation();
  useEffect(() => {
    window.location.replace(target);
  }, [target]);
  return <AuthLayout>{t("pages.oauthAuthorize.authorizing")}</AuthLayout>;
}

export const OAuthAuthorize: React.FC = () => {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const { data: session, isPending } = useSession();
  const authorization = `/api/auth/oauth2/authorize?${originalAuthorizationParams(params)}`;
  const signedLogin = params.has("sig");
  if (session?.user && !signedLogin)
    return (
      <PrivateReadScopeBoundary>
        <ResumeAuthorization target={authorization} />
      </PrivateReadScopeBoundary>
    );
  if (isPending)
    return (
      <AuthLayout showLanguageSwitcher={false}>{t("pages.oauthAuthorize.loading")}</AuthLayout>
    );

  // The provider can request fresh authentication even when the browser has a session.
  // Its client plugin sends the signed query with the login and follows the provider's response.
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
        <AuthView
          pathname={ROUTES.LOGIN}
          redirectTo={signedLogin ? `${ROUTES.OAUTH_AUTHORIZE}?${params}` : authorization}
        />
        <AuthErrorDisplay />
      </div>
    </AuthLayout>
  );
};
