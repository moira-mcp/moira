/**
 * One section of a settings page: an icon, a heading, one sentence saying what the section is for,
 * optional help and actions, then the section's cards.
 *
 * Every section looks the same, so a reader learns the page once. The section is also the unit the
 * page's navigation and deep links address: `id` is its anchor (`/settings#<id>`) and
 * `data-settings-section` is what the navigation observes and highlights.
 */

import React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export interface SettingsSectionProps {
  id: string;
  icon: LucideIcon;
  title: string;
  /** One plain sentence: what this section controls. */
  description: string;
  /** A `HelpPopover` next to the heading. */
  help?: React.ReactNode;
  /** Buttons at the end of the heading row (a tutorial, a primary action). */
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}

export function SettingsSection({
  id,
  icon: Icon,
  title,
  description,
  help,
  actions,
  children,
  className,
  "data-testid": testId,
}: SettingsSectionProps): React.JSX.Element {
  const headingId = `${id}-heading`;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      data-settings-section={id}
      data-testid={testId}
      // The sticky chip bar on narrow screens covers the top of the viewport; a jump must land below it.
      className={cn("scroll-mt-20 space-y-4 lg:scroll-mt-8", className)}
    >
      <header className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
          <span
            className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/60 text-foreground"
            aria-hidden="true"
          >
            <Icon className="size-[18px]" />
          </span>
          <div className="min-w-0 space-y-0.5">
            <div className="flex items-center gap-1.5">
              <h2 id={headingId} className="text-lg font-semibold leading-7 tracking-tight">
                {title}
              </h2>
              {help}
            </div>
            <p className="text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/**
 * A titled card inside a section, for a section that holds more than one thing (sign-in security
 * and the devices signed in). Its title, help, description and actions sit in the card's own
 * header, like every other card on the page, and its children are the card's content, so the
 * children render without a card of their own.
 */
export function SettingsSubsection({
  title,
  description,
  help,
  actions,
  children,
  className,
  "data-testid": testId,
}: {
  title: string;
  description?: string;
  help?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}): React.JSX.Element {
  return (
    <Card className={className} data-testid={testId}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1 basis-60 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <CardTitle role="heading" aria-level={3} className="text-base">
                {title}
              </CardTitle>
              {help}
            </div>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
