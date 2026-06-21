/**
 * Verify Email page - confirm email verification from link
 */

import React, { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { CheckCircle, XCircle, Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AuthLayout } from "@/components/AuthLayout";
import { ROUTES } from "../constants/routes";

export const VerifyEmail: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const [status, setStatus] = useState<"loading" | "success" | "error">("loading");
  const [errorKey, setErrorKey] = useState<"invalidLink" | "failed" | "networkError">("failed");

  useEffect(() => {
    const token = searchParams.get("token");
    const error = searchParams.get("error");

    if (error) {
      setStatus("error");
      setErrorKey("failed");
    } else if (token) {
      setStatus("success");
    } else {
      setStatus("error");
      setErrorKey("invalidLink");
    }
  }, [searchParams]);

  const getErrorMessage = () => {
    switch (errorKey) {
      case "invalidLink":
        return t("pages.verifyEmail.invalidLink");
      case "failed":
        return t("pages.verifyEmail.failed");
      case "networkError":
        return t("pages.verifyEmail.networkError");
      default:
        return t("pages.verifyEmail.failed");
    }
  };

  return (
    <AuthLayout>
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle>{t("pages.verifyEmail.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          {status === "loading" && (
            <>
              <Loader2 className="h-12 w-12 animate-spin text-muted-foreground" />
              <p className="text-muted-foreground">{t("pages.verifyEmail.verifying")}</p>
            </>
          )}

          {status === "success" && (
            <>
              <CheckCircle className="h-12 w-12 text-chart-2" />
              <p className="text-center">{t("pages.verifyEmail.success")}</p>
              <Button asChild>
                <Link to={ROUTES.LOGIN}>{t("pages.verifyEmail.continueToLogin")}</Link>
              </Button>
            </>
          )}

          {status === "error" && (
            <>
              <XCircle className="h-12 w-12 text-destructive" />
              <p className="text-center text-destructive">{getErrorMessage()}</p>
              <Button variant="outline" asChild>
                <Link to={ROUTES.LOGIN}>{t("pages.verifyEmail.backToLogin")}</Link>
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </AuthLayout>
  );
};
