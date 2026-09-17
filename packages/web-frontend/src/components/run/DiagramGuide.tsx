/**
 * "How to read this diagram" — the standing explanation of the view the reader has open, as one
 * toolbar button with a disclosure. The map and the graph draw the same process out of different
 * material (block rows and lanes against block groups and step cards), so each names its own note
 * under `<page guide key>.<mode>.{title,body}`: the run page's notes describe the run's state on
 * the diagram, the flow page's describe the definition.
 *
 * It is closed by default so the diagram keeps the column, and the reader's choice is remembered
 * per page and mode in `localStorage` — a browser that refuses storage simply keeps the default.
 * It is mounted in the toolbar of both diagrams, so its ids say "diagram", not "map".
 */

import React from "react";
import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModeGuideKey } from "../flow/editing";
import { useStoredFlag } from "../diagram/useStoredFlag";
import type { RunViewMode } from "./modes";

export function DiagramGuide({ mode }: { mode: RunViewMode }): React.JSX.Element {
  const { t } = useTranslation();
  const guideKey = useModeGuideKey();
  const [open, toggleOpen] = useStoredFlag(`moira.diagram.guide:${guideKey}.${mode}`, false);
  const label = t("components.diagram.howToRead");
  return (
    <div className="relative" data-testid="diagram-guide">
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        data-hint={label}
        aria-label={label}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
          open && "border-primary/50 bg-primary/10 text-primary",
        )}
        data-testid="diagram-guide-toggle"
      >
        <Compass className="size-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-[360px] rounded-lg border bg-popover p-3 text-xs leading-5 text-popover-foreground shadow-md"
          data-testid="diagram-guide-body"
          data-guide-mode={mode}
        >
          <p className="mb-1 font-medium text-primary">{t(`${guideKey}.${mode}.title`)}</p>
          {t(`${guideKey}.${mode}.body`)}
        </div>
      )}
    </div>
  );
}
