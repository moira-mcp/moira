/**
 * One section of a side panel: a bordered card with a header row (title, a short summary on the
 * right, a chevron) and a body that folds away. The fold state is remembered per section key so a
 * reader who never wants the raw writes keeps them folded. Gives every panel one rhythm: header,
 * body, gap.
 */

import React, { useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStoredFlag } from "./useStoredFlag";

export function PanelSection({
  id,
  title,
  summary,
  defaultOpen = true,
  children,
  className,
  testId,
  openToken,
}: {
  /** Storage key suffix; the fold state is kept per id. */
  id: string;
  title: React.ReactNode;
  /** Shown at the right of the header: a count, a duration, the current item. */
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
  className?: string;
  testId?: string;
  /** A new value unfolds the section (a "go to" landed inside it). */
  openToken?: number;
}): React.JSX.Element {
  const [folded, toggle] = useStoredFlag(`moira.panel.folded:${id}`, !defaultOpen);
  const lastToken = useRef(openToken);
  useEffect(() => {
    if (openToken === undefined || openToken === lastToken.current) return;
    lastToken.current = openToken;
    if (folded) toggle();
  }, [openToken, folded, toggle]);
  return (
    <section
      className={cn("rounded-lg border bg-card", className)}
      data-testid={testId ?? `panel-section-${id}`}
      data-folded={folded ? "true" : undefined}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!folded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </span>
        {summary && (
          <span className="ml-auto min-w-0 truncate text-xs text-foreground/80">{summary}</span>
        )}
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            !summary && "ml-auto",
            folded && "-rotate-90",
          )}
          aria-hidden="true"
        />
      </button>
      {!folded && (
        <div className="border-t px-3 py-2 [&>section>p.uppercase]:hidden [&>section>p:first-child.uppercase]:hidden">
          {children}
        </div>
      )}
    </section>
  );
}
