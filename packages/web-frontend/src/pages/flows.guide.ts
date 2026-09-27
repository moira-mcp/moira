/**
 * The flow list's tour: that flows are created by the reader's agent rather than on this page, the
 * recommended flows to start with, the whole catalog with its scopes and filters, and the level
 * badge that says how much a flow asks of the reader.
 *
 * The recommended panel can be hidden, and the level badge appears only on flows built with the
 * Workflow Management Flow, which records the level (the bundled flows carry none), so those two
 * steps are optional; the opening step says a flow is created at an agreed level either way.
 */

import type { GuideDefinition } from "../guides/types";

export const flowsGuide: GuideDefinition = {
  id: "flows",
  kind: "screen",
  screen: "flows",
  routes: ["/workflows"],
  steps: [
    { id: "intro", anchor: "flows.header", kind: "look", revision: 1 },
    {
      id: "recommended",
      anchor: "flows.recommended",
      kind: "look",
      revision: 1,
      optional: true,
      absentWhen: { panelHidden: "workflows-recommended" },
    },
    { id: "all", anchor: "flows.list", kind: "look", revision: 1 },
    { id: "scopes", anchor: "flows.scopes", kind: "look", revision: 1 },
    { id: "filters", anchor: "flows.filters", kind: "look", revision: 1 },
    { id: "level", anchor: "flows.level", kind: "look", revision: 1, optional: true },
  ],
};
