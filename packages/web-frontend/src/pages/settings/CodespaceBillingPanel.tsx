import React from "react";
import { useTranslation } from "react-i18next";
import type { CodespaceProviderBillingView } from "@mcp-moira/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { apiClient } from "@/services/api-client";
import { useResource } from "@/hooks/useResource";
import { DataRegion } from "@/components/DataRegion";

export function CodespaceBillingPanel({
  billing,
}: {
  billing: CodespaceProviderBillingView;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const number = (value: number) =>
    value.toLocaleString(i18n.language, { maximumFractionDigits: 4 });
  const dollars = (value: number) =>
    value.toLocaleString(i18n.language, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    });

  return (
    <Card data-testid="github-codespace-billing">
      <CardHeader>
        <CardTitle className="text-base">{t("pages.settings.codespaces.billing.title")}</CardTitle>
        <CardDescription>{t("pages.settings.codespaces.billing.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {billing === "unavailable" ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="github-codespace-billing-unavailable"
          >
            {t("pages.settings.codespaces.billing.unavailable")}
          </p>
        ) : (
          <div className="space-y-3" data-testid="github-codespace-billing-available">
            <p className="text-sm text-muted-foreground">
              {t("pages.settings.codespaces.billing.payerPeriod", {
                payer: billing.payer_login,
                period: new Date(
                  Date.UTC(billing.period.year, billing.period.month - 1),
                ).toLocaleDateString(i18n.language, {
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                }),
              })}
            </p>
            <p className="text-xs text-muted-foreground">
              {billing.plan
                ? t("pages.settings.codespaces.billing.plan", {
                    plan: billing.plan === "free" ? "Free" : "Pro",
                  })
                : t("pages.settings.codespaces.billing.planUnknown")}
            </p>
            <dl className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border p-3">
                <dt className="text-sm text-muted-foreground">
                  {t("pages.settings.codespaces.billing.compute")}
                </dt>
                <dd className="font-semibold tabular-nums">
                  {billing.compute.included_core_hours === null
                    ? t("pages.settings.codespaces.billing.usedUnknownAllowance", {
                        used: number(billing.compute.used_core_hours),
                        unit: t("pages.settings.codespaces.billing.coreHours"),
                      })
                    : t("pages.settings.codespaces.billing.usedOfAllowance", {
                        used: number(billing.compute.used_core_hours),
                        included: number(billing.compute.included_core_hours),
                        unit: t("pages.settings.codespaces.billing.coreHours"),
                      })}
                </dd>
              </div>
              <div className="rounded-lg border p-3">
                <dt className="text-sm text-muted-foreground">
                  {t("pages.settings.codespaces.billing.storage")}
                </dt>
                <dd className="font-semibold tabular-nums">
                  {billing.storage.included_gb_month === null
                    ? t("pages.settings.codespaces.billing.usedUnknownAllowance", {
                        used: number(billing.storage.used_gb_month),
                        unit: t("pages.settings.codespaces.billing.gbMonth"),
                      })
                    : t("pages.settings.codespaces.billing.usedOfAllowance", {
                        used: number(billing.storage.used_gb_month),
                        included: number(billing.storage.included_gb_month),
                        unit: t("pages.settings.codespaces.billing.gbMonth"),
                      })}
                </dd>
              </div>
              <div className="rounded-lg border p-3">
                <dt className="text-sm text-muted-foreground">
                  {t("pages.settings.codespaces.billing.billable")}
                </dt>
                <dd className="font-semibold tabular-nums">{dollars(billing.net_amount_usd)}</dd>
              </div>
            </dl>
            <p className="text-xs text-muted-foreground">
              {t("pages.settings.codespaces.billing.retrieved", {
                time: new Date(billing.retrieved_at).toLocaleString(i18n.language),
              })}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function CodespaceBillingFromData({
  active = false,
}: {
  active?: boolean;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const resource = useResource<CodespaceProviderBillingView>(
    active ? "codespace-provider-billing" : null,
    () => apiClient.getCodespaceBilling(),
    () => t("localDevices.codespaces.billingFailed"),
  );
  if (!active) return null;
  return (
    <DataRegion
      hasResult={resource.data !== undefined}
      pending={resource.pending}
      error={resource.error}
      onRetry={resource.refresh}
      testId="codespace-billing-region"
    >
      {resource.data !== undefined && <CodespaceBillingPanel billing={resource.data} />}
    </DataRegion>
  );
}
