/**
 * The ordinal of a block (or a position in a list) as one badge everywhere it appears: on the
 * card's title band, in the contents sidebar, at the head of the block panel. The tone follows
 * the block's run status so the number carries the same colour as its card.
 */

import React from "react";
import { cn } from "@/lib/utils";
import type { CardTone } from "./PortedCard";

const BADGE_TONE: Record<CardTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  active: "bg-primary text-primary-foreground",
  waiting: "bg-warning text-warning-foreground",
  done: "bg-success text-success-foreground",
  error: "bg-destructive text-white",
};

export function IndexBadge({
  index,
  tone = "neutral",
  size = "md",
  className,
}: {
  index: number | string;
  tone?: CardTone;
  /** `md` on cards and panel headers, `sm` in dense rows (the contents sidebar). */
  size?: "sm" | "md";
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md font-bold tabular-nums",
        size === "md" ? "h-6 min-w-6 px-1.5 text-[12px]" : "h-5 min-w-5 px-1 text-[11px]",
        BADGE_TONE[tone],
        className,
      )}
      data-step-index=""
    >
      {index}
    </span>
  );
}
