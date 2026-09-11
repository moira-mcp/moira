/**
 * Guidance elements shared by every prototype surface: a callout that says what a surface is and
 * how to use it, and a small "?" hint for a single control. Both read their text from i18n so a
 * newcomer gets the explanation in their language; nothing here depends on the data model.
 */

import React from "react";
import { HelpCircle, Lightbulb, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Inline callout: a title, one or two sentences, dismissible per page load. */
export function GuidanceCallout({
  title,
  children,
  className,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}): React.JSX.Element | null {
  const [open, setOpen] = React.useState(true);
  if (!open) return null;
  return (
    <aside
      role="note"
      data-testid={testId ?? "guidance-callout"}
      className={cn(
        "relative flex gap-3 rounded-lg border border-info/40 bg-info/5 px-3 py-2.5 text-sm",
        className,
      )}
    >
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
      <div className="min-w-0 space-y-0.5 pr-6">
        <p className="font-medium leading-5">{title}</p>
        <div className="leading-5 text-muted-foreground">{children}</div>
      </div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="absolute right-2 top-2 rounded-md p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Dismiss"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </aside>
  );
}

/** A "?" next to one control that opens a short explanation. */
export function GuidanceHint({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
          data-testid="guidance-hint"
        >
          <HelpCircle className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" className="w-80 text-sm leading-5">
        {children}
      </PopoverContent>
    </Popover>
  );
}
