/**
 * Status vocabulary shared by every run-page mode: active, waiting, done, repeated with the pass
 * count, skipped, pending — each readable without hover, with the app's semantic tokens.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Check, CircleDashed, Hourglass, Loader2, RotateCcw, SkipForward } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ExecutionBlockStatus } from "./model";

interface StatusStyle {
  icon: React.ComponentType<{ className?: string }>;
  /** Border/ring/text tint used by block surfaces. */
  surface: string;
  /** Solid chip used by compact badges. */
  chip: string;
  tint: string;
  spin?: boolean;
}

export const STATUS_STYLE: Record<ExecutionBlockStatus, StatusStyle> = {
  pending: {
    icon: CircleDashed,
    surface: "border-border bg-card text-muted-foreground",
    chip: "bg-muted text-muted-foreground",
    tint: "text-muted-foreground",
  },
  active: {
    icon: Loader2,
    surface: "border-primary bg-primary/5 text-foreground ring-2 ring-primary/25 shadow-md",
    chip: "bg-primary text-primary-foreground",
    tint: "text-primary",
    spin: true,
  },
  done: {
    icon: Check,
    surface: "border-success/60 bg-success/5 text-foreground",
    chip: "bg-success text-success-foreground",
    tint: "text-success",
  },
  repeated: {
    icon: RotateCcw,
    surface: "border-success/60 bg-success/5 text-foreground",
    chip: "bg-success text-success-foreground",
    tint: "text-success",
  },
  skipped: {
    icon: SkipForward,
    surface: "border-dashed border-border bg-muted/30 text-muted-foreground",
    chip: "bg-muted text-muted-foreground",
    tint: "text-muted-foreground",
  },
  waiting: {
    icon: Hourglass,
    surface: "border-warning bg-warning/10 text-foreground ring-2 ring-warning/30",
    chip: "bg-warning text-warning-foreground",
    tint: "text-warning-foreground",
  },
};

export const STATUS_ORDER: ExecutionBlockStatus[] = [
  "pending",
  "active",
  "waiting",
  "done",
  "repeated",
  "skipped",
];

export function StatusIcon({
  status,
  className,
}: {
  status: ExecutionBlockStatus;
  className?: string;
}): React.JSX.Element {
  const style = STATUS_STYLE[status];
  const Icon = style.icon;
  return (
    <Icon
      className={cn("size-4 shrink-0", style.tint, style.spin && "animate-spin", className)}
      aria-hidden="true"
    />
  );
}

/** Compact chip: icon + status word, plus the pass count when the block repeated. */
export function StatusChip({
  status,
  iterations,
  className,
}: {
  status: ExecutionBlockStatus;
  iterations?: number;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const style = STATUS_STYLE[status];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4",
        style.chip,
        className,
      )}
      data-status={status}
    >
      <Icon className={cn("size-3", style.spin && "animate-spin")} aria-hidden="true" />
      {t(`pages.runPage.status.${status}`)}
      {status === "repeated" && iterations ? (
        <span className="ml-0.5 tabular-nums" data-testid="status-iterations">
          ×{iterations}
        </span>
      ) : null}
    </span>
  );
}

/** Legend: the vocabulary explained once, above every mode. */
export function StatusLegend({ className }: { className?: string }): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <ul
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground",
        className,
      )}
      data-testid="status-legend"
    >
      {STATUS_ORDER.map((status) => (
        <li key={status} className="inline-flex items-center gap-1">
          <StatusIcon status={status} className="size-3" />
          {t(`pages.runPage.status.${status}`)}
        </li>
      ))}
    </ul>
  );
}
