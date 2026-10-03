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
import { PageHeaderContent, type ProcessPageHeaderProps } from "../page-header-content";

export function PageHeader(props: ProcessPageHeaderProps): React.JSX.Element {
  return <PageHeaderContent {...props} variant="process" />;
}
