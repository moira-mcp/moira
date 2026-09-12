/**
 * The one badge the panel tabs use: a count (errors, open items) or a warning dot (an answer is
 * waiting, a lock is active), in one geometry, with an accessible label saying what it means.
 */

import React from "react";
import { cn } from "@/lib/utils";

export function TabBadge({
  count,
  warning = false,
  label,
  tone = "neutral",
  testId,
}: {
  count?: number;
  warning?: boolean;
  /** What the badge means, for assistive technology and the tooltip. */
  label: string;
  tone?: "neutral" | "danger" | "warning";
  testId?: string;
}): React.JSX.Element | null {
  if (!warning && !count) return null;
  return (
    <span
      className={cn(
        "ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-4 tabular-nums",
        tone === "danger" && "bg-destructive text-white",
        tone === "warning" && "bg-warning text-warning-foreground",
        tone === "neutral" && "bg-muted text-foreground",
      )}
      role="status"
      aria-label={label}
      title={label}
      data-testid={testId}
      data-tab-badge={warning ? "warning" : "count"}
    >
      {warning ? "!" : count}
    </span>
  );
}
