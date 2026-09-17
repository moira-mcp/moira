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

import React from "react";
import { CanvasDiagram } from "./CanvasView";
import { ContentsLayout } from "./ContentsSidebar";
import { DiagramGuide } from "./DiagramGuide";
import { type RunViewProps } from "./model";

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
              <DiagramGuide mode="map" />
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
