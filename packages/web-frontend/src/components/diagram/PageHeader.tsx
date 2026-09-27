/**
 * The header of a process page (a flow, a run): text about what is being looked at, and nothing
 * functional. One row of identity — a back link, the name, its version or id, status badges —
 * with the page's own actions on the right, and beneath it an optional line of description or
 * goal that may wrap to two lines. The description keeps at least a readable width: on a narrow
 * screen the fact chips move to their own line instead of squeezing it. Everything that does
 * something with the diagram (view modes, search, layout, zoom, guides) lives in the
 * `DiagramToolbar` beneath, never here.
 */

import React from "react";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export function PageHeader({
  back,
  title,
  meta,
  badges,
  actions,
  description,
  facts,
  children,
  testId = "page-header",
  guide,
  detailsGuide,
}: {
  back?: { label: string; onClick: () => void; testId?: string };
  title?: React.ReactNode;
  /** A page that composes its own identity row puts it here instead of `title`/`meta`/`badges`. */
  children?: React.ReactNode;
  /** Small secondary text beside the title: a version, a short id. */
  meta?: React.ReactNode;
  /** Status chips after the title. */
  badges?: React.ReactNode;
  /** The page's own actions, right-aligned: edit, lock, refresh, owner. */
  actions?: React.ReactNode;
  /** The goal or description, up to two lines. */
  description?: React.ReactNode;
  /** Small fact chips under the description (the projection's facts). */
  facts?: React.ReactNode;
  testId?: string;
  /** A guide anchor (`guideAnchor(...)`) for the header as a whole. */
  guide?: { "data-guide": string };
  /** A guide anchor for the row under the title: the description and the fact chips. */
  detailsGuide?: { "data-guide": string };
}): React.JSX.Element {
  return (
    <header className="shrink-0 border-b bg-card px-3 py-1.5" data-testid={testId} {...guide}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        {children}
        {back && (
          <button
            type="button"
            onClick={back.onClick}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid={back.testId}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">{back.label}</span>
          </button>
        )}
        {title && (
          <h1 className="min-w-0 truncate text-sm font-semibold leading-7" data-testid="page-title">
            {title}
          </h1>
        )}
        {meta && <span className="shrink-0 text-xs text-muted-foreground">{meta}</span>}
        {badges && <div className="flex shrink-0 items-center gap-1.5">{badges}</div>}
        {actions && <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {(description || facts) && (
        <div
          className={cn("mt-0.5 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5")}
          {...detailsGuide}
        >
          {description && (
            <p
              className="line-clamp-2 min-w-0 flex-1 basis-64 text-xs leading-5 text-muted-foreground"
              data-testid="page-description"
            >
              {description}
            </p>
          )}
          {facts && (
            <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1">{facts}</div>
          )}
        </div>
      )}
    </header>
  );
}
