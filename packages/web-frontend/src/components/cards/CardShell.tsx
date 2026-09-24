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
 * - `badges` — states that need attention (invalid, shared, failed), on the title line;
 * - `actions` — icon buttons, shown on hover or focus.
 *
 * In the list view an item is a comfortable row of up to four lines; in the grid view the same
 * slots stack in a card. An item that opens on click opens from anywhere on it with the pointer, and
 * from the keyboard through its title, which is then a button. Anything interactive inside a slot
 * (an action, a tag filter, a toggle) stops its click from reaching the item.
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

/** The height of one row of grid cards with the gap between rows. */
export const GRID_ROW_HEIGHT = 180;

export interface CardShellProps {
  compact?: boolean;
  onClick?: () => void;
  actions?: CardAction[];
  className?: string;
  testId?: string;
  icon?: React.ReactNode;
  title: React.ReactNode;
  titleAside?: React.ReactNode;
  description?: React.ReactNode;
  note?: React.ReactNode;
  meta?: React.ReactNode;
  badges?: React.ReactNode;
}

const actionVariantClasses: Record<string, string> = {
  default: "",
  destructive: "text-destructive hover:text-destructive hover:bg-destructive/10",
  success: "text-success hover:text-success hover:bg-success/10",
};

const ActionsGroup: React.FC<{
  actions: CardAction[];
  className?: string;
}> = ({ actions, className }) => (
  <div
    className={cn(
      "flex items-center gap-0.5 transition-opacity flex-shrink-0",
      "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
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
        data-hint={action.label}
        data-testid={action.testId}
      >
        {action.icon}
      </Button>
    ))}
  </div>
);

/** The slots, laid out for either view. */
function SlottedBody({
  compact,
  onClick,
  icon,
  title,
  titleAside,
  description,
  note,
  meta,
  badges,
}: Omit<CardShellProps, "actions" | "className" | "testId"> & {
  compact: boolean;
}): React.JSX.Element {
  const titleClass = "min-w-0 truncate text-[15px] font-medium leading-5 text-foreground";
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
            {onClick ? (
              <button
                type="button"
                onClick={(event) => {
                  // The item itself opens on a pointer click; the title only adds the keyboard.
                  event.stopPropagation();
                  onClick();
                }}
                className={cn(
                  titleClass,
                  "rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
                data-slot="card-title"
              >
                {title}
              </button>
            ) : (
              <span className={titleClass} data-slot="card-title">
                {title}
              </span>
            )}
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
  ...slots
}) => {
  const hasActions = actions !== undefined && actions.length > 0;
  return (
    <Card
      className={cn(
        "group border border-border bg-card transition-colors duration-150",
        onClick && "cursor-pointer hover:border-primary/50 hover:bg-accent/30",
        compact ? "h-full" : "mb-2",
        className,
      )}
      onClick={onClick}
      data-testid={testId}
      data-slotted="true"
    >
      {compact ? (
        <div className="relative flex h-full flex-col gap-2 p-4">
          {hasActions && <ActionsGroup actions={actions} className="absolute top-2 right-2" />}
          <SlottedBody compact onClick={onClick} {...slots} />
        </div>
      ) : (
        <div className="flex items-start gap-3 px-4 py-3">
          <SlottedBody compact={false} onClick={onClick} {...slots} />
          {hasActions && <ActionsGroup actions={actions} />}
        </div>
      )}
    </Card>
  );
};
