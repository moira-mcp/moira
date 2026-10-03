import React, { lazy, Suspense } from "react";
import type { AuthView as LibraryAuthView } from "@daveyplate/better-auth-ui";
import { useTranslation } from "react-i18next";
import { Skeleton } from "../components/ui/skeleton";

const AuthForm = lazy(() => import("./AuthForm").then((module) => ({ default: module.AuthForm })));

/** Keep the surrounding auth page and error display mounted while form code arrives. */
export function AuthView(props: React.ComponentProps<typeof LibraryAuthView>) {
  const { t } = useTranslation();
  return (
    <Suspense
      fallback={
        <Skeleton
          className="h-80 w-full rounded-xl"
          role="status"
          aria-label={t("common.loading")}
        />
      }
    >
      <AuthForm {...props} />
    </Suspense>
  );
}
