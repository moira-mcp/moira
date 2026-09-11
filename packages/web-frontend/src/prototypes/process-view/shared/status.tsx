/**
 * Status vocabulary shared by every process-view variant.
 *
 * #179 asks for more than active / done / pending: repeated with an iteration count, skipped by
 * routing, and waiting on the user — each readable without hover. Everything here uses the app's
 * semantic tokens (primary, success, warning, muted) so the variants share one language.
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Check, CircleDashed, Hourglass, Loader2, RotateCcw, SkipForward } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BlockRunState, BlockStatus } from "../model";

interface StatusStyle {
  icon: React.ComponentType<{ className?: string }>;
  /** Border/ring/text tint used by block surfaces. */
  surface: string;
  /** Solid chip used by compact badges. */
  chip: string;
  /** Icon-only tint. */
  tint: string;
  /** Whether the icon should spin (only the active state). */
  spin?: boolean;
}

export const STATUS_STYLE: Record<BlockStatus, StatusStyle> = {
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

export const STATUS_ORDER: BlockStatus[] = [
  "pending",
  "active",
  "done",
  "repeated",
  "skipped",
  "waiting",
];

export function StatusIcon({
  status,
  className,
}: {
  status: BlockStatus;
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

/** Compact chip: icon + status word, plus the iteration count when the block repeated. */
export function StatusChip({
  state,
  className,
}: {
  state: BlockRunState;
  className?: string;
}): React.JSX.Element {
  const { t } = useTranslation();
  const style = STATUS_STYLE[state.status];
  const Icon = style.icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold leading-4",
        style.chip,
        className,
      )}
      data-status={state.status}
    >
      <Icon className={cn("size-3", style.spin && "animate-spin")} aria-hidden="true" />
      {t(`pages.processViewPrototype.status.${state.status}`)}
      {state.status === "repeated" && state.iterations ? (
        <span className="ml-0.5 tabular-nums">×{state.iterations}</span>
      ) : null}
    </span>
  );
}

/** Legend row used by the host so the vocabulary is explained once, above every variant. */
export function StatusLegend(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {STATUS_ORDER.map((status) => (
        <li key={status} className="inline-flex items-center gap-1.5">
          <StatusIcon status={status} className="size-3.5" />
          {t(`pages.processViewPrototype.status.${status}`)}
        </li>
      ))}
    </ul>
  );
}
