/**
 * Map — the process as a diagram with its table of contents.
 *
 * A compact header names what is being looked at — the run's task, its rendered title, its goal
 * and the projection's facts (on a definition, the workflow's name and description) — above the
 * layered diagram (`CanvasDiagram`): blocks left to right in process order, labelled forward
 * transitions, loops below, hub bundles, a chip per exit, and on a run the block the run is at in
 * view. The left sidebar is the contents: every block in order with its status, how many times it
 * ran, the progress of the list it is bound to and, on the flow page, how long the block typically
 * takes — plus the node finder, which answers "which block is this step in" and selects that block.
 *
 * The diagram owns the column: the explanation of the view is one line with a disclosure, closed
 * until the reader opens it and remembered per page in `localStorage`, so it costs one row instead
 * of a third of the height. On a phone the map is one scrolling column — the diagram at a readable
 * fixed height, the contents beneath it — and the page's panel follows underneath as before.
 *
 * The map holds no block narrative: the page's right panel carries it, on the run page with the
 * run's timings, list and route facts and on the flow page with authoring.
 */

import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import { Compass } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModeGuideKey } from "../flow/editing";
import { CanvasDiagram } from "./CanvasView";
import { ContentsLayout } from "./ContentsSidebar";
import { type RunViewProps } from "./model";

/**
 * The explanation of the view as one line: a title with a disclosure that opens the body. It is
 * closed by default so the diagram keeps the column, and the reader's choice is remembered per
 * page in `localStorage` — a browser that refuses storage simply keeps the default.
 */
function MapGuide({ guideKey }: { guideKey: string }): React.JSX.Element {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" data-testid="guidance-map">
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        data-hint={t(`${guideKey}.map.title`)}
        aria-label={t(`${guideKey}.map.title`)}
        className={cn(
          "inline-flex h-8 w-8 items-center justify-center rounded-md border border-transparent text-muted-foreground hover:border-border hover:bg-accent hover:text-foreground",
          open && "border-primary/50 bg-primary/10 text-primary",
        )}
        data-testid="guidance-map-toggle"
      >
        <Compass className="size-4" aria-hidden="true" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full z-20 mt-1 w-[360px] rounded-lg border bg-popover p-3 text-xs leading-5 text-popover-foreground shadow-md"
          data-testid="guidance-map-body"
        >
          <p className="mb-1 font-medium text-primary">{t(`${guideKey}.map.title`)}</p>
          {t(`${guideKey}.map.body`)}
        </div>
      )}
    </div>
  );
}

export function MapView({
  sidebar,
  toolbarModes,
  toolbarExtra,
  toolbarTrailing,
  ...props
}: RunViewProps & {
  /** Extra content the page puts above the contents list. */
  sidebar?: React.ReactNode;
  /** The page's view-mode switch, first in the toolbar. */
  toolbarModes?: React.ReactNode;
  /** The page's own controls (the route cursor), placed after the sidebar toggle. */
  toolbarExtra?: React.ReactNode;
  /** The page's trailing controls (legend, guide), placed after the diagram's. */
  toolbarTrailing?: React.ReactNode;
}): React.JSX.Element {
  const guideKey = useModeGuideKey();
  const { blocks, selectedBlockId, onSelectBlock } = props;
  return (
    <ContentsLayout
      blocks={blocks}
      selectedBlockId={selectedBlockId}
      onSelect={onSelectBlock}
      sidebar={sidebar}
      testId="map-view"
    >
      {(toggle) => (
        <CanvasDiagram
          {...props}
          toolbarModes={toolbarModes}
          toolbarTrailing={
            <>
              <MapGuide guideKey={guideKey} />
              {toolbarTrailing}
            </>
          }
          toolbarLeading={
            <>
              {toggle}
              {toolbarExtra}
            </>
          }
        />
      )}
    </ContentsLayout>
  );
}
