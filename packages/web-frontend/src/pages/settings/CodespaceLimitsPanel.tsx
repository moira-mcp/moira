/**
 * The reader's own codespace limits beside their use, from the `limits` the codespace listing
 * returns (the same view agents see in the MCP `list` result). The three limits a person runs into
 * are shown as meters; the rest are listed underneath, folded.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Gauge } from "lucide-react";
import type { CodespaceLimitsView } from "@mcp-moira/shared";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { HelpPopover } from "@/components/settings/HelpPopover";
import { useGitHubCodespaces } from "./GitHubCodespacesData";

/** Bytes in the largest whole unit, localized. */
export function formatBytes(bytes: number, locale: string): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toLocaleString(locale, { maximumFractionDigits: digits })} ${units[unit]}`;
}

function Meter({
  label,
  used,
  max,
  display,
  testId,
}: {
  label: string;
  used: number;
  max: number;
  display: string;
  testId: string;
}) {
  const ratio = max > 0 ? Math.min(used / max, 1) : 0;
  return (
    // Label, value and bar each on their own line, so every meter has the same height whatever
    // the length of its value ("2 of 4" beside "12 MB of 100 MB").
    <div className="flex flex-col gap-1 rounded-lg border bg-card p-3" data-testid={testId}>
      <span className="truncate text-sm text-muted-foreground">{label}</span>
      <span className="truncate text-base font-semibold tabular-nums">{display}</span>
      <div
        className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={used}
      >
        <div
          className={cn(
            "h-full rounded-full transition-[width]",
            ratio >= 1 ? "bg-destructive" : ratio >= 0.75 ? "bg-amber-500" : "bg-primary",
          )}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

export function CodespaceLimitsPanel({
  limits,
}: {
  limits: CodespaceLimitsView;
}): React.JSX.Element {
  const { t, i18n } = useTranslation();
  const bytes = (value: number) => formatBytes(value, i18n.language);
  const minutes = (seconds: number) => Math.round(seconds / 60);
  const facts: Array<[string, string]> = [
    [
      t("pages.settings.codespaces.limits.machine"),
      t("pages.settings.codespaces.limits.machineValue", {
        cpu: limits.machine_ceiling.cpu_cores,
        memory: bytes(limits.machine_ceiling.memory_bytes),
        storage: bytes(limits.machine_ceiling.storage_bytes),
      }),
    ],
    [
      t("pages.settings.codespaces.limits.commandDuration"),
      t("pages.settings.codespaces.limits.minutes", {
        count: minutes(limits.operations.max_duration_seconds),
      }),
    ],
    [
      t("pages.settings.codespaces.limits.backgroundDuration"),
      t("pages.settings.codespaces.limits.minutes", {
        count: minutes(limits.operations.max_background_seconds),
      }),
    ],
    [t("pages.settings.codespaces.limits.commandInput"), bytes(limits.operations.max_input_bytes)],
    [
      t("pages.settings.codespaces.limits.commandOutput"),
      bytes(limits.operations.max_retained_output_bytes),
    ],
    [t("pages.settings.codespaces.limits.fileSize"), bytes(limits.transfers.max_file_bytes)],
    [
      t("pages.settings.codespaces.limits.retention"),
      t("pages.settings.codespaces.limits.days", { count: limits.lifecycle.retention_days }),
    ],
    [
      t("pages.settings.codespaces.limits.createInterval"),
      t("pages.settings.codespaces.limits.seconds", {
        count: limits.codespaces.create_throttle_seconds,
      }),
    ],
    [
      t("pages.settings.codespaces.limits.instance"),
      t("pages.settings.codespaces.limits.ofMax", {
        used: limits.codespaces.instance_held,
        max: limits.codespaces.max_instance,
      }),
    ],
    [
      t("pages.settings.codespaces.limits.billing"),
      t("pages.settings.codespaces.limits.billingUnavailable"),
    ],
  ];

  return (
    <Card data-testid="github-codespace-limits">
      <CardHeader>
        <div className="flex items-center gap-1.5">
          <Gauge className="size-4 text-muted-foreground" aria-hidden="true" />
          <CardTitle className="text-base">{t("pages.settings.codespaces.limits.title")}</CardTitle>
          <HelpPopover
            title={t("pages.settings.codespaces.limits.helpTitle")}
            data-testid="codespace-limits-help"
          >
            <p>{t("pages.settings.codespaces.limits.helpHeld")}</p>
            <p>{t("pages.settings.codespaces.limits.helpBilling")}</p>
          </HelpPopover>
        </div>
        <CardDescription>{t("pages.settings.codespaces.limits.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Meter
            label={t("pages.settings.codespaces.limits.held")}
            used={limits.codespaces.held}
            max={limits.codespaces.max_per_user}
            display={t("pages.settings.codespaces.limits.ofMax", {
              used: limits.codespaces.held,
              max: limits.codespaces.max_per_user,
            })}
            testId="codespace-limit-held"
          />
          <Meter
            label={t("pages.settings.codespaces.limits.commands")}
            used={limits.operations.active}
            max={limits.operations.max_concurrent_per_user}
            display={t("pages.settings.codespaces.limits.ofMax", {
              used: limits.operations.active,
              max: limits.operations.max_concurrent_per_user,
            })}
            testId="codespace-limit-commands"
          />
          <Meter
            label={t("pages.settings.codespaces.limits.transfers")}
            used={limits.transfers.used_bytes}
            max={limits.transfers.max_bytes_per_user}
            display={t("pages.settings.codespaces.limits.ofMax", {
              used: bytes(limits.transfers.used_bytes),
              max: bytes(limits.transfers.max_bytes_per_user),
            })}
            testId="codespace-limit-transfers"
          />
        </div>
        <Collapsible>
          <CollapsibleTrigger
            className="group inline-flex items-center gap-1 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="codespace-limits-more"
          >
            <ChevronDown
              className="size-4 transition-transform group-data-[state=open]:rotate-180"
              aria-hidden="true"
            />
            {t("pages.settings.codespaces.limits.more")}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="mt-2 grid gap-x-6 gap-y-2 rounded-lg border p-3 text-sm sm:grid-cols-2">
              {facts.map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  );
}

/** The limits panel for the section's shared codespace data, once it has loaded. */
export function CodespaceLimitsFromData(): React.JSX.Element | null {
  const { management } = useGitHubCodespaces();
  return management ? <CodespaceLimitsPanel limits={management.limits} /> : null;
}
