/**
 * CardShell — the one item every list page draws, in the list view and in the grid view.
 *
 * An item is given as slots, and the shell owns the layout, so every list reads the same way:
 *
 * - `icon` — a small leading mark of what the item is;
 * - `title` — what the reader scans for, with `titleAside` beside it (a version, a key);
 * - `description` — up to two lines of readable text saying what the item is;
 * - `note` — one short emphasised line under the description (when to pick a flow, a warning);
 * - `meta` — a quiet line of facts (owner, time, size, tags);
 * - `badges` — states that matter at a glance (invalid, shared, failed), on the title line;
 * - `actions` — icon buttons, shown on hover or focus in the list view.
 *
 * In the list view an item is a comfortable row of up to four lines; in the grid view the same
 * slots stack in a card. Items that still pass free-form `children` get the single-line row; they
 * move to the slots page by page.
 */

import React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface CardAction {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: "default" | "destructive" | "success";
  testId?: string;
}

/**
 * The height a list-view item takes on average, for the lists that size their pages to the space
 * they have: a title line, two description lines, a meta line, padding and the gap between items.
 */
export const LIST_ITEM_HEIGHT = 112;

/**
 * The same for the grid view, per item: a card is 120 to 170 pixels tall with its gap depending on
 * its description, and a row holds up to three.
 */
export const GRID_ITEM_HEIGHT = Math.round(150 / 3);

interface CardShellSlots {
  icon?: React.ReactNode;
  title?: React.ReactNode;
  titleAside?: React.ReactNode;
  description?: React.ReactNode;
  note?: React.ReactNode;
  meta?: React.ReactNode;
  badges?: React.ReactNode;
}

interface CardShellProps extends CardShellSlots {
  compact?: boolean;
  onClick?: () => void;
  actions?: CardAction[];
  className?: string;
  testId?: string;
  /** Free-form content of an item not yet on the slots: drawn in the single-line row. */
  children?: React.ReactNode;
}

const actionVariantClasses: Record<string, string> = {
  default: "",
  destructive: "text-destructive hover:text-destructive hover:bg-destructive/10",
  success: "text-success hover:text-success hover:bg-success/10",
};

const ActionsGroup: React.FC<{
  actions: CardAction[];
  className?: string;
  alwaysVisible?: boolean;
}> = ({ actions, className, alwaysVisible }) => (
  <div
    className={cn(
      "flex items-center gap-0.5 transition-opacity flex-shrink-0",
      !alwaysVisible && "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
      className,
    )}
  >
    {actions.map((action) => (
      <Button
        key={action.label}
        variant="ghost"
        size="icon"
        className={cn("h-7 w-7", actionVariantClasses[action.variant || "default"])}
        onClick={(e) => {
          e.stopPropagation();
          action.onClick();
        }}
        aria-label={action.label}
        data-testid={action.testId}
      >
        {action.icon}
      </Button>
    ))}
  </div>
);

function hasSlots(props: CardShellSlots): boolean {
  return props.title !== undefined;
}

/** The slots, laid out for either view. */
function SlottedBody({
  compact,
  icon,
  title,
  titleAside,
  description,
  note,
  meta,
  badges,
}: CardShellSlots & { compact: boolean }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 gap-3">
      {icon && (
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-primary [&_svg]:size-4">
          {icon}
        </span>
      )}
      <div className={cn("flex min-w-0 flex-1 flex-col", compact ? "gap-2" : "gap-1")}>
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span
              className="min-w-0 truncate text-[15px] font-medium leading-5 text-foreground"
              data-slot="card-title"
            >
              {title}
            </span>
            {titleAside && (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {titleAside}
              </span>
            )}
          </div>
          {badges && (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">{badges}</div>
          )}
        </div>
        {description && (
          <div
            className={cn(
              "text-sm leading-5 text-muted-foreground [overflow-wrap:anywhere]",
              compact ? "line-clamp-3" : "line-clamp-2",
            )}
            data-slot="card-description"
          >
            {description}
          </div>
        )}
        {note && (
          <div className="text-xs leading-5 text-foreground/80" data-slot="card-note">
            {note}
          </div>
        )}
        {meta && (
          <div
            className={cn(
              "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground",
              compact && "mt-auto",
            )}
            data-slot="card-meta"
          >
            {meta}
          </div>
        )}
      </div>
    </div>
  );
}

export const CardShell: React.FC<CardShellProps> = ({
  compact = false,
  onClick,
  actions,
  className,
  testId,
  children,
  ...slots
}) => {
  const slotted = hasSlots(slots);

  if (compact) {
    return (
      <Card
        className={cn(
          "cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 group h-full",
          "border border-border bg-card hover:border-primary/50",
          className,
        )}
        onClick={onClick}
        data-testid={testId}
      >
        <div
          className={cn("flex h-full flex-col gap-2 relative", slotted ? "p-4" : "p-3")}
          data-slotted={slotted ? "true" : undefined}
        >
          {actions && actions.length > 0 && (
            <ActionsGroup actions={actions} className="absolute top-2 right-2" />
          )}
          {slotted ? <SlottedBody compact {...slots} /> : children}
        </div>
      </Card>
    );
  }

  if (slotted) {
    return (
      <Card
        className={cn(
          "mb-2 cursor-pointer transition-colors duration-150 group",
          "border border-border bg-card hover:border-primary/50 hover:bg-accent/30",
          className,
        )}
        onClick={onClick}
        data-testid={testId}
      >
        <div className="flex items-start gap-3 px-4 py-3" data-slotted="true">
          <SlottedBody compact={false} {...slots} />
          {actions && actions.length > 0 && <ActionsGroup actions={actions} />}
        </div>
      </Card>
    );
  }

  return (
    <Card
      className={cn(
        "mb-1.5 cursor-pointer transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 group",
        "border border-border bg-card hover:border-primary/50",
        className,
      )}
      onClick={onClick}
      data-testid={testId}
    >
      <div className="flex items-center h-10 px-3 gap-3">
        {children}
        {actions && actions.length > 0 && <ActionsGroup actions={actions} alwaysVisible />}
      </div>
    </Card>
  );
};

export { ActionsGroup as CardActions };
