import React from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

type GuideAnchor = { "data-guide": string };

export interface ProcessPageHeaderProps {
  back?: { label: string; onClick: () => void; testId?: string };
  title?: React.ReactNode;
  /** Custom process identity instead of the title/meta/badges slots. */
  children?: React.ReactNode;
  /** A version or short ID next to the title. */
  meta?: React.ReactNode;
  badges?: React.ReactNode;
  actions?: React.ReactNode;
  /** Process goal or description; diagram controls belong to its toolbar. */
  description?: React.ReactNode;
  facts?: React.ReactNode;
  testId?: string;
  guide?: GuideAnchor;
  /** Description/fact-row guide, independent of the identity anchor. */
  detailsGuide?: GuideAnchor;
}

type HeaderContentProps =
  | {
      variant: "standard";
      title: string;
      description?: string;
      actions?: React.ReactNode;
      guide?: GuideAnchor;
    }
  | (ProcessPageHeaderProps & { variant: "process" });

/** Shared header presentation; routing and the page's operation ownership stay in callers. */
export function PageHeaderContent(props: HeaderContentProps) {
  const compact = props.variant === "process";
  const Frame = compact ? "header" : "div";
  const heading = (!compact || props.title) && (
    <h1
      className={
        compact
          ? "min-w-0 truncate text-sm font-semibold leading-7"
          : "text-2xl font-semibold tracking-tight"
      }
      data-testid={compact ? "page-title" : undefined}
    >
      {props.title}
    </h1>
  );
  return (
    <Frame
      className={compact ? "shrink-0 border-b bg-card px-3 py-1.5" : "mb-6"}
      data-testid={compact ? (props.testId ?? "page-header") : undefined}
      {...(compact ? props.guide : undefined)}
    >
      <div
        className={
          compact
            ? "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
            : "flex flex-wrap items-center justify-between gap-x-4 gap-y-3"
        }
      >
        {compact ? (
          <>
            {props.children}
            {props.back && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={props.back.onClick}
                aria-label={props.back.label}
                className="h-7 shrink-0 gap-1.5 px-1.5 text-sm text-muted-foreground"
                data-testid={props.back.testId}
              >
                <ArrowLeft className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">{props.back.label}</span>
              </Button>
            )}
            {heading}
            {props.meta && (
              <span className="shrink-0 text-xs text-muted-foreground">{props.meta}</span>
            )}
            {props.badges && (
              <div className="flex shrink-0 items-center gap-1.5">{props.badges}</div>
            )}
          </>
        ) : (
          <div className="min-w-0 flex-1 basis-72" {...props.guide}>
            {heading}
            {props.description && (
              <p className="mt-1 text-sm text-muted-foreground">{props.description}</p>
            )}
          </div>
        )}
        {props.actions && (
          <div
            className={
              compact ? "ml-auto flex shrink-0 items-center gap-1.5" : "flex items-center gap-2"
            }
          >
            {props.actions}
          </div>
        )}
      </div>
      {compact && (props.description || props.facts) && (
        <div
          className="mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5"
          {...props.detailsGuide}
        >
          {props.description && (
            <p
              className="line-clamp-2 min-w-0 flex-1 basis-64 text-xs leading-5 text-muted-foreground"
              data-testid="page-description"
            >
              {props.description}
            </p>
          )}
          {props.facts && (
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
              {props.facts}
            </div>
          )}
        </div>
      )}
    </Frame>
  );
}
