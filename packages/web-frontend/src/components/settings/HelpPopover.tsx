/**
 * An explanation a reader asks for: a small question-mark button that opens a short, readable card.
 *
 * It is for text too long for a tooltip — what a setting does, what happens when you change it,
 * the difference between two similar things — that the page should not print permanently. The card
 * is the application's popover (keyboard-operable, closes on Escape and outside click), drawn on the
 * same surface as every hint so help looks the same wherever it appears.
 */

import React from "react";
import { CircleHelp } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface HelpPopoverProps {
  /** Heading of the card; also names the button for assistive technology. */
  title: string;
  /** The explanation: a sentence, paragraphs or a short list. */
  children: React.ReactNode;
  /** Accessible name of the button; defaults to the title. */
  label?: string;
  /** A link at the bottom of the card, for the full documentation. */
  learnMore?: { href: string; label: string };
  align?: "start" | "center" | "end";
  className?: string;
  "data-testid"?: string;
}

export function HelpPopover({
  title,
  children,
  label,
  learnMore,
  align = "start",
  className,
  "data-testid": testId,
}: HelpPopoverProps): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={label ?? title}
          data-testid={testId}
          className={cn(
            "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <CircleHelp className="size-4" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="w-[min(22rem,calc(100vw-2rem))] space-y-2 p-4 text-sm leading-6"
        data-testid={testId ? `${testId}-content` : undefined}
      >
        <p className="font-semibold leading-5 text-foreground">{title}</p>
        <div className="space-y-2 text-muted-foreground [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc">
          {children}
        </div>
        {learnMore && (
          <a
            href={learnMore.href}
            className="inline-flex text-sm font-medium text-primary underline-offset-4 hover:underline"
          >
            {learnMore.label}
          </a>
        )}
      </PopoverContent>
    </Popover>
  );
}
