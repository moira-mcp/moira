/**
 * The marker of one item of a block's bound list, the same on the card, in the block panel and
 * in the contents sidebar: done (a check), in progress (a spinner or a pulsing arrow), pending
 * (a dashed circle). `glyph` draws text glyphs for the compact card list; `icon` draws icons.
 */

import React from "react";
import { Check, CircleDashed, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export function ListMarker({
  done,
  current,
  variant = "icon",
  className,
}: {
  done: boolean;
  current: boolean;
  variant?: "icon" | "glyph";
  className?: string;
}): React.JSX.Element {
  if (variant === "glyph") {
    return (
      <span
        className={cn("w-3 shrink-0 text-center", current && "marker-pulse", className)}
        aria-hidden="true"
      >
        {done ? "✓" : current ? "▶" : "·"}
      </span>
    );
  }
  const Icon = current ? Loader2 : done ? Check : CircleDashed;
  return (
    <Icon
      className={cn(
        "size-3.5 shrink-0",
        current ? "animate-spin text-primary" : done ? "text-success" : "text-muted-foreground",
        className,
      )}
      aria-hidden="true"
    />
  );
}
