/**
 * CardShell — universal card wrapper for list/grid dual-mode cards.
 * Extracts shared hover, border, shadow, click, and action-button patterns
 * from all card components (NoteCard, ArtifactCard, ExecutionCard, etc.)
 *
 * In compact (grid) mode: actions float top-right, content is vertical flex.
 * In list mode: actions are appended at the end of the horizontal row.
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

interface CardShellProps {
  compact?: boolean;
  onClick?: () => void;
  actions?: CardAction[];
  className?: string;
  testId?: string;
  children: React.ReactNode;
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
      !alwaysVisible && "opacity-0 group-hover:opacity-100",
      className,
    )}
  >
    {actions.map((action) => (
      <Button
        key={action.label}
        variant="ghost"
        size="icon"
        className={cn("h-6 w-6", actionVariantClasses[action.variant || "default"])}
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

export const CardShell: React.FC<CardShellProps> = ({
  compact = false,
  onClick,
  actions,
  className,
  testId,
  children,
}) => {
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
        <div className="p-3 flex flex-col gap-2 h-full relative">
          {actions && actions.length > 0 && (
            <ActionsGroup actions={actions} className="absolute top-2 right-2" />
          )}
          {children}
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
